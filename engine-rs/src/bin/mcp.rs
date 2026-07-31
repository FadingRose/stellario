//! stellario-mcp — MCP server (stdio transport).
//!
//! Exposes stellario's engine over the Model Context Protocol, making it
//! frontend-agnostic: any MCP-compatible client (opencode, Claude Desktop,
//! a CLI, a web UI) consumes the same tools.
//!
//! The server holds:
//!   - a project capsule (AutomergeStorage) — opened at startup from the
//!     capsule path argument,
//!   - the current session identity — set by `select_identity` (recall
//!     bootstrap: resolves who the agent is + returns their meta).
//!
//! Tool surface (phase 4 — grows over time):
//!   select_identity — register/pick an agent; returns meta (recall bootstrap)
//!   write           — append a version with intent (+ optional typed edges)
//!   show            — materialize an entry (latest active version)
//!   search          — telescope hybrid search (fzf + semantic)
//!   lineage         — version+intent timeline for one entry

use std::sync::Arc;

use anyhow::Result;
use rmcp::{
    Json, ServerHandler,
    handler::server::{router::tool::ToolRouter, wrapper::Parameters},
    model::*,
    tool, tool_handler, tool_router,
    transport::stdio,
    ServiceExt,
};
use schemars::JsonSchema;
use serde::Deserialize;
use tokio::sync::RwLock;

use stellario::{AutomergeStorage, ResolvedIdentity, SearchParams, Storage, search, select_identity};

// ─── Server state ──────────────────────────────────────────────────────────

/// The MCP server holds a capsule + the current session identity.
struct StellarioServer {
    capsule: Arc<RwLock<AutomergeStorage>>,
    identity: Arc<RwLock<Option<ResolvedIdentity>>>,
    tool_router: ToolRouter<Self>,
}

// ─── Tool parameter schemas (auto-generate JSON schema via schemars) ───────

#[derive(Deserialize, JsonSchema)]
struct SelectIdentityParams {
    /// The agent name to load (e.g. "edelweiss"). Must be registered.
    name: String,
}

#[derive(Deserialize, JsonSchema)]
struct WriteParams {
    /// Target volume (e.g. "layer", "meta", "task").
    volume: String,
    /// Existing entry id to revise (e.g. "65"), or omit for a new entry.
    /// Storage generates the id if omitted.
    #[serde(default)]
    target_id: Option<String>,
    /// Entry content (markdown; first `## ` heading becomes the title).
    content: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    /// REQUIRED: why this write is happening (the vertical recall thread).
    intent: String,
}

#[derive(Deserialize, JsonSchema)]
struct ShowParams {
    volume: String,
    /// The entry id (e.g. "65" for layer:65).
    id: String,
}

#[derive(Deserialize, JsonSchema)]
struct SearchParamsMcp {
    #[serde(default)]
    query: Option<String>,
    #[serde(default)]
    volumes: Option<Vec<String>>,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    tags_any: Vec<String>,
    #[serde(default)]
    tags_not: Vec<String>,
    #[serde(default)]
    limit: Option<usize>,
}

#[derive(Deserialize, JsonSchema)]
struct LineageParams {
    volume: String,
    id: String,
}

// ─── Tool implementations ─────────────────────────────────────────────────

#[tool_router(router = tool_router)]
impl StellarioServer {
    pub fn new(capsule: AutomergeStorage) -> Self {
        Self {
            capsule: Arc::new(RwLock::new(capsule)),
            identity: Arc::new(RwLock::new(None)),
            tool_router: Self::tool_router(),
        }
    }

    /// Recall bootstrap: load an agent identity + return its meta.
    /// This is the first call a session makes — it establishes who the agent
    /// is and what they should remember.
    #[tool(name = "select_identity", description = "Load an agent identity by name. Returns the agent's meta (recall bootstrap). Must be called before writing.")]
    async fn select_identity(
        &self,
        Parameters(SelectIdentityParams { name }): Parameters<SelectIdentityParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let resolved = select_identity(&cap, &name).map_err(|e| e.to_string())?;
        let meta = resolved.meta.clone();
        let display = resolved.display.clone();
        let instance = resolved.instance.clone();
        *self.identity.write().await = Some(resolved);
        Ok(Json(serde_json::json!({
            "identity": instance,
            "display": display,
            "meta": meta,
        })))
    }

