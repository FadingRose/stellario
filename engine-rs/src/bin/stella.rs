//! stella — the lightweight stellario CLI.
//!
//! Two APIs:
//!   stella <query> <intent> [--repo] [--memory]   unified search (Phase 4 — not wired yet)
//!   stella lint <path>...                          stellario-entry grammar checker
//!
//! Query is the primary entry (positionals); `lint` is a reserved first word.
//! Intent is mandatory for queries — every query is a telemetry point.

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, Subcommand};

#[derive(Parser)]
#[command(name = "stella", version, about = "stellario repo plane — query + lint")]
struct Cli {
    /// Search query (not yet wired — Phase 4).
    query: Option<String>,
    /// Search intent (mandatory once query lands).
    intent: Option<String>,
    /// Search repo (comment/doc) entries.
    #[arg(long)]
    repo: bool,
    /// Search memory (capsule) entries.
    #[arg(long)]
    memory: bool,
    #[command(subcommand)]
    cmd: Option<Cmd>,
}

#[derive(Subcommand)]
enum Cmd {
    /// Lint <stellario> entry blocks in .rs/.md files.
    ///
    /// No --fix: violations come with repair suggestions; lint never
    /// rewrites human content. The lint-owned `auto` field is the only
    /// exception (written with a printed notice).
    Lint {
        /// Files or directories to scan (directories are walked recursively).
        #[arg(required = true)]
        paths: Vec<PathBuf>,
    },
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    match cli.cmd {
        Some(Cmd::Lint { paths }) => {
            let report = stellario::lint::run(&paths)?;
            stellario::lint::print_report(&report);
            if report.error_count() > 0 {
                std::process::exit(1);
            }
            Ok(())
        }
        None => match (&cli.query, &cli.intent) {
            (Some(q), Some(i)) => {
                eprintln!("query is not wired yet (Phase 4). query={q:?} intent={i:?}");
                std::process::exit(2);
            }
            _ => {
                eprintln!("usage: stella <query> <intent> [--repo] [--memory]");
                eprintln!("       stella lint <path>...");
                std::process::exit(2);
            }
        },
    }
}
