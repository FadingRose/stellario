//! lint — stellario-entry grammar checker (P17, `stellario.skill`).
//!
//! Two-phase parsing:
//!   1. host comment stripping (Rust `//` variants; markdown raw, fenced code
//!      blocks treated as code, not content)
//!   2. `<stellario>…</stellario>` zone extraction, YAML subset inside
//!
//! Design rules this enforces (see stellario.skill for the full semantics):
//!   - `header` required: `word-word-word — one sentence tldr.` (3–5 lowercase
//!     hyphenated words; repo-unique slug)
//!   - `binding` required: `embed` | `cascade`
//!   - `walls` bullets typed: `not:` / `traps:` / `warning:`
//!   - block content is English-only (retrieval substrate constraint)
//!   - `chain` paths must resolve relative to the repo root
//!   - refs are state-transparent: `slug.md`, never `slug.state.md`
//!
//! There is NO --fix. Violations are reported with friendly, test-covered
//! repair suggestions; lint never rewrites human-authored content. The one
//! exception is the `auto` field: it is lint-owned (a verifiable blame
//! cache, `<hash> at <commit-time>`), so lint writes/refreshes it and prints
//! a notice for every write.
//!
//! NOTE: span hashing is file-level in v1 (file content excluding stellario
//! blocks). Section-level spans are future work — the auto format already
//! accommodates them without a grammar change.

use std::collections::HashMap;
use std::fs;
use std::path::{Path, PathBuf};
use std::process::Command;

use anyhow::{Context, Result};
use serde_yaml::Value;
use sha2::{Digest, Sha256};

// ─── Public types ──────────────────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Severity {
    Error,
    Warning,
}

#[derive(Debug)]
pub struct Violation {
    pub severity: Severity,
    /// Stable machine code, e.g. "slug-format". Tests key on these.
    pub code: &'static str,
    pub file: PathBuf,
    pub line: usize,
    pub message: String,
    /// Friendly repair guidance. Every code has one; tested.
    pub suggestion: String,
}

#[derive(Debug, Default)]
pub struct LintReport {
    pub violations: Vec<Violation>,
    /// Human-readable notices for auto-field writes.
    pub auto_notices: Vec<String>,
    pub files_scanned: usize,
    pub blocks_found: usize,
}

impl LintReport {
    pub fn error_count(&self) -> usize {
        self.violations.iter().filter(|v| v.severity == Severity::Error).count()
    }
}

// ─── Host handling (phase 1) ───────────────────────────────────────────────

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum Host {
    Rust,
    Markdown,
}

fn host_for(path: &Path) -> Option<Host> {
    match path.extension().and_then(|e| e.to_str()) {
        Some("rs") => Some(Host::Rust),
        Some("md") => Some(Host::Markdown),
        _ => None,
    }
}

/// One source line after host adaptation.
#[derive(Debug)]
struct Line {
    no: usize,
    /// Raw line, unchanged — needed to rewrite `auto` lines in place.
    raw: String,
    /// Content with host comment syntax stripped.
    text: String,
    /// Everything before the stripped content (e.g. "//! "). Reused when
    /// writing `auto` lines so they keep the host comment prefix.
    prefix: String,
    /// True if this line carries harvestable content (comment / markdown
    /// prose). False for code lines and fenced-code lines in markdown.
    is_content: bool,
}

