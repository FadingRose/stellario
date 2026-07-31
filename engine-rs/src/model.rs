//! Data model — the evolution graph.
//!
//! The atom is a **version**, not an entry. An entry's "current state" is a
//! materialized view: the latest non-superseded version for an id. Evolution is
//! carried by three orthogonal axes on each version (see
//! `evolution-graph-memory-history.md`):
//!
//!   - **version** — `volume:id:hash`, a content-addressed full-entry snapshot,
//!     auto-created on every write. Inert; untyped.
//!   - **parent edge** — auto, vertical, to the previous version of the same id.
//!     Carries the required `intent`.
//!   - **typed edge** — explicit, horizontal, between specific version hashes
//!     (supersede/derive_from/validate/constrain). Machine-queryable.
//!
//! Fork is NOT a structure: concurrent writes diverge and are recovered via
//! Automerge `get_all`; no dedicated fork node.
//!
//! ## Identity
//!
//! Identity is `volume:n` (e.g. `active:65`, `task:238`). The legacy `idPrefix`
//! is abolished. A version's full address is `volume:id:hash`.

use serde::{Deserialize, Serialize};

/// A free-form knowledge link between entries (agent association or auto-refs
/// engine output). Distinct from typed evolution edges: refs express
/// *relatedness*, edges express *derivation*. Kept for compatibility with the
/// knowledge-graph layer; evolution is modeled by [`Edge`].
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, autosurgeon::Reconcile, autosurgeon::Hydrate)]
pub struct MemRef {
    pub target: String,
    pub reason: String,
    /// "manual" | "auto"
    pub source: String,
}

/// A content-addressed snapshot — the storage atom.
///
/// `hash` = hash(content + tags + keywords), computed by the storage layer on
/// write. Two writes producing identical content yield the same hash and thus
/// converge with zero conflict.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, autosurgeon::Reconcile, autosurgeon::Hydrate)]
pub struct Version {
    /// Content hash of (content + tags + keywords). The address.
    pub hash: String,
    pub volume: String,
    /// Ordinal within the volume, e.g. "65" → id `active:65`.
    pub id: String,
    pub content: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    pub author: String,
    /// YYYY-MM-DDTHH:MM:SSZ (ISO 8601), to order versions of one id.
    pub created: String,
    /// Snapshot may be superseded; see edges. Kept on the version for query
    /// convenience; the source of truth is a `supersede` edge targeting `hash`.
    #[serde(default)]
    pub superseded: bool,
}

/// How a volume generates ids for new entries. An engine-enforced behavioral
/// constraint, not agent semantics (the agent never picks or knows the id
/// strategy — the storage layer decides at write time).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum IdStrategy {
    /// `volume:n` — next sequential ordinal. For volumes whose entries have a
    /// time/referential dependency (handover audit, tasks, knowledge).
    Sequential,
    /// `volume:<hash>` — random short hash. For entries with no time dependency:
    /// drafts, channels, link structures built on addressable-but-unordered ids.
    Random,
}

impl Default for IdStrategy {
    fn default() -> Self {
        IdStrategy::Sequential
    }
}

/// Whether entries in a volume may be superseded. Engine-enforced: the storage
/// layer rejects a `Supersede` edge targeting a version in a `Forbidden`
/// volume. This replaces the legacy `append` profile — its real meaning was
/// "audit trail: append-only, no overturning," which is exactly supersede
/// forbidden.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum SupersedePolicy {
    Allowed,
    Forbidden,
}

impl Default for SupersedePolicy {
    fn default() -> Self {
        SupersedePolicy::Allowed
    }
}

/// Engine-enforced behavioral attributes of a volume. Stored as capsule
/// metadata (`root.volumedefs`), NOT as an entry — these are constraints the
/// Rust layer enforces, not knowledge the agent interprets. The old four-way
/// `profile` concept (mutable/append/scratch/frozen) collapses into these two
/// orthogonal attributes; frozen/archived is simply a volume that accepts no
/// writes.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, Default)]
pub struct VolumeDef {
    #[serde(default)]
    pub id_strategy: IdStrategy,
    #[serde(default)]
    pub supersede: SupersedePolicy,
}

/// The kind of a typed evolution edge (horizontal, machine-queryable).
///
/// These are the only relations that carry machine-actionable semantics and
/// feed constellation's causal ordering. Free-form refs ([`MemRef`]) are a
/// separate channel.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize, autosurgeon::Reconcile, autosurgeon::Hydrate)]
#[serde(rename_all = "snake_case")]
pub enum EdgeKind {
    /// Auto, vertical: this version follows the previous version of the same id.
    /// Every write creates exactly one parent edge; it carries the `intent`.
    Parent,
    /// This version overturns the target version.
    Supersede,
    /// This version builds on the target version.
    DeriveFrom,
    /// This version confirms/checks the target version.
    Validate,
    /// This version sets a constraint the target must respect.
    Constrain,
}

/// A typed relation between two specific versions.
///
/// `from`/`to` are version hashes, NOT entry ids — an edge pins the exact
/// state the author meant, so later revisions of the target leave the edge
/// intact.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize, autosurgeon::Reconcile, autosurgeon::Hydrate)]
pub struct Edge {
    /// Source version hash.
    pub from: String,
    /// Target version hash.
    pub to: String,
    pub kind: EdgeKind,
    /// For Parent: the required write intent ("why this change"). For typed
    /// edges: the reason for the relation. Empty only for synthetic migration
    /// roots (no prior version).
    #[serde(default)]
    pub reason: String,
}

/// A materialized view — the "current state" of an entry, for state-as-entry
/// tools (show, telescope). Produced by reading the latest non-superseded
/// version of an id. Never the storage atom.
#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
pub struct Entry {
    pub id: String,
    pub volume: String,
    pub content: String,
    pub tags: Vec<String>,
    pub keywords: Vec<String>,
    pub author: String,
    pub created: String,
    pub updated: String,
    /// The hash of the version this view materializes.
    pub hash: String,
    /// Free-form knowledge links (relatedness, not derivation).
    #[serde(default)]
    pub refs: Vec<MemRef>,
    #[serde(default)]
    pub refs_removed: Vec<String>,
    #[serde(default)]
    pub archived_at: Option<String>,
    #[serde(default)]
    pub archived_reason: Option<String>,
}

impl Version {
    /// Compute the content hash from the addressable fields.
    /// Same content + tags + keywords → same hash → free dedup & convergence.
    pub fn compute_hash(content: &str, tags: &[String], keywords: &[String]) -> String {
        use sha2::{Digest, Sha256};
        let mut hasher = Sha256::new();
        hasher.update(content.as_bytes());
        hasher.update(b"\x00");
        // tags and keywords are sorted before hashing so order doesn't matter.
        let mut t = tags.to_vec();
        t.sort();
        for tag in &t {
            hasher.update(tag.as_bytes());
            hasher.update(b"\x01");
        }
        let mut k = keywords.to_vec();
        k.sort();
        for kw in &k {
            hasher.update(kw.as_bytes());
            hasher.update(b"\x02");
        }
        // 12 hex chars — enough collision resistance at stellario scale, short
        // enough that `layer:262:abc123` reads cleanly.
        let digest = hasher.finalize();
        hex::encode(&digest[..6])
    }

    /// The full address of this version.
    pub fn address(&self) -> String {
        format!("{}:{}:{}", self.volume, self.id, self.hash)
    }
}
