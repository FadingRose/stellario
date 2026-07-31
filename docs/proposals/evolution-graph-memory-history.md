# Proposal: Evolution Graph — Memory History & Fork

## Status
Draft — the semantic memory layer. Builds on `automerge-storage-architecture.md`
(which settled the *storage plane*) by settling the *meaning plane*: how a
memory evolves, and how that evolution is preserved and queried.

## The Problem

Stellario has never truly modeled memory evolution. It has **tried** — and each
attempt left the real evolution encoded as natural-language prose, not structure:

- **git as history** (`src/git.ts`): tracks file state ("jsonl line 42 changed
  Tuesday"), answers nothing about *why* l273 overturned l262. Causality and
  intent live in entry content, never in the version control.
- **constellation's FrameType/EdgeType** (`engine/types/types.go`): a complete
  vocabulary for non-linear evolution (assert/derive/supersede/validate/... +
  derive_from/supersede/validates/constrains). But it only ever lived in
  constellation's *in-memory* graph, fed by a SQLite *shadow* store synced from
  JSONL. Agents writing memory never used these frames — they wrote freehand,
  e.g. entry `m17`:

  > "SUPERSEDED by l273 §四 + l275 pass DAG. 原始: l207 四层架构. l262 升级为
  > 传导场, l273 deprecate Green 函数..."

  That prose *is* an evolution lineage (`l207 → l262 → l273/l275`) with reasons
  at every hop — exactly what a typed-edge graph models structurally. But it
  exists only as text, invisible to telescope search and only reachable by
  constellation after a sync.

- **LWW `revise`**: the current write path. The last write wins; prior states
  are retrievable only via git archaeology. Evolution is flattened to "current
  state + discard pile."

The common failure: **evolution is treated as linear (version N replaces N-1),
when it is actually a non-linear hypothesis forest.** A concept forks into
parallel candidate answers; some survive, some are superseded; the reasons and
the losing branches are the most valuable part of the memory, and they are the
part with no structure today.

## What counts as a version? (the question that shaped this design)

A naive operation model says "each write is an operation." But that leaves the
noise question unanswered: is fixing a typo a version? Adding a keyword? Is it
the same "version" as overturning an assumption? If every change is equally an
"operation," the evolution graph drowns in noise and becomes git's old failure —
all changes equal, none distinguished.

The resolution taken here: **stop trying to decide which changes "deserve" to be
versions.** Instead:

- **Every write is a version, automatically.** No commit ceremony, no "this
  counts / this doesn't." A typo fix, a keyword add, a supersede are all
  versions, structurally equal as snapshots.
- **What distinguishes them is not the version itself (which is a dumb
  content-addressed snapshot) but the *intent* attached to every write, and the
  *typed edges* that relate versions.** Noise is not suppressed by gating
  versions — it is surfaced as recall signal: every version carries the reason
  it was written, so the operation stream is legible rather than noisy.

This inverts the usual instinct. Instead of "few meaningful versions," it is
"all versions, each annotated." The intent is the asset; the snapshot is cheap.

## The Model

### Three orthogonal axes on one content-addressed snapshot

Every write produces a **version** — a content-addressed snapshot of the full
entry, addressable as `volume:id:hash`. On it hang three independent kinds of
connection:

| Axis | What | Who produces it | Purpose |
|---|---|---|---|
| **version** | `volume:id:hash` — full entry snapshot | auto, every write | content-addressed addressing, dedup, concurrent convergence |
| **intent** | natural language, **required on every write** | agent | vertical — "why this change." The recall thread |
| **parent edge** | auto, to the previous version | system | vertical — full operation timeline of one entry |
| **typed edge** | supersede/derive_from/validate, points at a **specific hash** | agent, explicit | horizontal — semantic relations between entries. Machine-queryable |

The three axes do not pollute each other:
- **Vertical** (parent + intent) = how one memory evolved over time.
- **Horizontal** (typed edges) = semantic lineage across memories.
- **version** = inert snapshot, untyped; all meaning lives on the edges.

```
                       typed edge (horizontal, explicit, → a specific hash)
                         ↗ supersede layer:262:abc  (reason: "Green 函数反演不成立")
                         ↗ derive_from layer:207:def
   version v_ghi  ──────
   layer:262:ghi        ↘ parent (vertical, auto)
                           → layer:262:def
                             intent: "SFX/Ambience lifecycle 完成"
                             ↘ parent → layer:262:abc
                                         intent: "记录 voice 管线启动"
```

**Forks are NOT a first-class structure.** Fork semantics is nearly absent in
real memory evolution. The only real "parallel versions" case — two devices
writing concurrently — is recovered from `get_all` with no dedicated structure.
The hypothetical "agent declares a named parallel alternative" turns out not to
occur in practice. There is no `forks` sub-tree; concurrent-write divergence is
the whole story.

### Why content-addressing (`volume:id:hash`)

1. **Dedup is free.** Identical content → identical hash → identical address.
   If two devices independently revise an entry to the same content, they
   produce the same version and converge with zero conflict or dedup logic.
   (The same property git blob hashing enjoys.)
2. **Fork is free.** Automerge's concurrent writes + `get_all` *are* the fork
   primitive. Device A writes C_A, B writes C_B concurrently; after merge the
   LWW winner is C_A but C_B is recoverable via `get_all`. Both are
   content-addressable states. **Concurrent writes = parallel versions = fork.**
   No separate fork structure is needed for the parallel-version case.
3. **Edges point at the right thing.** A ref/edge today points at `active:65` —
   a moving target that changes whenever the entry is revised. Under
   `volume:id:hash`, "l273 supersedes l262" is `supersede l262:abc` — pinned to
   the exact version the author meant. A later typo fix produces `l262:def`, but
   the edge still points at `abc`. This is a correctness the flat-id model
   cannot offer.

### Why `hash = full entry` (content + tags + keywords)

- **Uniformity.** No half-measures ("content change counts, keyword change
  doesn't"). Any write produces a new version; the mental model is minimal.
- **Keyword changes are real versions.** Keywords anchor telescope semantic
  search; changing them alters how the memory is discoverable — addressable is
  correct.
- **Edges pin precise state.** `supersede l262:abc` locks to the full state at
  declaration time; any later field change is a different version, leaving the
  edge intact.

### Why intent is required (not optional)

Because every write is a version automatically, the only thing distinguishing a
typo fix from a supersede is the intent attached to each. Making intent optional
would let the operation stream degrade into unlabeled snapshots — exactly the
noise problem. Making it **required** turns every version into a legible step:

```
layer:262:abc  intent: "记录传导场假设"           (assert)
layer:262:def  intent: "SFX lifecycle 完成"        (progress note)
layer:262:ghi  intent: "Green 函数反演不成立"      (supersede, + typed edge)
```

On recall, an agent reads not just "the current state" but a **stream of
operations with intents** — how this memory came to be, what the author was
doing at each step. This is strictly richer than the `m17` prose pattern, which
stuffed a lineage into content; here the lineage *is* the structure.

Intent is free-form natural language (not a closed `kind` vocabulary): the
closed-vocabulary approach (`assert`/`supersede`/...) cannot capture the
specific "why," which is what recall actually needs. The closed vocabulary
survives only where it is machine-actionable: on **typed edges**.

### Why typed edges are separate from intent (and from free refs)

Three distinct relation channels, never conflated:

- **parent** (auto) — same-entry timeline. Structural, not semantic.
- **typed edge** (explicit, horizontal) — `supersede`/`derive_from`/`validate`,
  pointing at a specific version hash, carrying a reason. **Machine-queryable:**
  this is what lets constellation's Kahn topological sort produce a causal
  ordering. Without structured edges, "trace the derivation chain" would require
  parsing natural-language intents.
- **free refs** (today's `m12 → meta:24`, "auto: shared keyword") — agent
  free-association and engine-derived relatedness. A knowledge graph of
  *relatedness*, not of *derivation*.

Mixing typed edges into the free-ref pool would make "what does this derive
from" indistinguishable from "what is loosely related." Typed edges keep the
evolution DAG queryable on its own.

## Data Model (sketch)

Inside one Automerge capsule:

```
root
├── volumes     # map: volume -> id -> [version hashes]   (all versions, in order)
├── versions    # map: hash -> Version                     (the content-addressed snapshots)
└── edges       # list of Edge                             (parent + typed edges)
```

**Version** (the inert snapshot — content-addressed):
```
Version {
    hash:      "abc123..."           # = hash(content + tags + keywords)
    volume:    "layer"
    id:        "262"
    content:   "..."
    tags:      [...]
    keywords:  [...]
    author:    actor / agent
    created:   timestamp
}
```

**Edge** (the only carrier of semantic relation):
```
Edge {
    from:    "layer:262:ghi"          # a specific version hash
    to:      "layer:262:def"          # a specific version hash
    type:    "parent" | "supersede" | "derive_from" | "validate" | "constrain"
    reason:  string                    # for typed edges; empty for auto-parent
}
```

**Write operation** (what `create`/`revise` becomes — every write):
```
write(volume, id, content, tags, keywords, intent, ?edges):
    v = materialize_version(volume, id, content, tags, keywords)
    h = hash(v)
    versions[h] = v
    volumes[volume][id].append(h)
    edges.append(Edge { from: h, to: previous_version(volume,id), type: "parent", reason: "" })
    edges.append(Edge { from: h, to: ..., type: "supersede", reason: ... })   # if declared
    record intent(h, intent)
```

**Fork** — *not a structure.* See "Forks are NOT a first-class structure" above.
Concurrent-write divergence is recovered via `get_all`; no dedicated fork node.

## Relationship to Existing Pieces

- **constellation** (`engine/orchestrator/`): its Kahn topological sort over
  `derive_from` edges is *exactly* an evolution-graph query. Once typed edges are
  persisted (not synced-from-JSONL), constellation reads them directly. The
  vocabulary (`types.go`) is reused; it finally gets a storage home and a
  content-addressed target. (Rust port deferred per the engine plan; this
  proposal makes it read `versions`/`edges` rather than a shadow store.)
- **telescope**: searches versions but filters to active (non-superseded) by
  default; can traverse typed edges for lineage. Old versions are searchable
  but filterable.
- **`create`/`revise` tools**: every call now requires an `intent` argument and
  optionally declares typed edges. A supersede is a revise + a supersede edge.
  LWW overwrite is replaced by "append a version + parent edge."
- **the `m17` pattern**: the hand-written lineage becomes structured — the agent
  declares a supersede edge with a reason instead of prose in content.

## Migration Implications

The phase-0 migration (taskboard → task volume, idPrefix → volume:n) holds. One
more pass: each migrated entry becomes one initial **version** (no prior
history), addressable as `volume:id:hash`, with a synthetic parent-less root.
Pre-migration data has no evolution structure, so every entry is an unparented
assertion with an auto intent ("migrated from JSONL"). Going forward, agents
author versioned writes with real intents.

## Open Questions

1. **Active version lookup.** "Current state" of `volume:id` = latest non-
   superseded version. At stellario scale an index (entry id → active hash)
   avoids scanning the version list. Cheap.
2. **Intent storage.** Is `intent` a field on the edge (the auto-parent edge
   carries it), or a separate per-version record? Lean: on the parent edge —
   intent describes the transition, the edge *is* the transition.

## Scope & Sequencing (adjusting the engine plan)

1. **Version model** — `volume:id:hash` snapshots + `versions` store + auto
   parent edges. Every write versions.
2. **Intent on every write** — required argument on create/revise.
3. **Typed edges** — supersede/derive_from/validate, pointing at hashes.
4. **Re-migrate** — each existing entry → one root version with synthetic intent.
5. **Query engines read evolution** — telescope filters active + traverses
   edges; constellation reads `versions`/`edges` directly.

## Relationship to Other Documents

- **Builds on** `automerge-storage-architecture.md`. That settled the storage
  plane (Automerge, device-agnostic ids, convergence). This settles the meaning
  plane on top of it.
- **Absorbs** constellation's vocabulary (`engine/types/types.go`) into storage
  — the vocabulary is not new, it was never persisted, and it was never
  content-addressed. Now it is both.
- **Supersedes** the implicit "git is memory history" assumption in `src/git.ts`.
  Git remains the *transport* for the Automerge capsule; it no longer represents
  semantic evolution.