fn strip_host(host: Host, content: &str) -> Vec<Line> {
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

const OPEN_MARKER: &str = "<stellario>";
const CLOSE_MARKER: &str = "</stellario>";

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
#[derive(Debug)]
struct Block {
    file: PathBuf,
    /// 1-based line number of the opening marker.
    start_line: usize,
    /// 1-based line number of the closing marker.
    end_line: usize,
    /// The comment prefix of the block's lines (for auto insertion).
    prefix: String,
    /// Parsed YAML mapping (raw text kept for error reporting).
    map: serde_yaml::Mapping,
}

impl Block {
    fn get(&self, key: &str) -> Option<&Value> {
        self.map.get(Value::String(key.into()))
    }

    /// The slug from `header`, if present and well-formed enough to split.
    fn slug(&self) -> Option<String> {
        match self.get("header") {
            Some(Value::String(h)) => h.splitn(2, " — ").next().map(|s| s.trim().to_string()),
            _ => None,
        }
    }
}

struct ParseOutcome {
    blocks: Vec<Block>,
    lines: Vec<Line>,
    errors: Vec<Violation>,
}

fn extract_blocks(path: &Path, host: Host, content: &str) -> ParseOutcome {
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
                errors.push(Violation {
                    severity: Severity::Error,
                    code: "unclosed-block",
                    file: path.into(),
                    line: ln.no,
                    message: "<stellario> block is never closed".into(),
                    suggestion: format!("add a closing line: {} (same comment prefix as the opening marker)", CLOSE_MARKER),
                });
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
                Err(e) => errors.push(Violation {
                    severity: Severity::Error,
                    code: "yaml-parse",
                    file: path.into(),
                    line: lines[start].no,
                    message: format!("block is not valid YAML: {e}"),
                    suggestion: "block interior is a YAML subset: flat keys, scalar lists (`tags: [a, b]`), typed bullets (`- not: …`). Check indentation. Common cause: `header: slug: tldr` — the slug/tldr separator is ' — ' (em-dash), because ': ' is illegal in a YAML plain scalar.".into(),
                }),
            }
            i = j + 1;
        } else {
            i += 1;
        }
    }
    ParseOutcome { blocks, lines, errors }
}

// ─── Checks ────────────────────────────────────────────────────────────────

const KNOWN_FIELDS: &[&str] = &[
    "header", "binding", "tags", "keywords", "walls", "refs", "chain", "codemap",
    "owner", "author", "auto",
];

const WALL_TYPES: &[&str] = &["not", "traps", "warning"];

/// Slug: 3–5 lowercase alphanumeric words joined by single hyphens.
fn valid_slug(slug: &str) -> bool {
    let parts: Vec<&str> = slug.split('-').collect();
    if !(3..=5).contains(&parts.len()) {
        return false;
    }
    parts.iter().all(|p| !p.is_empty() && p.chars().all(|c| c.is_ascii_lowercase() || c.is_ascii_digit()))
}

fn check_header(block: &Block, out: &mut Vec<Violation>) {
    match block.get("header") {
        None => out.push(Violation {
            severity: Severity::Error,
            code: "header-required",
            file: block.file.clone(),
            line: block.start_line,
            message: "missing required field `header`".into(),
            suggestion: "add: header: word-word-word — one sentence tldr. (3-5 lowercase words joined by '-', then ' — ', then one sentence; em-dash because ': ' breaks YAML). The slug is the entry's identity; keep it stable.".into(),
        }),
        Some(Value::String(h)) => {
            let Some((slug, tldr)) = h.split_once(" — ") else {
                out.push(Violation {
                    severity: Severity::Error,
                    code: "slug-format",
                    file: block.file.clone(),
                    line: block.start_line,
                    message: format!("header does not split into `slug — tldr` — got {h:?}"),
                    suggestion: "format is `slug — one sentence.` separated by ' — ' (space, em-dash, space). NOTE: ': ' is NOT allowed — colon-space breaks YAML plain scalars (this is why the separator is the em-dash).".into(),
                });
                return;
            };
            if !valid_slug(slug) {
                out.push(Violation {
                    severity: Severity::Error,
                    code: "slug-format",
                    file: block.file.clone(),
                    line: block.start_line,
                    message: format!("slug {slug:?} is not 3-5 lowercase hyphenated words"),
                    suggestion: "use 3-5 lowercase words joined by single hyphens, e.g. `dumb-pipe-declaration-scheduling`. Three words is the collision-safety floor; five is the 'do not smuggle a sentence into the address' ceiling.".into(),
                });
            }
            if tldr.trim().is_empty() {
                out.push(Violation {
                    severity: Severity::Error,
                    code: "tldr-empty",
                    file: block.file.clone(),
                    line: block.start_line,
                    message: "header tldr is empty".into(),
                    suggestion: "the tldr is the highest-density sentence of the entry: state what this IS in one sentence. If it does not fit, split into two entries.".into(),
                });
            }
        }
        Some(_) => out.push(Violation {
            severity: Severity::Error,
            code: "slug-format",
            file: block.file.clone(),
            line: block.start_line,
            message: "header must be a plain string `slug: tldr`".into(),
            suggestion: "write it as one line: header: word-word-word — one sentence tldr.".into(),
        }),
    }
}

