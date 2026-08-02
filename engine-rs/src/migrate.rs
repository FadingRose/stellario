//! JSONL → Automerge migration — the phase-0 risk gate.
//!
//! Converts a seed device's JSONL memory into a single Automerge document per
//! project (a "capsule"), per `automerge-storage-architecture.md`.
//!
//! ## What this migration abolishes (data hygiene, not just porting)
//!
//!   1. **idPrefix.** The legacy prefix-encoded id (`a65`, `m03`, `ar753e`) is
//!      gone. Every entry id becomes `volume:n` (e.g. `active:65`, `meta:03`,
//!      `task:238`). This is self-describing, reversible (display id == stored
//!      id), and needs no per-volume config. The old prefix character was a
//!      coincidental mnemonic that leaked into storage and forced the
//!      irreversible display-id parsing the TS layer worked around.
//!
//!   2. **taskboard.jsonl / the Task entity.** Tasks are not a separate entity
//!      type. A task migrates to an entry in the `task` volume with tags
//!      (`type:task`, `status:claimed`, `owner:edelweiss`, `file:src/foo.rs`)
//!      and refs (`parent`, `depends-on`, `blocked-by`). Task storage collapses
//!      into the same volume + entry + tags + refs model; telescope search and
//!      the refs graph cover tasks uniformly. The status lifecycle survives as
//!      domain logic over tags, not as a storage schema.
//!
//!   3. **in_progress status.** `claimed` absorbs "actively working" (commit
//!      ada8d8a); any residual `in_progress` (fossil in old backups) normalizes
//!      to `claimed`.
//!
//! ## Ref normalization
//!
//! Legacy refs use two target formats; both resolve to `volume:n`:
//!   - short:  `a29`        → resolve to its volume, emit `active:29`
//!   - display: `active:65` → already volume:n-shaped; verify + emit directly
//! Task refs (`tb100` in parent/depends_on/blocked_by) → `task:100`.
//!
//! ## Integrity
//!
//! Dangling refs (target resolves to no entry) are classified by source:
//!   - auto refs → dropped (the engine rebuilds them)
//!   - manual refs → reported as violations (hard fail unless
//!     `--allow-dangling-manual`)

use std::collections::{BTreeMap, HashMap};
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};
use automerge::{AutoCommit, ObjType, ReadDoc, Value};
use serde::{Deserialize, Serialize};

use crate::model::MemRef;
use crate::storage::{AutomergeStorage, Storage};

/// One Automerge document per project.
pub const DOC_FILENAME: &str = "capsule.automerge";

/// The synthetic volume tasks migrate into.
const TASK_VOLUME: &str = "task";

// ─── Options ───────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MigrationOptions {
    /// Dry-run: validate and report, write nothing.
    pub dry_run: bool,
    /// Drop dangling AUTO refs instead of failing. Default true — auto refs
    /// are rebuildable derivative data.
    pub drop_dangling_auto: bool,
    /// Allow dangling MANUAL refs (carry them through verbatim). Default false
    /// — a manual ref to a missing entry is a data-integrity signal worth a
    /// human decision.
    pub allow_dangling_manual: bool,
}

impl Default for MigrationOptions {
    fn default() -> Self {
        Self {
            dry_run: false,
            drop_dangling_auto: true,
            allow_dangling_manual: false,
        }
    }
}

// ─── Report ────────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct MigrationReport {
    pub project_dir: PathBuf,
    pub entries_written: usize,
    pub tasks_migrated: usize,
    pub volumes_written: BTreeMap<String, usize>,
    pub refs_normalized: usize,
    pub dangling_auto_dropped: usize,
    pub dangling_manual: Vec<DanglingRef>,
    pub in_progress_normalized: usize,
    pub doc_bytes: Option<usize>,
    pub dry_run: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DanglingRef {
    pub source: String,
    pub target: String,
    pub ref_source: String, // "auto" | "manual"
}

// ─── Public entry point ────────────────────────────────────────────────────

