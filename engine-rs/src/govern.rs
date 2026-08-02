//! govern — the governance plane: doctor (check) + migrate (act).
//!
//! One topic, lint-loop shaped: check → suggest → explicit act → recheck.
//! Checks are read-only; acts are explicit. This is the whole maintenance
//! plane — un-distilled legacy, dangling refs, staging zombies, orphan
//! tombstones, migrate candidates.
//!
//! Findings are graded (constellation-model governance deskcheck):
//!   error   — truth damaged, must handle (dangling refs, orphan tombstones)
//!   warning — hygiene debt, should handle (lint, un-distilled, zombies)
//!   info    — opportunities, optional (migrate candidates)
//!
//! TODO(governance): downgrade reflux (repo .stella claims canonical but the
//! capsule has it as a star) needs a repo registry — pending capsule
//! metadata. sync --status covers repo-side constellation state meanwhile.

use std::collections::HashSet;
use std::path::{Path, PathBuf};

use anyhow::Result;

use crate::index::Index;
use crate::parse::{self, Block};
use crate::storage::{AutomergeStorage, Storage};
use crate::{Edge, EdgeKind};

/// Finding severity — Ord so Error sorts first in reports.
#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord)]
pub enum Level {
    Info,
    Warning,
    Error,
}

impl Level {
    pub fn as_str(&self) -> &'static str {
        match self {
            Level::Error => "error",
            Level::Warning => "warning",
            Level::Info => "info",
        }
    }
}

#[derive(Debug)]
pub struct Finding {
    pub level: Level,
    pub code: &'static str,
    pub capsule: String,
    pub entry: Option<String>,
    pub message: String,
    /// The executable governance action, when one exists.
    pub action: Option<String>,
}

impl Finding {
    fn new(level: Level, code: &'static str, capsule: &str, entry: Option<String>, message: impl Into<String>) -> Self {
        Finding { level, code, capsule: capsule.into(), entry, message: message.into(), action: None }
    }
    fn with_action(mut self, action: impl Into<String>) -> Self {
        self.action = Some(action.into());
        self
    }
}

/// Extract a native entry's `<stellario>` block from its stored content.
fn block_from_content(content: &str) -> Option<Block> {
    let path = Path::new("capsule-entry.stella");
    let outcome = parse::extract_blocks(path, parse::Host::Markdown, content);
    outcome.blocks.into_iter().next()
}

/// The set of legacy ids already distilled (referenced by a `supersedes:`
/// ref from some native block).
fn distilled_legacy_ids(registry: &[(String, AutomergeStorage)]) -> HashSet<String> {
    let mut out = HashSet::new();
    for (_, storage) in registry {
        let Ok(vols) = storage.volume_names() else { continue };
        for vol in vols {
            let Ok(ids) = storage.list(&vol) else { continue };
            for id in ids {
                let Ok(Some(entry)) = storage.materialize(&vol, &id) else { continue };
                let Some(block) = block_from_content(&entry.content) else { continue };
                for r in block.string_list("refs") {
                    if let Some(target) = r.trim().strip_prefix("supersedes:") {
                        let target = target.split('—').next().unwrap_or(target).trim();
                        let target = target.split('@').next().unwrap_or(target).trim();
                        if target.contains(':') {
                            out.insert(target.to_string());
                        }
                    }
                }
            }
        }
    }
    out
}

