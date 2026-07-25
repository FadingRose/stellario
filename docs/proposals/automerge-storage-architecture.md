# Proposal: CRDT-Native Storage Architecture (Automerge + Rust)

## Status
Draft — foundational storage-plane proposal. Supersedes `capsule-sync-execution-model.md`
(absorbs its distributed-systems insights; replaces its hand-rolled convergence
machinery with a standard CRDT). Builds on the declaration-first control-plane
refactor (`7634029`).

## Architectural Principle

**The binary is self-sufficient; the TS layer exposes the minimum. Stellario
must not assume its only frontend is opencode.**

This principle is the north star. It shapes every decision below:

- All logic — storage, resolution, injection computation, tool execution —
  lives in the binary. The binary owns correctness.
- The binary exposes capability through a **standard protocol (MCP)**, so any
  MCP-compatible frontend (opencode, another agent framework, a CLI, a web UI)
  can consume stellario without a TS runtime.
- The TS layer collapses to a thin opencode plugin: start the binary's MCP
  server, register its tools. Nothing more.
- This structurally eliminates the current TS/Go divergence (two
  implementations that must stay in sync). There is one implementation; the
  TS layer forwards.

The principle precedes the CRDT choice. The CRDT choice answers "what storage
primitive lives inside the self-sufficient binary."

## The Problem: Impedance Mismatch

Cross-device sync has been patched repeatedly and works poorly. The root cause
is not a flawed protocol design — it is a **storage-primitive mismatch**.

The current infra stores **mutable JSONL entries in device-partitioned
directories** (`projects/<name>/<device>/`), with entry IDs carrying device
suffixes (`m03.Sirius`). This is a single-device storage model. Cross-device
features (auto-mounts of sibling dirs, device-migration, sibling visibility)
are bridges bolted onto a primitive that was never convergent.

`capsule-sync-execution-model.md` correctly diagnosed that convergence requires
immutable revision events + a materialized view. Its distributed-systems
reframing (opponents are partition / reordering / brain-split, not malicious
actors) is sound. But it then **hand-rolls a CRDT**: revision envelopes, replica
paths per device, materialized-view rebuild, brain-split detection, idempotent
delivery. Each piece is a reconstruction of what a CRDT provides natively.

Hand-rolling a convergence protocol is exactly the problem CRDTs were invented
to solve. The impedance mismatch is: **building convergence on top of a
non-convergent primitive, by hand.**

## The Standard Solution: Automerge

The problem stellario faces — multiple offline devices writing to a shared
structured state with automatic convergence — is a solved problem with a
standard answer: **CRDTs**. The mature, academically rigorous implementation
fitting stellario's data shape is **Automerge**.

Automerge (Rust crate `automerge`, v0.10.0, maintained by Ink & Switch /
Kleppmann, convergence theorem-proven in Isabelle) is a JSON-like CRDT document
engine designed for local-first software. It is almost purpose-built for
stellario's requirements:

- **Structured data**: nested maps / lists / text + primitives (string, int,
  float, bool, counter, timestamp). Maps directly to entries.
- **Offline-first**: each device has a local copy, writes queue, sync on
  reconnect. Local writes acknowledged without network.
- **Automatic convergence**: concurrent edits merge by CRDT rules — brain-split
  is structurally impossible, not merely detected.
- **Device as provenance, not partition**: each change carries an `ActorId`.
  One actor per device is the recommended pattern. Device is metadata.
- **Stable device-agnostic IDs**: object IDs (`ObjId`) are operation-addressed,
  not device-addressed. The `m03.Sirius` suffix problem disappears.
- **Built-in history**: change hashes, `*_at()` time travel. Replaces the
  revision envelope.
- **Conflict surfacing**: concurrent writes to the same field resolve
  deterministically (LWW), with losers available via `get_all()`. Divergence
  is observable, never silent, never data-losing.
- **Network-agnostic sync**: the sync protocol runs over any reliable in-order
  transport. "Files on disk, email attachment, USB drive — if you can transfer
  bytes, you can sync." Git is such a transport.
- **Rust-native**: first-class Rust implementation (not a binding). Unifies
  with a Rust binary with zero FFI friction.
- **autosurgeon**: a companion Rust crate mapping Rust structs ↔ Automerge
  documents (serde-like derive for CRDT). Shrinks custom schema code.

Yjs was evaluated and disqualified: pure JS (no Rust core), ecosystem focused
on collaborative text editing rather than structured documents.

## Data Model Mapping

One Automerge document per project (a capsule). The document is a map:

```
root
├── config        # project config (LWW map)
├── meta          # meta volume — map of entries
│   └── "m03"     # entry key = stable device-agnostic ID
│       ├── content     # LWW register (latest revision wins)
│       ├── tags        # CRDT list (concurrent add/remove converges)
│       ├── keywords    # CRDT list
│       ├── refs        # CRDT list of { target, reason, source }
│       ├── author      # LWW string
│       └── updated     # LWW timestamp
├── active         # same structure
├── handover       # same structure
└── ...            # one map per declared volume
```

Design rules:

- **Entry identity** = the map key (`"m03"`), device-agnostic and stable.
  Replaces suffixed IDs entirely.
- **Scalar fields** (content, author, timestamps) use **LWW** — latest revision
  wins, which matches stellario's "revise replaces" semantics.
- **Collection fields** (tags, keywords, refs) use **CRDT lists** — concurrent
  adds and removes converge without conflict. This is strictly better than
  today's mutable-array approach.
- **Refs** target entry keys (stable IDs), so the ref graph is device-agnostic
  and survives migration intact.
- **Provenance** is implicit: every change records its ActorId. "Which device
  wrote this" is queryable, not stored as part of identity.

## What capsule-sync's Machinery Becomes

| capsule-sync (hand-rolled) | Automerge (native CRDT) |
|---|---|
| revision envelope + materialized-view rebuild | document state (auto-converging) |
| replica path per device | ActorId (device as provenance) |
| brain-split detection | structurally impossible; conflicts via `get_all()` |
| idempotent delivery | CRDT operations are idempotent |
| device-suffixed IDs | device-agnostic ObjId / map keys |
| semantic merge computation | merge rules encoded in data types (LWW, list CRDT) |
| sync protocol design | Automerge sync protocol over git |

capsule-sync's **insights** survive (distributed-systems framing, trust model,
local-write-first acknowledgment, brain-split as the central concern). Its
**mechanism** is replaced wholesale by Automerge. The proposal is superseded,
not merely amended — there is no value in hand-rolling what the library gives
as a mathematical property.

## Language: Rust

Given the self-sufficient-binary principle plus Automerge, Rust is the natural
consequence, not a preference:

- Automerge's first-class implementation is Rust. A Rust binary integrates the
  storage primitive natively — no FFI boundary, no cross-language marshalling.
- **edelweiss is Rust.** The engine stellario serves and the memory system
  that serves it share a language ecosystem. Coherent.
- The current Go binary has no path to Automerge without FFI-to-Rust
  awkwardness or a Go CRDT reimplementation (re-inventing the wheel we just
  decided to stop inventing).
- Moving storage to Rust **collapses the TS/Go divergence**: the binary owns
  all logic; the TS layer becomes a thin MCP client. Two implementations
  become one.

The migration cost (rewriting the Go binary's logic in Rust) is real but
partial — much of the Go logic (storage, migrate) is *replaced* by Automerge,
not ported. The net Rust codebase is: config validation + resolution + Automerge
schema + tool execution + MCP server + migration. Fresh, but not enormous.

## Frontend Decoupling: MCP

The binary exposes an **MCP server**. Every stellario capability (memory
create/revise/search/show, workspace status, volume-link, coordination) is an
MCP tool served by the binary.

Consequences:

- **opencode** consumes stellario via MCP — the plugin shrinks to "start the
  binary, point opencode at its MCP endpoint." No TS tool definitions, no
  `import("stellario/...")`, no symlink staleness (the class of bug that bit
  us this session).
- **Any other frontend** — a different agent framework, a CLI, a web UI —
  consumes the same MCP server. Stellario is no longer opencode-coupled.
- The **stale-copy problem disappears**: there is one binary, installed once;
  frontends talk to it over MCP, not by importing source.

This realizes the declaration-first principle at the architecture level: the
system's behavior does not depend on which frontend hosts it.

## Migration: One Breaking Change

The two storage primitives (mutable JSONL + device partition vs CRDT document)
are incompatible. There is no incremental path that doesn't maintain both
models simultaneously — which amplifies the impedance mismatch during
migration. A clean, one-shot breaking migration is correct, and conditions are
ideal: small owned dataset (3067 entries, 3 projects, single user, few
devices), current cross-device state already broken (negative value), git
history as structural rollback.

### Principle: devices converge, they do not each convert

Migration is **not** "each device converts its own JSONL to an Automerge doc."
That would produce N divergent conversions. The correct flow:

1. **Seed device** (most complete data): convert its JSONL → Automerge doc.
   Each entry becomes a map object; IDs are stripped of device suffixes to
   become stable keys; refs are rewritten to target the new keys; provenance
   (original device + original ID) recorded in the conversion map.
2. **Seed pushes** the `.automerge` binary doc to the git remote.
3. **Other devices discard their local divergence** and pull the convergent
   Automerge doc. They do not convert their own JSONL — they converge to the
   seed's truth. Their previously-stale sibling data (the bad auto-mount
   views) is abandoned.
4. **Post-migration verification**: every old entry has a corresponding doc
   object; every old ref resolves to a new key; entry counts match;
   materialized state reproduces the pre-migration view.

Rollback: old JSONL remains in git history; the old binary is retained.
Checkout restores the pre-migration state.

### ID remapping

The trickiest mechanical step. `m03.Sirius` → `m03`. A mapping table is built
during conversion; all refs (which store entry IDs) are rewritten through it.
Completeness is verified: every old ref must resolve to a new key. A single
dangling ref fails the migration.

## Open Questions

