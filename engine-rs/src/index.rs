//! index — the derived, rebuildable retrieval store (Phase 4).
//!
//! Single-file embedded store (sqlite + sqlite-vec). Two entry kinds share
//! one retrieval space: `repo` (harvested `<stellario>` blocks) and `memory`
//! (capsule entries). Vectors live in a vec0 virtual table keyed by keyword
//! anchors — content is NEVER embedded (that would be RAG; anchors only).
//!
//! Authority discipline: this store is *synthesized* — it can be deleted and
//! rebuilt from capsule + repo at any time. Corruption is a non-event.

use std::fs::OpenOptions;
use std::io::Write;
use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use rusqlite::{params, Connection};

use crate::storage::Storage;

pub const EMBEDDING_DIM: usize = 384;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Kind {
    Repo,
    Memory,
}

impl Kind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Kind::Repo => "repo",
            Kind::Memory => "memory",
        }
    }
}

/// One entry to be indexed (vectors supplied separately).
#[derive(Debug, Clone)]
pub struct IndexEntry {
    pub id: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    /// repo: `path:start-end`; memory: `capsule`
    pub span: String,
}

/// A row read back from the index.
#[derive(Debug, Clone)]
pub struct EntryRow {
    pub id: String,
    pub kind: Kind,
    pub source: String,
    pub span: String,
    pub title: String,
    pub content: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
}

/// Register sqlite-vec as an auto-extension (once per process).
fn init_vec_extension() {
    use std::sync::Once;
    static ONCE: Once = Once::new();
    ONCE.call_once(|| unsafe {
        rusqlite::ffi::sqlite3_auto_extension(Some(std::mem::transmute(
            sqlite_vec::sqlite3_vec_init as *const (),
        )));
    });
}

pub fn default_path() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".stellario").join("index.db")
}

pub struct Index {
    conn: Connection,
}

