//! cli — the unified tool surface (product decision, 2026-08-02).
//!
//! One binary, five verb classes. Agents learn ONE tool — the loop
//! query → write → sync → show → govern. The stella/stellario split was
//! internal discipline (weight, failure domains); under pre-compiled
//! distribution a single binary is the product surface. `stellario` is an
//! alias entry (argv[0] not inspected — both names behave identically).
//!
//!   stella <query> <intent>   — hybrid search (read)
//!   stella show <id>          — read one entry (read)
//!   stella lint <paths>       — edit-plane discipline (write: auto field)
//!   stella sync [--capsule]   — the write loop, shape-aware (write)
//!   stella doctor / migrate   — governance (check / act)
//!   stella export / list / …  — storage surface (legacy + governance)
//!
//! Failure-domain discipline lives at the COMMAND level, not the binary
//! level: read verbs are pure; write verbs are explicit; destructive
//! actions appear in doctor reports, never in hints.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};

use crate::{AutomergeStorage, SearchParams, Storage, search};

const USAGE_GUIDE: &str = "\
ONE TOOL, FIVE VERB CLASSES

  Read:
    stella \"query\" \"intent\"                    — hybrid search (fzf + semantic)
    stella show <id>                             — read one entry (slug or volume:id)
    stella search \"query\" --capsule NAME         — legacy telescope search

  Write loop (the loop: query → write → sync → show → govern):
    (write <slug>.stella in a .stella/ dir, then:)
    stella sync                                  — shape-aware: self-declared home
    stella sync --capsule NAME                   — staging shape (explicit target)

  Discipline:
    stella lint <paths>                          — edit-plane grammar check

  Governance:
    stella doctor [--level error|warning|info]   — full-system health (read-only)
    stella migrate <ids> --to <capsule>          — relocate entries (auto-create)

  Storage:
    stella export --capsule NAME --out DIR       — capsule → files (legacy-exit)
    stella list / volumes / lineage              — capsule registry + history

  Retired (behind --dangerous): write, expand-new. Authoring happens in
  editors as files. --capsule defaults to the first available.";

#[derive(Parser)]
#[command(
    name = "stella",
    version,
    about = "stellario — one tool: hybrid search, the write loop, and governance",
    after_help = USAGE_GUIDE
)]
struct Cli {
    /// Project capsule to operate on (defaults to first available).
    #[arg(long, global = true)]
    capsule: Option<String>,

    /// Index file (default ~/.stellario/index.db; env STELLA_INDEX overrides).
    #[arg(long, global = true)]
    index: Option<PathBuf>,

    // ── query positionals (the primary verb) ──
    /// Search query.
    query: Option<String>,
    /// Search intent (mandatory — logged as telemetry, routes hints).
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
    /// Include sealed legacy history (excluded by default).
    #[arg(long)]
    sealed: bool,
    /// Max results (default 20).
    #[arg(long)]
    limit: Option<usize>,

    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Show one entry by id (slug for native, volume:id for legacy).
    ///
    /// Renders what the index holds and points at the authority: file span
    /// for repo embeds, capsule + lineage for natives and legacy.
    Show { id: String },

    /// Lint <stellario> entry blocks in .rs/.md/.stella files.
    ///
    /// No --fix: violations come with repair suggestions; lint never
    /// rewrites human content. The lint-owned `auto` field is the only
    /// exception (written with a printed notice).
    Lint {
        /// Files or directories to scan (directories are walked recursively).
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },

    /// The write loop: shape-aware sync.
    ///
    /// No flags: a directory with .stellario + .stella/ syncs automatically
    /// (self-declared home). A directory with only .stellario/.stella/ is
    /// the staging shape — pass --capsule (default: the scratch inbox,
    /// auto-created). --repo <paths> harvests explicitly.
    Sync {
        #[arg(long)]
        repo: Vec<PathBuf>,
        #[arg(long)]
        reindex_memory: bool,
        /// Print the constellation hygiene report for the repo's .stella/ dir.
        #[arg(long)]
        status: bool,
    },

