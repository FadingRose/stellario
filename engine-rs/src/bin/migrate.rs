//! stellario-migrate — JSONL → Automerge capsule migration tool.
//!
//! Phase-0 risk gate. Converts a seed device's JSONL memory into one Automerge
//! capsule document, with strict integrity verification.
//!
//! Usage:
//!     stellario-migrate <device-memory-dir> [--dry-run] [--allow-dangling-manual]
//!
//! Example:
//!     stellario-migrate ~/.stellario/projects/edelweiss-core/linux-...-321a --dry-run

use std::path::PathBuf;

use anyhow::Result;
use clap::{Parser, ValueHint};

use stellario::{migrate_project, MigrationOptions};

#[derive(Parser)]
#[command(
    name = "stellario-migrate",
    about = "Migrate JSONL memory into an Automerge capsule (phase 0).",
    long_about = "Reads a seed device's JSONL memory directory, normalizes refs, \
                  verifies integrity, and writes one capsule.automerge document. \
                  Run with --dry-run first to validate without writing."
)]
struct Cli {
    /// The device-relative memory directory, e.g.
    /// ~/.stellario/projects/{name}/{device-id}/
    #[arg(value_hint = ValueHint::DirPath)]
    dir: PathBuf,

    /// Validate and report only — write nothing.
    #[arg(long)]
    dry_run: bool,

    /// Carry through dangling MANUAL refs instead of failing. A manual ref to
    /// a missing entry is a data-integrity signal; review before using this.
    #[arg(long)]
    allow_dangling_manual: bool,

    /// Keep dangling AUTO refs (fail instead of dropping them). By default auto
    /// refs to missing entries are dropped — the engine rebuilds them.
    #[arg(long)]
    keep_dangling_auto: bool,
}

fn main() -> Result<()> {
    let cli = Cli::parse();
    let opts = MigrationOptions {
        dry_run: cli.dry_run,
        drop_dangling_auto: !cli.keep_dangling_auto,
        allow_dangling_manual: cli.allow_dangling_manual,
    };

    eprintln!("→ migrating {} (dry_run={})", cli.dir.display(), opts.dry_run);

    let report = migrate_project(&cli.dir, &opts)?;

    print_report(&report);

    if !report.dangling_manual.is_empty() && !opts.allow_dangling_manual {
        // migrate_project already returned Err in this case; this is defensive.
        eprintln!("\n✗ integrity check failed — see dangling refs above.");
        std::process::exit(1);
    }
    Ok(())
}

fn print_report(r: &stellario::MigrationReport) {
    eprintln!("\n── migration report ──");
    eprintln!("  project dir:     {}", r.project_dir.display());
    eprintln!("  dry run:         {}", r.dry_run);
    eprintln!("  entries written: {}", r.entries_written);
    eprintln!("  tasks migrated:  {} (→ task volume)", r.tasks_migrated);
    eprintln!("  refs normalized: {}", r.refs_normalized);
    eprintln!("  auto dropped:    {}", r.dangling_auto_dropped);
    if r.in_progress_normalized > 0 {
        eprintln!(
            "  in_progress→claimed: {} (abolished status normalized)",
            r.in_progress_normalized
        );
    }

    eprintln!("  volumes:");
    if r.volumes_written.is_empty() {
        eprintln!("    (none)");
    }
    let max = r.volumes_written.values().copied().max().unwrap_or(1);
    for (vol, count) in &r.volumes_written {
        let bar_len = (*count as f64 / max as f64 * 30.0).round() as usize;
        eprintln!("    {:<14} {:>4} {}", vol, count, "█".repeat(bar_len));
    }

    if !r.dangling_manual.is_empty() {
        eprintln!("  ⚠ dangling manual refs: {}", r.dangling_manual.len());
        for d in r.dangling_manual.iter().take(15) {
            eprintln!("     {} → {} ({})", d.source, d.target, d.ref_source);
        }
        if r.dangling_manual.len() > 15 {
            eprintln!("     ... and {} more", r.dangling_manual.len() - 15);
        }
    }

    if let Some(bytes) = r.doc_bytes {
        eprintln!("  capsule written: {} bytes", bytes);
        eprintln!("  ✓ migration complete");
    } else if r.dry_run {
        eprintln!("  (dry-run — no capsule written)");
    }
}
