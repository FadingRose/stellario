//! hints — the guide layer on top of stella (constellation §3.5 + UX deskcheck).
//!
//! Design rules (from the failure-mode deskcheck, 2026-08-02):
//!   1. Hints are buttons, not commands — suggestive, always ignorable.
//!   2. Relevance-gated: hints bind to the current query/show context.
//!   3. Strictly read-only: computation never writes (no lint, no auto, no
//!      materialization).
//!   4. Bounded and deterministic: max 3, stable ordering.
//!   5. Read-first: writing is earned by the reading loop. Write hints fire
//!      only at the two honest moments — a legacy hit (distill) and a
//!      zero-hit search (create justified by absence).
//!   6. Intent is the dispatch key (mandatory intent field, logged as
//!      telemetry): meta intents suppress creation suggestions on zero hits;
//!      write intents escalate.
//!
//! Intent classification is grounded in the real intent log (415 records,
//! 2026-06-19 → 08-02): read 78%, meta 6%, write 0%. Unknown intents default
//! to read — the data-supported bias.

use std::path::{Path, PathBuf};

use crate::index::{EntryRow, Index, Kind};

/// A single hint — one line, ending in an actionable command.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Hint {
    pub text: String,
}

impl Hint {
    fn new(text: impl Into<String>) -> Self {
        Hint { text: text.into() }
    }
}

/// Intent class, from the mandatory intent field.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum IntentClass {
    /// System self-testing: verify/test/check … — creation must not fire.
    Meta,
    /// Explicit authoring intent — escalate write hints.
    Write,
    /// Everything else — the data-supported default.
    Read,
}

const META_PREFIXES: &[&str] = &[
    "verify", "test", "check", "debug", "测试", "验证", "试验", "检查一下", "确认系统",
];
const WRITE_PREFIXES: &[&str] = &[
    "record", "note", "save", "remember", "distill", "write", "add", "create",
    "记录", "保存", "蒸馏", "新建", "总结", "建档",
];

/// Bilingual, prefix-based intent classification (real-log grounded).
pub fn classify_intent(intent: &str) -> IntentClass {
    let i = intent.trim().to_lowercase();
    if META_PREFIXES.iter().any(|p| i.starts_with(p)) {
        IntentClass::Meta
    } else if WRITE_PREFIXES.iter().any(|p| i.starts_with(p)) {
        IntentClass::Write
    } else {
        IntentClass::Read
    }
}

/// Is this a legacy entry (capsule volume:id, not yet distilled)?
pub fn is_legacy(row: &EntryRow) -> bool {
    row.kind == Kind::Memory && row.id.contains(':')
}

/// Does the entry carry walls (negation bullets) in its indexed content?
fn has_walls(row: &EntryRow) -> bool {
    ["\ntraps:", "\nnot:", "\nwarning:"]
        .iter()
        .any(|m| row.content.contains(m))
}

/// Task/issue-id shaped query — a zero-hit here is a lookup failure, not a
/// knowledge gap (creation must not be suggested).
fn is_lookup_id(query: &str) -> bool {
    query.split_whitespace().any(|t| {
        // tbNNN task ids, and any volume:id-shaped token (arc:123, layer:45)
        let digits = |s: &str| !s.is_empty() && s.chars().all(|c| c.is_ascii_digit());
        (t.starts_with("tb") && digits(&t[2..]))
            || (t.contains(':')
                && t.split(':').count() == 2
                && digits(t.split(':').nth(1).unwrap_or("")))
    })
}

/// Best tag-overlap neighbor (excluding the row itself) — the "related" hint.
fn related_by_tag<'a>(rows: &'a [EntryRow], row: &EntryRow) -> Option<&'a EntryRow> {
    rows.iter()
        .filter(|r| r.id != row.id)
        .filter_map(|r| {
            let overlap = r.tags.iter().filter(|t| row.tags.contains(t)).count();
            if overlap > 0 {
                Some((overlap, r))
            } else {
                None
            }
        })
        .max_by_key(|(overlap, _)| *overlap)
        .map(|(_, r)| r)
}

/// The conventional staging area: ~/.stellario/staging/<capsule>/*.stella
fn staged_files() -> Vec<(String, PathBuf)> {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    let staging = Path::new(&home).join(".stellario/staging");
    // Staging is shape-driven (anywhere): also scan cwd when it has the
    // undeclared-home shape.
    let mut roots: Vec<PathBuf> = vec![staging];
    if let Ok(cwd) = std::env::current_dir() {
        if cwd.join(".stella").is_dir() && crate::config::discover(&cwd).is_none() {
            roots.push(cwd);
        }
    }
    let mut out = Vec::new();
    for root in roots {
        let Ok(caps) = std::fs::read_dir(&root) else { continue };
        for cap in caps.flatten() {
            let cap_dir = cap.path();
            let creation = cap_dir.join(".stella");
            if !creation.is_dir() {
                continue;
            }
            let Ok(files) = std::fs::read_dir(&creation) else { continue };
            for f in files.flatten() {
                if f.path().extension().and_then(|e| e.to_str()) == Some("stella") {
                    out.push((
                        cap.file_name().to_string_lossy().to_string(),
                        f.path(),
                    ));
                }
            }
        }
    }
    out
}