impl Index {
    pub fn open(path: &Path) -> Result<Self> {
        init_vec_extension();
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let conn = Connection::open(path).with_context(|| format!("opening index {}", path.display()))?;
        conn.execute_batch(&format!(
            "CREATE TABLE IF NOT EXISTS entries (
                kind     TEXT NOT NULL,
                id       TEXT NOT NULL,
                source   TEXT NOT NULL,
                span     TEXT NOT NULL,
                title    TEXT NOT NULL,
                content  TEXT NOT NULL,
                tags     TEXT NOT NULL,
                keywords TEXT NOT NULL,
                PRIMARY KEY (kind, id)
            );
            CREATE VIRTUAL TABLE IF NOT EXISTS keyword_vecs USING vec0(
                embedding float[{EMBEDDING_DIM}],
                +kind TEXT,
                +entry_id TEXT,
                +keyword TEXT
            );"
        ))?;
        Ok(Index { conn })
    }

    /// Replace all entries of (kind, source) with the new set — the
    /// rebuild-in-place primitive. Vectors are (keyword, embedding) per entry.
    pub fn replace_source(
        &self,
        kind: Kind,
        source: &str,
        entries: &[(IndexEntry, Vec<(String, Vec<f32>)>)],
    ) -> Result<usize> {
        // Collect ids of the old set, delete their vectors, then the rows.
        let mut stmt = self.conn.prepare("SELECT id FROM entries WHERE kind = ?1 AND source = ?2")?;
        let old_ids: Vec<String> = stmt
            .query_map(params![kind.as_str(), source], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        drop(stmt);
        for id in &old_ids {
            self.conn.execute(
                "DELETE FROM keyword_vecs WHERE rowid IN (SELECT rowid FROM keyword_vecs WHERE kind = ?1 AND entry_id = ?2)",
                params![kind.as_str(), id],
            )?;
        }
        self.conn.execute(
            "DELETE FROM entries WHERE kind = ?1 AND source = ?2",
            params![kind.as_str(), source],
        )?;

        for (entry, vecs) in entries {
            self.conn.execute(
                "INSERT OR REPLACE INTO entries (kind, id, source, span, title, content, tags, keywords)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    kind.as_str(),
                    entry.id,
                    source,
                    entry.span,
                    entry.title,
                    entry.content,
                    serde_json::to_string(&entry.tags)?,
                    serde_json::to_string(&entry.keywords)?,
                ],
            )?;
            for (keyword, vec) in vecs {
                if vec.len() != EMBEDDING_DIM {
                    continue;
                }
                let blob: Vec<u8> = vec.iter().flat_map(|f| f.to_le_bytes()).collect();
                self.conn.execute(
                    "INSERT INTO keyword_vecs (embedding, kind, entry_id, keyword) VALUES (?1, ?2, ?3, ?4)",
                    params![blob, kind.as_str(), entry.id, keyword],
                )?;
            }
        }
        Ok(entries.len())
    }

    /// All rows of a kind (None = both kinds), for fzf scoring.
    pub fn entries(&self, kind: Option<Kind>) -> Result<Vec<EntryRow>> {
        let (sql, param): (&str, Option<&str>) = match kind {
            Some(k) => ("SELECT kind, id, source, span, title, content, tags, keywords FROM entries WHERE kind = ?1", Some(k.as_str())),
            None => ("SELECT kind, id, source, span, title, content, tags, keywords FROM entries", None),
        };
        let mut stmt = self.conn.prepare(sql)?;
        let map_row = |r: &rusqlite::Row| -> rusqlite::Result<EntryRow> {
            let kind_str: String = r.get(0)?;
            let tags_json: String = r.get(6)?;
            let kw_json: String = r.get(7)?;
            Ok(EntryRow {
                kind: if kind_str == "repo" { Kind::Repo } else { Kind::Memory },
                id: r.get(1)?,
                source: r.get(2)?,
                span: r.get(3)?,
                title: r.get(4)?,
                content: r.get(5)?,
                tags: serde_json::from_str(&tags_json).unwrap_or_default(),
                keywords: serde_json::from_str(&kw_json).unwrap_or_default(),
            })
        };
        let rows: Vec<EntryRow> = match param {
            Some(p) => stmt.query_map(params![p], map_row)?.collect::<rusqlite::Result<_>>()?,
            None => stmt.query_map([], map_row)?.collect::<rusqlite::Result<_>>()?,
        };
        Ok(rows)
    }

    /// KNN over keyword anchors. Returns (entry_id, keyword, cosine) with the
    /// best cosine per entry. vec0 distance is L2; for normalized vectors
    /// cos = 1 - d²/2 (fastembed MiniLM vectors are normalized).
    pub fn knn(&self, query: &[f32], k: usize, kind: Option<Kind>) -> Result<Vec<(String, String, f64)>> {
        let blob: Vec<u8> = query.iter().flat_map(|f| f.to_le_bytes()).collect();
        // Over-fetch and filter in Rust — auxiliary-column WHERE support in
        // vec0 knn queries is version-dependent; keep it dumb.
        let fetch = k * 4 + 16;
        let mut stmt = self.conn.prepare(
            "SELECT kind, entry_id, keyword, distance FROM keyword_vecs
             WHERE embedding MATCH ?1 AND k = ?2 ORDER BY distance",
        )?;
        let rows = stmt.query_map(params![blob, fetch as i64], |r| {
            Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?, r.get::<_, String>(2)?, r.get::<_, f64>(3)?))
        })?;
        let mut best: std::collections::HashMap<String, (String, f64)> = std::collections::HashMap::new();
        for row in rows {
            let (k_str, entry_id, keyword, dist) = row?;
            if let Some(want) = kind {
                if k_str != want.as_str() {
                    continue;
                }
            }
            let cosine = (1.0 - dist * dist / 2.0).max(0.0);
            best.entry(entry_id)
                .and_modify(|e| {
                    if cosine > e.1 {
                        *e = (keyword.clone(), cosine);
                    }
                })
                .or_insert((keyword, cosine));
        }
        let mut out: Vec<(String, String, f64)> = best.into_iter().map(|(id, (kw, c))| (id, kw, c)).collect();
        out.sort_by(|a, b| b.2.partial_cmp(&a.2).unwrap_or(std::cmp::Ordering::Equal));
        out.truncate(k);
        Ok(out)
    }
}

/// Ingest a capsule's active memory entries into the index (kind=memory).
/// Read-only on the capsule; the index is derived, so a full replace of the
/// capsule's source is the correct granularity.
pub fn ingest_memory<S: Storage + ?Sized>(
    index: &Index,
    capsule: &str,
    storage: &S,
    embed: &dyn Fn(&[String]) -> Option<Vec<Vec<f32>>>,
) -> Result<usize> {
    let mut entries: Vec<(IndexEntry, Vec<(String, Vec<f32>)>)> = Vec::new();
    let mut all_keywords: Vec<String> = Vec::new();
    let mut rows: Vec<IndexEntry> = Vec::new();

    for vol in storage.volume_names()? {
        for id in storage.list(&vol)? {
            let Some(entry) = storage.materialize(&vol, &id)? else { continue };
            let title = entry
                .content
                .lines()
                .find(|l| l.trim_start().starts_with('#'))
                .map(|l| l.trim_start_matches('#').trim().to_string())
                .unwrap_or_else(|| entry.content.chars().take(80).collect());
            rows.push(IndexEntry {
                id: entry.id.clone(),
                title,
                content: entry.content.clone(),
                tags: entry.tags.clone(),
                keywords: entry.keywords.clone(),
                span: capsule.to_string(),
            });
            all_keywords.extend(entry.keywords.clone());
        }
    }

    let vecs = embed(&all_keywords);
    let mut kw_iter = all_keywords.iter();
    let mut vec_iter = vecs.as_ref().map(|v| v.iter());
    for row in rows {
        let n = row.keywords.len();
        let kws: Vec<String> = kw_iter.by_ref().take(n).cloned().collect();
        let entry_vecs: Vec<(String, Vec<f32>)> = match &mut vec_iter {
            Some(vi) => kws.into_iter().zip(vi.by_ref().take(n).cloned()).collect(),
            None => Vec::new(),
        };
        entries.push((row, entry_vecs));
    }
    index.replace_source(Kind::Memory, capsule, &entries)
}

