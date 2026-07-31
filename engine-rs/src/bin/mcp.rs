//! stellario-mcp — MCP readiness notice.
//!
//! The MCP server does NOT implement stellario's operations. It exists for one
//! reason: when a frontend connects via MCP (because it has no Bash/shell), this
//! server tells the agent that the `stellario` CLI exists, where it is, and how
//! to use it. After that, the agent uses the CLI directly via Bash.
//!
//! For frontends WITH Bash (like ZCode), the agent may never even call this — it
//! just uses `stellario <command>` directly. This server is the bootstrap bridge
//! for frontends that discover capabilities through MCP tools/list.
//!
//! The single tool returns a readiness report: binary path, available capsules,
//! and a usage guide. That's it.

use anyhow::Result;
use rmcp::{
    ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    tool, tool_handler, tool_router,
    transport::stdio,
    ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;

struct StellarioMcp {
    tool_router: ToolRouter<Self>,
}

#[derive(Deserialize, JsonSchema)]
struct CheckParams {}

#[tool_router(router = tool_router)]
impl StellarioMcp {
    pub fn new() -> Self {
        Self {
            tool_router: Self::tool_router(),
        }
    }

    /// The only tool: report CLI readiness + usage. After calling this, use the
    /// `stellario` CLI directly via Bash for all operations.
    #[tool(name = "stellario", description = "Check stellario CLI readiness and get usage guide. Returns: binary path, available capsules, and commands. After this, use the CLI directly via Bash — stellario is a command-line tool, not an MCP tool suite.")]
    async fn check(
        &self,
        Parameters(_): Parameters<CheckParams>,
    ) -> String {
        let bin = which_stellario();
        let capsules = discover_capsules();

        let mut out = String::new();
        out.push_str("stellario CLI is ready.\n\n");
        out.push_str(&format!("binary: {}\n", bin));
        out.push_str(&format!("capsules: {}\n\n", capsules.join(", ")));
        out.push_str("Usage (via Bash):\n");
        out.push_str("  stellario list                              — list capsules\n");
        out.push_str("  stellario volumes --capsule NAME            — list volumes\n");
        out.push_str("  stellario search \"query\" --capsule NAME     — hybrid search\n");
        out.push_str("  stellario show volume:id --capsule NAME     — read an entry\n");
        out.push_str("  stellario expand volume:id --capsule NAME   — expand to .md for editing\n");
        out.push_str("  stellario expand-new VOLUME --capsule NAME  — blank template for new entry\n");
        out.push_str("  stellario sync --capsule NAME --author ID   — ingest .md edits (auto-runs before expand)\n");
        out.push_str("  stellario lineage volume:id --capsule NAME  — version+intent timeline\n");
        out.push_str("  stellario write -v VOL -c CONTENT -i INTENT -a AUTHOR  — direct write (no file editing)\n");
        out.push_str("\nEditing flow: expand → Edit the .md file → sync (automatic on next expand).\n");
        out.push_str("Files are cleaned up after sync. No stale state.\n");

        if bin.is_empty() {
            out.push_str("\n⚠ stellario binary not found in PATH. Install: cargo build --release --bin stellario\n");
        }

        out
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for StellarioMcp {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::default()
            .with_server_info(Implementation::new("stellario", "0.1.0"))
    }
}

fn which_stellario() -> String {
    // Check common locations.
    for candidate in [
        std::env::var("STELLARIO_BIN").ok(),
        which_in_path(),
        dirs_home_stellario(),
    ] {
        if let Some(path) = candidate {
            if std::path::Path::new(&path).exists() {
                return path;
            }
        }
    }
    String::new()
}

fn which_in_path() -> Option<String> {
    let out = std::process::Command::new("which").arg("stellario").output().ok()?;
    if out.status.success() {
        Some(String::from_utf8_lossy(&out.stdout).trim().to_string())
    } else {
        None
    }
}

fn dirs_home_stellario() -> Option<String> {
    let home = std::env::var("HOME").ok()?;
    Some(format!("{}/.local/bin/stellario", home))
}

fn stellario_root() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home).join(".stellario")
}

fn discover_capsules() -> Vec<String> {
    let projects = stellario_root().join("projects");
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                let dev_dir = entry.path();
                if let Ok(sub) = std::fs::read_dir(&dev_dir) {
                    for d in sub.flatten() {
                        if d.path().join("capsule.automerge").exists() {
                            names.push(entry.file_name().to_string_lossy().to_string());
                            break;
                        }
                    }
                }
            }
        }
    }
    names.sort();
    names
}

#[tokio::main]
async fn main() -> Result<()> {
    eprintln!("stellario-mcp: readiness notice (use the stellario CLI for all operations)");
    let server = StellarioMcp::new();
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
