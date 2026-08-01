//! stella — the lightweight stellario CLI.
//!
//! Two APIs:
//!   stella <query> <intent> [--repo] [--memory]   unified hybrid search
//!   stella lint <path>...                          stellario-entry grammar checker
//!
//! Query is the primary entry (positionals); `lint` is a reserved first word.
//! Intent is mandatory — every query is a telemetry point (intent-log.jsonl).
//!
//! Scoring (mirrors telescope semantics):
//!   fzf      id exact ×10, slug-segment ×6, tag ×6, keyword ×5, content ×3
//!   semantic cosine over keyword-anchor vectors (never content), ×10 × 0.5
//! fzf is primary; semantic rescues conceptually related entries.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

use stellario::index::{self, EntryRow, Index, Kind};
use stellario::parse::Form;
use stellario::telescope::embed_texts;

#[derive(Parser)]
#[command(name = "stella", version, about = "stellario — unified query + lint")]
struct Cli {
    /// Search query.
    query: Option<String>,
    /// Search intent (mandatory — logged as telemetry).
    intent: Option<String>,
    /// Search repo (comment/doc) entries only.
    #[arg(long)]
    repo: bool,
    /// Search memory (capsule) entries only.
    #[arg(long)]
    memory: bool,
    /// Include star drafts (excluded by default).
    #[arg(long)]
    stars: bool,
    /// Index file (default ~/.stellario/index.db; env STELLA_INDEX overrides).
    #[arg(long, global = true)]
    index: Option<PathBuf>,
    /// Max results (default 20).
    #[arg(long, global = true)]
    limit: Option<usize>,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Lint <stellario> entry blocks in .rs/.md files.
    ///
    /// No --fix: violations come with repair suggestions; lint never
    /// rewrites human content. The lint-owned `auto` field is the only
    /// exception (written with a printed notice).
    Lint {
        /// Files or directories to scan (directories are walked recursively).
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
    /// Show one entry by id (slug for repo, volume:id for memory).
    ///
    /// Renders what the index holds and points at the authority: the file
    /// span for repo entries, the capsule for memory entries.
    Show {
        /// Entry id. Exact match first; falls back to substring candidates.
        id: String,
    },
}

fn index_path(cli: &Cli) -> PathBuf {
    if let Some(p) = &cli.index {
        return p.clone();
    }
    if let Ok(p) = std::env::var("STELLA_INDEX") {
        return PathBuf::from(p);
    }
    index::default_path()
}

/// fzf text signal: id exact ×10 > slug segment ×6 = tag ×6 > keyword ×5 >
/// content ×3. Per-term, summed.
fn fzf_score(row: &EntryRow, terms: &[&str]) -> f64 {
    let id = row.id.to_lowercase();
    let segments: Vec<&str> = id.split('-').collect();
    let tags: Vec<String> = row.tags.iter().map(|t| t.to_lowercase()).collect();
    let kws: Vec<String> = row.keywords.iter().map(|k| k.to_lowercase()).collect();
    let content = row.content.to_lowercase();
    let title = row.title.to_lowercase();

    let mut total = 0.0;
    for term in terms {
        let t = term.to_lowercase();
        let mut s = 0.0;
        if id == t {
            s += 10.0;
        } else if segments.iter().any(|seg| *seg == t) {
            s += 6.0;
        }
        if tags.iter().any(|tag| tag.contains(&t)) {
            s += 6.0;
        }
        if kws.iter().any(|kw| kw.contains(&t)) {
            s += 5.0;
        }
        if content.contains(&t) || title.contains(&t) {
            s += 3.0;
        }
        total += s;
    }
    total
}

fn run_query(index_path: &PathBuf, query: &str, intent: &str, kind: Option<Kind>, limit: usize, include_stars: bool) -> Result<()> {
    let idx = Index::open(index_path)?;
    let rows: Vec<EntryRow> = idx
        .entries(kind)?
        .into_iter()
        .filter(|r| include_stars || r.form != Form::Star)
        .collect();

    let terms: Vec<&str> = query.split_whitespace().collect();
    let mut scored: std::collections::HashMap<String, (EntryRow, f64)> = std::collections::HashMap::new();

    for row in rows {
        let s = fzf_score(&row, &terms);
        if s > 0.0 {
            scored.insert(row.id.clone(), (row, s));
        }
    }

    // Semantic signal (optional — degrades gracefully to fzf-only).
    if let Some(vecs) = embed_texts(&[query.to_string()]) {
        if let Some(qv) = vecs.first() {
            let knn = idx.knn(qv, limit * 4, kind, include_stars).unwrap_or_default();
            for (id, _kw, cosine) in knn {
                let fused = cosine * 10.0 * 0.5;
                match scored.get_mut(&id) {
                    Some((_, s)) => *s += fused,
                    None => {
                        // Rescue: semantic-only hit — look the row back up.
                        let want = if let Some(k) = kind { vec![k] } else { vec![Kind::Repo, Kind::Memory] };
                        for k in want {
                            if let Some(row) = idx.entries(Some(k))?.into_iter().find(|r| r.id == id) {
                                scored.insert(id.clone(), (row, fused));
                                break;
                            }
                        }
                    }
                }
            }
        }
    }

    let mut hits: Vec<(EntryRow, f64)> = scored.into_values().collect();
    hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);

