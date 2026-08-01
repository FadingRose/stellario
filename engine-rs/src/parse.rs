//! parse — the two-phase `<stellario>` block parser, shared by lint & harvest.
//!
//! Phase 1: host comment stripping (Rust `//` variants; markdown raw with
//! fenced-code exclusion). Phase 2: `<stellario>…</stellario>` zone
//! extraction, YAML subset inside (parsed by serde_yaml).
//!
//! This module owns syntax only — no grammar checks (lint.rs) and no
//! semantics (harvest.rs). See `stellario.skill` for the format spec.

use std::fs;
use std::path::{Path, PathBuf};

// ─── Host handling (phase 1) ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Host {
    Rust,
    Markdown,
}

pub fn host_for(path: &Path) -> Option<Host> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("rs") => Some(Host::Rust),
        Some("md") => Some(Host::Markdown),
        _ => None,
    }
}

/// One source line after host adaptation.
#[derive(Debug)]
pub struct Line {
    pub no: usize,
    /// Raw line, unchanged — needed to rewrite `auto` lines in place.
    pub raw: String,
    /// Content with host comment syntax stripped.
    pub text: String,
    /// Everything before the stripped content (e.g. "//! ").
    pub prefix: String,
    /// True if this line carries harvestable content (comment / markdown
    /// prose). False for code lines and fenced-code lines in markdown.
    pub is_content: bool,
}

pub fn strip_host(host: Host, content: &str) -> Vec<Line> {
    let mut in_fence = false;
    content
        .lines()
        .enumerate()
        .map(|(i, raw)| {
            let no = i + 1;
            match host {
                Host::Markdown => {
                    let trimmed = raw.trim_start();
                    if trimmed.starts_with("```") {
                        in_fence = !in_fence;
                        return Line { no, raw: raw.into(), text: String::new(), prefix: String::new(), is_content: false };
                    }
                    if in_fence {
                        Line { no, raw: raw.into(), text: String::new(), prefix: String::new(), is_content: false }
                    } else {
                        Line { no, raw: raw.into(), text: raw.into(), prefix: String::new(), is_content: true }
                    }
                }
                Host::Rust => {
                    let t = raw.trim_start();
                    for marker in ["//!", "///", "//"] {
                        if let Some(rest) = t.strip_prefix(marker) {
                            let rest = rest.strip_prefix(' ').unwrap_or(rest);
                            let prefix_len = raw.len() - rest.len();
                            return Line {
                                no,
                                raw: raw.into(),
                                text: rest.to_string(),
                                prefix: raw[..prefix_len].to_string(),
                                is_content: true,
                            };
                        }
                    }
                    Line { no, raw: raw.into(), text: String::new(), prefix: String::new(), is_content: false }
                }
            }
        })
        .collect()
}

// ─── Zone extraction (phase 2) ─────────────────────────────────────────────

pub const OPEN_MARKER: &str = "<stellario>";
pub const CLOSE_MARKER: &str = "</stellario>";

/// Normalize a marker line: accepts bare `<stellario>` and the
/// markdown-invisible form `<!-- <stellario> -->`.
fn marker_kind(text: &str) -> Option<bool> {
    let t = text.trim();
    let t = t.strip_prefix("<!--").map(|s| s.trim()).unwrap_or(t);
    let t = t.strip_suffix("-->").map(|s| s.trim()).unwrap_or(t);
    if t == OPEN_MARKER {
        Some(true)
    } else if t == CLOSE_MARKER {
        Some(false)
    } else {
        None
    }
}

/// A parsed `<stellario>` block with its location in the file.
#[derive(Debug, Clone)]
pub struct Block {
    pub file: PathBuf,
    /// 1-based line number of the opening marker.
    pub start_line: usize,
    /// 1-based line number of the closing marker.
    pub end_line: usize,
    /// The comment prefix of the block's lines (for auto insertion).
    pub prefix: String,
    /// Parsed YAML mapping.
    pub map: serde_yaml::Mapping,
}

