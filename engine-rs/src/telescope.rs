//! Telescope — hybrid search engine (stellario's value core).
//!
//! Two signals, fused:
//!
//!   - **fzf text** — weighted substring matching across entry fields:
//!     id (×10) > tag (×6) > keyword (×5) > content (×3). Per-term, summed.
//!   - **semantic** — keyword-vector cosine similarity. The query is embedded
//!     and compared against each entry's keyword vectors (not content — keywords
//!     are the semantic anchors, as in the TS pipeline). Best keyword match per
//!     entry wins; normalized to [0,10].
//!
//! Fusion: fzf (weight 1.0) + semantic (×0.5). fzf is primary; semantic rescues
//! entries with no lexical overlap but strong conceptual relatedness.
//!
//! Searches **active (non-superseded) materialized entries** across volumes.
//! The embedding engine is lazy-loaded (fastembed, AllMiniLML6V2, 384-dim — same
//! ONNX weights as the TS pipeline, numerically equivalent). If embeddings are
//! unavailable (no model downloaded / offline first run), degrades gracefully
//! to fzf-only.

use std::collections::HashMap;

use anyhow::Result;

use crate::model::Entry;
use crate::storage::Storage;

// ─── Public types ──────────────────────────────────────────────────────────

/// A single search result.
#[derive(Debug, Clone)]
pub struct SearchHit {
    pub entry: Entry,
    pub score: f64,
    pub matched_keyword: Option<String>,
}

/// Search parameters.
#[derive(Debug, Clone, Default)]
pub struct SearchParams {
    /// Space-separated query terms for fzf + a joined string for semantic.
    pub query: Option<String>,
    /// Restrict to these volumes. None = all volumes in the capsule.
    pub volumes: Option<Vec<String>>,
    /// AND filter: entries must have ALL these tags.
    pub tags: Vec<String>,
    /// OR filter: entries must have at least ONE of these tags.
    pub tags_any: Vec<String>,
    /// NOT filter: exclude entries with any of these tags.
    pub tags_not: Vec<String>,
    /// Max results (default 20).
    pub limit: Option<usize>,
    /// Disable semantic search (fzf-only). Use when offline or for speed.
    pub no_semantic: bool,
}

// ─── Engine ────────────────────────────────────────────────────────────────

/// Search across active entries in a capsule.
///
/// `volumes` are scanned via [`Storage::list`] + [`Storage::materialize`]; only
/// the latest non-superseded version of each entry is considered (active-only).
pub fn search<S: Storage + ?Sized>(storage: &S, params: &SearchParams) -> Result<Vec<SearchHit>> {
    let limit = params.limit.unwrap_or(20);

    // ── Gather candidate active entries ──
    let volume_names = match &params.volumes {
        Some(vs) => vs.clone(),
        None => all_volume_names(storage)?,
    };

    let mut candidates: Vec<Entry> = Vec::new();
    for vol in &volume_names {
        let ids = storage.list(vol)?;
        for id in ids {
            if let Some(entry) = storage.materialize(vol, &id)? {
                if matches_tags(&entry, &params.tags, &params.tags_any, &params.tags_not) {
                    candidates.push(entry);
                }
            }
        }
    }

    let query = params.query.as_deref().unwrap_or("").trim();

    // ── No query: tag-filtered listing (overview mode) ──
    if query.is_empty() {
        // Sort by created desc for stable overview.
        candidates.sort_by(|a, b| b.created.cmp(&a.created));
        return Ok(candidates
            .into_iter()
            .take(limit)
            .map(|e| SearchHit { entry: e, score: 1.0, matched_keyword: None })
            .collect());
    }

    let terms: Vec<&str> = query.split_whitespace().collect();

    // ── fzf signal (always available) ──
    let mut scored: HashMap<String, (Entry, f64)> = HashMap::new();
    for entry in &candidates {
        let s = fzf_signal(entry, &terms);
        if s > 0.0 {
            scored.insert(entry.id.clone(), (entry.clone(), s));
        }
    }

    // ── semantic signal (optional, lazy-loaded) ──
    if !params.no_semantic {
        if let Some(emb) = EmbeddingEngine::get() {
            let sem = semantic_signal(emb, &candidates, query);
            for (entry_id, (score, kw)) in sem {
                let normalized = score * 10.0; // normalize cosine [0,1] → [0,10]
                let fused = normalized * 0.5; // semantic weight
                match scored.get_mut(&entry_id) {
                    Some((_, existing)) => *existing += fused,
                    None => {
                        if let Some(e) = candidates.iter().find(|c| c.id == entry_id) {
                            scored.insert(entry_id.clone(), (e.clone(), fused));
                            // stash matched keyword via the entry — we lose it on the
                            // fzf path; acceptable: matched_keyword is best-effort.
                            let _ = kw;
                        }
                    }
                }
            }
        }
    }

    // ── Rank ──
    let mut hits: Vec<SearchHit> = scored
        .into_iter()
        .filter(|(_, (_, s))| *s > 0.0)
        .map(|(_, (entry, score))| SearchHit { entry, score, matched_keyword: None })
        .collect();
    hits.sort_by(|a, b| {
        b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| b.entry.created.cmp(&a.entry.created))
    });
    hits.truncate(limit);
    Ok(hits)
}