    index::log_intent(index_path, intent, query, match kind {
        Some(Kind::Repo) => "repo",
        Some(Kind::Memory) => "memory",
        None => "repo+memory",
    }, hits.len());

    if hits.is_empty() {
        println!("No matching entries found.");
        return Ok(());
    }
    for (row, score) in hits {
        let loc = match row.kind {
            Kind::Repo => row.span.clone(),
            Kind::Memory => row.span.clone(),
        };
        println!("[{}] {}/{} {:.0} — {}", row.id, row.kind.as_str(), row.form.as_str(), score, row.title);
        println!("    {loc}");
    }
    Ok(())
}

fn run_show(index_path: &PathBuf, id: &str) -> Result<()> {
    let idx = Index::open(index_path)?;
    let all = idx.entries(None)?;

    // Exact match first; then substring candidates (slugs are long, fingers are lazy).
    let exact: Vec<&EntryRow> = all.iter().filter(|r| r.id == id).collect();
    if exact.is_empty() {
        let candidates: Vec<&EntryRow> = all.iter().filter(|r| r.id.contains(id)).take(5).collect();
        if candidates.is_empty() {
            println!("no entry with id {id:?}");
        } else {
            println!("no exact match for {id:?}. candidates:");
            for c in candidates {
                println!("  [{}] {} — {}", c.id, c.kind.as_str(), c.title);
            }
        }
        return Ok(());
    }

    for row in exact {
        println!("[{}] {}/{}", row.id, row.kind.as_str(), row.form.as_str());
        println!("  source:   {}", row.source);
        println!("  span:     {}", row.span);
        println!("  tags:     {}", row.tags.join(", "));
        println!("  keywords: {}", row.keywords.join(", "));
        println!();
        for line in row.content.lines() {
            println!("  {line}");
        }
        println!();
        match row.kind {
            Kind::Repo => {
                let file = row.span.split(':').next().unwrap_or("");
                println!("  → authority: {file} (the block binds the prose beside it; the index is a copy, the file is the truth)");
            }
            Kind::Memory => {
                println!("  → authority: capsule '{}' — `stellario show {} --capsule {}` for raw, `stellario lineage {} --capsule {}` for history",
                    row.source, row.id, row.source, row.id, row.source);
            }
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let idx_path = index_path(&cli);
    match cli.cmd {
        Some(Cmd::Lint { paths }) => {
            let report = stellario::lint::run(&paths)?;
            stellario::lint::print_report(&report);
            if report.error_count() > 0 {
                std::process::exit(1);
            }
            Ok(())
        }
        Some(Cmd::Show { id }) => run_show(&idx_path, &id),
        None => match (&cli.query, &cli.intent) {
            (Some(q), Some(i)) => {
                let kind = match (cli.repo, cli.memory) {
                    (true, false) => Some(Kind::Repo),
                    (false, true) => Some(Kind::Memory),
                    _ => None,
                };
                run_query(&idx_path, q, i, kind, cli.limit.unwrap_or(20), cli.stars)
            }
            (Some(_), None) => {
                eprintln!("intent is mandatory: stella <query> <intent> [--repo] [--memory]");
                eprintln!("every query is a telemetry point — say what you are trying to do.");
                std::process::exit(2);
            }
            _ => {
                eprintln!("usage: stella <query> <intent> [--repo] [--memory]");
                eprintln!("       stella lint <path>...");
                std::process::exit(2);
            }
        },
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn row(id: &str, tags: &[&str], kws: &[&str], content: &str) -> EntryRow {
        EntryRow {
            id: id.into(),
            kind: Kind::Repo,
            form: Form::Embed,
            source: "test".into(),
            span: "t.rs:1-3".into(),
            title: content.into(),
            content: content.into(),
            tags: tags.iter().map(|s| s.to_string()).collect(),
            keywords: kws.iter().map(|s| s.to_string()).collect(),
        }
    }

    #[test]
    fn slug_exact_beats_segment_beats_nothing() {
        let r = row("continuity-not-roundtrip-criterion", &[], &[], "");
        let exact = fzf_score(&r, &["continuity-not-roundtrip-criterion"]);
        let segment = fzf_score(&r, &["roundtrip"]);
        let miss = fzf_score(&r, &["zebra"]);
        assert_eq!(exact, 10.0);
        assert_eq!(segment, 6.0);
        assert_eq!(miss, 0.0);
    }

    #[test]
    fn tag_keyword_content_weights() {
        let r = row("a-b-c", &["module:iris"], &["metamerism"], "about judging constructors");
        let s = fzf_score(&r, &["iris", "metamerism", "judging"]);
        assert_eq!(s, 6.0 + 5.0 + 3.0);
    }
}
