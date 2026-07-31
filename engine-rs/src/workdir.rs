//! Session workdir — the file-based editing surface for memory entries.
//!
//! Instead of editing entries through JSON parameters in MCP tool calls, agents
//! edit real `.md` files. `expand` writes an entry to the workdir; `sync` reads
//! back changed files and ingests them as new versions. The workdir is
//! session-level (a temp dir), not persistent.
//!
//! Flow:
//!   expand meta:03  →  /tmp/stellario-work/{session}/meta:03.md
//!   agent edits the .md file (Read/Edit — the agent's natural primitives)
//!   sync            →  diffs each .md vs the capsule, writes new versions
//!                       with auto-generated intent from the change
//!
//! The MCP server auto-syncs before every expand (so unsaved edits aren't lost).

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};

use anyhow::{anyhow, Context, Result};

use crate::model::Entry;
use crate::storage::Storage;

/// A session-level workdir for expanded entry files.
pub struct Workdir {
    root: PathBuf,
    /// Track what was last expanded (id → file path), for sync to diff.
    expanded: HashMap<String, ExpandedEntry>,
}

#[derive(Clone)]
struct ExpandedEntry {
    /// The volume:id (e.g. "meta:03").
    id: String,
    volume: String,
    ordinal: String,
    /// The hash of the version that was expanded (to diff against).
    source_hash: String,
    /// The file path in the workdir.
    path: PathBuf,
}

impl Workdir {
    /// Create a session workdir under the system temp dir.
    pub fn new(session_id: &str) -> Result<Self> {
        let root = std::env::temp_dir().join("stellario-work").join(session_id);
        fs::create_dir_all(&root)?;
        Ok(Self { root, expanded: HashMap::new() })
    }

    /// Expand an entry to a `.md` file in the workdir. Returns the file path.
    pub fn expand(&mut self, entry: &Entry) -> Result<PathBuf> {
        let path = self.root.join(format!("{}.md", entry.id));
        let content = render_entry_md(entry);
        fs::write(&path, &content)
            .with_context(|| format!("writing {}", path.display()))?;

        let (volume, ordinal) = entry.id.split_once(':')
            .unwrap_or(("unknown", "0"));
        self.expanded.insert(
            entry.id.clone(),
            ExpandedEntry {
                id: entry.id.clone(),
                volume: volume.to_string(),
                ordinal: ordinal.to_string(),
                source_hash: entry.hash.clone(),
                path: path.clone(),
            },
        );
        Ok(path)
    }

    /// Expand a brand-new entry (not yet in the capsule) as a template file.
    /// Agent fills it in, then sync ingests it.
    pub fn expand_new(&mut self, volume: &str, ordinal_hint: &str) -> Result<PathBuf> {
        let id = format!("{}:{}", volume, ordinal_hint);
        let path = self.root.join(format!("{}.md", id));
        let template = format!(
            "# {id}\n\n<!-- Edit below. First line starting with ## becomes the title. -->\n<!-- Tags: comma-separated, e.g. type:design, module:auth -->\n<!-- Keywords: comma-separated -->\n\n## Title\n\nWrite content here.\n",
            id = id
        );
        fs::write(&path, &template)?;
        self.expanded.insert(
            id.clone(),
            ExpandedEntry {
                id,
                volume: volume.to_string(),
                ordinal: ordinal_hint.to_string(),
                source_hash: String::new(), // empty = new entry
                path: path.clone(),
            },
        );
        Ok(path)
    }

    /// Sync all expanded files: diff each against its source, ingest changed ones.
    /// Returns a list of (id, action) where action is "written" or "unchanged".
    pub fn sync<S: Storage + ?Sized>(&mut self, storage: &mut S, author: &str) -> Result<Vec<(String, &'static str)>> {
        let mut results = Vec::new();
        // Collect the IDs first to avoid borrowing self during the loop.
        let ids: Vec<String> = self.expanded.keys().cloned().collect();

        for id in ids {
            let exp = self.expanded.get(&id).cloned();
            let Some(exp) = exp else { continue };

            let file_content = match fs::read_to_string(&exp.path) {
                Ok(c) => c,
                Err(_) => {
                    // File was deleted — skip (or could mean "forget").
                    results.push((id, "deleted"));
                    continue;
                }
            };

            // Parse the md back into (content, tags, keywords).
            let (content, tags, keywords) = parse_entry_md(&file_content);

            if exp.source_hash.is_empty() {
                // New entry — write it.
                let intent = format!("new entry {}", id);
                storage.write(&exp.volume, None, &content, &tags, &keywords, author, &intent, &[], &[])?;
                // Update source_hash so a re-sync doesn't re-ingest.
                if let Some(e) = self.expanded.get_mut(&id) {
                    e.source_hash = crate::model::Version::compute_hash(&content, &tags, &keywords);
                }
                results.push((id, "created"));
            } else {
                // Existing entry — check if content changed.
                let new_hash = crate::model::Version::compute_hash(&content, &tags, &keywords);
                if new_hash == exp.source_hash {
                    results.push((id, "unchanged"));
                    continue;
                }
                // Changed — write new version. Intent is auto-generated.
                let intent = auto_intent(&file_content, &exp.source_hash);
                storage.write(&exp.volume, Some(&exp.ordinal), &content, &tags, &keywords, author, &intent, &[], &[])?;
                // Update source_hash so a re-sync doesn't re-ingest.
                if let Some(e) = self.expanded.get_mut(&id) {
                    e.source_hash = new_hash;
                }
                results.push((id, "revised"));
            }
        }
        Ok(results)
    }