fn check_binding(block: &Block, prose_before: bool, out: &mut Vec<Violation>) {
    match block.get("binding") {
        None => out.push(Violation {
            severity: Severity::Error,
            code: "binding-required",
            file: block.file.clone(),
            line: block.start_line,
            message: "missing required field `binding`".into(),
            suggestion: "add `binding: embed` (annotates the prose above; place at section end) or `binding: cascade` (declares the following subtree; place directly under a heading, before prose).".into(),
        }),
        Some(Value::String(b)) if b == "embed" || b == "cascade" => {
            if b == "embed" && !prose_before {
                out.push(Violation {
                    severity: Severity::Warning,
                    code: "embed-no-prose",
                    file: block.file.clone(),
                    line: block.start_line,
                    message: "embed block has no prose above it (case B6)".into(),
                    suggestion: "embed binds to the prose above it — add explanatory prose, or change to `binding: cascade` if this block declares what follows.".into(),
                });
            }
        }
        Some(Value::String(b)) => out.push(Violation {
            severity: Severity::Error,
            code: "binding-value",
            file: block.file.clone(),
            line: block.start_line,
            message: format!("binding must be `embed` or `cascade`, got {b:?}"),
            suggestion: "embed = annotation of the preceding prose (receives inheritance). cascade = declaration for the following subtree (gives inheritance, union-only).".into(),
        }),
        Some(_) => out.push(Violation {
            severity: Severity::Error,
            code: "binding-value",
            file: block.file.clone(),
            line: block.start_line,
            message: "binding must be the string `embed` or `cascade`".into(),
            suggestion: "write: binding: embed  (or: binding: cascade)".into(),
        }),
    }
}

fn check_walls(block: &Block, out: &mut Vec<Violation>) {
    let Some(w) = block.get("walls") else { return };
    let Value::Sequence(items) = w else {
        out.push(Violation {
            severity: Severity::Error,
            code: "walls-shape",
            file: block.file.clone(),
            line: block.start_line,
            message: "walls must be a list of typed bullets, never prose".into(),
            suggestion: "write bullets:\n  walls:\n    - not: what this is not\n    - traps: a falsified judgment (with reference)\n    - warning: a hypothetical danger".into(),
        });
        return;
    };
    for item in items {
        let ok = match item {
            Value::Mapping(m) => m.len() == 1 && m.keys().any(|k| matches!(k, Value::String(s) if WALL_TYPES.contains(&s.as_str()))),
            Value::String(s) => WALL_TYPES.iter().any(|t| s.starts_with(&format!("{t}:"))),
            _ => false,
        };
        if !ok {
            out.push(Violation {
                severity: Severity::Error,
                code: "walls-bullet-type",
                file: block.file.clone(),
                line: block.start_line,
                message: format!("walls bullet must start with not:/traps:/warning: — got {item:?}"),
                suggestion: "type the bullet by its epistemic status: `not:` identity negation (what this is NOT), `traps:` falsified in practice (cite where), `warning:` hypothetical danger (no incident yet).".into(),
            });
        }
    }
}

/// Does a ref/chain/codemap value carry state segments (`slug.seg.md`)?
fn has_state_segment(s: &str) -> bool {
    let path = s.split('#').next().unwrap_or(s);
    let Some(stem) = path.rsplit('/').next() else { return false };
    let Some(base) = stem.strip_suffix(".md") else { return false };
    base.contains('.')
}

