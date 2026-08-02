//! stellario — CLI access to the memory engine.
//!
//! A thin shell over the same engine lib that the MCP server uses. For agents
//! or humans that prefer command-line access over MCP.
//!
//!   stellario list                              — list available capsules
//!   stellario search <query> [--capsule NAME]   — telescope hybrid search
//!   stellario show <volume:id> [--capsule NAME] — read an entry
//!   stellario write -v VOL -c CONTENT -i INTENT [-capsule NAME] [-a AUTHOR]
//!                                                  — write with intent
//!   stellario lineage <volume:id> [--capsule NAME] — version+intent timeline
//!
//! `--capsule` defaults to the first available project capsule.

use std::path::{Path, PathBuf};

use anyhow::{anyhow, bail, Context, Result};
use clap::{Parser, Subcommand};

use stellario::{AutomergeStorage, Edge, EdgeKind, SearchParams, Storage, Workdir, search};

const USAGE_GUIDE: &str = "\
USAGE GUIDE

  Reading:
    stellario list                                — discover capsules
    stellario volumes --capsule NAME              — see volumes + counts
    stellario search \"query\" --capsule NAME       — fzf + semantic search
    stellario show meta:03 --capsule NAME         — read an entry
    stellario lineage meta:03 --capsule NAME      — how it evolved (intent per version)

  Writing (file-based editing — recommended):
    stellario expand meta:03 --capsule NAME       — writes /tmp/.../meta:03.md
    (edit the .md file with your editor or Edit tool)
    stellario sync --capsule NAME --author ID     — ingest edits, cleans up .md
    (sync auto-runs before every expand, so you rarely call it manually)

  Writing (direct — for scripts/short content):
    stellario write -v meta -c \"## Title\" -i \"why\" -a \"name:agent#hash\"

  --capsule defaults to the first available. --author is name:name#instance.";

#[derive(Parser)]
#[command(
    name = "stellario",
    about = "Memory engine — version-graph storage with telescope hybrid search",
    after_help = USAGE_GUIDE
)]
struct Cli {
    /// Project capsule to operate on (defaults to first available).
    #[arg(long, global = true)]
    capsule: Option<String>,

    #[command(subcommand)]
    cmd: Cmd,
}

#[derive(Subcommand)]
enum Cmd {
    /// List available project capsules.
    List,
    /// Search entries (fzf + semantic).
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
    /// Read an entry by volume:id (e.g. meta:63).
    Show { id: String },
    /// Write an entry. Requires intent.
    ///
    /// RETIRED (constellation model §4): authoring happens in editors as
    /// files, not via API. Kept behind --dangerous for the transition.
    Write {
        #[arg(short = 'v', long)]
        volume: String,
        #[arg(short = 'c', long)]
        content: String,
        #[arg(short = 'i', long)]
        intent: String,
        #[arg(long, value_delimiter = ',')]
        tags: Vec<String>,
        #[arg(long, value_delimiter = ',')]
        keywords: Vec<String>,
        /// Author identity (e.g. name:edelweiss#abcd). Required.
        #[arg(short = 'a', long)]
        author: String,
        /// Revise an existing entry by id (e.g. "63").
        #[arg(long)]
        target_id: Option<String>,
        /// Acknowledge create is retired and use it anyway.
        #[arg(long)]
        dangerous: bool,
    },
    /// View the version+intent timeline of an entry.
    Lineage { id: String },
    /// List volumes in a capsule.
    Volumes,
    /// Expand an entry to an editable .md file. Edit the file, then sync.
    Expand {
        /// Entry id (volume:n, e.g. meta:03).
        id: String,
    },
    /// Create a blank .md template for a new entry.
    ///
    /// RETIRED (constellation model §4): write a <slug>.stella file instead.
    ExpandNew {
        /// Volume for the new entry.
        volume: String,
        /// Optional id hint.
        #[arg(long)]
        id_hint: Option<String>,
        /// Acknowledge create is retired and use it anyway.
        #[arg(long)]
        dangerous: bool,
    },
    /// Sync: ingest changed .md files from the workdir. Use --author for provenance.
    Sync {
        #[arg(short = 'a', long)]
        author: Option<String>,
        /// Harvest <stellario> blocks from these repo paths into the index
        /// (read-only on the repo; scoped replacement per scanned path).
        #[arg(long)]
        repo: Vec<PathBuf>,
        /// Reindex the capsule's memory entries into the index (read-only
        /// on the capsule).
        #[arg(long)]
        reindex_memory: bool,
        /// Index file (default ~/.stellario/index.db; env STELLA_INDEX overrides).
        #[arg(long)]
        index: Option<PathBuf>,
        /// Print the constellation hygiene report for the repo's .stella/ dir.
        #[arg(long)]
        status: bool,
    },
    /// Export the capsule to files (legacy-exit primitive): read-only dump
    /// of every entry as <out>/<volume>/<id>.md + manifest.jsonl.
    Export {
        /// Output directory (created if missing).
        #[arg(long)]
        out: PathBuf,
    },
    /// Delete an entry (supersede to tombstone). Disappears from search, stays in lineage.
    Delete {
        /// Entry id (volume:n).
        id: String,
        #[arg(short = 'a', long)]
        author: String,
        #[arg(short = 'i', long, default_value = "deleted")]
        intent: String,
    },
}

