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

use std::path::PathBuf;

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
    ExpandNew {
        /// Volume for the new entry.
        volume: String,
        /// Optional id hint.
        #[arg(long)]
        id_hint: Option<String>,
    },
    /// Sync: ingest changed .md files from the workdir. Use --author for provenance.
    Sync {
        #[arg(short = 'a', long)]
        author: String,
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
        } => {
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

        Cmd::ExpandNew { volume, id_hint } => {
            auto_sync_if_needed(&cli)?;
            let mut wd = stellario::Workdir::new("cli")?;
            let hint = id_hint.clone().unwrap_or_else(|| "new".to_string());
            let path = wd.expand_new(&volume, &hint)?;
            save_workdir_state(&wd, &cli)?;
            println!("{}", path.display());
        }

        Cmd::Sync { author } => {
            let capsule_name = resolve_capsule_name(&cli);
            let path = project_capsule_path(&capsule_name)
                .ok_or_else(|| anyhow!("capsule '{}' not found", capsule_name))?;
            let bytes = std::fs::read(&path)?;
            let mut storage = AutomergeStorage::load(&bytes)?;
            let mut wd = stellario::Workdir::new("cli")?;
            wd.discover_from_disk()?;
            let results = wd.sync(&mut storage, author)?;
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
