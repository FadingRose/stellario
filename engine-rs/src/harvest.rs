//! harvest — repo → index entries.
//!
//! Walks `.rs`/`.md` files, extracts `<stellario>` blocks via `parse.rs`,
//! and shapes each block into a `HarvestedEntry` ready for the index.
//! Description extraction is deliberately v1-simple:
//!   - embed  → the contiguous prose paragraph directly above the block
//!   - cascade → the contiguous prose paragraph directly below the block
//! Full-section capture (heading-tree spans) is future work; the paragraph
//! rule already covers the dominant shapes (section-tail embed, top-of-file
//! cascade) without pretending to a document model we don't have yet.

use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::Result;

use crate::parse::{self, Block, Form, Line};
use crate::storage::Storage;
use crate::{Edge, EdgeKind};

/// The capsule volume that holds native (slug) entries.
pub const NATIVE_VOLUME: &str = "native";

/// One repo entry, shaped for the index.
#[derive(Debug, Clone)]
pub struct HarvestedEntry {
    /// The slug (identity).
    pub id: String,
    /// One-sentence tldr from the header.
    pub title: String,
    /// Bound prose (embed: paragraph; native: whole file outside blocks).
    pub description: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    /// `relative/path.rs:start-end` (embed) or `relative/file.stella` (native)
    pub span: String,
    /// embed | cascade
    pub binding: String,
    /// embed | native | star
    pub form: Form,
    /// Wall bullets, flattened to "type: text" lines.
    pub walls: Vec<String>,
    pub author: Option<String>,
}

fn paragraph_above(lines: &[Line], block_start_idx: usize) -> String {
    let mut i = block_start_idx;
    let mut collected: Vec<&str> = Vec::new();
    // Skip blanks, then collect contiguous non-blank content lines.
    while i > 0 {
        i -= 1;
        let ln = &lines[i];
        if !ln.is_content {
            break;
        }
        let t = ln.text.trim();
        if t.is_empty() {
            if collected.is_empty() {
                continue; // still skipping the blank gap
            }
            break; // end of the paragraph
        }
        if t.starts_with('#') || t == parse::OPEN_MARKER || t == parse::CLOSE_MARKER {
            break;
        }
        collected.push(t);
    }
    collected.reverse();
    collected.join(" ")
}

fn paragraph_below(lines: &[Line], block_end_idx: usize) -> String {
    let mut collected: Vec<&str> = Vec::new();
    for ln in lines.iter().skip(block_end_idx + 1) {
        if !ln.is_content {
            break;
        }
        let t = ln.text.trim();
        if t.is_empty() {
            if collected.is_empty() {
                continue;
            }
            break;
        }
        if t.starts_with('#') || t == parse::OPEN_MARKER || t == parse::CLOSE_MARKER {
            break;
        }
        collected.push(t);
    }
    collected.join(" ")
}

fn wall_lines(block: &Block) -> Vec<String> {
    let mut out = Vec::new();
    if let Some(serde_yaml::Value::Sequence(items)) = block.get("walls") {
        for item in items {
            match item {
                serde_yaml::Value::Mapping(m) => {
                    for (k, v) in m {
                        if let (serde_yaml::Value::String(t), serde_yaml::Value::String(text)) = (k, v) {
                            out.push(format!("{t}: {text}"));
                        }
                    }
                }
                serde_yaml::Value::String(s) => out.push(s.clone()),
                _ => {}
            }
        }
    }
    out
}

fn repo_root_for(start: &Path) -> PathBuf {
    let out = Command::new("git")
        .args(["rev-parse", "--show-toplevel"])
        .current_dir(start)
        .output();
    match out {
        Ok(o) if o.status.success() => {
            PathBuf::from(String::from_utf8_lossy(&o.stdout).trim().to_string())
        }
        _ => start.to_path_buf(),
    }
}

/// All prose in a file outside any block's line range (native entries:
/// the whole file is the description).
fn whole_file_prose(lines: &[Line], blocks: &[&Block]) -> String {
    let mut out: Vec<&str> = Vec::new();
    'lines: for ln in lines {
        if !ln.is_content {
            continue;
        }
        for b in blocks {
            if ln.no >= b.start_line && ln.no <= b.end_line {
                continue 'lines;
            }
        }
        let t = ln.text.trim();
        if !t.is_empty() {
            out.push(t);
        }
    }
    out.join("\n")
}

/// Harvest all `<stellario>` blocks under the given paths.
/// Returns (entries, repo_root).
pub fn harvest(paths: &[PathBuf]) -> Result<(Vec<HarvestedEntry>, PathBuf)> {
    let cwd = std::env::current_dir()?;
    let repo_root = repo_root_for(&cwd);

    let mut files = Vec::new();
    parse::collect_files(paths, &mut files);
    files.sort();

    let mut entries = Vec::new();
    for file in &files {
        let Ok(content) = fs::read_to_string(file) else { continue };
        let Some(host) = parse::host_for(file) else { continue };
        let is_native = file.extension().and_then(|e| e.to_str()) == Some("stella");
        let outcome = parse::extract_blocks(file, host, &content);
        let block_refs: Vec<&Block> = outcome.blocks.iter().collect();
        for block in &outcome.blocks {
            let Some(slug) = block.slug() else { continue }; // lint's job to flag
            let rel = file.strip_prefix(&repo_root).unwrap_or(file);
            let (form, description, span) = if is_native {
                (
                    Form::Native,
                    whole_file_prose(&outcome.lines, &block_refs),
                    rel.display().to_string(),
                )
            } else {
                let binding = block.binding().unwrap_or_else(|| "embed".into());
                let description = if binding == "cascade" {
                    paragraph_below(&outcome.lines, block.end_line - 1)
                } else {
                    paragraph_above(&outcome.lines, block.start_line - 1)
                };
                (
                    Form::Embed,
                    description,
                    format!("{}:{}-{}", rel.display(), block.start_line, block.end_line),
                )
            };
            entries.push(HarvestedEntry {
                id: slug,
                title: block.tldr().unwrap_or_default(),
                description,
                tags: block.string_list("tags"),
                keywords: block.string_list("keywords"),
                span,
                binding: block.binding().unwrap_or_else(|| "embed".into()),
                form,
                walls: wall_lines(block),
                author: match block.get("author") {
                    Some(serde_yaml::Value::String(a)) => Some(a.clone()),
                    _ => None,
                },
            });
        }
    }
    Ok((entries, repo_root))
}

