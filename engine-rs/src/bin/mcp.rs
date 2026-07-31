//! stellario-mcp — MCP server (stdio transport).
//!
//! Frontend-agnostic exposure of the stellario engine over MCP. The server is
//! **stateful**: it starts with no capsule loaded. The agent drives bootstrap
//! through a sequence of tool calls whose descriptions are self-explanatory:
//!
//!   1. `list_capsules`   — discover available project capsules
//!   2. `load_capsule`    — load one into the session (state)
//!   3. `select_identity` — load an agent identity; returns meta (recall bootstrap)
//!   4. `write` / `show` / `search` / `lineage` — operate within the loaded capsule
//!
//! The server holds: the loaded project capsule (+ its on-disk path, for
//! persistence), the current session identity, and the global capsule (identity
//! registry, always loaded from ~/.stellario/global/).
//!
//! Writes persist: every `write` saves the capsule back to disk.

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

// ─── Paths ─────────────────────────────────────────────────────────────────

/// ~/.stellario — the cluster root.
fn stellario_root() -> std::path::PathBuf {
    let home = std::env::var("HOME").unwrap_or_else(|_| "/tmp".into());
    std::path::PathBuf::from(home).join(".stellario")
}

/// ~/.stellario/projects/{name}/{device}/capsule.automerge
fn project_capsule_path(name: &str) -> Option<std::path::PathBuf> {
    let projects = stellario_root().join("projects").join(name);
    // Find the device subdir (first one with a capsule).
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            let cap = entry.path().join("capsule.automerge");
            if cap.exists() {
                return Some(cap);
            }
        }
    }
    None
}

/// List project names that have a capsule.
fn discover_capsules() -> Vec<String> {
    let projects = stellario_root().join("projects");
    let mut names = Vec::new();
    if let Ok(entries) = std::fs::read_dir(&projects) {
        for entry in entries.flatten() {
            if entry.path().is_dir() {
                if let Some(cap) = project_capsule_path(&entry.file_name().to_string_lossy()) {
                    if cap.exists() {
                        names.push(entry.file_name().to_string_lossy().to_string());
                    }
                }
            }
        }
    }
    names.sort();
    names
}

// ─── Server state ──────────────────────────────────────────────────────────

/// The loaded project capsule + its on-disk path (for persistence).
struct LoadedCapsule {
    storage: AutomergeStorage,
    path: std::path::PathBuf,
}

struct StellarioServer {
    /// The loaded project capsule. None until `load_capsule` is called.
    capsule: Arc<RwLock<Option<LoadedCapsule>>>,
    /// The global capsule (identity registry) + its on-disk path. Loaded from
    /// ~/.stellario/global at startup. register_identity persists here.
    global: Arc<RwLock<LoadedCapsule>>,
    /// Current session identity.
    identity: Arc<RwLock<Option<ResolvedIdentity>>>,
    tool_router: ToolRouter<Self>,
}

// ─── Tool parameter schemas ────────────────────────────────────────────────

#[derive(Deserialize, JsonSchema)]
struct LoadCapsuleParams {
    /// Project name (e.g. "edelweiss-core"), as returned by list_capsules.
    name: String,
}

#[derive(Deserialize, JsonSchema)]
struct SelectIdentityParams {
    /// The agent name to load (e.g. "edelweiss"). Must be registered in the global capsule.
    name: String,
}

#[derive(Deserialize, JsonSchema)]
struct RegisterIdentityParams {
    /// The agent name (e.g. "edelweiss"). Becomes its lookup key.
    name: String,
    /// Human-readable display name (e.g. "Edelweiss").
    display: String,
    /// What this agent does / its meta (shown on select_identity).
    description: String,
}

#[derive(Deserialize, JsonSchema)]
struct WriteParams {
    volume: String,
    #[serde(default)]
    target_id: Option<String>,
    content: String,
    #[serde(default)]
    tags: Vec<String>,
    #[serde(default)]
    keywords: Vec<String>,
    /// REQUIRED: why this write is happening (the recall thread).
    intent: String,
}