/// Append one intent record to the log next to the index file.
pub fn log_intent(index_path: &Path, intent: &str, query: &str, kinds: &str, result_count: usize) {
    let log = index_path.with_file_name("intent-log.jsonl");
    let record = serde_json::json!({
        "intent": intent,
        "query": query,
        "kinds": kinds,
        "result_count": result_count,
        "created_at": chrono::Utc::now().to_rfc3339(),
    });
    if let Ok(mut f) = OpenOptions::new().create(true).append(true).open(log) {
        let _ = writeln!(f, "{record}");
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn test_index(name: &str) -> (PathBuf, Index) {
        let path = std::env::temp_dir().join(format!("stella-index-test-{}-{}.db", name, std::process::id()));
        let _ = std::fs::remove_file(&path);
        let idx = Index::open(&path).unwrap();
        (path, idx)
    }

    fn entry(id: &str, kws: &[&str]) -> IndexEntry {
        IndexEntry {
            id: id.into(),
            title: format!("title of {id}"),
            content: format!("content about {id}"),
            tags: vec!["module:test".into()],
            keywords: kws.iter().map(|s| s.to_string()).collect(),
            span: "src/t.rs:1-5".into(),
        }
    }

    /// Normalized 384-dim vector with energy in one coordinate.
    fn basis_vec(i: usize) -> Vec<f32> {
        let mut v = vec![0.0f32; EMBEDDING_DIM];
        v[i % EMBEDDING_DIM] = 1.0;
        v
    }

    #[test]
    fn replace_source_roundtrip() {
        let (path, idx) = test_index("roundtrip");
        let e1 = entry("alpha-beta-gamma", &["auth", "jwt"]);
        let e2 = entry("delta-epsilon-zeta", &["render"]);
        let n = idx
            .replace_source(
                Kind::Repo,
                "testrepo",
                &[
                    (e1.clone(), vec![("auth".into(), basis_vec(0)), ("jwt".into(), basis_vec(1))]),
                    (e2.clone(), vec![("render".into(), basis_vec(2))]),
                ],
            )
            .unwrap();
        assert_eq!(n, 2);

        let rows = idx.entries(Some(Kind::Repo)).unwrap();
        assert_eq!(rows.len(), 2);
        assert!(rows.iter().any(|r| r.id == "alpha-beta-gamma" && r.keywords == vec!["auth", "jwt"]));

        // Replace with a smaller set — old entry must disappear.
        idx.replace_source(Kind::Repo, "testrepo", &[(e2.clone(), vec![("render".into(), basis_vec(2))])])
            .unwrap();
        let rows = idx.entries(Some(Kind::Repo)).unwrap();
        assert_eq!(rows.len(), 1);
        assert_eq!(rows[0].id, "delta-epsilon-zeta");

        // knn near basis_vec(2) should hit delta's "render" keyword.
        let hits = idx.knn(&basis_vec(2), 5, Some(Kind::Repo)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "delta-epsilon-zeta");
        assert_eq!(hits[0].1, "render");
        assert!(hits[0].2 > 0.99, "cosine should be ~1: {}", hits[0].2);

        // knn for the removed entry's keyword should miss.
        let hits = idx.knn(&basis_vec(0), 5, Some(Kind::Repo)).unwrap();
        assert!(hits.is_empty() || hits[0].2 < 0.99, "deleted vectors must be gone: {hits:?}");

        let _ = std::fs::remove_file(&path);
    }

    #[test]
    fn kind_filter() {
        let (path, idx) = test_index("kindfilter");
        let e = entry("alpha-beta-gamma", &["x"]);
        idx.replace_source(Kind::Repo, "r", &[(e.clone(), vec![("x".into(), basis_vec(0))])]).unwrap();
        idx.replace_source(Kind::Memory, "m", &[(entry("meta:1", &["y"]), vec![("y".into(), basis_vec(1))])]).unwrap();
        assert_eq!(idx.entries(Some(Kind::Repo)).unwrap().len(), 1);
        assert_eq!(idx.entries(Some(Kind::Memory)).unwrap().len(), 1);
        assert_eq!(idx.entries(None).unwrap().len(), 2);
        let hits = idx.knn(&basis_vec(1), 5, Some(Kind::Memory)).unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].0, "meta:1");
        let _ = std::fs::remove_file(&path);
    }
}
