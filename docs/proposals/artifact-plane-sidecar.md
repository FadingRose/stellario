# Proposal: The Artifact Plane — `.stella` Sidecar Binding

## Meta

- Date: 2026-08-01
- Author: Kobayakawaami (creator) × Kimi K3 (session agent)
- Status: draft
- Builds on: `reconstruction-paradigm.md` §4 (paradigm motivation — read it first for *why*; this document is the *how*)
- Answers: lilac whitepaper v2.1 open questions #1 (automatic cache invalidation) and #2 (partial-invalidation granularity) — open since 2026-05-10
- Generalizes: lilac LIP-006 (inline annotation tags) and LIP-009 (chapter frontmatter) — from chapter-scale annotation to a universal artifact↔memory ABI
- Supersedes: the informal `file:` tag convention (one-directional, unverifiable)

---

## 1. The Problem

Memory entries describe artifacts — chapters, code files, designs. Today the link is **convention, not structure**:

- **One-directional.** Entries may carry `file:` tags, but the artifact does not know its entries. Navigation file → memory requires guessing queries.
- **Unverifiable.** Nothing checks whether the file still matches what the entry describes. A stale entry is not wrong — it is *unmarked*. Staleness has no signal: it lies quietly and gets recalled with full confidence, which is worse than absence.
- **Ephemeral.** The expand/sync flow already treats text files as the editing interface — but in `/tmp`, cleaned up after sync. The bridge exists for minutes, then dissolves.

From inside, wrong reconstruction feels exactly like thinking (see `reconstruction-paradigm.md` Appendix A.1 for a documented instance). Internal self-check is unsound. The binding must be **external, structural, and checkable**.

## 2. Design Principles

1. **The sidecar is an ABI, not a store.** Minimal, plain-text, git-tracked, greppable. Heavy content stays in the capsule; the sidecar carries only binding + tags + hash.
2. **Binding is a tool act, not a convention.** Sidecars are written by `stellario bind`, never hand-maintained (transition period excepted — Open Q4).
3. **Lean on git.** The hash is the git blob hash: content-addressed, zero extra state, drift check = one `git hash-object` comparison. Rename detection comes free (same hash, new path → propose rebind).
4. **Opt-in and lazy.** Files without process truth deserve no sidecar. Absence is a valid state, not an error.
5. **Graceful degradation.** Dead entry refs = dangling pointers (reported, not silently dropped); lost capsule = sidecars survive in git as the reconstruction map.

## 3. Format

### 3.1 File anchor (primary)

```yaml
# story/prism/origins/05a-深层坠落.md.stella
version: 1
entries: [active:387, layer:11, handover:41]
hash: git-blob:4f3a9c21...        # blob hash of the artifact at last alignment
tags: [work:origins, chapter:05a, status:current]
bound_at: 2026-08-01T18:00:00Z
```

- Naming: `<artifact-filename>.stella`, co-located. Committed to git — the sidecar **is** the ABI; gitignoring it would recreate the invisibility problem.
- `version`: format version, for evolution.
- `entries`: display IDs (volume:id), append-only set semantics (merge = union).
- `hash`: `git hash-object <file>` at bind/refresh time.
- `tags`: curated mirror — the repo-side half of hybrid retrieval (grep = exact filter without stellario).

### 3.2 Directory anchor (aggregate)

```yaml
# story/prism/eroding-tide/.stella
version: 1
entries: [active:389, active:390, active:391, layer:17]
tags: [work:eroding-tide, status:current]
```

For bindings whose subject is a whole subtree (a work arc, a module). No `hash` field — directory bindings are topic anchors, not content locks. File anchors override/extend directory anchors at query time.

### 3.3 What is deliberately NOT in the sidecar

- Entry content (lives in the capsule — the sidecar is a pointer, not a copy; copies drift)
- Full entry tag sets (mirror only navigation tags: `work:*`, `chapter:*`, `status:*`, `file:*` — see Open Q3)
- Embeddings or keywords (index-time concerns, not binding concerns)