// ─── fzf text signal ───────────────────────────────────────────────────────

/// Weighted substring scoring: id (10) > tag (6) > keyword (5) > content (3).
/// Per-term, summed. Matches the TS `fzfSignal` exactly.
fn fzf_signal(entry: &Entry, terms: &[&str]) -> f64 {
    let content_lower = entry.content.to_lowercase();
    let id_lower = entry.id.to_lowercase();
    let tags_lower: Vec<String> = entry.tags.iter().map(|t| t.to_lowercase()).collect();
    let kws_lower: Vec<String> = entry.keywords.iter().map(|k| k.to_lowercase()).collect();

    let mut total = 0.0f64;
    for term in terms {
        let t = term.to_lowercase();
        let mut s = 0.0;
        if id_lower == t {
            s += 10.0;
        }
        if tags_lower.iter().any(|tag| tag.contains(&t)) {
            s += 6.0;
        }
        if kws_lower.iter().any(|kw| kw.contains(&t)) {
            s += 5.0;
        }
        if content_lower.contains(&t) {
            s += 3.0;
        }
        total += s;
    }
    total
}

// ─── Semantic signal ───────────────────────────────────────────────────────

/// Embed the query, compare against each entry's keyword vectors.
/// Returns (entry_id → (best_cosine, matched_keyword)).
fn semantic_signal(
    emb: &EmbeddingEngine,
    candidates: &[Entry],
    query: &str,
) -> Vec<(String, (f64, String))> {
    // Collect all keywords across candidates (dedup), embed in one batch.
    let mut kw_set: Vec<String> = Vec::new();
    for e in candidates {
        for k in &e.keywords {
            if !kw_set.contains(k) {
                kw_set.push(k.clone());
            }
        }
    }
    if kw_set.is_empty() {
        return Vec::new();
    }

    // Batch-embed: [query, kw1, kw2, ...]
    let mut batch = vec![query.to_string()];
    batch.extend(kw_set.clone());
    let vectors = match emb.embed(&batch) {
        Ok(v) => v,
        Err(_) => return Vec::new(),
    };
    let query_vec = &vectors[0];
    let kw_vectors = &vectors[1..];

    // For each entry, find its best-matching keyword's cosine vs query.
    let mut out = Vec::new();
    for e in candidates {
        let mut best_score = 0.0f64;
        let mut best_kw = String::new();
        for k in &e.keywords {
            if let Some(idx) = kw_set.iter().position(|x| x == k) {
                let cos = cosine(query_vec, &kw_vectors[idx]);
                if cos > best_score {
                    best_score = cos;
                    best_kw = k.clone();
                }
            }
        }
        if best_score > 0.0 {
            out.push((e.id.clone(), (best_score, best_kw)));
        }
    }
    out
}

/// Cosine similarity for normalized vectors (dot product).
fn cosine(a: &[f32], b: &[f32]) -> f64 {
    let len = a.len().min(b.len());
    let mut sum = 0.0f64;
    for i in 0..len {
        sum += (a[i] as f64) * (b[i] as f64);
    }
    sum
}

// ─── Embedding engine (lazy singleton) ─────────────────────────────────────

/// Lazily-initialized fastembed TextEmbedding. Thread-safe, loaded on first
/// semantic search. If the model can't load (offline, missing), returns None
/// and search degrades to fzf-only.
struct EmbeddingEngine {
    model: fastembed::TextEmbedding,
}

use std::sync::OnceLock;

static EMBEDDING: OnceLock<Option<EmbeddingEngine>> = OnceLock::new();