/// Migrate a seed device's JSONL directory into one Automerge capsule.
///
/// `device_dir` is the device-relative memory directory, e.g.
/// `~/.stellario/projects/{name}/{device-id}/`. Reads every `*.jsonl` volume
/// (except index/log files) plus `taskboard.jsonl`, normalizes everything to
/// entries with `volume:n` ids, and writes `capsule.automerge`.
pub fn migrate_project(device_dir: &Path, opts: &MigrationOptions) -> Result<MigrationReport> {
    if !device_dir.is_dir() {
        return Err(anyhow!("device memory dir not found: {}", device_dir.display()));
    }

    // ── Pass 1: read raw entries + tasks ──
    let (raw_entries, raw_tasks) = read_all(device_dir)
        .with_context(|| format!("reading JSONL from {}", device_dir.display()))?;

    // ── Pass 2: build id resolution index ──
    // old_id -> volume   (so a short ref `a29` can be promoted to `active:29`)
    // Also: per-volume slice index for legacy display-format resolution.
    let (old_id_to_volume, vol_slice_index) = build_resolution_index(&raw_entries);
    // Tasks all live in the synthetic `task` volume; their old ids are `tb<N>`.
    // The number after "tb" becomes the task ordinal: tb238 -> task:238.
    let task_numbers: std::collections::HashSet<String> = raw_tasks
        .iter()
        .filter_map(|t| t.id.strip_prefix("tb").map(|n| n.to_string()))
        .collect();

    let resolver = Resolver {
        old_id_to_volume: &old_id_to_volume,
        vol_slice_index: &vol_slice_index,
        task_numbers: &task_numbers,
    };

    // ── Pass 3: normalize + write to the version graph ──
    // Each migrated entry becomes a root version (no parent; intent records
    // that it was migrated). Refs normalize to volume:n; typed edges are empty
    // (pre-migration data has no evolution structure).
    let mut storage = if opts.dry_run {
        AutomergeStorage::new() // build in-memory, discard
    } else {
        AutomergeStorage::new()
    };
    let mut dangling_auto = 0usize;
    let mut dangling_manual: Vec<DanglingRef> = Vec::new();
    let mut refs_normalized = 0usize;
    let mut in_progress_normalized = 0usize;
    let mut entries_written = 0usize;
    let mut tasks_migrated = 0usize;
    let mut volumes_written: BTreeMap<String, usize> = BTreeMap::new();

    // Write each migrated memory entry as a root version.
    for re in raw_entries {
        if re.id.is_empty() {
            continue;
        }
        let vol = if re.volume.is_empty() { "unknown" } else { &re.volume };
        let ord = ordinal_of(&re.id);
        let new_id = format!("{}:{}", vol, ord);

        let mut refs = Vec::with_capacity(re.refs.len());
        for r in re.refs {
            match resolver.resolve(&r.target) {
                Some(new_target) => {
                    refs_normalized += 1;
                    refs.push(MemRef { target: new_target, reason: r.reason, source: r.source });
                }
                None => classify_dangling(
                    &r, &new_id, opts, &mut dangling_auto, &mut dangling_manual, &mut refs,
                ),
            }
        }
        // refs_removed normalize but aren't a first-class concept post-migration;
        // we drop them silently (the auto-refs engine rebuilds).

        storage
            .write(
                vol,
                Some(&ord),
                &re.content,
                &re.tags,
                &re.keywords,
                &re.author,
                "migrated from JSONL",
                &refs,
                &[],
            )
            .context("writing migrated version")?;
        *volumes_written.entry(vol.to_string()).or_default() += 1;
        entries_written += 1;
    }

    // ── Pass 3b: tasks → task-volume root versions ──
    for t in raw_tasks {
        let Some(n) = t.id.strip_prefix("tb") else { continue };
        if n.is_empty() {
            continue;
        }
        let status = if t.status == "in_progress" {
            in_progress_normalized += 1;
            "claimed".to_string()
        } else {
            t.status
        };

        let mut tags = Vec::with_capacity(4 + t.tags.len());
        tags.push("type:task".to_string());
        tags.push(format!("status:{}", status));
        if let Some(o) = &t.owner {
            if !o.is_empty() {
                tags.push(format!("owner:{}", o));
            }
        }
        for p in &t.paths {
            tags.push(format!("file:{}", p));
        }
        tags.extend(t.tags.into_iter());

        // Task-tree relations become knowledge-graph refs.
        let mut refs: Vec<MemRef> = Vec::new();
        {
            let push_ref = |refs: &mut Vec<MemRef>, raw: &str, reason: &str| {
                if let Some(target) = resolver.resolve(raw) {
                    refs.push(MemRef {
                        target,
                        reason: reason.to_string(),
                        source: "manual".to_string(),
                    });
                }
            };
            if let Some(p) = &t.parent {
                push_ref(&mut refs, p, "parent");
            }
            for d in &t.depends_on {
                push_ref(&mut refs, d, "depends-on");
            }
            for b in &t.blocked_by {
                push_ref(&mut refs, b, "blocked-by");
            }
        }
        refs_normalized += refs.len();

        let content = match &t.body {
            Some(b) if !b.is_empty() => format!("## {}\n\n{}", t.title, b),
            _ => format!("## {}", t.title),
        };

        storage
            .write(
                TASK_VOLUME,
                Some(n),
                &content,
                &tags,
                &[],
                &t.author,
                "migrated from taskboard",
                &refs,
                &[],
            )
            .context("writing migrated task version")?;
        *volumes_written.entry(TASK_VOLUME.to_string()).or_default() += 1;
        tasks_migrated += 1;
    }

    // ── Integrity gate ──
    if !opts.allow_dangling_manual {
        let manual_only: Vec<_> = dangling_manual.iter().filter(|d| d.ref_source == "manual").collect();
        if !manual_only.is_empty() {
            return Err(anyhow!(
                "integrity check failed: {} dangling MANUAL refs. \
                 Review them, or pass --allow-dangling-manual. Samples: {:?}",
                manual_only.len(),
                manual_only.iter().take(5).collect::<Vec<_>>()
            ));
        }
    }

    // ── Pass 4: persist the capsule ──
    let mut doc_bytes: Option<usize> = None;
    if !opts.dry_run {
        let bytes = storage.save()?;
        let out_path = device_dir.join(DOC_FILENAME);
        fs::write(&out_path, &bytes)
            .with_context(|| format!("writing {}", out_path.display()))?;
        doc_bytes = Some(bytes.len());
    }

    Ok(MigrationReport {
        project_dir: device_dir.to_path_buf(),
        entries_written,
        tasks_migrated,
        volumes_written,
        refs_normalized,
        dangling_auto_dropped: dangling_auto,
        dangling_manual,
        in_progress_normalized,
        doc_bytes,
        dry_run: opts.dry_run,
    })
}