#[derive(Deserialize, JsonSchema)]
struct ShowParams {
    volume: String,
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
    pub fn new() -> Self {
        // Load or create the global capsule (identity registry).
        let global_dir = stellario_root().join("global");
        let global_path = {
            let mut found = None;
            if let Ok(entries) = std::fs::read_dir(&global_dir) {
                for entry in entries.flatten() {
                    let cap = entry.path().join("capsule.automerge");
                    if cap.exists() {
                        found = Some(cap);
                        break;
                    }
                }
            }
            // If no global capsule exists yet, create one in the first device dir.
            found.unwrap_or_else(|| {
                let dev = global_dir.join("default");
                std::fs::create_dir_all(&dev).ok();
                dev.join("capsule.automerge")
            })
        };

        let global_storage = match std::fs::read(&global_path) {
            Ok(bytes) if !bytes.is_empty() => AutomergeStorage::load(&bytes).unwrap_or_else(|_| AutomergeStorage::new()),
            _ => {
                // Fresh global capsule — persist immediately so the path is valid.
                let mut s = AutomergeStorage::new();
                if let Ok(bytes) = s.save() {
                    let _ = std::fs::create_dir_all(global_path.parent().unwrap_or(&global_dir));
                    let _ = std::fs::write(&global_path, &bytes);
                }
                s
            }
        };

        Self {
            capsule: Arc::new(RwLock::new(None)),
            global: Arc::new(RwLock::new(LoadedCapsule { storage: global_storage, path: global_path })),
            identity: Arc::new(RwLock::new(None)),
            tool_router: Self::tool_router(),
        }
    }

    /// Discover available project capsules.
    #[tool(name = "list_capsules", description = "List available project capsules you can load. Call this first to see what's available.")]
    async fn list_capsules(&self) -> Result<Json<serde_json::Value>, String> {
        let names = discover_capsules();
        Ok(Json(serde_json::json!(names)))
    }

    /// Load a project capsule into the session.
    #[tool(name = "load_capsule", description = "Load a project capsule by name (from list_capsules). Must be called before write/show/search/lineage.")]
    async fn load_capsule(
        &self,
        Parameters(LoadCapsuleParams { name }): Parameters<LoadCapsuleParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let path = project_capsule_path(&name)
            .ok_or_else(|| format!("no capsule found for project '{}'", name))?;
        let bytes = std::fs::read(&path).map_err(|e| e.to_string())?;
        let storage = AutomergeStorage::load(&bytes).map_err(|e| e.to_string())?;
        let vol_count = storage.volume_names().unwrap_or_default().len();
        *self.capsule.write().await = Some(LoadedCapsule { storage, path: path.clone() });
        Ok(Json(serde_json::json!({
            "loaded": name,
            "volumes": vol_count,
        })))
    }