/// Mirror `.stella` natives from a creation surface into the capsule
///
/// NOTE(perf): each mirror reindexes the whole capsule afterwards (in the
/// CLI). Incremental reindex over changed slugs only is future work.
/// (constellation §3.6-3.7): create v1 or supersede vN+1 per slug.
///
/// Lint gate: only lint-passing shapes enter the truth store — invalid
/// slugs are reported and skipped (never ingested). The capsule stores the
/// full `.stella` text as content; tags/keywords come from the block.
pub fn mirror_natives_to_capsule<S: Storage + ?Sized>(
    storage: &mut S,
    creation_dir: &Path,
    author: &str,
) -> Result<Vec<String>> {
    let mut synced = Vec::new();
    let Ok(entries) = fs::read_dir(creation_dir) else { return Ok(synced) };
    let mut files: Vec<PathBuf> = entries
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|e| e.to_str()) == Some("stella"))
        .collect();
    files.sort();
    for file in files {
        let Ok(content) = fs::read_to_string(&file) else { continue };
        let outcome = parse::extract_blocks(&file, parse::Host::Markdown, &content);
        let Some(block) = outcome.blocks.first() else { continue };
        let Some(slug) = block.slug() else { continue };
        if !crate::lint::valid_slug(&slug) {
            eprintln!("  [mirror] skip {}: invalid slug {slug:?}", file.display());
            continue;
        }
        // The .stella extension is the claim of discipline — sync enforces
        // it: grammar violations never enter the truth store (lint gate).
        let violations = crate::lint::lint_block(block);
        let errors: Vec<_> = violations
            .iter()
            .filter(|v| v.severity == crate::lint::Severity::Error)
            .collect();
        if !errors.is_empty() {
            eprintln!("  [mirror] skip {}: grammar violations — run `stella lint` first", file.display());
            for v in errors {
                eprintln!("    [{}] {}", v.code, v.message);
            }
            continue;
        }
        let tags = block.string_list("tags");
        let keywords = block.string_list("keywords");
        let prev = storage.materialize(NATIVE_VOLUME, &slug)?;
        // No-op guard: re-mirroring unchanged content must not append a
        // version — a supersede of the only version would tombstone the
        // entry (write() would mark prev superseded with no successor).
        if let Some(p) = &prev {
            if p.content == content {
                continue;
            }
        }
        let intent = if prev.is_some() {
            "repo edit: synced from .stella"
        } else {
            "created: synced from .stella"
        };
        let edges = match prev {
            Some(p) => vec![Edge {
                from: String::new(),
                to: p.hash,
                kind: EdgeKind::Supersede,
                reason: intent.to_string(),
            }],
            None => Vec::new(),
        };
        storage.write(
            NATIVE_VOLUME,
            Some(&slug),
            &content,
            &tags,
            &keywords,
            author,
            intent,
            &[],
            &edges,
        )?;
        synced.push(slug);
    }
    Ok(synced)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::parse::{extract_blocks, Host};

    const SRC: &str = r#"//! The protocol derives barrier layers from declarations.
//!
//! <stellario>
//! header: dumb-pipe-declaration-scheduling — Subsystems declare reads/writes.
//! binding: embed
//! tags: [module:spark-vm]
//! keywords: [dumb-pipe, barrier-derivation]
//! walls:
//!   - not: a lock manager
//! author: kimi-k3
//! </stellario>
"#;

    #[test]
    fn embed_description_is_paragraph_above() {
        let outcome = extract_blocks(Path::new("t.rs"), Host::Rust, SRC);
        let b = &outcome.blocks[0];
        let desc = paragraph_above(&outcome.lines, b.start_line - 1);
        assert_eq!(desc, "The protocol derives barrier layers from declarations.");
        assert_eq!(b.tldr().as_deref(), Some("Subsystems declare reads/writes."));
        assert_eq!(wall_lines(b), vec!["not: a lock manager".to_string()]);
    }

    #[test]
    fn cascade_description_is_paragraph_below() {
        let src = "//! # Module\n//!\n//! <stellario>\n//! header: mod-decl-thing — Declares the module.\n//! binding: cascade\n//! </stellario>\n//!\n//! This module does X and Y.\n//! More of the same paragraph.\n";
        let outcome = extract_blocks(Path::new("t.rs"), Host::Rust, src);
        let b = &outcome.blocks[0];
        let desc = paragraph_below(&outcome.lines, b.end_line - 1);
        assert_eq!(desc, "This module does X and Y. More of the same paragraph.");
    }
}
