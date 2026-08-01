//! constellation — discovery and hygiene for the constellation model (P5).
//!
//! A constellation is a slug's family of files in a `.stella/` directory:
//!   <slug>.stella   canonical native entry (lint-disciplined, indexed)
//!   <slug>.<star>   draft — loose form, gitignored, no grammar discipline
//!
//! No registry: the naming IS the grouping. Discovery is a directory scan;
//! collection state comes from the canonical's `stars:` list; dismissal and
//! demotion are footnotes inside the star files. See
//! docs/proposals/constellation-model.md §3.

use std::fs;
use std::path::{Path, PathBuf};

use crate::parse;

/// Curated star namespace (constellation-model Open Q1, leaning curated).
/// Order matters: the hint offers the first unused name.
pub const STAR_NAMES: &[&str] = &[
    "sirius", "canopus", "vega", "rigel", "polaris", "altair", "antares",
    "betelgeuse", "aldebaran", "capella", "deneb", "fomalhaut", "regulus",
    "spica", "arcturus", "procyon", "castor", "pollux", "bellatrix", "alnilam",
];

#[derive(Debug)]
pub struct StarInfo {
    pub name: String,
    pub path: PathBuf,
    /// `status: dismissed` — dead end kept as a lesson; not "uncollected".
    pub dismissed: bool,
    /// `demoted: <reason>` — a former canonical, overturned.
    pub demoted: Option<String>,
}

#[derive(Debug)]
pub struct CanonicalInfo {
    pub path: PathBuf,
    /// The `stars: [...]` collected list from the canonical's block.
    pub collected: Vec<String>,
    /// The lint-owned auto line (blame cache), if present.
    pub auto: Option<String>,
}

#[derive(Debug)]
pub struct Constellation {
    pub slug: String,
    pub canonical: Option<CanonicalInfo>,
    pub stars: Vec<StarInfo>,
}

impl Constellation {
    /// Stars never distilled nor dismissed — the memory-debt number.
    pub fn uncollected(&self) -> Vec<&StarInfo> {
        let collected: Vec<&str> = self
            .canonical
            .as_ref()
            .map(|c| c.collected.iter().map(|s| s.as_str()).collect())
            .unwrap_or_default();
        self.stars
            .iter()
            .filter(|s| !s.dismissed && s.demoted.is_none() && !collected.contains(&s.name.as_str()))
            .collect()
    }

    /// Vacant head: stars exist but no canonical — an open question.
    pub fn is_vacant(&self) -> bool {
        self.canonical.is_none() && !self.stars.is_empty()
    }

    /// First curated star name not used in this constellation.
    pub fn next_star_hint(&self) -> Option<&'static str> {
        STAR_NAMES
            .iter()
            .find(|n| !self.stars.iter().any(|s| s.name == **n))
            .copied()
    }
}

/// Split a `.stella/`-dir filename into (slug, suffix). Returns None for
/// names without a dot (not part of any constellation).
fn split_name(filename: &str) -> Option<(String, String)> {
    let (slug, suffix) = filename.rsplit_once('.')?;
    if slug.is_empty() || suffix.is_empty() {
        return None;
    }
    Some((slug.to_string(), suffix.to_string()))
}

fn star_info(path: &Path, name: &str) -> StarInfo {
    let content = fs::read_to_string(path).unwrap_or_default();
    let dismissed = content.lines().any(|l| l.trim_start().starts_with("status: dismissed"));
    let demoted = content.lines().find_map(|l| {
        l.trim_start()
            .strip_prefix("demoted:")
            .map(|r| r.trim().to_string())
    });
    StarInfo { name: name.into(), path: path.into(), dismissed, demoted }
}

fn canonical_info(path: &Path) -> CanonicalInfo {
    let mut info = CanonicalInfo { path: path.into(), collected: Vec::new(), auto: None };
    if let Ok(content) = fs::read_to_string(path) {
        let outcome = parse::extract_blocks(path, parse::Host::Markdown, &content);
        if let Some(block) = outcome.blocks.first() {
            info.collected = block.string_list("stars");
            if let Some(serde_yaml::Value::String(a)) = block.get("auto") {
                info.auto = Some(a.clone());
            }
        }
    }
    info
}