/// Create a capsule on first use — a sync side effect, not a create
/// ceremony. The capsule emerges from sync targeting it (constellation
/// final topology: structure is discovered from writing, not declared).
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


/// Harvest <stellario> blocks from repo paths into the index (embeds +
/// natives). Read-only on the repo; scoped replacement per scanned path.
fn harvest_to_index(repo_paths: &[PathBuf], index_path: &Path) -> Result<()> {
    let (entries, root) = stellario::harvest::harvest(repo_paths)?;
    let index = stellario::index::Index::open(index_path)?;

    let all_kw: Vec<String> = entries.iter().flat_map(|e| e.keywords.clone()).collect();
    let vecs = stellario::telescope::embed_texts(&all_kw);
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
            stellario::index::IndexEntry {
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
/// its `.stellario` config declares (constellation §3.7 — self-declared home).
fn mirror_declared(repo_paths: &[PathBuf], index_path: &Path) -> Result<()> {
    for p in repo_paths {
        let Some((dir, cfg)) = stellario::config::discover(p) else { continue };
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
            let synced = stellario::harvest::mirror_natives_to_capsule(&mut storage, &creation, "stellario")?;
            if !synced.is_empty() {
                let new_bytes = storage.save()?;
                std::fs::write(&path, &new_bytes)?;
                println!("mirror: {} natives from {} -> capsule '{}'", synced.len(), creation.display(), cap);
                // Reindex the capsule so the index sees the new/updated natives.
                let index = stellario::index::Index::open(index_path)?;
                let n = stellario::index::ingest_memory(&index, cap, &storage, &|texts| {
                    stellario::telescope::embed_texts(texts)
                })?;
                println!("memory reindex: {} entries from capsule '{}' -> index", n, cap);
            } else {
                println!("mirror: nothing new in {}", creation.display());
            }
        }
    }
    Ok(())
}

fn main() -> Result<()> {
    let cli = Cli::parse();

    match &cli.cmd {
        Cmd::List => {
            for name in discover_capsules() {
                println!("{}", name);
            }
        }

        Cmd::Volumes => {
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            for vol in storage.volume_names()? {
                let count = storage.list(&vol)?.len();
                println!("{:<16} {} entries", vol, count);
            }
        }

        Cmd::Search {
            query,
            volumes,
            tags,
            limit,
            no_semantic,
        } => {
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
        }

        Cmd::Show { id } => {
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            let (vol, n) = parse_id(id)?;
            let entry = storage
                .materialize(&vol, &n)?
                .ok_or_else(|| anyhow!("{}:{} not found", vol, n))?;
            println!("id:      {}", entry.id);
            println!("author:  {}", entry.author);
            println!("hash:    {}", entry.hash);
            println!("created: {}", entry.created);
            if !entry.tags.is_empty() {
                println!("tags:    {}", entry.tags.join(", "));
            }
            if !entry.keywords.is_empty() {
                println!("keywords: {}", entry.keywords.join(", "));
            }
            println!();
            println!("{}", entry.content);
        }

        Cmd::Write {
            volume,
            content,
            intent,
            tags,
            keywords,
            author,
            target_id,
            dangerous,
        } => {
            if !dangerous {
                eprintln!("create is retired (constellation model §4): authoring happens in editors as files.");
                eprintln!("  site-free knowledge  → write a <slug>.stella native entry");
                eprintln!("  drafts               → write a <slug>.<star> file in .stella/");
                eprintln!("  use --dangerous to override during the transition.");
                std::process::exit(2);
            }
            let capsule_name = cli.capsule.clone().unwrap_or_else(|| {
                discover_capsules().first().cloned().unwrap_or_default()
            });
            let path = project_capsule_path(&capsule_name)
                .ok_or_else(|| anyhow!("capsule '{}' not found", capsule_name))?;
            let bytes = std::fs::read(&path)?;
            let mut storage = AutomergeStorage::load(&bytes)?;
            let (id, hash) = storage.write(
                volume,
                target_id.as_deref(),
                content,
                tags,
                keywords,
                author,
                intent,
                &[],
                &[],
            )?;
            // Persist
            let new_bytes = storage.save()?;
            std::fs::write(&path, &new_bytes)?;
            println!("written: {}:{}  hash={}", volume, id, hash);
        }

        Cmd::Lineage { id } => {
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            let (vol, n) = parse_id(id)?;
            let steps = storage.lineage(&vol, &n)?;
            if steps.is_empty() {
                bail!("{}:{} not found", vol, n);
            }
            for (i, s) in steps.iter().enumerate() {
                let status = if s.version.superseded { " (superseded)" } else { "" };
                println!("v{}  {}{}  author={}", i, s.version.hash, status, s.version.author);
                println!("     intent: {}", s.intent);
                println!("     created: {}", s.version.created);
            }
        }

        Cmd::Expand { id } => {
            // Auto-sync before expand (don't lose unsaved edits).
            auto_sync_if_needed(&cli)?;
            let (_name, storage) = load_capsule(cli.capsule.as_deref())?;
            let (vol, n) = parse_id(&id)?;
            let entry = storage
                .materialize(&vol, &n)?
                .ok_or_else(|| anyhow!("{} not found", id))?;
            let mut wd = stellario::Workdir::new("cli")?;
            let path = wd.expand(&entry)?;
            // Save the workdir tracking state for sync to pick up.
            save_workdir_state(&wd, &cli)?;
            println!("{}", path.display());
        }

        Cmd::ExpandNew { volume, id_hint, dangerous } => {
            if !dangerous {
                eprintln!("expand-new is retired (constellation model §4): write a <slug>.stella file directly.");
                eprintln!("  use --dangerous to override during the transition.");
                std::process::exit(2);
            }
            auto_sync_if_needed(&cli)?;
            let mut wd = stellario::Workdir::new("cli")?;
            let hint = id_hint.clone().unwrap_or_else(|| "new".to_string());
            let path = wd.expand_new(&volume, &hint)?;
            save_workdir_state(&wd, &cli)?;
            println!("{}", path.display());
        }

        Cmd::Sync { author, repo, reindex_memory, index, status } => {
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
                let cons = stellario::constellation::discover(&root.join(".stella"));
                print!("{}", stellario::constellation::format_report(&cons));
                return Ok(());
            }
            let index_path = index
                .clone()
                .or_else(|| std::env::var("STELLA_INDEX").ok().map(PathBuf::from))
                .unwrap_or_else(stellario::index::default_path);

            // ── explicit --repo: harvest to index + mirror declared natives ──
            if !repo.is_empty() {
                harvest_to_index(&repo, &index_path)?;
                mirror_declared(&repo, &index_path)?;
                return Ok(());
            }
            // ── memory reindex (read-only on the capsule) ──
            if *reindex_memory {
                let capsule_name = resolve_capsule_name(&cli);
                let (_, storage) = load_capsule(Some(&capsule_name))?;
                let index = stellario::index::Index::open(&index_path)?;
                let n = stellario::index::ingest_memory(&index, &capsule_name, &storage, &|texts| {
                    stellario::telescope::embed_texts(texts)
                })?;
                println!("memory reindex: {} entries from capsule '{}' -> index {}", n, capsule_name, index_path.display());
                return Ok(());
            }


            // ── shape-aware sync (no flags): the directory declares its own
            //    semantics by its file layout (constellation §3.7) ──
            debug_assert!(!*reindex_memory, "reindex branch must precede shape-aware sync");
            {
                let cwd = std::env::current_dir()?;
                if let Some((dir, cfg)) = stellario::config::discover(&cwd) {
                    // self-declared home: harvest embeds + mirror natives
                    harvest_to_index(&[dir.clone()], &index_path)?;
                    mirror_declared(&[dir.clone()], &index_path)?;
                    let _ = cfg;
                    return Ok(());
                }
                if stellario::config::is_staging_shape(&cwd) {
                    // undeclared home — staging shape: sync must be told where.
                    // No --capsule → the scratch inbox (created on first use):
                    // capture-anything path with zero ceremony.
                    let cap = cli.capsule.clone().unwrap_or_else(|| "scratch".into());
                    let path = ensure_capsule(&cap)?;
                    let bytes = std::fs::read(&path)?;
                    let mut storage = AutomergeStorage::load(&bytes)?;
                    let creation = cwd.join(stellario::config::DEFAULT_CREATION_DIR);
                    let synced = stellario::harvest::mirror_natives_to_capsule(&mut storage, &creation, "stellario")?;
                    if !synced.is_empty() {
                        let new_bytes = storage.save()?;
                        std::fs::write(&path, &new_bytes)?;
                        println!("mirror: {} natives from {} -> capsule '{}'", synced.len(), creation.display(), cap);
                        let index = stellario::index::Index::open(&index_path)?;
                        let n = stellario::index::ingest_memory(&index, &cap, &storage, &|texts| {
                            stellario::telescope::embed_texts(texts)
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
                return Ok(());
            }

            // ── original workdir sync (author required) ──
            let author = author.clone().ok_or_else(|| anyhow!("--author is required for workdir sync"))?;
            let capsule_name = resolve_capsule_name(&cli);
            let path = project_capsule_path(&capsule_name)
                .ok_or_else(|| anyhow!("capsule '{}' not found", capsule_name))?;
            let bytes = std::fs::read(&path)?;
            let mut storage = AutomergeStorage::load(&bytes)?;
            let mut wd = stellario::Workdir::new("cli")?;
            wd.discover_from_disk()?;
            let results = wd.sync(&mut storage, &author)?;
            let new_bytes = storage.save()?;
            std::fs::write(&path, &new_bytes)?;
            if results.is_empty() {
                println!("nothing to sync");
            } else {
                for r in &results {
                    match &r.action {
                        stellario::SyncAction::Created { assigned_id } => {
                            println!("  {} → {}  created", r.id, assigned_id);
                        }
                        _ => {
                            println!("  {}  {}", r.id, r.action.label());
                        }
                    }
                }
            }
        }

        Cmd::Export { out } => {
            let capsule_name = resolve_capsule_name(&cli);
            let (name, storage) = load_capsule(Some(&capsule_name))?;
            let stats = stellario::export::export_capsule(&storage, &out)?;
            println!(
                "exported capsule '{}': {} volumes, {} entries, {} bytes -> {}",
                name,
                stats.volumes,
                stats.entries,
                stats.bytes,
                out.display()
            );
        }

        Cmd::Delete { id, author, intent } => {
            let capsule_name = resolve_capsule_name(&cli);
            let path = project_capsule_path(&capsule_name)
                .ok_or_else(|| anyhow!("capsule '{}' not found", capsule_name))?;
            let bytes = std::fs::read(&path)?;
            let mut storage = AutomergeStorage::load(&bytes)?;
            let (vol, n) = parse_id(&id)?;
            let entry = storage.materialize(&vol, &n)?
                .ok_or_else(|| anyhow!("{} not found", id))?;
            let supersede_edge = Edge {
                from: String::new(),
                to: entry.hash.clone(),
                kind: EdgeKind::Supersede,
                reason: intent.clone(),
            };
            storage.write(
                &vol, Some(&n),
                "(deleted)", &["type:deleted".to_string()], &[],
                &author, &intent, &[], &[supersede_edge],
            )?;
            let new_bytes = storage.save()?;
            std::fs::write(&path, &new_bytes)?;
            println!("deleted: {} (superseded, stays in lineage)", id);
        }
    }

    Ok(())
}

/// Auto-sync if there's a workdir with pending changes.
fn auto_sync_if_needed(cli: &Cli) -> anyhow::Result<()> {
    let mut wd = stellario::Workdir::new("cli")?;
    wd.discover_from_disk()?;
    let capsule_name = resolve_capsule_name(cli);
    let path = match project_capsule_path(&capsule_name) {
        Some(p) => p,
        None => return Ok(()),
    };
    let bytes = std::fs::read(&path)?;
    let mut storage = AutomergeStorage::load(&bytes)?;
    let results = wd.sync(&mut storage, "cli-auto")?;
    let changed: Vec<_> = results.iter().filter(|r| {
        matches!(r.action, stellario::SyncAction::Created { .. } | stellario::SyncAction::Revised)
    }).collect();
    if !changed.is_empty() {
        let new_bytes = storage.save()?;
        std::fs::write(&path, &new_bytes)?;
        eprintln!("auto-synced: {}", changed.iter().map(|r| format!("{}={}", r.id, r.action.label())).collect::<Vec<_>>().join(", "));
    }
    Ok(())
}

/// Resolve the capsule name (explicit or first available).
fn resolve_capsule_name(cli: &Cli) -> String {
    cli.capsule.clone().unwrap_or_else(|| {
        discover_capsules().first().cloned().unwrap_or_default()
    })
}

/// Workdir state is per-process (Workdir holds its tracking in memory).
/// For CLI's stateless model, each expand creates a fresh Workdir that
/// re-discovers .md files in the workdir root. sync scans all .md files there.
fn save_workdir_state(_wd: &stellario::Workdir, _cli: &Cli) -> anyhow::Result<()> {
    // The .md files themselves are the state — sync reads them from disk.
    // No separate state file needed: sync re-derives source_hash from the
    // <!-- hash: ... --> comment in each .md file.
    Ok(())
}