    /// Governance check: full-system health with graded findings
    /// (error/warning/info) and executable actions. Read-only.
    Doctor {
        /// Minimum level to show (error|warning|info).
        #[arg(long, default_value = "info")]
        level: String,
    },

    /// Governance act: migrate entries to a target capsule (auto-created).
    /// Source entries are tombstoned with intent; provenance stays in lineage.
    Migrate {
        /// Entry ids (volume:id or slug), e.g. whiteboard:99.
        #[arg(required = true)]
        ids: Vec<String>,
        /// Target capsule (auto-created if missing).
        #[arg(long)]
        to: String,
        /// Source capsule (default: resolve each id across all capsules).
        #[arg(long)]
        from: Option<String>,
    },

    /// Export the capsule to files (legacy-exit primitive): read-only dump
    /// of every entry as <out>/<volume>/<id>.md + manifest.jsonl.
    Export {
        /// Output directory (created if missing).
        #[arg(long)]
        out: PathBuf,
    },

    /// List available project capsules.
    List,
    /// Search entries (fzf + semantic) — legacy telescope surface.
    Search {
        query: String,
        #[arg(long)]
        volumes: Option<String>,
        #[arg(long, value_delimiter = ',')]
        tags: Vec<String>,
        #[arg(long)]
        limit: Option<usize>,
        #[arg(long)]
        no_semantic: bool,
    },
    /// List volumes in a capsule.
    Volumes,
    /// View the version+intent timeline of an entry.
    Lineage { id: String },
}

// ─── capsule registry helpers ───────────────────────────────────────────────

/// Create a capsule on first use — a sync side effect, not a create
/// ceremony. The capsule emerges from sync targeting it.
fn ensure_capsule(name: &str) -> Result<PathBuf> {
    if let Some(p) = project_capsule_path(name) {
        return Ok(p);
    }
    let device = std::process::Command::new("hostname")
        .output()
        .ok()
        .filter(|o| o.status.success())
        .map(|o| String::from_utf8_lossy(&o.stdout).trim().to_string())
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "local".into());
    let dir = stellario_root().join("projects").join(name).join(device);
    std::fs::create_dir_all(&dir)?;
    let mut storage = AutomergeStorage::new();
    let bytes = storage.save()?;
    let path = dir.join("capsule.automerge");
    std::fs::write(&path, &bytes)?;
    println!("capsule created: {} ({})", name, path.display());
    Ok(path)
}

fn stellario_root() -> PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    PathBuf::from(home).join(".stellario")
}

fn project_capsule_path(name: &str) -> Option<PathBuf> {
    let projects = stellario_root().join("projects").join(name);
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let cap = entry.path().join("capsule.automerge");
            if cap.exists() {
                return Some(cap);
            }
        }
    }
    None
}

fn discover_capsules() -> Vec<String> {
    let projects = stellario_root().join("projects");
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if project_capsule_path(&entry.file_name().to_string_lossy()).is_some() {
                    names.push(entry.file_name().to_string_lossy().to_string());
                }
            }
        }
    }
    names.sort();
    names
}

fn load_capsule(name: Option<&str>) -> Result<(String, AutomergeStorage)> {
    let capsules = discover_capsules();
    let name = match name {
        Some(n) => n.to_string(),
        None => capsules
            .first()
            .ok_or_else(|| anyhow!("no capsules found"))?
            .clone(),
    };
    let path = project_capsule_path(&name)
        .ok_or_else(|| anyhow!("capsule '{}' not found", name))?;
    let bytes = std::fs::read(&path).with_context(|| format!("reading {}", path.display()))?;
    let storage = AutomergeStorage::load(&bytes)?;
    Ok((name, storage))
}

fn parse_id(id: &str) -> Result<(String, String)> {
    let (vol, n) = id
        .split_once(':')
        .ok_or_else(|| anyhow!("id must be volume:n format, e.g. meta:63"))?;
    Ok((vol.to_string(), n.to_string()))
}

fn extract_title(content: &str) -> String {
    for line in content.lines() {
        let t = line.trim();
        if let Some(r) = t.strip_prefix("## ") {
            return r.trim().to_string();
        }
    }
    content.lines().next().unwrap_or("").chars().take(60).collect()
}