## 4. CLI Primitives

### 4.1 `stellario bind <path> <entry> [--tags t1,t2]`

- Creates or updates `<path>.stella`: appends the entry ref, refreshes the blob hash, merges tags.
- Validates the entry exists in the capsule (refuses to bind dangling refs).
- Reverse direction: adds/normalizes the `file:<path>` tag on the entry itself (both directions written by one act — this is why binding must be a tool act).

### 4.2 `stellario status [--path <subtree>]`

Repo-wide binding health report:

| Condition | Meaning | Action offered |
|-----------|---------|----------------|
| hash mismatch | artifact changed since last alignment | review → `bind --refresh` or revise the entry |
| dangling entry ref | entry deleted (tombstoned) or capsule missing | report; never auto-remove (the dangling pointer is information: this history is sealed) |
| moved artifact | same blob hash at new path | propose `bind --rebind <new-path>` |
| unbound artifacts | files under watched subtrees with no sidecar | informational only — opt-in means most files stay unbound legitimately |

Exit code non-zero on hash mismatch → **CI-checkable**: "this PR modified 05a but its memory binding is now stale" becomes a gate.

### 4.3 `stellario index [--path <subtree>]`

Ingests sidecars into the index layer:

- Each bound artifact becomes a `type:file` entry: content = path + sidecar tags + titles of bound entries; tags from the sidecar; keywords **curated at bind time** (the anchor discipline applies to artifacts too — no full-content embedding, that is RAG and rejected).
- `type:file` entries participate in telescope exactly like memory entries: tag-gated, fzf + keyword-anchor semantic, active-only.
- Result: product truth and process truth in **one** retrieval space. The artifact gains dimensions (why, what was excluded, evolution) — not token mass.
- The index is derived/rebuildable (authority: synthesized): regenerate from capsule + repo at any time; corruption is a non-event.

## 5. Drift Semantics

Hash mismatch means: **the artifact moved; the bound memory may no longer describe it.** It does not auto-invalidate the entries — invalidation is a judgment, and per the authority gradient, judgment belongs to Knowledge (human-in-loop) or to the volume's owning agent. Resolution paths:

1. Artifact changed cosmetically → `bind --refresh` (re-lock hash; no memory change).
2. Artifact changed substantively → revise/supersede the bound entries (with intent, per the evolution graph), then refresh.
3. Entries were already stale → the mismatch surfaces it; supersede with reason.

Partial invalidation granularity = the file (answers v2.1 open Q2 at file level; finer granularity is future work, see Open Q5).

## 6. Lifecycle & Edge Cases

- **Entry deletion (tombstone)**: sidecar ref dangles. `status` reports it; the ref is kept — it records that the artifact *had* a history now sealed. Manual cleanup via `bind --prune` if desired.
- **Artifact deletion**: sidecar loses its subject → orphan sidecar, reported by `status`; removable via `bind --prune`.
- **Rename**: content addressing detects it (same blob hash, new path) → `bind --rebind` rewrites the sidecar path and the entry's `file:` tag.
- **Concurrent binds (multi-device)**: entries list merges as set union; last `bound_at` wins; hash is deterministic.
- **Binary artifacts**: binding works (hash is content-based); anchors/keywords must be supplied at bind time since no text is scannable.

## 7. Migration & Dogfooding

1. **stellario itself**: bind `docs/proposals/*` + `docs/concepts.md` of the stellario repo to the (to-be-registered) stellario capsule. The artifact plane's first user is its own author — and registering stellario's own capsule is the first task the new capsule should track.
2. **lilac-in-the-rain** (first large adopter): migration = curation. Bind only `status:current` entries from `active` (354 entries — most superseded ones go to archived, not to sidecars). Chapters get file anchors; work arcs (eroding-tide etc.) get directory anchors.
3. Legacy `.tag.md` annotated sources (LIP-006) remain as-is; the sidecar does not replace inline annotation, it generalizes the binding half.