/// Discover all constellations in a `.stella/` directory.
pub fn discover(dir: &Path) -> Vec<Constellation> {
    let mut cons: Vec<Constellation> = Vec::new();
    let Ok(entries) = fs::read_dir(dir) else { return cons };
    for entry in entries.flatten() {
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let name = entry.file_name().to_string_lossy().to_string();
        let Some((slug, suffix)) = split_name(&name) else { continue };
        let con = match cons.iter_mut().find(|c| c.slug == slug) {
            Some(c) => c,
            None => {
                cons.push(Constellation { slug, canonical: None, stars: Vec::new() });
                cons.last_mut().unwrap()
            }
        };
        if suffix == "stella" {
            con.canonical = Some(canonical_info(&path));
        } else {
            con.stars.push(star_info(&path, &suffix));
        }
    }
    cons.sort_by(|a, b| a.slug.cmp(&b.slug));
    for c in &mut cons {
        c.stars.sort_by(|a, b| a.name.cmp(&b.name));
    }
    cons
}

/// The hygiene report (sync --status).
pub fn format_report(cons: &[Constellation]) -> String {
    if cons.is_empty() {
        return "no constellations found (no .stella/ directory or it is empty)".into();
    }
    let mut out = String::new();
    for c in cons {
        out.push_str(&format!("{}\n", c.slug));
        match &c.canonical {
            Some(canon) => {
                let auto = canon.auto.as_deref().unwrap_or("no auto yet");
                out.push_str(&format!("  canonical:   {} ({})\n", canon.path.display(), auto));
            }
            None => out.push_str("  canonical:   (vacant — open question)\n"),
        }
        if !c.stars.is_empty() {
            let names: Vec<String> = c
                .stars
                .iter()
                .map(|s| {
                    if s.dismissed {
                        format!("{} (dismissed)", s.name)
                    } else if let Some(r) = &s.demoted {
                        format!("{} (demoted: {})", s.name, r)
                    } else {
                        s.name.clone()
                    }
                })
                .collect();
            out.push_str(&format!("  stars:       {}\n", names.join(", ")));
        }
        let uncollected = c.uncollected();
        if !uncollected.is_empty() {
            let names: Vec<&str> = uncollected.iter().map(|s| s.name.as_str()).collect();
            out.push_str(&format!("  △ uncollected: {}\n", names.join(", ")));
        }
        if let Some(hint) = c.next_star_hint() {
            out.push_str(&format!("  next star:   {hint}\n"));
        }
    }
    out
}

/// One-line side note for query hits (in-path reporting, §3.5).
pub fn side_note(cons: &Constellation) -> Option<String> {
    if cons.is_vacant() {
        return Some(format!("△ constellation '{}' is a vacant head (open question)", cons.slug));
    }
    let n = cons.uncollected().len();
    if n > 0 {
        Some(format!("△ {} uncollected star{} in constellation '{}'", n, if n > 1 { "s" } else { "" }, cons.slug))
    } else {
        None
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn setup() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("stella-cons-test-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("walls-hit-presentation.stella"),
            "# Canonical\n\n<stellario>\nheader: walls-hit-presentation — tldr.\nstars: [sirius, aquila]\n</stellario>\n",
        )
        .unwrap();
        fs::write(dir.join("walls-hit-presentation.sirius"), "fragment one").unwrap();
        fs::write(dir.join("walls-hit-presentation.aquila"), "fragment two").unwrap();
        fs::write(dir.join("walls-hit-presentation.vega"), "loose end").unwrap();
        fs::write(dir.join("walls-hit-presentation.rigel"), "demoted: failed at scale").unwrap();
        fs::write(dir.join("open-question.polaris"), "musings").unwrap();
        dir
    }

    #[test]
    fn discovery_and_uncollected() {
        let dir = setup();
        let cons = discover(&dir);
        assert_eq!(cons.len(), 2);

        let c = cons.iter().find(|c| c.slug == "walls-hit-presentation").unwrap();
        assert!(c.canonical.is_some());
        assert_eq!(c.stars.len(), 4);
        // sirius+aquila collected, rigel demoted → vega is the only debt.
        let un: Vec<&str> = c.uncollected().iter().map(|s| s.name.as_str()).collect();
        assert_eq!(un, vec!["vega"]);
        assert_eq!(c.next_star_hint(), Some("canopus"));
        assert!(side_note(c).unwrap().contains("1 uncollected star"));

        let v = cons.iter().find(|c| c.slug == "open-question").unwrap();
        assert!(v.is_vacant());
        assert!(side_note(v).unwrap().contains("vacant head"));

        let report = format_report(&cons);
        assert!(report.contains("△ uncollected: vega"));
        assert!(report.contains("(vacant — open question)"));
        fs::remove_dir_all(&dir).ok();
    }

    #[test]
    fn split_names() {
        assert_eq!(split_name("foo.stella"), Some(("foo".into(), "stella".into())));
        assert_eq!(split_name("a-b-c.sirius"), Some(("a-b-c".into(), "sirius".into())));
        assert_eq!(split_name("nodots"), None);
    }
}