fn check_string_list(
    block: &Block,
    field: &str,
    repo_root: &Path,
    check_exists: bool,
    out: &mut Vec<Violation>,
) {
    let Some(v) = block.get(field) else { return };
    let Value::Sequence(items) = v else {
        out.push(Violation {
            severity: Severity::Error,
            code: "list-shape",
            file: block.file.clone(),
            line: block.start_line,
            message: format!("`{field}` must be a list (one bullet per target)"),
            suggestion: format!("write:\n  {field}:\n    - first-target\n    - second-target"),
        });
        return;
    };
    for item in items {
        let Value::String(s) = item else { continue };
        if has_state_segment(s) {
            let stem = s.rsplit('/').next().unwrap_or(s);
            let slug = stem.trim_end_matches(".md").split('.').next().unwrap_or("");
            out.push(Violation {
                severity: Severity::Warning,
                code: "state-segment-ref",
                file: block.file.clone(),
                line: block.start_line,
                message: format!("{field} target {s:?} carries a state segment"),
                suggestion: format!("refs are state-transparent: write `{slug}.md` — it matches any `{slug}.*.md`, so renames on state transitions never break the ref."),
            });
        }
        if check_exists && !has_state_segment(s) {
            let path_part = s.split('#').next().unwrap_or(s);
            // codemap entries carry `:linerange` suffixes — strip before resolving.
            let path_part = path_part.split(':').next().unwrap_or(path_part);
            if !path_part.is_empty() && !repo_root.join(path_part).exists() {
                out.push(Violation {
                    severity: Severity::Error,
                    code: "chain-unresolvable",
                    file: block.file.clone(),
                    line: block.start_line,
                    message: format!("{field} target {s:?} does not resolve (repo root: {})", repo_root.display()),
                    suggestion: "chain/codemap paths are relative to the repo root. Check for typos or a moved file; if the doc was renamed with a state segment, write `<slug>.md` instead.".into(),
                });
            }
        }
    }
}

/// Recursively collect string scalars in a YAML value.
fn collect_strings<'a>(v: &'a Value, out: &mut Vec<&'a str>) {
    match v {
        Value::String(s) => out.push(s),
        Value::Sequence(items) => items.iter().for_each(|i| collect_strings(i, out)),
        Value::Mapping(m) => {
            for (k, val) in m {
                collect_strings(k, out);
                collect_strings(val, out);
            }
        }
        _ => {}
    }
}

fn check_english(block: &Block, out: &mut Vec<Violation>) {
    let mut strings = Vec::new();
    for (k, v) in &block.map {
        let mut key_str = Vec::new();
        collect_strings(k, &mut key_str);
        collect_strings(v, &mut strings);
        strings.extend(key_str);
    }
    let mut offenders: Vec<String> = Vec::new();
    for s in strings {
        if s.chars().any(|c| c.is_alphabetic() && !c.is_ascii()) {
            offenders.push(s.chars().take(40).collect());
        }
    }
    if !offenders.is_empty() {
        out.push(Violation {
            severity: Severity::Error,
            code: "non-english",
            file: block.file.clone(),
            line: block.start_line,
            message: format!("block contains non-English text: {}", offenders.join(" | ")),
            suggestion: "block content must be English-only: fzf tokenization and the embedding model are English-centric. Prose outside the block may be any language — the constraint applies to the machine zone only.".into(),
        });
    }
}

fn check_unknown_keys(block: &Block, out: &mut Vec<Violation>) {
    for k in block.map.keys() {
        if let Value::String(s) = k {
            if !KNOWN_FIELDS.contains(&s.as_str()) {
                out.push(Violation {
                    severity: Severity::Warning,
                    code: "unknown-field",
                    file: block.file.clone(),
                    line: block.start_line,
                    message: format!("unknown field {s:?}"),
                    suggestion: format!("known fields: {}. Unknown keys are harvested but warn — if this is a doc-type extension, it belongs in that type's schema.", KNOWN_FIELDS.join(", ")),
                });
            }
        }
    }
}

/// Is there prose above the block? (B6 detection.)
/// Walk upward skipping blank content lines. Heading, code line, or another
/// block's content boundary → no prose. Any other content line → prose.
fn prose_above(lines: &[Line], block_start_idx: usize) -> bool {
    let mut i = block_start_idx;
    while i > 0 {
        i -= 1;
        let ln = &lines[i];
        if !ln.is_content {
            return false; // hit code
        }
        let t = ln.text.trim();
        if t.is_empty() {
            continue;
        }
        if t.starts_with('#') {
            return false; // directly under a heading
        }
        return true;
    }
    false
}

// ─── auto field maintenance (lint-owned) ───────────────────────────────────