/// Run the doctor over the given capsules. `index` resolves ref existence.
pub fn doctor(
    registry: &[(String, AutomergeStorage)],
    index: &Index,
    staging_dir: &Path,
    min_level: Level,
) -> Vec<Finding> {
    let mut out = Vec::new();
    let mut undistilled: std::collections::HashMap<(String, String), (usize, String)> =
        std::collections::HashMap::new();
    let distilled = distilled_legacy_ids(registry);

    // Memory-side id set for dangling-ref resolution.
    let memory_ids: HashSet<String> = index
        .entries(Some(crate::index::Kind::Memory))
        .map(|rows| rows.into_iter().map(|r| r.id).collect())
        .unwrap_or_default();

    for (cap, storage) in registry {
        let Ok(vols) = storage.volume_names() else { continue };
        for vol in vols {
            let Ok(ids) = storage.list(&vol) else { continue };
            for id in ids {
                // ── Orphan tombstone: listed but not materializable ──
                let Ok(Some(entry)) = storage.materialize(&vol, &id) else {
                    out.push(Finding::new(
                        Level::Error,
                        "orphan-tombstone",
                        cap,
                        Some(format!("{vol}:{id}")),
                        "entry is listed but has no active version (tombstoned without a successor)",
                    ));
                    continue;
                };

                let entry_id = format!("{vol}:{id}");
                // ── Native entries: lint + ref resolution ──
                if let Some(block) = block_from_content(&entry.content) {
                    for v in crate::lint::lint_block(&block) {
                        out.push(Finding::new(
                            Level::Warning,
                            "lint",
                            cap,
                            Some(entry_id.clone()),
                            format!("[{}] {}", v.code, v.message),
                        ));
                    }
                    // dangling refs: refs bullets targeting slugs / legacy ids
                    for r in block.string_list("refs") {
                        let target = r.trim().split('—').next().unwrap_or(r.trim()).trim();
                        let target = target.split('@').next().unwrap_or(target).trim();
                        let is_supersedes = target.starts_with("supersedes:");
                        let target = target.strip_prefix("supersedes:").unwrap_or(target).trim();
                        if target.is_empty() {
                            continue;
                        }
                        let exists = if target.contains(':') {
                            memory_ids.contains(target)
                        } else {
                            memory_ids.contains(target)
                        };
                        if !exists && !is_supersedes {
                            out.push(Finding::new(
                                Level::Error,
                                "dangling-ref",
                                cap,
                                Some(entry_id.clone()),
                                format!("ref target {target:?} does not resolve"),
                            ));
                        }
                    }
                    continue;
                }

                // ── Legacy entries: distillation state (aggregated per
                //    volume — the pending migration is a bulk state, not a
                //    per-entry daily concern) ──
                if id.contains(':') || vol != crate::harvest::NATIVE_VOLUME {
                    let full = format!("{vol}:{id}");
                    let migrated = entry
                        .content
                        .starts_with("(migrated to")
                        || entry.content.starts_with("(deleted)");
                    if !migrated && !distilled.contains(&full) {
                        undistilled.entry((cap.clone(), vol.clone()))
                            .and_modify(|(c, sample)| {
                                *c += 1;
                                if sample.is_empty() {
                                    *sample = full.clone();
                                }
                            })
                            .or_insert((1, full.clone()));
                    }
                }
            }
        }
    }

    // Aggregated un-distilled (one finding per volume, not per entry).
    let mut und: Vec<_> = undistilled.into_iter().collect();
    und.sort_by(|a, b| b.1 .0.cmp(&a.1 .0));
    for ((cap, vol), (count, sample)) in und {
        out.push(
            Finding::new(
                Level::Warning,
                "un-distilled",
                &cap,
                None,
                format!("{count} legacy entries in volume '{vol}' not yet distilled (e.g. {sample}) — the migration is pending"),
            )
            .with_action(format!("see docs/legacy-exit-pending.md — start with `stellario migrate {sample} --to <target>`")),
        );
    }

    // ── Staging zombies: staged .stella whose slug is nowhere in any capsule ──
    let native_ids: HashSet<String> = registry
        .iter()
        .flat_map(|(_, s)| {
            s.volume_names()
                .ok()
                .into_iter()
                .flatten()
                .flat_map(|v| s.list(&v).ok().into_iter().flatten())
                .collect::<Vec<_>>()
        })
        .collect();
    if staging_dir.is_dir() {
        if let Ok(caps) = std::fs::read_dir(staging_dir) {
            for cap in caps.flatten() {
                let creation = cap.path().join(".stella");
                if !creation.is_dir() {
                    continue;
                }
                if let Ok(files) = std::fs::read_dir(&creation) {
                    for f in files.flatten() {
                        let name = f.file_name().to_string_lossy().to_string();
                        let Some((slug, _)) = name.rsplit_once('.') else { continue };
                        if !native_ids.contains(slug) {
                            out.push(
                                Finding::new(
                                    Level::Warning,
                                    "staging-zombie",
                                    &cap.file_name().to_string_lossy(),
                                    Some(slug.to_string()),
                                    "staged .stella whose slug exists in no capsule",
                                )
                                .with_action(format!("stellario sync --capsule {}", cap.file_name().to_string_lossy())),
                            );
                        }
                    }
                }
            }
        }
    }

    out.into_iter().filter(|f| f.level >= min_level).collect()
}