/// Semantic rescue makes literal zero-hit queries rare — noise floors at
/// score ~1-3 while real hits start ~8. Below this floor, treat the query
/// as effectively zero-hit (the honest "creation justified by absence"
/// moment, and the only place meta-intent suppression matters).
pub const ZERO_FLOOR: f64 = 5.0;

/// Compute hints for a query run. `rows` = all rows of the queried space
/// (post-dedupe, pre-scoring); `scored` = rows with fzf score > 0.
/// Returns at most 3 hints, deterministic order.
pub fn query_hints(
    _idx: &Index,
    rows: &[EntryRow],
    scored: &[(EntryRow, f64)],
    query: &str,
    intent: &str,
    limit: usize,
) -> Vec<Hint> {
    let iclass = classify_intent(intent);
    let effective_zero = scored
        .first()
        .map(|(_, s)| *s < ZERO_FLOOR)
        .unwrap_or(true);
    let mut hints: Vec<Hint> = Vec::new();

    // ── Zero-hit: creation justified by absence (honest write moment B) ──
    if effective_zero {
        if iclass != IntentClass::Meta && !is_lookup_id(query) {
            hints.push(Hint::new(format!(
                "searched {query:?} with nothing found — consider a native entry: write a <slug>.stella, then `stellario sync --capsule <name>`"
            )));
        }
        return truncate(hints);
    }

    let (top, top_score) = &scored[0];

    // ── Legacy hit: distill (honest write moment A) ──
    if is_legacy(top) {
        let cap = &top.source;
        let staging_path = format!(
            "~/.stellario/staging/{cap}/.stella/{}.stella",
            top.id.replace(':', "-")
        );
        hints.push(Hint::new(format!(
            "{} is a legacy entry — consider distilling it: write {} then `stellario sync --capsule {cap}`",
            top.id, staging_path
        )));
    }

    // ── Walls caution (read) ──
    if has_walls(top) {
        hints.push(Hint::new(format!(
            "{} carries walls (negations/traps) — read them before touching",
            top.id
        )));
    }

    // ── Constellation state (read) ──
    if top.kind == Kind::Repo {
        let dir = PathBuf::from(&top.source).join(".stella");
        for cons in crate::constellation::discover(&dir) {
            if cons.slug == top.id {
                if let Some(note) = crate::constellation::side_note(&cons) {
                    hints.push(Hint::new(format!("{note} — `stella <query> --stars` to include drafts")));
                }
            }
        }
    }

    // ── Related by tag (read) ──
    if hints.len() < 3 {
        if let Some(rel) = related_by_tag(rows, top) {
            hints.push(Hint::new(format!(
                "related by tag: {} — `stella show {}`",
                rel.id, rel.id
            )));
        }
    }

    // ── Many weak hits: refine (read) ──
    if hints.len() < 3 && scored.len() >= limit && *top_score <= 15.0 {
        hints.push(Hint::new("many weak hits — narrow with tag filters; try adding a domain word"));
    }

    // ── Staged files pending (write, global-lowest) ──
    if hints.len() < 3 && iclass != IntentClass::Meta {
        let staged = staged_files();
        if let Some((cap, path)) = staged.first() {
            hints.push(Hint::new(format!(
                "{} file(s) staged (first: {}) — `stellario sync --capsule {cap}`",
                staged.len(),
                path.file_name().unwrap_or_default().to_string_lossy()
            )));
        }
    }

    truncate(hints)
}

/// Entry-contextual hints for `stella show`.
pub fn show_hints(_idx: &Index, row: &EntryRow) -> Vec<Hint> {
    let mut hints: Vec<Hint> = Vec::new();
    if is_legacy(row) {
        let cap = &row.source;
        hints.push(Hint::new(format!(
            "legacy entry — consider distilling: write ~/.stellario/staging/{cap}/.stella/{}.stella then `stellario sync --capsule {cap}`",
            row.id.replace(':', "-")
        )));
    }
    if has_walls(row) {
        hints.push(Hint::new(format!("{} carries walls — read them before touching", row.id)));
    }
    if row.kind == Kind::Repo {
        let dir = PathBuf::from(&row.source).join(".stella");
        for cons in crate::constellation::discover(&dir) {
            if cons.slug == row.id {
                if let Some(note) = crate::constellation::side_note(&cons) {
                    hints.push(Hint::new(note));
                }
            }
        }
    }
    truncate(hints)
}