    /// List currently expanded files.
    pub fn list(&self) -> Vec<(String, PathBuf)> {
        self.expanded.iter()
            .map(|(id, e)| (id.clone(), e.path.clone()))
            .collect()
    }
}

/// Render an entry as a human-editable markdown file.
/// Front-matter-ish header carries metadata; body is the content.
fn render_entry_md(entry: &Entry) -> String {
    let mut out = String::new();
    out.push_str(&format!("# {}\n\n", entry.id));
    // Metadata as HTML comments (visible to humans, ignored by markdown renderers).
    out.push_str(&format!("<!-- author: {} -->\n", entry.author));
    if !entry.tags.is_empty() {
        out.push_str(&format!("<!-- tags: {} -->\n", entry.tags.join(", ")));
    }
    if !entry.keywords.is_empty() {
        out.push_str(&format!("<!-- keywords: {} -->\n", entry.keywords.join(", ")));
    }
    out.push_str(&format!("<!-- hash: {} (source version) -->\n", entry.hash));
    out.push_str("\n");
    out.push_str(&entry.content);
    if !entry.content.ends_with('\n') {
        out.push('\n');
    }
    out
}

/// Parse an edited .md file back into (content, tags, keywords).
/// Extracts metadata from HTML comments; the rest is content.
fn parse_entry_md(raw: &str) -> (String, Vec<String>, Vec<String>) {
    let mut tags = Vec::new();
    let mut keywords = Vec::new();
    let mut content_lines = Vec::new();
    let mut past_header = false;

    for line in raw.lines() {
        let trimmed = line.trim();
        if !past_header {
            // Skip the # id line and blank lines before content.
            if trimmed.starts_with("# ") {
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("<!-- tags:") {
                if let Some(val) = rest.strip_suffix("-->") {
                    tags = val.trim().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                }
                continue;
            }
            if let Some(rest) = trimmed.strip_prefix("<!-- keywords:") {
                if let Some(val) = rest.strip_suffix("-->") {
                    keywords = val.trim().split(',').map(|s| s.trim().to_string()).filter(|s| !s.is_empty()).collect();
                }
                continue;
            }
            if trimmed.starts_with("<!--") {
                continue; // skip author/hash comments
            }
            if trimmed.is_empty() {
                if content_lines.is_empty() {
                    continue; // skip leading blanks
                }
            }
            past_header = true;
        }
        content_lines.push(line);
    }

    let content = content_lines.join("\n").trim().to_string();
    (content, tags, keywords)
}

/// Auto-generate an intent from the edit. Since we don't have a diff library
/// handy, we use a simple heuristic: the first changed line.
fn auto_intent(_raw: &str, _source_hash: &str) -> String {
    // TODO: line-level diff for a meaningful intent. For now, a generic one.
    "edited via workdir".to_string()
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::storage::AutomergeStorage;

    #[test]
    fn expand_then_edit_then_sync() {
        let mut storage = AutomergeStorage::new();
        // Seed an entry.
        let (_, _) = storage.write(
            "meta", None,
            "## Auth Design\nUse JWT with RS256.",
            &["type:design".into()],
            &["jwt".into()],
            "agent", "initial design", &[], &[],
        ).unwrap();

        let entry = storage.materialize("meta", "1").unwrap().unwrap();

        // Expand to workdir.
        let mut wd = Workdir::new("test-expand").unwrap();
        let path = wd.expand(&entry).unwrap();
        assert!(path.exists());

        // Simulate an edit: change the content.
        let raw = fs::read_to_string(&path).unwrap();
        let edited = raw.replace("Use JWT with RS256.", "Use Ed25519 instead. More modern.");
        fs::write(&path, &edited).unwrap();

        // Sync — should detect the change and write a new version.
        let results = wd.sync(&mut storage, "agent").unwrap();
        assert_eq!(results.len(), 1);
        assert_eq!(results[0].1, "revised");

        // Verify: materialize now returns the new content.
        let updated = storage.materialize("meta", "1").unwrap().unwrap();
        assert!(updated.content.contains("Ed25519"));
        assert!(!updated.content.contains("RS256"));
    }

    #[test]
    fn expand_new_then_sync_creates() {
        let mut storage = AutomergeStorage::new();
        let mut wd = Workdir::new("test-new").unwrap();

        let path = wd.expand_new("meta", "1").unwrap();
        // Fill in the template.
        let edited = "## New Entry\n\nThis is brand new content.\n";
        fs::write(&path, edited).unwrap();

        let results = wd.sync(&mut storage, "agent").unwrap();
        assert_eq!(results[0].1, "created");

        let entry = storage.materialize("meta", "1").unwrap().unwrap();
        assert!(entry.content.contains("brand new content"));
    }

    #[test]
    fn unchanged_file_not_re_written() {
        let mut storage = AutomergeStorage::new();
        storage.write("meta", None, "## X\ncontent", &[], &[], "a", "init", &[], &[]).unwrap();
        let entry = storage.materialize("meta", "1").unwrap().unwrap();

        let mut wd = Workdir::new("test-unchanged").unwrap();
        wd.expand(&entry).unwrap(); // no edit

        let results = wd.sync(&mut storage, "a").unwrap();
        assert_eq!(results[0].1, "unchanged");
    }
}
