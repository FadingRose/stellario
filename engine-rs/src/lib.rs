//! Stellario engine — Rust core.
//!
//! Self-sufficient engine: the evolution-graph memory model (version + intent
//! + typed edges) on an Automerge storage substrate, exposed via MCP/CLI in
//! later phases.
//!
//! Layers:
//!   model    — Version / Edge / Entry (entry is a materialized view)
//!   storage  — Storage trait + AutomergeStorage impl (the meaning plane)
//!   migrate  — JSONL → version-graph migration (phase-0 risk gate)

pub mod config;
pub mod constellation;
pub mod export;
pub mod harvest;
pub mod identity;
pub mod index;
pub mod lint;
pub mod migrate;
pub mod parse;
pub mod model;
pub mod storage;
pub mod telescope;
pub mod workdir;

pub use identity::{author_for, list_identities, register_identity, select_identity, ResolvedIdentity};
pub use migrate::{migrate_project, MigrationOptions, MigrationReport};
pub use model::{Edge, EdgeKind, Entry, MemRef, Version};
pub use storage::{AutomergeStorage, LineageStep, Storage};
pub use telescope::{search, SearchHit, SearchParams};
pub use workdir::{SyncAction, Workdir};