/// File-level span hash v1: sha256 over file content with every stellario
/// block (markers + interior) removed. Same for all blocks in one file.
fn span_hash(lines: &[Line], blocks: &[Block]) -> String {
    let mut excluded: Vec<bool> = vec![false; lines.len()];
    for b in blocks {
        for ln in lines.iter() {
            if ln.no >= b.start_line && ln.no <= b.end_line {
                excluded[ln.no - 1] = true;
            }
        }
    }
    let mut hasher = Sha256::new();
    for (idx, ln) in lines.iter().enumerate() {
        if !excluded[idx] {
            hasher.update(ln.raw.as_bytes());
            hasher.update(b"\n");
        }
    }
    hex::encode(hasher.finalize())[..16].to_string()
}

/// Commit time of the file's last change, via git. None if uncommitted/untracked.
fn last_commit_time(repo_root: &Path, file: &Path) -> Option<String> {
    let rel = file.strip_prefix(repo_root).unwrap_or(file);
    let out = Command::new("git")
        .args(["log", "-1", "--format=%cI", "--"])
        .arg(rel)
        .current_dir(repo_root)
        .output()
        .ok()?;
    if !out.status.success() {
        return None;
    }
    let s = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if s.is_empty() { None } else { Some(s) }
}

/// Insert or refresh `auto:` in each block. Rewrites the file in place;
/// returns notices. Only ever touches auto lines — human content is sacred.
fn maintain_auto(
    path: &Path,
    lines: &[Line],
    blocks: &[Block],
    repo_root: &Path,
    notices: &mut Vec<String>,
) -> Result<()> {
    if blocks.is_empty() {
        return Ok(());
    }
    let Some(commit_time) = last_commit_time(repo_root, path) else {
        notices.push(format!("[auto] {}: skipped (file has no git history yet)", path.display()));
        return Ok(());
    };
    let hash = span_hash(lines, blocks);
    let wanted = format!("{hash} at {commit_time}");

    let mut raw_lines: Vec<String> = lines.iter().map(|l| l.raw.clone()).collect();
    let mut changed = false;

    // Process blocks bottom-up so insertions don't shift later line numbers.
    let mut sorted: Vec<&Block> = blocks.iter().collect();
    sorted.sort_by_key(|b| b.end_line);
    for block in sorted.iter().rev() {
        let slug = block.slug().unwrap_or_else(|| "?".into());
        let current = match block.get("auto") {
            Some(Value::String(a)) => Some(a.clone()),
            _ => None,
        };
        if current.as_deref() == Some(wanted.as_str()) {
            continue;
        }
        let auto_line = format!("{}auto: {}", block.prefix, wanted);
        if current.is_some() {
            // Replace the existing auto line inside the block.
            for ln in &lines[block.start_line..block.end_line - 1] {
                if ln.text.trim_start().starts_with("auto:") {
                    raw_lines[ln.no - 1] = auto_line;
                    break;
                }
            }
        } else {
            // Insert before the closing marker line.
            raw_lines.insert(block.end_line - 1, auto_line);
        }
        notices.push(format!(
            "[auto] {}:{} {} -> {}",
            path.display(),
            slug,
            current.as_deref().unwrap_or("none"),
            wanted
        ));
        changed = true;
    }

    if changed {
        fs::write(path, raw_lines.join("\n") + "\n")
            .with_context(|| format!("writing auto field into {}", path.display()))?;
    }
    Ok(())
}

// ─── Driver ────────────────────────────────────────────────────────────────