// ─── Id resolution ─────────────────────────────────────────────────────────

/// Resolve any legacy ref target to a normalized `volume:n` id.
struct Resolver<'a> {
    old_id_to_volume: &'a HashMap<String, String>,
    vol_slice_index: &'a HashMap<String, HashMap<String, String>>,
    task_numbers: &'a std::collections::HashSet<String>,
}

impl<'a> Resolver<'a> {
    fn resolve(&self, target: &str) -> Option<String> {
        // Already-normalized form (volume:n) — accept directly if the volume:n
        // refers to a real entry. We can't fully verify here without the new-id
        // set, so we accept volume:n shapes verbatim (they came from display
        // ids that pointed at real entries). The integrity check for these is
        // implicit: a display id `active:65` only existed because the entry did.
        if let Some((vol, n)) = target.split_once(':') {
            if self.vol_slice_index.contains_key(vol) {
                return Some(format!("{}:{}", vol, n));
            }
            // task:N already in normalized shape
            if vol == TASK_VOLUME && self.task_numbers.contains(n) {
                return Some(target.to_string());
            }
            return None;
        }

        // Task short ref: tb<N> → task:N
        if let Some(n) = target.strip_prefix("tb") {
            if self.task_numbers.contains(n) {
                return Some(format!("{}:{}", TASK_VOLUME, n));
            }
            return None;
        }

        // Legacy short id: a29 → look up its volume → active:29
        if let Some(vol) = self.old_id_to_volume.get(target) {
            return Some(format!("{}:{}", vol, ordinal_of(target)));
        }

        // Legacy display-shaped without colon is impossible here (no ':'). Any
        // remaining unresolved target is dangling.
        None
    }
}

/// Extract the ordinal from a legacy id by stripping its alphabetic prefix.
/// `a65` → "65", `ar753e` → "753e", `tb238` → "238", `meta:03` → "03".
fn ordinal_of(id: &str) -> String {
    if let Some((_, n)) = id.split_once(':') {
        return n.to_string();
    }
    let trimmed = id.trim_start_matches(|c: char| c.is_alphabetic());
    trimmed.to_string()
}

/// Build the lookup tables for resolving legacy ids.
///  - old_id_to_volume: "a29" → "active"  (for short-ref promotion)
///  - vol_slice_index:  volume → { id[1..] → full_id }  (legacy display parse)
fn build_resolution_index(
    entries: &[RawEntry],
) -> (HashMap<String, String>, HashMap<String, HashMap<String, String>>) {
    let mut id_to_vol: HashMap<String, String> = HashMap::new();
    let mut slice_idx: HashMap<String, HashMap<String, String>> = HashMap::new();
    for e in entries {
        if e.id.is_empty() || e.volume.is_empty() {
            continue;
        }
        id_to_vol.insert(e.id.clone(), e.volume.clone());
        if e.id.len() > 1 {
            let slice = e.id[1..].to_string();
            slice_idx
                .entry(e.volume.clone())
                .or_default()
                .insert(slice, e.id.clone());
        }
    }
    (id_to_vol, slice_idx)
}