/// Migrate entries to a target capsule (auto-created by the caller).
/// Source entries are tombstoned with intent; targets record provenance in
/// their intent. Returns migrated ids.
pub fn migrate(
    from: &mut AutomergeStorage,
    to: &mut AutomergeStorage,
    ids: &[&str],
    from_name: &str,
    to_name: &str,
    author: &str,
) -> Result<Vec<String>> {
    let mut done = Vec::new();
    for id in ids {
        // Slugs live in the native volume; volume:id legacy keeps its volume.
        let (vol, n) = match id.split_once(':') {
            Some((v, n)) => (v.to_string(), n.to_string()),
            None => (crate::harvest::NATIVE_VOLUME.to_string(), id.to_string()),
        };
        let Some(entry) = from.materialize(&vol, &n)? else {
            eprintln!("  [migrate] skip {id}: not found in {from_name}");
            continue;
        };
        // Target: create a copy with provenance in the intent.
        to.write(
            &vol,
            Some(&n),
            &entry.content,
            &entry.tags,
            &entry.keywords,
            author,
            &format!("migrated from {from_name}:{id}"),
            &[],
            &[],
        )?;
        // Source: tombstone with intent (stays in lineage).
        let edge = Edge {
            from: String::new(),
            to: entry.hash.clone(),
            kind: EdgeKind::Supersede,
            reason: format!("migrated to {to_name}"),
        };
        from.write(
            &vol,
            Some(&n),
            &format!("(migrated to {to_name})"),
            &["type:migrated".to_string()],
            &[],
            author,
            &format!("migrated to {to_name}"),
            &[],
            &[edge],
        )?;
        done.push(id.to_string());
    }
    Ok(done)
}

/// Format findings for the report, grouped by level.
pub fn format_report(findings: &[Finding]) -> String {
    if findings.is_empty() {
        return "doctor: clean — no findings".into();
    }
    let mut out = String::new();
    for level in [Level::Error, Level::Warning, Level::Info] {
        let items: Vec<&Finding> = findings.iter().filter(|f| f.level == level).collect();
        if items.is_empty() {
            continue;
        }
        let mark = match level {
            Level::Error => "✗",
            Level::Warning => "△",
            Level::Info => "·",
        };
        out.push_str(&format!("{} {} ({})\n", mark, level.as_str(), items.len()));
        for f in items {
            let entry = f.entry.as_deref().unwrap_or("-");
            out.push_str(&format!("  [{}] {entry} — {}\n", f.code, f.message));
            if let Some(a) = &f.action {
                out.push_str(&format!("    action: {a}\n"));
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn storage_with(content: &str, tags: &[&str]) -> AutomergeStorage {
        let mut s = AutomergeStorage::new();
        s.write(
            "native",
            Some("some-native-slug"),
            content,
            &tags.iter().map(|t| t.to_string()).collect::<Vec<_>>(),
            &[],
            "test",
            "seed",
            &[],
            &[],
        )
        .unwrap();
        s
    }

    #[test]
    fn lint_block_catches_bad_slug() {
        let content = "# T\n\n<stellario>\nheader: bad — no tldr split.\n</stellario>\n";
        let block = block_from_content(content).unwrap();
        let v = crate::lint::lint_block(&block);
        assert!(v.iter().any(|x| x.code == "slug-format"), "{v:?}");
    }

    #[test]
    fn migrate_moves_and_tombstones() {
        let mut from = AutomergeStorage::new();
        from.write("whiteboard", Some("99"),
            "## wb content", &["type:whiteboard-turn".into()], &[],
            "a", "seed", &[], &[]).unwrap();
        let mut to = AutomergeStorage::new();
        let done = migrate(&mut from, &mut to, &["whiteboard:99"], "scratch", "lilac-in-the-rain", "t").unwrap();
        assert_eq!(done, vec!["whiteboard:99".to_string()]);
        // target has it
        let t = to.materialize("whiteboard", "99").unwrap().unwrap();
        assert_eq!(t.content, "## wb content");
        // source tombstoned with marker
        let s = from.materialize("whiteboard", "99").unwrap().unwrap();
        assert!(s.content.starts_with("(migrated to"), "source must be tombstoned: {}", s.content);
    }
}