impl Block {
    pub fn get(&self, key: &str) -> Option<&serde_yaml::Value> {
        self.map.get(serde_yaml::Value::String(key.into()))
    }

    /// The slug from `header`, if present and well-formed enough to split.
    /// Separator is ' — ' (em-dash) — ': ' breaks YAML plain scalars.
    pub fn slug(&self) -> Option<String> {
        match self.get("header") {
            Some(serde_yaml::Value::String(h)) => h.splitn(2, " — ").next().map(|s| s.trim().to_string()),
            _ => None,
        }
    }

    /// The tldr from `header` (text after the em-dash separator).
    pub fn tldr(&self) -> Option<String> {
        match self.get("header") {
            Some(serde_yaml::Value::String(h)) => h.splitn(2, " — ").nth(1).map(|s| s.trim().to_string()),
            _ => None,
        }
    }

    /// A string-list field (tags/keywords/refs/chain/codemap) as Vec<String>.
    pub fn string_list(&self, key: &str) -> Vec<String> {
        match self.get(key) {
            Some(serde_yaml::Value::Sequence(items)) => items
                .iter()
                .filter_map(|i| match i {
                    serde_yaml::Value::String(s) => Some(s.clone()),
                    _ => None,
                })
                .collect(),
            _ => Vec::new(),
        }
    }

    pub fn binding(&self) -> Option<String> {
        match self.get("binding") {
            Some(serde_yaml::Value::String(b)) => Some(b.clone()),
            _ => None,
        }
    }
}

/// Parse-level failures (grammar-neutral; lint maps them to violations).
#[derive(Debug)]
pub enum ParseError {
    Unclosed { line: usize },
    Yaml { line: usize, error: String },
}

pub struct ParseOutcome {
    pub blocks: Vec<Block>,
    pub lines: Vec<Line>,
    pub errors: Vec<ParseError>,
}

pub fn extract_blocks(path: &Path, host: Host, content: &str) -> ParseOutcome {
    let lines = strip_host(host, content);
    let mut blocks = Vec::new();
    let mut errors = Vec::new();
    let mut i = 0;
    while i < lines.len() {
        let ln = &lines[i];
        if ln.is_content && marker_kind(&ln.text) == Some(true) {
            let start = i;
            let mut j = i + 1;
            let mut yaml_lines: Vec<&str> = Vec::new();
            let mut closed = false;
            while j < lines.len() {
                if lines[j].is_content && marker_kind(&lines[j].text) == Some(false) {
                    closed = true;
                    break;
                }
                yaml_lines.push(&lines[j].text);
                j += 1;
            }
            if !closed {
                errors.push(ParseError::Unclosed { line: ln.no });
                i = j;
                continue;
            }
            let yaml_text = yaml_lines.join("\n");
            match serde_yaml::from_str::<serde_yaml::Mapping>(&yaml_text) {
                Ok(map) => blocks.push(Block {
                    file: path.into(),
                    start_line: lines[start].no,
                    end_line: lines[j].no,
                    prefix: lines[start].prefix.clone(),
                    map,
                }),
                Err(e) => errors.push(ParseError::Yaml { line: lines[start].no, error: e.to_string() }),
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    ParseOutcome { blocks, lines, errors }
}

// ─── File collection ───────────────────────────────────────────────────────

pub fn collect_files(paths: &[PathBuf], out: &mut Vec<PathBuf>) {
    for p in paths {
        if p.is_file() {
            if host_for(p).is_some() {
                out.push(p.clone());
            }
        } else if p.is_dir() {
            visit_dir(p, out);
        }
    }
}

fn visit_dir(dir: &Path, out: &mut Vec<PathBuf>) {
    const SKIP: &[&str] = &[".git", "target", "node_modules", ".fastembed_cache", "dist"];
    let Ok(entries) = fs::read_dir(dir) else { return };
    for entry in entries.flatten() {
        let path = entry.path();
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.') || SKIP.contains(&name.as_ref()) {
            continue;
        }
        if path.is_dir() {
            visit_dir(&path, out);
        } else if host_for(&path).is_some() {
            out.push(path);
        }
    }
}