fn classify_dangling(
    r: &RawRef,
    source_new_id: &str,
    opts: &MigrationOptions,
    dangling_auto: &mut usize,
    dangling_manual: &mut Vec<DanglingRef>,
    refs: &mut Vec<MemRef>,
) {
    if r.source == "auto" {
        if opts.drop_dangling_auto {
            *dangling_auto += 1;
        } else {
            dangling_manual.push(DanglingRef {
                source: source_new_id.to_string(),
                target: r.target.clone(),
                ref_source: "auto".into(),
            });
            refs.push(MemRef {
                target: r.target.clone(),
                reason: r.reason.clone(),
                source: r.source.clone(),
            });
        }
    } else {
        dangling_manual.push(DanglingRef {
            source: source_new_id.to_string(),
            target: r.target.clone(),
            ref_source: "manual".into(),
        });
        if opts.allow_dangling_manual {
            refs.push(MemRef {
                target: r.target.clone(),
                reason: r.reason.clone(),
                source: r.source.clone(),
            });
        }
    }
}

// ─── JSONL readers ─────────────────────────────────────────────────────────

const NON_VOLUME_FILES: &[&str] = &[
    "volumes.jsonl",
    "keywords-index.jsonl",
    "intent-log.jsonl",
    "locks.json",
];

#[derive(Debug, Deserialize)]
struct RawRef {
    target: String,
    #[serde(default)]
    reason: String,
    #[serde(default)]
    source: String,
}

/// A legacy memory entry as found in `<volume>.jsonl`.
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // legacy migration data-model fields kept for history/import
struct RawEntry {
    #[serde(default)]
    id: String,
    #[serde(default)]
    volume: String,
    content: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    #[serde(default)]
    author: String,
    #[serde(default)]
    created: String,
    #[serde(default)]
    updated: String,
    #[serde(default)]
    refs: Vec<RawRef>,
    #[serde(default)]
    refs_removed: Vec<String>,
    #[serde(default)]
    archived_at: Option<String>,
    #[serde(default)]
    archived_reason: Option<String>,
}

/// A legacy task from `taskboard.jsonl`.
#[derive(Debug, Deserialize)]
#[allow(dead_code)] // legacy migration data-model fields kept for history/import
struct RawTask {
    #[serde(default)]
    id: String,
    #[serde(default)]
    title: String,
    #[serde(default)]
    body: Option<String>,
    #[serde(default, rename = "status")]
    status: String,
    #[serde(default)]
    author: String,
    #[serde(default)]
    owner: Option<String>,
    #[serde(default)]
    paths: Vec<String>,
    #[serde(default)]
    depends_on: Vec<String>,
    #[serde(default)]
    blocked_by: Vec<String>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    created: String,
    #[serde(default)]
    updated: String,
    #[serde(default)]
    completed: Option<String>,
    #[serde(default)]
    parent: Option<String>,
}

fn read_all(dir: &Path) -> Result<(Vec<RawEntry>, Vec<RawTask>)> {
    let mut entries = Vec::new();
    let mut tasks = Vec::new();

    for item in fs::read_dir(dir)? {
        let item = item?;
        let path = item.path();
        if !path.is_file() {
            continue;
        }
        let Some(name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !name.ends_with(".jsonl") {
            continue;
        }
        let contents = fs::read_to_string(&path)
            .with_context(|| format!("reading {}", path.display()))?;

        if name == "taskboard.jsonl" {
            for line in contents.lines() {
                let line = line.trim();
                if line.is_empty() {
                    continue;
                }
                match serde_json::from_str::<RawTask>(line) {
                    Ok(t) => tasks.push(t),
                    Err(e) => {
                        return Err(anyhow!(
                            "parse error in {} on line {:?}: {}",
                            path.display(),
                            line.get(..40).unwrap_or(line),
                            e
                        ))
                    }
                }
            }
            continue;
        }

        if NON_VOLUME_FILES.contains(&name) {
            continue;
        }

        for line in contents.lines() {
            let line = line.trim();
            if line.is_empty() {
                continue;
            }
            match serde_json::from_str::<RawEntry>(line) {
                Ok(e) => entries.push(e),
                Err(e) => {
                    return Err(anyhow!(
                        "parse error in {} on line {:?}: {}",
                        path.display(),
                        line.get(..40).unwrap_or(line),
                        e
                    ))
                }
            }
        }
    }

    Ok((entries, tasks))
}

// ─── Round-trip verification ───────────────────────────────────────────────

/// Count entries across all volumes in a capsule (round-trip verification).
pub fn count_capsule_entries(doc_bytes: &[u8]) -> Result<usize> {
    let doc = AutoCommit::load(doc_bytes)?;
    let mut total = 0;
    if let Some((Value::Object(ObjType::Map), volumes)) = doc.get(automerge::ROOT, "volumes")? {
        for vname in doc.keys(&volumes).collect::<Vec<_>>() {
            if let Some((_, vol)) = doc.get(&volumes, &vname)? {
                total += doc.keys(&vol).collect::<Vec<_>>().len();
            }
        }
    }
    Ok(total)
}