fn collect_files(paths: &[PathBuf], out: &mut Vec<PathBuf>) {
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

/// Run lint over the given paths. Returns the report; the caller decides the
/// exit code (errors → non-zero).
pub fn run(paths: &[PathBuf]) -> Result<LintReport> {
    let cwd = std::env::current_dir()?;
    let repo_root = repo_root_for(&cwd);

    let mut files = Vec::new();
    collect_files(paths, &mut files);
    files.sort();

    let mut report = LintReport::default();
    let mut slug_seen: HashMap<String, (PathBuf, usize)> = HashMap::new();

    let mut all_blocks: Vec<Block> = Vec::new();
    let mut file_lines: HashMap<PathBuf, Vec<Line>> = HashMap::new();
    let mut file_blocks: HashMap<PathBuf, Vec<usize>> = HashMap::new();

    for file in &files {
        report.files_scanned += 1;
        let content = match fs::read_to_string(file) {
            Ok(c) => c,
            Err(e) => {
                report.violations.push(Violation {
                    severity: Severity::Warning,
                    code: "read-error",
                    file: file.clone(),
                    line: 0,
                    message: format!("cannot read file: {e}"),
                    suggestion: "check permissions/encoding — only UTF-8 text files are lintable.".into(),
                });
                continue;
            }
        };
        let host = host_for(file).expect("filtered by collect_files");
        let outcome = extract_blocks(file, host, &content);
        report.violations.extend(outcome.errors);
        report.blocks_found += outcome.blocks.len();

        let base = all_blocks.len();
        file_blocks.insert(file.clone(), (base..base + outcome.blocks.len()).collect());
        all_blocks.extend(outcome.blocks);
        file_lines.insert(file.clone(), outcome.lines);
    }

    // Per-block checks.
    for (file, idxs) in &file_blocks {
        let lines = &file_lines[file];
        for &idx in idxs {
            let block = &all_blocks[idx];
            let start_idx = block.start_line - 1;
            let prose = prose_above(lines, start_idx);
            let v = &mut report.violations;
            check_header(block, v);
            check_binding(block, prose, v);
            check_walls(block, v);
            check_string_list(block, "chain", &repo_root, true, v);
            check_string_list(block, "codemap", &repo_root, true, v);
            check_string_list(block, "refs", &repo_root, false, v);
            check_english(block, v);
            check_unknown_keys(block, v);

            // Slug uniqueness registry.
            if let Some(slug) = block.slug() {
                if valid_slug(&slug) {
                    if let Some((first_file, first_line)) = slug_seen.get(&slug) {
                        v.push(Violation {
                            severity: Severity::Error,
                            code: "slug-duplicate",
                            file: block.file.clone(),
                            line: block.start_line,
                            message: format!("slug {slug:?} also defined at {}:{}", first_file.display(), first_line),
                            suggestion: "slugs are repo-global identities. Rename one side — if both blocks describe the same thing, merge them; the collision itself is a signal.".into(),
                        });
                    } else {
                        slug_seen.insert(slug, (block.file.clone(), block.start_line));
                    }
                }
            }
        }
    }

    // auto maintenance (lint-owned writes, with notices).
    for (file, idxs) in &file_blocks {
        let lines = &file_lines[file];
        let blocks: Vec<Block> = idxs.iter().map(|&i| all_blocks[i].clone_shallow()).collect();
        maintain_auto(file, lines, &blocks, &repo_root, &mut report.auto_notices)?;
    }

    Ok(report)
}

impl Block {
    /// Clone location + parsed map (cheap enough at lint scale).
    fn clone_shallow(&self) -> Block {
        Block {
            file: self.file.clone(),
            start_line: self.start_line,
            end_line: self.end_line,
            prefix: self.prefix.clone(),
            map: self.map.clone(),
        }
    }
}

/// Print the report in the human-facing format.
pub fn print_report(report: &LintReport) {
    for v in &report.violations {
        let mark = match v.severity {
            Severity::Error => "✗",
            Severity::Warning => "△",
        };
        println!("{} [{}] {}:{} — {}", mark, v.code, v.file.display(), v.line, v.message);
        println!("  fix: {}", v.suggestion.replace('\n', "\n       "));
    }
    for n in &report.auto_notices {
        println!("{n}");
    }
    println!(
        "—\n{} file(s), {} block(s), {} error(s), {} warning(s)",
        report.files_scanned,
        report.blocks_found,
        report.error_count(),
        report.violations.len() - report.error_count()
    );
}

// ─── Tests ─────────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    fn parse_rust(content: &str) -> ParseOutcome {
        extract_blocks(Path::new("test.rs"), Host::Rust, content)
    }

    fn violation_codes(outcome_blocks: &[Block], lines: &[Line]) -> Vec<&'static str> {
        let mut v = Vec::new();
        for b in outcome_blocks {
            let prose = prose_above(lines, b.start_line - 1);
            check_header(b, &mut v);
            check_binding(b, prose, &mut v);
            check_walls(b, &mut v);
            check_english(b, &mut v);
            check_unknown_keys(b, &mut v);
        }
        v.iter().map(|x| x.code).collect()
    }

    const VALID_BLOCK: &str = r#"//! The protocol derives barrier layers from declarations. Subsystems