fn index_path(cli: &Cli) -> PathBuf {
    if let Some(p) = &cli.index {
        return p.clone();
    }
    if let Ok(p) = std::env::var("STELLA_INDEX") {
        return PathBuf::from(p);
    }
    crate::index::default_path()
}

fn resolve_capsule_name(cli: &Cli) -> String {
    cli.capsule.clone().unwrap_or_else(|| {
        discover_capsules().first().cloned().unwrap_or_default()
    })
}

// ─── sync helpers ───────────────────────────────────────────────────────────

/// Harvest <stellario> blocks from repo paths into the index (embeds +
/// natives). Read-only on the repo; scoped replacement per scanned path.
fn harvest_to_index(repo_paths: &[PathBuf], index_path: &Path) -> Result<()> {
    let (entries, root) = crate::harvest::harvest(repo_paths)?;
    let index = crate::index::Index::open(index_path)?;

    let all_kw: Vec<String> = entries.iter().flat_map(|e| e.keywords.clone()).collect();
    let vecs = crate::telescope::embed_texts(&all_kw);
    let mut kw_iter = all_kw.iter();
    let mut vec_iter = vecs.as_ref().map(|v| v.iter());

    let mut shaped = Vec::new();
    for e in &entries {
        let n = e.keywords.len();
        let kws: Vec<String> = kw_iter.by_ref().take(n).cloned().collect();
        let ev: Vec<(String, Vec<f32>)> = match &mut vec_iter {
            Some(vi) => kws.into_iter().zip(vi.by_ref().take(n).cloned()).collect(),
            None => Vec::new(),
        };
        // Content = tldr + bound prose + walls — what fzf scores.
        let mut content = e.title.clone();
        if !e.description.is_empty() {
            content.push('\n');
            content.push_str(&e.description);
        }
        if !e.walls.is_empty() {
            content.push('\n');
            content.push_str(&e.walls.join("\n"));
        }
        shaped.push((
            crate::index::IndexEntry {
                id: e.id.clone(),
                title: e.title.clone(),
                content,
                tags: e.tags.clone(),
                keywords: e.keywords.clone(),
                span: e.span.clone(),
                form: e.form,
            },
            ev,
        ));
    }
    let source = root.display().to_string();
    let prefixes: Vec<String> = repo_paths
        .iter()
        .map(|p| {
            let canon = p.canonicalize().unwrap_or_else(|_| p.clone());
            canon
                .strip_prefix(&root)
                .map(|r| r.display().to_string())
                .unwrap_or_else(|_| p.display().to_string())
        })
        .collect();
    let n = index.replace_repo_scoped(&source, &prefixes, &shaped)?;
    println!("repo harvest: {} entries from {} -> index {}", n, source, index_path.display());
    if vecs.is_none() {
        println!("note: embeddings unavailable — semantic signal skipped (fzf still works)");
    }
    Ok(())
}

/// Mirror .stella natives from a repo's creation surface into the capsule(s)
/// its `.stellario` config declares (self-declared home).
fn mirror_declared(repo_paths: &[PathBuf], index_path: &Path) -> Result<()> {
    for p in repo_paths {
        let Some((dir, cfg)) = crate::config::discover(p) else { continue };
        let creation = dir.join(&cfg.creation_dir);
        if !creation.is_dir() {
            continue;
        }
        if cfg.capsules.is_empty() {
            eprintln!("  [sync] {} declares .stellario but no capsules — nothing to mirror", dir.display());
            continue;
        }
        for cap in &cfg.capsules {
            let path = ensure_capsule(cap)?;
            let bytes = std::fs::read(&path)?;
            let mut storage = AutomergeStorage::load(&bytes)?;
            let synced = crate::harvest::mirror_natives_to_capsule(&mut storage, &creation, "stellario")?;
            if !synced.is_empty() {
                let new_bytes = storage.save()?;
                std::fs::write(&path, &new_bytes)?;
                println!("mirror: {} natives from {} -> capsule '{}'", synced.len(), creation.display(), cap);
                let index = crate::index::Index::open(index_path)?;
                let n = crate::index::ingest_memory(&index, cap, &storage, &|texts| {
                    crate::telescope::embed_texts(texts)
                })?;
                println!("memory reindex: {} entries from capsule '{}' -> index", n, cap);
            } else {
                println!("mirror: nothing new in {}", creation.display());
            }
        }
    }
    Ok(())
}