fn truncate(mut hints: Vec<Hint>) -> Vec<Hint> {
    hints.truncate(3);
    hints
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, kind: Kind, tags: &[&str], content: &str) -> EntryRow {
        EntryRow {
            id: id.into(),
            kind,
            form: Form::Embed,
            source: "test".into(),
            span: "t.rs:1-3".into(),
            title: content.into(),
            content: content.into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            keywords: Vec::new(),
        }
    }

    #[test]
    fn intent_classification_grounded() {
        assert_eq!(classify_intent("find where M1 was defined"), IntentClass::Read);
        assert_eq!(classify_intent("understand the design"), IntentClass::Read);
        assert_eq!(classify_intent("查找 设计决策"), IntentClass::Read);
        assert_eq!(classify_intent("verify search works"), IntentClass::Meta);
        assert_eq!(classify_intent("check if rc004 is referenced"), IntentClass::Meta);
        assert_eq!(classify_intent("测试 检索"), IntentClass::Meta);
        assert_eq!(classify_intent("record the decision"), IntentClass::Write);
        assert_eq!(classify_intent("记录 这个决定"), IntentClass::Write);
    }

    #[test]
    fn legacy_and_walls_detection() {
        let legacy = row("vision:01", Kind::Memory, &[], "content");
        assert!(is_legacy(&legacy));
        let native = row("emdash-header-separator", Kind::Memory, &[], "content");
        assert!(!is_legacy(&native));
        let with_walls = row("a-b-c", Kind::Repo, &[], "title\nnot: a lock manager");
        assert!(has_walls(&with_walls));
        let plain = row("a-b-c", Kind::Repo, &[], "title");
        assert!(!has_walls(&plain));
    }

    #[test]
    fn zero_hit_create_gating() {
        let idx_path = std::env::temp_dir().join(format!("hints-zero-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&idx_path);
        let idx = Index::open(&idx_path).unwrap();
        let rows: Vec<EntryRow> = vec![];
        let scored: Vec<(EntryRow, f64)> = vec![];

        // read intent + no id → create suggestion
        let h = query_hints(&idx, &rows, &scored, "user profile", "find user profile", 20);
        assert!(!h.is_empty() && h[0].text.contains("consider a native entry"), "{h:?}");

        // meta intent → silent
        let h = query_hints(&idx, &rows, &scored, "search works", "verify search works", 20);
        assert!(h.is_empty(), "{h:?}");

        // task-id query → silent
        let h = query_hints(&idx, &rows, &scored, "tb441 sensor", "find tb441 task details", 20);
        assert!(h.is_empty(), "{h:?}");
        let _ = std::fs::remove_file(&idx_path);
    }

    #[test]
    fn noise_floor_counts_as_zero_and_meta_silences() {
        let idx_path = std::env::temp_dir().join(format!("hints-floor-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&idx_path);
        let idx = Index::open(&idx_path).unwrap();
        let rows = vec![row("asset:01", Kind::Memory, &[], "content")];
        // semantic noise at score 2 is below the floor → effectively zero
        let scored = vec![(rows[0].clone(), 2.0)];
        let h = query_hints(&idx, &rows, &scored, "zzzznope", "find anything", 20);
        assert!(h[0].text.contains("nothing found"), "{h:?}");
        // meta intent silences even with noise
        let h = query_hints(&idx, &rows, &scored, "zzzznope", "verify search works", 20);
        assert!(h.is_empty(), "{h:?}");
        let _ = std::fs::remove_file(&idx_path);
    }

    #[test]
    fn legacy_hit_suggests_distill() {
        let idx_path = std::env::temp_dir().join(format!("hints-legacy-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&idx_path);
        let idx = Index::open(&idx_path).unwrap();
        let legacy = row("vision:01", Kind::Memory, &["type:vision"], "## title\ncontent");
        let rows = vec![legacy.clone()];
        let scored = vec![(legacy.clone(), 12.0)];
        let h = query_hints(&idx, &rows, &scored, "vision", "find the vision", 20);
        assert!(h[0].text.contains("legacy entry"), "{h:?}");
        assert!(h[0].text.contains("distill"), "{h:?}");
        let _ = std::fs::remove_file(&idx_path);
    }

    #[test]
    fn bounded_at_three() {
        let idx_path = std::env::temp_dir().join(format!("hints-bounded-{}.db", std::process::id()));
        let _ = std::fs::remove_file(&idx_path);
        let idx = Index::open(&idx_path).unwrap();
        let rows = vec![
            row("vision:01", Kind::Memory, &["type:vision"], "## t\ncontent"),
            row("a-b-c", Kind::Memory, &["type:vision"], "## t2\ncontent\nnot: x"),
        ];
        let scored = vec![(rows[0].clone(), 20.0), (rows[1].clone(), 8.0)];
        let h = query_hints(&idx, &rows, &scored, "vision", "find vision", 20);
        assert!(h.len() <= 3, "{h:?}");
        let _ = std::fs::remove_file(&idx_path);
    }

    #[test]
    fn related_by_tag_finds_neighbor() {
        let rows = vec![
            row("a-b-c", Kind::Memory, &["module:iris"], "c"),
            row("d-e-f", Kind::Memory, &["module:iris", "plane:compute"], "c"),
            row("g-h-i", Kind::Memory, &["module:audio"], "c"),
        ];
        let rel = related_by_tag(&rows, &rows[0]).unwrap();
        assert_eq!(rel.id, "d-e-f");
    }
}
