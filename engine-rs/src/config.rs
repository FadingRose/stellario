//! config — the `.stellario` repo declaration (constellation §3.7).
//!
//! A directory's stellario semantics come from its own file layout (the
//! shape rule): `.stellario` present → self-declared home, sync automatic;
//! only `.stella/` present → undeclared home, sync needs `--capsule`
//! (that IS staging). This module reads the config and discovers it by
//! walking up from a start directory, git-like.

use std::path::{Path, PathBuf};

use anyhow::{Context, Result};
use serde::Deserialize;

pub const CONFIG_NAME: &str = ".stellario";
pub const DEFAULT_CREATION_DIR: &str = ".stella/";

#[derive(Debug, Clone, Deserialize)]
pub struct RepoConfig {
    /// Capsules this repo's natives sync into by default.
    #[serde(default)]
    pub capsules: Vec<String>,
    /// Creation surface directory (convention; configurable).
    #[serde(default = "default_creation_dir")]
    pub creation_dir: String,
}

fn default_creation_dir() -> String {
    DEFAULT_CREATION_DIR.to_string()
}

impl Default for RepoConfig {
    fn default() -> Self {
        RepoConfig { capsules: Vec::new(), creation_dir: DEFAULT_CREATION_DIR.to_string() }
    }
}

pub fn parse(content: &str) -> Result<RepoConfig> {
    if content.trim().is_empty() {
        return Ok(RepoConfig::default());
    }
    Ok(serde_yaml::from_str(content).context("parsing .stellario")?)
}

/// Walk up from `start` to the nearest directory containing `.stellario`.
/// Returns (config_dir, config).
pub fn discover(start: &Path) -> Option<(PathBuf, RepoConfig)> {
    let mut dir = if start.is_dir() {
        start.to_path_buf()
    } else {
        start.parent()?.to_path_buf()
    };
    loop {
        let candidate = dir.join(CONFIG_NAME);
        if candidate.is_file() {
            if let Ok(content) = std::fs::read_to_string(&candidate) {
                if let Ok(cfg) = parse(&content) {
                    return Some((dir.clone(), cfg));
                }
            }
        }
        dir = dir.parent()?.to_path_buf();
    }
}

/// Does this directory have the staging shape (`.stella/` without config)?
pub fn is_staging_shape(dir: &Path) -> bool {
    discover(dir).is_none() && dir.join(DEFAULT_CREATION_DIR).is_dir()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_config() {
        let cfg = parse("capsules: [edelweiss-core]\ncreation_dir: .stella/\n").unwrap();
        assert_eq!(cfg.capsules, vec!["edelweiss-core"]);
        assert_eq!(cfg.creation_dir, ".stella/");
        // empty → defaults
        let cfg = parse("").unwrap();
        assert!(cfg.capsules.is_empty());
        assert_eq!(cfg.creation_dir, DEFAULT_CREATION_DIR);
    }

    #[test]
    fn discover_walks_up() {
        let root = std::env::temp_dir().join(format!("stella-config-test-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("a/b/c")).unwrap();
        std::fs::write(root.join(".stellario"), "capsules: [edelweiss-core]\n").unwrap();

        let (dir, cfg) = discover(&root.join("a/b/c")).unwrap();
        assert_eq!(dir, root);
        assert_eq!(cfg.capsules, vec!["edelweiss-core"]);

        // staging shape: a tree with .stella/ but no config anywhere above
        let staging_root = std::env::temp_dir().join(format!("stella-staging-test-{}", std::process::id()));
        std::fs::create_dir_all(staging_root.join(".stella")).unwrap();
        assert!(is_staging_shape(&staging_root));
        assert!(!is_staging_shape(&root.join("a/b/c")));
        std::fs::remove_dir_all(&staging_root).ok();
        std::fs::remove_dir_all(&root).ok();
    }
}