// ─── query / show (the read verbs) ─────────────────────────────────────────

/// fzf text signal: id exact ×10 > slug segment ×6 = tag ×6 > keyword ×5 >
/// content ×3. Per-term, summed.
fn fzf_score(row: &crate::index::EntryRow, terms: &[&str]) -> f64 {
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

fn run_query(cli: &Cli, query: &str, intent: &str, kind: Option<crate::index::Kind>, limit: usize, include_stars: bool, include_sealed: bool) -> Result<()> {
    let index_path = index_path(cli);
    let idx = crate::index::Index::open(&index_path)?;

    // One row per slug — but only for mirror pairs (repo/native mirrored into
    // a memory/native row). repo/embed rows are file truth at a DIFFERENT
    // residence: a slug may legitimately be both an inline embed and a
    // capsule native — both rows survive.
    let mut by_id: std::collections::HashMap<String, Vec<crate::index::EntryRow>> =
        std::collections::HashMap::new();
    for row in idx.entries(kind)? {
        if !include_stars && row.form == crate::parse::Form::Star {
            continue;
        }
        by_id.entry(row.id.clone()).or_default().push(row);
    }
    let mut rows: Vec<crate::index::EntryRow> = Vec::new();
    for (_, group) in by_id {
        let has_memory_native = group
            .iter()
            .any(|r| r.kind == crate::index::Kind::Memory && r.form == crate::parse::Form::Native);
        for row in group {
            let is_repo_native_twin = row.kind == crate::index::Kind::Repo
                && row.form == crate::parse::Form::Native
                && has_memory_native;
            if !is_repo_native_twin {
                rows.push(row);
            }
        }
    }

    let terms: Vec<&str> = query.split_whitespace().collect();
    let mut scored: std::collections::HashMap<String, (crate::index::EntryRow, f64)> =
        std::collections::HashMap::new();

    for row in &rows {
        let s = fzf_score(row, &terms);
        if s > 0.0 {
            scored.insert(row.id.clone(), (row.clone(), s));
        }
    }

    // Semantic signal (optional — degrades gracefully to fzf-only).
    if let Some(vecs) = crate::telescope::embed_texts(&[query.to_string()]) {
        if let Some(qv) = vecs.first() {
            let knn = idx.knn(qv, limit * 4, kind, include_stars).unwrap_or_default();
            for (id, _kw, cosine) in knn {
                let fused = cosine * 10.0 * 0.5;
                match scored.get_mut(&id) {
                    Some((_, s)) => *s += fused,
                    None => {
                        let want = if let Some(k) = kind {
                            vec![k]
                        } else {
                            vec![crate::index::Kind::Repo, crate::index::Kind::Memory]
                        };
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

    let mut hits: Vec<(crate::index::EntryRow, f64)> = scored.into_values().collect();
    hits.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));
    hits.truncate(limit);

    // The guide layer: hints at the top (max 3, read-first, pure reads).
    let hints = crate::hints::query_hints(&idx, &rows, &hits, query, intent, limit);
    if !hints.is_empty() {
        println!("Hints");
        for h in &hints {
            println!("  · {}", h.text);
        }
        println!("  {}", "-".repeat(28));
    }

    crate::index::log_intent(&index_path, intent, query, match kind {
        Some(crate::index::Kind::Repo) => "repo",
        Some(crate::index::Kind::Memory) => "memory",
        None => "repo+memory",
    }, hits.len());

    if hits.is_empty() {
        println!("No matching entries found.");
        return Ok(());
    }
    for (row, score) in &hits {
        println!("[{}] {}/{} {:.0} — {}", row.id, row.kind.as_str(), row.form.as_str(), score, row.title);
        println!("    {}", row.span);
    }

    // In-path constellation hygiene: side notes for repo-kind hits.
    let mut noted: std::collections::HashSet<String> = std::collections::HashSet::new();
    for (row, _) in &hits {
        if row.kind != crate::index::Kind::Repo || !noted.insert(row.id.clone()) {
            continue;
        }
        let dir = PathBuf::from(&row.source).join(".stella");
        for cons in crate::constellation::discover(&dir) {
            if cons.slug == row.id {
                if let Some(note) = crate::constellation::side_note(&cons) {
                    println!("  {note}");
                }
            }
        }
    }
    Ok(())
}

fn run_show(cli: &Cli, id: &str) -> Result<()> {
    let index_path = index_path(cli);
    let idx = crate::index::Index::open(&index_path)?;
    let all = idx.entries(None)?;

    let exact: Vec<&crate::index::EntryRow> = all.iter().filter(|r| r.id == id).collect();
    if exact.is_empty() {
        let candidates: Vec<&crate::index::EntryRow> = all.iter().filter(|r| r.id.contains(id)).take(5).collect();
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

    let hints = crate::hints::show_hints(&idx, exact[0]);
    if !hints.is_empty() {
        println!("Hints");
        for h in &hints {
            println!("  · {}", h.text);
        }
        println!("  {}", "-".repeat(28));
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
            crate::index::Kind::Repo if row.form == crate::parse::Form::Embed => {
                let file = row.span.split(':').next().unwrap_or("");
                println!("  → authority: {file} — inline truth, bound to the code; the index is a copy");
            }
            crate::index::Kind::Repo => {
                let memory_ids: Vec<String> = idx
                    .entries(Some(crate::index::Kind::Memory))?
                    .into_iter()
                    .map(|r| r.id)
                    .collect();
                if memory_ids.iter().any(|m| m == &row.id) {
                    println!("  → authority: capsule (synced) — `stella lineage {} --capsule {}` for history", row.id, row.source);
                } else {
                    let file = row.span.split(':').next().unwrap_or(&row.span);
                    println!("  → authority: {file} (pre-sync — not yet mirrored into a capsule)");
                }
            }
            crate::index::Kind::Memory => {
                println!("  → authority: capsule '{}' — `stella lineage {} --capsule {}` for history",
                    row.source, row.id, row.source);
            }
        }
    }
    Ok(())
}

// ─── entry point ───────────────────────────────────────────────────────────

pub fn run() -> Result<()> {
    // CLI convention: die silently on closed pipes instead of panicking
    // (`stella ... | head` must exit 0-ish, not abort with a panic).
    unsafe {
        libc::signal(libc::SIGPIPE, libc::SIG_DFL);
    }
    let cli = Cli::parse();

    match &cli.cmd {
        Some(Cmd::Show { id }) => run_show(&cli, id),
        Some(Cmd::Lint { paths }) => {
            let report = crate::lint::run(paths)?;
            crate::lint::print_report(&report);
            if report.error_count() > 0 {
                std::process::exit(1);
            }
            Ok(())
        }
        Some(Cmd::List) => {
            for name in discover_capsules() {
                println!("{}", name);
            }
            Ok(())
        }
        Some(Cmd::Volumes) => {
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            for vol in storage.volume_names()? {
                let count = storage.list(&vol)?.len();
                println!("{:<16} {} entries", vol, count);
            }
            Ok(())
        }
        Some(Cmd::Search { query, volumes, tags, limit, no_semantic }) => {
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            let params = SearchParams {
                query: Some(query.clone()),
                volumes: volumes.as_ref().map(|s| s.split(',').map(String::from).collect()),
                tags: tags.clone(),
                tags_any: vec![],
                tags_not: vec![],
                limit: *limit,
                no_semantic: *no_semantic,
            };
            let hits = search(&storage, &params)?;
            if hits.is_empty() {
                println!("No matches.");
            }
            for h in hits {
                println!("{:>5}  {}  {}", (h.score * 10.0).round() / 10.0, h.entry.id, extract_title(&h.entry.content));
            }
            Ok(())
        }
        Some(Cmd::Lineage { id }) => {
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            let (vol, n) = parse_id(id)?;
            let steps = storage.lineage(&vol, &n)?;
            if steps.is_empty() {
                bail!("{} not found", id);
            }
            for (i, s) in steps.iter().enumerate() {
                let status = if s.version.superseded { " (superseded)" } else { "" };
                println!("v{}  {}{}  author={}", i, s.version.hash, status, s.version.author);
                println!("     intent: {}", s.intent);
                println!("     created: {}", s.version.created);
            }
            Ok(())
        }
        Some(Cmd::Sync { repo, reindex_memory, status }) => {
            if *status {
                let cwd = std::env::current_dir()?;
                let root = {
                    let out = std::process::Command::new("git")
                        .args(["rev-parse", "--show-toplevel"])
                        .current_dir(&cwd)
                        .output()?;
                    if out.status.success() {
                        PathBuf::from(String::from_utf8_lossy(&out.stdout).trim().to_string())
                    } else {
                        cwd
                    }
                };
                let cons = crate::constellation::discover(&root.join(".stella"));
                print!("{}", crate::constellation::format_report(&cons));
                return Ok(());
            }
            let index_path = index_path(&cli);

            if !repo.is_empty() {
                harvest_to_index(repo, &index_path)?;
                mirror_declared(repo, &index_path)?;
                return Ok(());
            }
            if *reindex_memory {
                let capsule_name = resolve_capsule_name(&cli);
                let (_, storage) = load_capsule(Some(&capsule_name))?;
                let index = crate::index::Index::open(&index_path)?;
                let n = crate::index::ingest_memory(&index, &capsule_name, &storage, &|texts| {
                    crate::telescope::embed_texts(texts)
                })?;
                println!("memory reindex: {} entries from capsule '{}' -> index {}", n, capsule_name, index_path.display());
                return Ok(());
            }

            // ── shape-aware sync (no flags): the directory declares its own
            //    semantics by its file layout. Runtime gated. ──
            if *reindex_memory {
                return Ok(());
            }
            let cwd = std::env::current_dir()?;
            if let Some((dir, cfg)) = crate::config::discover(&cwd) {
                harvest_to_index(&[dir.clone()], &index_path)?;
                mirror_declared(&[dir.clone()], &index_path)?;
                let _ = cfg;
                return Ok(());
            }
            if crate::config::is_staging_shape(&cwd) {
                let cap = cli.capsule.clone().unwrap_or_else(|| "scratch".into());
                let path = ensure_capsule(&cap)?;
                let bytes = std::fs::read(&path)?;
                let mut storage = AutomergeStorage::load(&bytes)?;
                let creation = cwd.join(crate::config::DEFAULT_CREATION_DIR);
                let synced = crate::harvest::mirror_natives_to_capsule(&mut storage, &creation, "stellario")?;
                if !synced.is_empty() {
                    let new_bytes = storage.save()?;
                    std::fs::write(&path, &new_bytes)?;
                    println!("mirror: {} natives from {} -> capsule '{}'", synced.len(), creation.display(), cap);
                    let index = crate::index::Index::open(&index_path)?;
                    let n = crate::index::ingest_memory(&index, &cap, &storage, &|texts| {
                        crate::telescope::embed_texts(texts)
                    })?;
                    println!("memory reindex: {} entries from capsule '{}' -> index", n, cap);
                } else {
                    println!("mirror: nothing new in {}", creation.display());
                }
                return Ok(());
            }
            eprintln!("no stellario shape here (no .stellario config, no .stella/ directory).");
            eprintln!("  repo-bound:   add a .stellario declaring your capsule, then re-run");
            eprintln!("  staging:      add .stella/ and pass --capsule <name>");
            Ok(())
        }
        Some(Cmd::Export { out }) => {
            let capsule_name = resolve_capsule_name(&cli);
            let (name, storage) = load_capsule(Some(&capsule_name))?;
            let stats = crate::export::export_capsule(&storage, out)?;
            println!(
                "exported capsule '{}': {} volumes, {} entries, {} bytes -> {}",
                name, stats.volumes, stats.entries, stats.bytes, out.display()
            );
            Ok(())
        }
        Some(Cmd::Doctor { level }) => {
            let min = match level.as_str() {
                "error" => crate::govern::Level::Error,
                "warning" => crate::govern::Level::Warning,
                _ => crate::govern::Level::Info,
            };
            let index_path = index_path(&cli);
            let index = crate::index::Index::open(&index_path)?;
            let mut registry = Vec::new();
            for name in discover_capsules() {
                let Ok((_, storage)) = load_capsule(Some(&name)) else { continue };
                registry.push((name, storage));
            }
            let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
            let staging = PathBuf::from(home).join(".stellario/staging");
            let findings = crate::govern::doctor(&registry, &index, &staging, min);
            print!("{}", crate::govern::format_report(&findings));
            if findings.iter().any(|f| f.level == crate::govern::Level::Error) {
                std::process::exit(1);
            }
            Ok(())
        }
        Some(Cmd::Migrate { ids, to, from }) => {
            let index_path = index_path(&cli);
            let to_path = ensure_capsule(to)?;
            let to_bytes = std::fs::read(&to_path)?;
            let mut to_storage = AutomergeStorage::load(&to_bytes)?;

            let mut done = Vec::new();
            for id in ids {
                let (from_name, mut from_storage) = match from {
                    Some(f) => {
                        let p = project_capsule_path(f)
                            .ok_or_else(|| anyhow!("capsule '{}' not found", f))?;
                        let bytes = std::fs::read(&p)?;
                        (f.clone(), AutomergeStorage::load(&bytes)?)
                    }
                    None => {
                        let mut found = None;
                        for name in discover_capsules() {
                            if let Ok((_, storage)) = load_capsule(Some(&name)) {
                                let (vol, n) = match id.split_once(':') {
                                    Some((v, n)) => (v.to_string(), n.to_string()),
                                    None => (crate::harvest::NATIVE_VOLUME.to_string(), id.clone()),
                                };
                                if storage.materialize(&vol, &n)?.is_some() {
                                    found = Some((name, storage));
                                    break;
                                }
                            }
                        }
                        found.ok_or_else(|| anyhow!("{id}: not found in any capsule"))?
                    }
                };
                let migrated = crate::govern::migrate(
                    &mut from_storage, &mut to_storage, &[id.as_str()], &from_name, to, "stellario",
                )?;
                if !migrated.is_empty() {
                    let p = project_capsule_path(&from_name)
                        .ok_or_else(|| anyhow!("capsule '{}' not found", from_name))?;
                    std::fs::write(&p, from_storage.save()?)?;
                }
                done.extend(migrated);
            }
            std::fs::write(&to_path, to_storage.save()?)?;

            let index = crate::index::Index::open(&index_path)?;
            for cap in [to, from.as_deref().unwrap_or("")] {
                if cap.is_empty() {
                    continue;
                }
                if let Ok((_, storage)) = load_capsule(Some(cap)) {
                    let n = crate::index::ingest_memory(&index, cap, &storage, &|texts| {
                        crate::telescope::embed_texts(texts)
                    })?;
                    println!("memory reindex: {} entries from capsule '{}'", n, cap);
                }
            }
            println!("migrated: {}", done.join(", "));
            Ok(())
        }
        None => match (&cli.query, &cli.intent) {
            (Some(q), Some(i)) => {
                let kind = match (cli.repo, cli.memory) {
                    (true, false) => Some(crate::index::Kind::Repo),
                    (false, true) => Some(crate::index::Kind::Memory),
                    _ => None,
                };
                run_query(&cli, q, i, kind, cli.limit.unwrap_or(20), cli.stars, cli.sealed)
            }
            (Some(_), None) => {
                eprintln!("intent is mandatory: stella <query> <intent> [--repo] [--memory]");
                eprintln!("every query is a telemetry point — say what you are trying to do.");
                std::process::exit(2);
            }
            _ => {
                eprintln!("usage: stella <query> <intent> [--repo] [--memory]");
                eprintln!("       stella show <id> | lint <paths> | sync | doctor | migrate …");
                std::process::exit(2);
            }
        },
    }
}
