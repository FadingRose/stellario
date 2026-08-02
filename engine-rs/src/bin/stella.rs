//! stella — the unified entry (alias-aware: both names behave identically).
//! All verbs live in `stellario::cli::run`.

fn main() -> anyhow::Result<()> {
    stellario::cli::run()
}