1. **Document granularity.** One Automerge doc per project (capsule), or
   per-volume? Per-project is simpler for sync (one file per capsule) and
   matches capsule-sync's isolation model. Per-volume allows independent
   sync lifecycle but multiplies documents. Lean: per-project; revisit if
   sync latency for large capsules becomes a concern (Automerge handles
   millions of ops per doc, so this is unlikely at stellario's scale).

2. **Search and indexing.** Today stellario scans JSONL and maintains a
   keywords index + optional embeddings. Over an Automerge doc (binary),
   search reads the materialized state. Automerge's **patches** (PatchLog →
   incremental patches) enable an incrementally-maintained index rather than
   full rebuild on every change. This is custom work but bounded.

3. **autosurgeon as the schema layer.** **Validated by prototype** (`src/bin/autosurge.rs`):
   derived `#[derive(Reconcile, Hydrate)]` on `Entry`/`MemRef`/`Capsule` structs
   maps stellario's schema with serde-like ergonomics — one `reconcile()` writes
   the whole structure, one `hydrate()` reads it. The smart-diff reconcile
   preserves CRDT concurrent-merge semantics (content LWW + tag/ref CRDT lists
   converge identically to the low-level API). Code volume drops from ~250 lines
   of manual put/get/insert to 3 struct derives. **autosurgeon is the right
   path for the schema layer.** One caveat: re-hydrate the structure after each
   merge (no incremental live structs yet) — acceptable at stellario's scale
   (re-hydrating a few thousand entries per sync, a correctness-neutral cost).

4. **Git transport of binary docs.** Automerge docs are append-only binary;
   git stores them opaquely (no useful diff). Concern: repo growth. Mitigation:
   Automerge supports compaction / incremental save; the doc file is
   rewritten compacted periodically. The append-only nature also means git's
   delta storage helps. Verify with the real dataset.

5. **Global / guardian capsule.** The guardian's global meta also becomes an
   Automerge doc. Identity-driven guardian resolution (from `7634029`)
   generalizes cleanly: the guardian resolves to the global capsule's doc,
   which is itself convergent across devices. The guardian reads convergent
   global truth, not a local-device slice — closing the gap noted during the
   declaration-first refactor.

6. **MCP maturity.** MCP is the emerging standard for agent-consumable tools,
   adopted by opencode and others. Betting on it is reasonable for stellario's
   "frontend-agnostic" goal, but the spec is still evolving. Mitigation: the
   binary's tool layer is isolated from its storage layer; if MCP evolves or
   an alternative emerges, only the exposure surface changes.

7. **Migration ordering vs control-plane proposals.** The three control-plane
   proposals (declarative GC, inject sections, token management) are relatively
   storage-agnostic, but the ID model (device suffixes) crosses both planes.
   Storage + ID model should settle first; control-plane features then build
   on the stable foundation. Building them on the old ID model would force
   rework.

## Prototype Validation

A self-contained Rust prototype (`prototype/automerge-poc/`) validates the
core thesis empirically, using real stellario data (the user-profile entry and
an edelweiss audit entry) across two simulated devices:

- **Content revision (LWW) + concurrent tag addition (CRDT list)** converge
  without loss — A's revised content and B's added tag both present after sync.
- **Concurrent refs** both survive (CRDT list union) — A's ref→m03 and B's
  ref→l14 both retained.
- **Field conflicts** resolve deterministically (LWW winner), with the loser
  observable via `get_all` — no silent data loss.
- **Provenance** is inherent: each change records its ActorId; entry IDs are
  device-agnostic map keys.
- **Doc size**: a 2-entry capsule with operations serializes to 558 bytes —
  git transport of binary docs is not a size concern at this scale (scale
  testing for thousands of entries remains warranted).

The prototype uses the low-level `automerge` API, confirming the schema maps
directly without requiring autosurgeon (see open question 3). Convergence
behavior is no longer a hypothesis — it is demonstrated.

## Scope and Sequencing

This is a storage-engine rewrite, not a refactor. It deserves dedicated design
and implementation effort. Proposed sequence:

1. **Prototype** the data-model mapping in Rust + Automerge on a single
   capsule — prove entries/refs/tags converge across two simulated devices.
2. **Migration tooling**: JSONL → Automerge doc converter with dry-run,
   ref-rewrite, and verification.
3. **Rust binary**: config validation + resolution + Automerge-backed storage
   + tool execution. Replaces the Go binary's role.
4. **MCP server** exposure.
5. **Thin TS plugin** for opencode (start binary, register MCP tools).
6. **One-shot breaking migration** of the live cluster (seed → push → others
   converge).
7. **Control-plane proposals** (GC, inject sections, token) build on the new
   foundation.

## Relationship to Other Documents

- **Supersedes** `capsule-sync-execution-model.md`. capsule-sync's
  distributed-systems framing and trust model are absorbed; its hand-rolled
  convergence machinery is replaced by Automerge. The capsule-sync document is
  retained for historical context but no longer the active storage design.
- **Builds on** the declaration-first refactor (`7634029`). That refactor
  settled the control plane (config authority, identity-driven resolution,
  declarative inject). This proposal settles the data plane to match.
- **Founds** the three control-plane proposals (declarative GC, inject
  sections, token management). They should be implemented against this storage
  foundation, not the legacy JSONL model.
