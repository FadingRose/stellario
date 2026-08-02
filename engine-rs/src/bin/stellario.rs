//! stellario — alias entry for the unified tool (compat with old muscle
//! memory). Same binary behavior as `stella`.

fn main() -> anyhow::Result<()> {
    stellario::cli::run()
}
