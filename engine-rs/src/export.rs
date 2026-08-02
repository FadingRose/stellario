//! export — capsule → files, the legacy-exit primitive.
//!
//! The migration decision (2026-08-02): legacy `volume:id` entries exit the
//! active capsules *as files* — the capability we need is not an archive
//! capsule but export itself. Distill then reads the export.
//!
//! Layout:
//!   <out>/<volume>/<id>.md        human-readable entry (id colon → '-')
//!   <out>/manifest.jsonl          machine-readable, all entries (importable)
//!
//! Read-only on the capsule. Export is lossless: every field an entry
//! carries appears in both the .md and the manifest row.

use std::fs;
use std::path::Path;

use anyhow::{Context, Result};
use serde::Serialize;

use crate::storage::Storage;

#[derive(Debug, Default)]
pub struct ExportStats {
    pub volumes: usize,
    pub entries: usize,
    pub bytes: u64,
}

#[derive(Serialize)]
struct ManifestRow<'a> {
    id: String,
    volume: String,
    tags: &'a [String],
    keywords: &'a [String],
    author: Option<&'a str>,
    created: String,
    updated: String,
    content_len: usize,
}

/// Export every active entry of a capsule into `out/`.
pub fn export_capsule<S: Storage + ?Sized>(storage: &S, out: &Path) -> Result<ExportStats> {
    fs::create_dir_all(out).with_context(|| format!("creating export dir {}", out.display()))?;
    let mut stats = ExportStats::default();
    let manifest_path = out.join("manifest.jsonl");
    let mut manifest = fs::File::create(&manifest_path)
        .with_context(|| format!("creating {}", manifest_path.display()))?;

    for volume in storage.volume_names()? {
        let vol_dir = out.join(&volume);
        fs::create_dir_all(&vol_dir)?;
        stats.volumes += 1;
        for id in storage.list(&volume)? {
            let Some(entry) = storage.materialize(&volume, &id)? else { continue };
            let safe_id = entry.id.replace(':', "-");
            let md_path = vol_dir.join(format!("{safe_id}.md"));

            let mut md = format!(
                "<!-- stellario-export: {} | volume {} -->\n# {}\n\n",
                entry.id, volume, entry.id
            );
            if !entry.tags.is_empty() {
                md.push_str(&format!("tags: {}\n", entry.tags.join(", ")));
            }
            if !entry.keywords.is_empty() {
                md.push_str(&format!("keywords: {}\n", entry.keywords.join(", ")));
            }
            if !entry.author.is_empty() {
                md.push_str(&format!("author: {}\n", entry.author));
            }
            md.push_str(&format!("created: {}\nupdated: {}\n\n---\n\n", entry.created, entry.updated));
            md.push_str(&entry.content);
            if !md.ends_with('\n') {
                md.push('\n');
            }
            fs::write(&md_path, &md)?;
            stats.bytes += md.len() as u64;

            let row = ManifestRow {
                id: entry.id.clone(),
                volume: volume.clone(),
                tags: &entry.tags,
                keywords: &entry.keywords,
                author: if entry.author.is_empty() { None } else { Some(entry.author.as_str()) },
                created: entry.created.clone(),
                updated: entry.updated.clone(),
                content_len: entry.content.len(),
            };
            serde_json::to_writer(&mut manifest, &row)?;
            manifest.write_all(b"\n")?;
            stats.entries += 1;
        }
    }
    Ok(stats)
}

use std::io::Write;

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::AutomergeStorage;

    fn seed() -> AutomergeStorage {
        let mut s = AutomergeStorage::new();
        s.write("layer", Some("1"),
            "## Auth Token Format\nJWT-based auth with RS256.",
            &["type:design".into(), "module:auth".into()],
            &["jwt".into(), "token".into()],
            "a", "seed auth", &[], &[]).unwrap();
        s.write("meta", Some("1"),
            "## Convention\nUse Result<T,E>.",
            &["type:convention".into()],
            &["error-handling".into()],
            "a", "seed convention", &[], &[]).unwrap();
        s
    }

    #[test]
    fn idempotent_write_does_not_double_timeline() {
        // M3 regression: re-writing identical content must not append the
        // hash twice or mint a self-parent edge — lineage stays clean.
        let mut s = AutomergeStorage::new();
        s.write("layer", Some("1"), "## X", &[], &[], "a", "one", &[], &[]).unwrap();
        s.write("layer", Some("1"), "## X", &[], &[], "a", "two", &[], &[]).unwrap();
        let lin = s.lineage("layer", "1").unwrap();
        assert_eq!(lin.len(), 1, "idempotent write must not append to the timeline");
        let entry = s.materialize("layer", "1").unwrap().unwrap();
        assert_eq!(entry.content, "## X");
    }

    #[test]
    fn export_roundtrip() {
        let s = seed();
        let dir = std::env::temp_dir().join(format!("stella-export-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        let stats = export_capsule(&s, &dir).unwrap();
        assert_eq!(stats.entries, 2);
        assert_eq!(stats.volumes, 2);

        let layer_md = dir.join("layer/layer-1.md");
        assert!(layer_md.exists());
        let md = fs::read_to_string(&layer_md).unwrap();
        assert!(md.contains("JWT-based auth"));
        assert!(md.contains("tags: type:design, module:auth"));

        let manifest = fs::read_to_string(dir.join("manifest.jsonl")).unwrap();
        let lines: Vec<&str> = manifest.lines().collect();
        assert_eq!(lines.len(), 2);
        let first: serde_json::Value = serde_json::from_str(lines[0]).unwrap();
        assert_eq!(first["id"], "layer:1");
        assert_eq!(first["volume"], "layer");
        assert!(first["content_len"].as_u64().unwrap() > 0);
        fs::remove_dir_all(&dir).ok();
    }
}