    /// Append a version with intent. Requires select_identity first.
    #[tool(name = "write", description = "Write a memory entry (new or revision). Requires intent — the natural-language reason for this write. Call select_identity first.")]
    async fn write(
        &self,
        Parameters(WriteParams { volume, target_id, content, tags, keywords, intent }): Parameters<WriteParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let author = self.identity.read().await.as_ref()
            .map(|i| i.instance.clone())
            .ok_or("no identity selected — call select_identity first")?;
        let (id, hash) = {
            let mut cap = self.capsule.write().await;
            cap.write(&volume, target_id.as_deref(), &content, &tags, &keywords, &author, &intent, &[], &[])
                .map_err(|e| e.to_string())?
        };
        Ok(Json(serde_json::json!({
            "id": format!("{}:{}", volume, id),
            "hash": hash,
        })))
    }

    /// Read an entry's current state (latest active version).
    #[tool(name = "show", description = "Read an entry by volume and id. Returns the latest active (non-superseded) version.")]
    async fn show(
        &self,
        Parameters(ShowParams { volume, id }): Parameters<ShowParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let entry = cap.materialize(&volume, &id).map_err(|e| e.to_string())?
            .ok_or_else(|| format!("entry {}:{} not found", volume, id))?;
        Ok(Json(serde_json::to_value(&entry).map_err(|e| e.to_string())?))
    }

    /// Telescope hybrid search (fzf + semantic).
    #[tool(name = "search", description = "Hybrid search across active entries: weighted text matching (fzf) + semantic keyword similarity. Use tags/tags_any/tags_not for filtering.")]
    async fn search(
        &self,
        Parameters(SearchParamsMcp { query, volumes, tags, tags_any, tags_not, limit }): Parameters<SearchParamsMcp>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let params = SearchParams { query, volumes, tags, tags_any, tags_not, limit, no_semantic: false };
        let hits = search(&*cap, &params).map_err(|e| e.to_string())?;
        let results: Vec<serde_json::Value> = hits.iter().map(|h| serde_json::json!({
            "id": h.entry.id,
            "score": (h.score * 10.0).round() / 10.0,
            "title": extract_title(&h.entry.content),
            "tags": h.entry.tags,
        })).collect();
        Ok(Json(serde_json::json!(results)))
    }

    /// Version+intent timeline for one entry (how it evolved).
    #[tool(name = "lineage", description = "View the evolution timeline of an entry: each version with its write intent, newest first.")]
    async fn lineage(
        &self,
        Parameters(LineageParams { volume, id }): Parameters<LineageParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let steps = cap.lineage(&volume, &id).map_err(|e| e.to_string())?;
        let timeline: Vec<serde_json::Value> = steps.iter().map(|s| serde_json::json!({
            "hash": s.version.hash,
            "intent": s.intent,
            "superseded": s.version.superseded,
            "author": s.version.author,
            "created": s.version.created,
        })).collect();
        Ok(Json(serde_json::json!(timeline)))
    }
}

#[tool_handler(router = self.tool_router)]
impl ServerHandler for StellarioServer {
    fn get_info(&self) -> ServerInfo {
        ServerInfo::default()
            .with_server_info(Implementation::new("stellario", "0.1.0"))
    }
}

fn extract_title(content: &str) -> String {
    for line in content.lines() {
        let t = line.trim();
        if let Some(r) = t.strip_prefix("## ") {
            return r.trim().to_string();
        }
    }
    content.lines().next().unwrap_or("").chars().take(60).collect()
}

// ─── Entry point ───────────────────────────────────────────────────────────

#[tokio::main]
async fn main() -> Result<()> {
    // TODO: proper arg parsing (clap). For now: capsule path as first arg.
    let args: Vec<String> = std::env::args().collect();
    let capsule_path = args.get(1).cloned().unwrap_or_else(|| {
        eprintln!("usage: stellario-mcp <capsule.automerge path>");
        std::process::exit(1);
    });

    let bytes = std::fs::read(&capsule_path)?;
    let capsule = AutomergeStorage::load(&bytes)?;
    eprintln!("stellario-mcp: loaded capsule {} ({} bytes)", capsule_path, bytes.len());

    let server = StellarioServer::new(capsule);
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