//! declare reads/writes; the VM never interprets effects.
//!
//! <stellario>
//! header: dumb-pipe-declaration-scheduling — Subsystems declare reads/writes; the VM derives barrier layers.
//! binding: embed
//! tags: [module:spark-vm]
//! keywords: [dumb-pipe]
//! walls:
//!   - not: a lock manager — RwLock was rejected
//!   - warning: adding locks turns the scheduler into a lock manager
//! author: kimi-k3
//! </stellario>
"#;

    #[test]
    fn valid_block_passes() {
        let outcome = parse_rust(VALID_BLOCK);
        assert!(outcome.errors.is_empty(), "parse errors: {:?}", outcome.errors);
        assert_eq!(outcome.blocks.len(), 1);
        let codes = violation_codes(&outcome.blocks, &outcome.lines);
        assert!(codes.is_empty(), "unexpected violations: {codes:?}");
    }

    #[test]
    fn missing_header_and_binding() {
        let src = "//! Some prose here.\n//!\n//! <stellario>\n//! tags: [a]\n//! </stellario>\n";
        let outcome = parse_rust(src);
        let codes = violation_codes(&outcome.blocks, &outcome.lines);
        assert!(codes.contains(&"header-required"), "{codes:?}");
        assert!(codes.contains(&"binding-required"), "{codes:?}");
    }

    #[test]
    fn bad_slug_gets_suggestion() {
        let src = "//! Prose.\n//! <stellario>\n//! header: BadSlug — tldr here.\n//! binding: embed\n//! </stellario>\n";
        let outcome = parse_rust(src);
        let mut v = Vec::new();
        check_header(&outcome.blocks[0], &mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].code, "slug-format");
        assert!(v[0].suggestion.contains("3-5 lowercase"), "suggestion must teach the shape: {}", v[0].suggestion);
    }

    #[test]
    fn embed_without_prose_warns_b6() {
        // Block directly under a heading — no prose between.
        let src = "//! ## Section\n//! <stellario>\n//! header: alpha-beta-gamma — tldr.\n//! binding: embed\n//! </stellario>\n";
        let outcome = parse_rust(src);
        let codes = violation_codes(&outcome.blocks, &outcome.lines);
        assert!(codes.contains(&"embed-no-prose"), "{codes:?}");
    }

    #[test]
    fn walls_bullet_must_be_typed() {
        let src = "//! Prose.\n//! <stellario>\n//! header: alpha-beta-gamma — tldr.\n//! binding: embed\n//! walls:\n//!   - free-form prose bullet\n//! </stellario>\n";
        let outcome = parse_rust(src);
        let mut v = Vec::new();
        check_walls(&outcome.blocks[0], &mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].code, "walls-bullet-type");
        assert!(v[0].suggestion.contains("not:") && v[0].suggestion.contains("traps:") && v[0].suggestion.contains("warning:"));
    }

    #[test]
    fn non_english_block_flagged() {
        let src = "//! 散文。\n//! <stellario>\n//! header: alpha-beta-gamma — 中文描述。\n//! binding: embed\n//! </stellario>\n";
        let outcome = parse_rust(src);
        let mut v = Vec::new();
        check_english(&outcome.blocks[0], &mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].code, "non-english");
        assert!(v[0].suggestion.contains("English-only"));
    }

    #[test]
    fn em_dash_and_typographic_punctuation_pass() {
        // The VALID_BLOCK contains an em-dash — must not trip the English check.
        let outcome = parse_rust(VALID_BLOCK);
        let mut v = Vec::new();
        check_english(&outcome.blocks[0], &mut v);
        assert!(v.is_empty());
    }

    #[test]
    fn state_segment_ref_suggested() {
        let mut v = Vec::new();
        let outcome = parse_rust("//! Prose.\n//! <stellario>\n//! header: alpha-beta-gamma — tldr.\n//! binding: embed\n//! chain:\n//!   - docs/whiteboard/iris-operators.active.md\n//! </stellario>\n");
        check_string_list(&outcome.blocks[0], "chain", Path::new("/nonexistent-root"), false, &mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].code, "state-segment-ref");
        assert!(v[0].suggestion.contains("iris-operators.md"), "{}", v[0].suggestion);
    }

    #[test]
    fn markdown_fenced_code_is_not_content() {
        // Examples inside ``` fences (like stellario.skill itself) must be ignored.
        let src = "# Doc\n\n```rust\n//! <stellario>\n//! header: fake-fake-fake — example.\n//! </stellario>\n```\n\nReal prose.\n\n<stellario>\nheader: real-real-real — tldr.\nbinding: embed\n</stellario>\n";
        let outcome = extract_blocks(Path::new("doc.md"), Host::Markdown, src);
        assert_eq!(outcome.blocks.len(), 1, "fenced example must not be harvested");
        assert_eq!(outcome.blocks[0].slug().as_deref(), Some("real-real-real"));
    }

    #[test]
    fn unclosed_block_is_error() {
        let src = "//! Prose.\n//! <stellario>\n//! header: alpha-beta-gamma — tldr.\n";
        let outcome = parse_rust(src);
        assert_eq!(outcome.errors.len(), 1);
        assert_eq!(outcome.errors[0].code, "unclosed-block");
        assert!(outcome.errors[0].suggestion.contains("</stellario>"));
    }

    #[test]
    fn unknown_field_warns_not_errors() {
        let src = "//! Prose.\n//! <stellario>\n//! header: alpha-beta-gamma — tldr.\n//! binding: embed\n//! mood: happy\n//! </stellario>\n";
        let outcome = parse_rust(src);
        let mut v = Vec::new();
        check_unknown_keys(&outcome.blocks[0], &mut v);
        assert_eq!(v.len(), 1);
        assert_eq!(v[0].severity, Severity::Warning);
        assert_eq!(v[0].code, "unknown-field");
    }

    #[test]
    fn slug_uniqueness_logic() {
        assert!(valid_slug("dumb-pipe-routing"));
        assert!(valid_slug("a-b-c-d-e"));
        assert!(!valid_slug("two-words"));
        assert!(!valid_slug("Six-Word-Slug-With-Caps"));
        assert!(!valid_slug("one--double-dash"));
        assert!(!valid_slug("a-b-c-d-e-f"));
    }

    #[test]
    fn span_hash_excludes_blocks() {
        let with_block = VALID_BLOCK;
        let without_block = "//! The protocol derives barrier layers from declarations. Subsystems\n//! declare reads/writes; the VM never interprets effects.\n//!\n";
        let o1 = parse_rust(with_block);
        let o2 = parse_rust(without_block);
        let h1 = span_hash(&o1.lines, &o1.blocks);
        let h2 = span_hash(&o2.lines, &o2.blocks);
        assert_eq!(h1, h2, "hash must not change when only the block changes");
    }

    #[test]
    fn auto_insert_and_replace() {
        let dir = std::env::temp_dir().join(format!("stella-lint-test-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let file = dir.join("entry.rs");
        fs::write(&file, VALID_BLOCK).unwrap();

        let content = fs::read_to_string(&file).unwrap();
        let outcome = extract_blocks(&file, Host::Rust, &content);
        let blocks: Vec<Block> = outcome.blocks.iter().map(|b| b.clone_shallow()).collect();
        // insert
        let hash = span_hash(&outcome.lines, &blocks);
        let wanted = format!("{hash} at 2026-08-01T00:00:00+00:00");
        let mut raw_lines: Vec<String> = outcome.lines.iter().map(|l| l.raw.clone()).collect();
        let b = &blocks[0];
        raw_lines.insert(b.end_line - 1, format!("{}auto: {}", b.prefix, wanted));
        fs::write(&file, raw_lines.join("\n") + "\n").unwrap();
        let reread = fs::read_to_string(&file).unwrap();
        assert!(reread.contains(&format!("auto: {wanted}")));
        // block must still parse
        let outcome2 = extract_blocks(&file, Host::Rust, &reread);
        assert_eq!(outcome2.blocks.len(), 1);
        assert!(matches!(outcome2.blocks[0].get("auto"), Some(Value::String(_))));
        fs::remove_dir_all(&dir).ok();
    }
}