## 8. Alternatives Considered

- **Status quo (`file:` tag convention only)** — rejected: one-directional, unverifiable, zero drift signal. This is the failure mode that motivated the proposal.
- **Repo-only docs protocol (process truth into git)** — rejected in `reconstruction-paradigm.md` §9: medium mismatch (git is linear/per-commit; reasoning is per-concept/associative).
- **git notes as the binding store** — rejected: notes attach to *commits*, not files; not shared by default; invisible in the working tree; hostile to exactly the auditability we need.
- **Inline frontmatter inside the artifact** — rejected: pollutes the artifact. Chapters are literature; code files have their own grammars. The sidecar is format-agnostic precisely because it does not touch the artifact.
- **Single root manifest (one `.stella` for the whole repo)** — rejected: breaks co-location, merge-hostile, rename-fragile, and couples unrelated bindings into one contention point.
- **Full-content embedding of artifacts** — rejected: RAG. Artifacts enter the index with curated anchors only (§4.3).
- **Hash = content hash of entry set as well** — deferred: binding freshness currently tracks the *artifact* side; tracking entry-side drift (entry revised after bind) is available via the evolution graph (compare entry's current hash vs at-bind hash) and can be added to `status` without format change.

## 9. Consequences

**Positive**
- Staleness gains a signal — memory's compiler warning. The grounding court exists (paradigm §4.1).
- Navigation closes the loop: file ↔ memory, both directions, one tool act.
- The boundary becomes auditable and CI-gateable; memory maintenance joins the engineering loop.
- Capsule loss is survivable: sidecars in git are the reconstruction map (bindings + navigation tags persist even if entries die).

**Negative / costs**
- Sidecar proliferation — mitigated by opt-in discipline + directory anchors, but needs social enforcement.
- `entries` list merge conflicts — low rate (set-union semantics), but the format spec must state it.
- One more file kind in the tree — editor/linguist noise (`.stella` linguist-markable as generated).
- Binding authorship discipline: if agents hand-edit sidecars, the ABI degrades into convention again.

## 10. Open Questions

1. **Tag mirroring depth.** Navigation tags only (`work/chapter/status/file`) vs full entry tag mirror. Grep power vs sync cost. Leaning: navigation only.
2. **Multi-capsule binding.** May one artifact be bound from two capsules (e.g. lilac + edelweiss both reference a spec)? Format allows it (entry IDs are capsule-scoped by resolution); semantics need a rule.
3. **Entry-side freshness.** Should `status` also flag "entry revised after `bound_at`" (entry drifted, artifact didn't)? Available free via the version graph; decide signal vs noise.
4. **Transition authorship.** During adoption, agents will hand-write some sidecars; cutoff point after which `bind` is the only writer?
5. **Finer invalidation granularity.** Section-level bindings (`05a.md#scene-3`)? Requires anchor syntax in artifacts; file-level is the right v1.
6. **Capsule registration for stellario itself** — prerequisite for dogfooding §7.1; currently `stellario list` shows only edelweiss-core and lilac-in-the-rain. This is an infra gap, not a design question.

## 11. Relationship to Other Documents

- **Builds on** `reconstruction-paradigm.md` §4 — that document argues *why* grounding is the missing invariant; this one specifies *how*.
- **Completes the trilogy**: `automerge-storage-architecture.md` (storage plane) → `evolution-graph-memory-history.md` (meaning plane) → this document (artifact plane).
- **Answers** lilac v2.1 open questions #1/#2 (automatic invalidation; granularity) — the dependency-tracking mechanism requested 2026-05-10.
- **Generalizes** LIP-006 / LIP-009 (chapter annotation → universal ABI).
- **Feeds** the next-generation index (`reconstruction-paradigm.md` §5): `type:file` ingestion is the index's repo half.

## Resolution

*(Open — draft.)*