    /// Recall bootstrap: load an agent identity + return its meta.
    #[tool(name = "select_identity", description = "Load an agent identity by name. Returns the agent's meta. Establishes session identity for write provenance. Call after load_capsule. Use register_identity first if the name doesn't exist.")]
    async fn select_identity(
        &self,
        Parameters(SelectIdentityParams { name }): Parameters<SelectIdentityParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let global = self.global.read().await;
        let resolved = select_identity(&global.storage, &name).map_err(|e| e.to_string())?;
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

    /// Register a new agent identity in the global capsule. Persists to disk.
    #[tool(name = "register_identity", description = "Register a new agent identity. Persists to the global capsule. Call this once per agent, then use select_identity to load it.")]
    async fn register_identity(
        &self,
        Parameters(RegisterIdentityParams { name, display, description }): Parameters<RegisterIdentityParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let (id, hash) = {
            let mut global = self.global.write().await;
            let mut storage = std::mem::replace(&mut global.storage, AutomergeStorage::new());
            let result = stellario::register_identity(&mut storage, &name, &display, &description, "bootstrap");
            global.storage = storage;
            result.map_err(|e| e.to_string())?
        };
        // Persist global capsule to disk.
        persist_capsule(&self.global).await;
        Ok(Json(serde_json::json!({
            "id": format!("identity:{}", id),
            "hash": hash,
            "registered": name,
        })))
    }

    /// Append a version with intent. Persists to disk. Requires load_capsule + select_identity.
    #[tool(name = "write", description = "Write a memory entry (new or revision) with a required intent. Persists immediately. Requires load_capsule + select_identity first.")]
    async fn write(
        &self,
        Parameters(WriteParams { volume, target_id, content, tags, keywords, intent }): Parameters<WriteParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let author = self.identity.read().await.as_ref()
            .map(|i| i.instance.clone())
            .ok_or("no identity selected — call select_identity first")?;

        let (id, hash) = {
            let mut cap_guard = self.capsule.write().await;
            let loaded = cap_guard.as_mut()
                .ok_or("no capsule loaded — call load_capsule first")?;
            let mut storage = std::mem::replace(&mut loaded.storage, AutomergeStorage::new());
            let result = storage.write(&volume, target_id.as_deref(), &content, &tags, &keywords, &author, &intent, &[], &[]);
            loaded.storage = storage;
            result.map_err(|e| e.to_string())?
        };

        // Persist to disk.
        {
            let cap_guard = self.capsule.write().await;
            if cap_guard.is_some() {
                drop(cap_guard);
                // persist_capsule needs a &Arc<RwLock<LoadedCapsule>>, but our
                // capsule is Option<LoadedCapsule>. We persist by reconstructing.
                let mut guard = self.capsule.write().await;
                if let Some(loaded) = guard.as_mut() {
                    let mut storage = std::mem::replace(&mut loaded.storage, AutomergeStorage::new());
                    let result = storage.save();
                    loaded.storage = storage;
                    if let Ok(bytes) = result {
                        let path = loaded.path.clone();
                        drop(guard);
                        let _ = std::fs::write(&path, &bytes);
                    }
                }
            }
        }

        Ok(Json(serde_json::json!({
            "id": format!("{}:{}", volume, id),
            "hash": hash,
        })))
    }

    /// Read an entry's current state.
    #[tool(name = "show", description = "Read an entry by volume and id. Returns the latest active (non-superseded) version.")]
    async fn show(
        &self,
        Parameters(ShowParams { volume, id }): Parameters<ShowParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let loaded = cap.as_ref().ok_or("no capsule loaded — call load_capsule first")?;
        let entry = loaded.storage.materialize(&volume, &id).map_err(|e| e.to_string())?
            .ok_or_else(|| format!("entry {}:{} not found", volume, id))?;
        Ok(Json(serde_json::to_value(&entry).map_err(|e| e.to_string())?))
    }

    /// Telescope hybrid search.
    #[tool(name = "search", description = "Hybrid search across active entries: weighted text matching (fzf) + semantic keyword similarity. Use tags/tags_any/tags_not for filtering.")]
    async fn search(
        &self,
        Parameters(SearchParamsMcp { query, volumes, tags, tags_any, tags_not, limit }): Parameters<SearchParamsMcp>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let loaded = cap.as_ref().ok_or("no capsule loaded — call load_capsule first")?;
        let params = SearchParams { query, volumes, tags, tags_any, tags_not, limit, no_semantic: false };
        let hits = search(&loaded.storage, &params).map_err(|e| e.to_string())?;
        let results: Vec<serde_json::Value> = hits.iter().map(|h| serde_json::json!({
            "id": h.entry.id,
            "score": (h.score * 10.0).round() / 10.0,
            "title": extract_title(&h.entry.content),
            "tags": h.entry.tags,
        })).collect();
        Ok(Json(serde_json::json!(results)))
    }

    /// Version+intent timeline for one entry.
    #[tool(name = "lineage", description = "View the evolution timeline of an entry: each version with its write intent, newest first.")]
    async fn lineage(
        &self,
        Parameters(LineageParams { volume, id }): Parameters<LineageParams>,
    ) -> Result<Json<serde_json::Value>, String> {
        let cap = self.capsule.read().await;
        let loaded = cap.as_ref().ok_or("no capsule loaded — call load_capsule first")?;
        let steps = loaded.storage.lineage(&volume, &id).map_err(|e| e.to_string())?;
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

/// Persist a LoadedCapsule to disk (swap out, save, swap back, write file).
async fn persist_capsule(lock: &Arc<RwLock<LoadedCapsule>>) {
    let mut guard = lock.write().await;
    let mut storage = std::mem::replace(&mut guard.storage, AutomergeStorage::new());
    let result = storage.save();
    guard.storage = storage;
    if let Ok(bytes) = result {
        let path = guard.path.clone();
        drop(guard);
        let _ = std::fs::write(&path, &bytes);
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
    eprintln!("stellario-mcp: ready (no capsule loaded — call list_capsules)");
    let server = StellarioServer::new();
    let service = server.serve(stdio()).await?;
    service.waiting().await?;
    Ok(())
}