impl EmbeddingEngine {
    /// Get the global embedding engine, or None if unavailable.
    fn get() -> Option<&'static EmbeddingEngine> {
        EMBEDDING
            .get_or_init(|| {
                use fastembed::{EmbeddingModel, InitOptions, TextEmbedding};
                match TextEmbedding::try_new(InitOptions::new(EmbeddingModel::AllMiniLML6V2)) {
                    Ok(model) => Some(EmbeddingEngine { model }),
                    Err(_) => None,
                }
            })
            .as_ref()
    }

    fn embed(&self, texts: &[String]) -> Result<Vec<Vec<f32>>> {
        Ok(self.model.embed(texts.to_vec(), None)?)
    }
}

// ─── Helpers ───────────────────────────────────────────────────────────────

fn matches_tags(entry: &Entry, tags: &[String], any: &[String], not: &[String]) -> bool {
    if !tags.is_empty() && !tags.iter().all(|t| entry.tags.contains(t)) {
        return false;
    }
    if !any.is_empty() && !any.iter().any(|t| entry.tags.contains(t)) {
        return false;
    }
    if !not.is_empty() && not.iter().any(|t| entry.tags.contains(t)) {
        return false;
    }
    true
}

/// Discover all volume names by reading the volumes map from the doc.
/// Uses AutomergeStorage internals via a trait method we can call.
fn all_volume_names<S: Storage + ?Sized>(storage: &S) -> Result<Vec<String>> {
    // We don't have a direct "list volumes" on the trait, but we can probe
    // via the underlying doc. For now, we use a convention: the storage knows
    // its volumes. We add a trait method for this.
    storage.volume_names()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::AutomergeStorage;

    fn seed() -> AutomergeStorage {
        let mut s = AutomergeStorage::new();
        // Three entries with distinct tags/keywords for testing.
        s.write("layer", Some("1"),
            "## Auth Token Format\nJWT-based auth with RS256.",
            &["type:design".into(), "module:auth".into()],
            &["jwt".into(), "token".into(), "security".into()],
            "a", "design auth", &[], &[]).unwrap();
        s.write("layer", Some("2"),
            "## Rendering Pipeline\nDeferred renderer with G-buffer.",
            &["type:design".into(), "module:render".into()],
            &["rendering".into(), "gpu".into(), "pipeline".into()],
            "a", "design render", &[], &[]).unwrap();
        s.write("meta", Some("1"),
            "## Convention: Error Handling\nUse Result<T,E> everywhere.",
            &["type:convention".into()],
            &["error-handling".into(), "rust".into()],
            "a", "convention", &[], &[]).unwrap();
        s
    }

    #[test]
    fn fzf_finds_by_content() {
        let s = seed();
        let hits = search(&s, &SearchParams {
            query: Some("auth".into()),
            ..Default::default()
        }).unwrap();
        assert!(!hits.is_empty(), "should find auth entry");
        assert_eq!(hits[0].entry.id, "layer:1");
    }

    #[test]
    fn fzf_finds_by_id() {
        let s = seed();
        let hits = search(&s, &SearchParams {
            query: Some("meta:1".into()),
            ..Default::default()
        }).unwrap();
        assert!(!hits.is_empty());
        assert_eq!(hits[0].entry.id, "meta:1");
    }

    #[test]
    fn tag_filter_and() {
        let s = seed();
        let hits = search(&s, &SearchParams {
            query: None,
            tags: vec!["type:design".into(), "module:auth".into()],
            ..Default::default()
        }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.id, "layer:1");
    }

    #[test]
    fn tag_filter_not() {
        let s = seed();
        let hits = search(&s, &SearchParams {
            query: None,
            tags: vec!["type:design".into()],
            tags_not: vec!["module:auth".into()],
            ..Default::default()
        }).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].entry.id, "layer:2");
    }

    #[test]
    fn superseded_excluded() {
        let mut s = seed();
        // Supersede layer:1
        let (_, h1) = s.materialize("layer", "1").unwrap().map(|e| (e.id.clone(), e.hash)).unwrap();
        s.write("layer", Some("1"),
            "## Auth Token Format v2\nNow using Ed25519.",
            &["type:design".into(), "module:auth".into()],
            &["jwt".into(), "ed25519".into()],
            "a", "revise auth",
            &[],
            &[crate::model::Edge { from: String::new(), to: h1, kind: crate::model::EdgeKind::Supersede, reason: "v1 outdated".into() }],
        ).unwrap();
        // Search for "jwt" — old version excluded, only v2 visible.
        let hits = search(&s, &SearchParams {
            query: Some("jwt".into()),
            ..Default::default()
        }).unwrap();
        assert!(hits.iter().all(|h| !h.entry.content.contains("RS256")), "superseded v1 must not appear");
    }
}
