# Proposal: The Constellation Model — Native Entries, Star Drafts, and the Death of create

## Meta

- Date: 2026-08-02
- Author: Kobayakawaami (creator) × Kimi K3 (session agent)
- Status: draft
- Builds on: `artifact-plane-sidecar.md` (superseded — see §9), edelweiss P17 (`stellario-entry` comment grammar, implemented)
- Informed by: the working Phase 2–4 implementation (`stella` lint/query/show, sqlite-vec index, `stellario sync --repo/--reindex-memory`)

---

## 1. The Problem

The comment-side grammar (edelweiss P17) made knowledge *inside existing
artifacts* retrievable. Three gaps remain:

1. **Site-free knowledge has no native file form.** A reasoning chain that
   belongs to no source file — a design thread, a falsified approach, a
   creative iteration — currently lives only inside the capsule (opaque
   `volume:id` entries) or in repo docs (edelweiss's habit, not a stellario
   requirement). Memory entries must be able to stand alone as files.
2. **Drafts have no home.** Thinking is messy: a topic spawns fragments
   across sessions. Today they either get prematurely consolidated (losing
   the exploration) or never written down (losing the thought). The old
   evolution graph demanded typed supersede edges with intent *during*
   exploration — ceremony at exactly the moment of maximum uncertainty.
3. **Identity is unreadable.** `whiteboard:99` tells you nothing; it is a
   position, not a meaning. Refs, citations, and conversation all pay the
   tax (visible today: repo entries' slugs are self-describing in `stella`
   results; memory entries' `volume:id`s are opaque in the same list).

## 2. Design Principles

1. **One grammar, two attachment scales.** The `<stellario>` block grammar
   is unchanged. *embed* attaches it to a region inside a host file; *entry*
   attaches it to a whole file. They are the same thing at two scales.
2. **Truth lives in names, not registries.** Grouping, state, and lifecycle
   are carried by filenames (`<slug>.stella`, `<slug>.<star>`,
   `<slug>.<status>.md`). Any mechanism whose truth depends on a registry
   being maintained is rejected in advance.
3. **Premature naming is avoided; consolidation earns the slug.** Drafts
   carry arbitrary handles (star names) under a topic slug; the canonical
   slug is minted at consolidation.
4. **stellario is lifecycle-agnostic.** It harvests what *is*; it never
   manages how long things live. Lifecycle = renames and sync.
5. **Falsification is preserved, not deleted.** Overturning yourself
   demotes a canonical entry to a named star — the wrong position stays in
   the constellation as sealed history.

## 3. The Model

### 3.1 Native entry: `<slug>.stella`

A whole file is one entry. The file's prose is the description; one
`<stellario>` block (at the end of the file) carries the fields. Same
grammar, same lint, same harvest — the file is simply the maximal span.

```
# Why the VM stays dumb

(long-form reasoning, markdown, any language for prose)

<stellario>
header: dumb-pipe-declaration-scheduling — Subsystems declare reads/writes; the VM derives barrier layers and never interprets effects.
tags: [module:spark-vm, plane:compute]
keywords: [dumb-pipe, barrier-derivation]
walls:
  - not: a lock manager — RwLock was the rejected fix
refs:
  - derives-from: layer:11
chain:
  - docs/proposals/P11.md
author: kimi-k3
</stellario>
```

Native entries are self-contained: they need no docs/ practice, no host
artifact, no capsule residency to be meaningful. Sync may carry them into
the capsule for distribution; the file is the authority.

**`binding` is exempt on native entries.** The whole file is the
description, so embed is the only meaningful reading — requiring the field
would be ceremony without information. Lint treats it as optional for
`.stella` files (embed implied; cascade is an error there).

**Constellations live in a `.stella/` directory at the repo root.**
gitignore: `.stella/*` with `!.stella/*.stella` — canonicals are tracked,
stars are not.

### 3.6 Three planes, one authority rule

Storage, index, and edit are separate planes with non-overlapping
lifecycles:

| Plane | Holds | Authority |
|-------|-------|-----------|
| storage (automerge capsule) | entry versions + version graph | **truth** — append-only, replayable |
| index (index.db) | projected rows + anchor vectors | none — derived, rebuildable |
| edit (files: work copies, staging, repo `.stella`) | working surface | none — transient (pre-sync files excepted) |

All plane transitions are explicit tool acts (sync / reindex / expand /
export); none is magic. Index is never edited; capsule is never edited
directly; edits always happen on files.

**Authority by residence** (resolves the dual-residency question):

- **embed blocks** (inline markers in `.rs`/`.md`): truth stays with the
  inlined part — the file. The knowledge is bound to the code; the code is
  the truth.
- **self-contained `<slug>.stella` files**: after sync, the **capsule is
  the single truth**; the repo file is an edit/review surface (git-tracked
  for review, never authoritative). Pre-sync, the file is still the truth;
  sync is the moment truth migrates to the capsule.

Consequence for `stella show`: the authority pointer is per-residence —
repo/embed hits point at the file; repo/native hits point at the capsule
(post-sync); memory hits point at the capsule + lineage.

### 3.7 lint vs doctor — validation split

`stella lint` scans the **edit plane only** (files): stella faces the
currently visible environment. Capsule-resident entries are linted by a
heavy, storage-side entry point — `stellario doctor` — which reads the
capsule, materializes entries, and validates them with the same grammar
(plus storage invariants: dangling refs, vacant heads, stale collections).
The split is deliberate: stella stays light and context-local; the whole-
corpus check is a deliberate, heavier act.

### 3.2 Star drafts: `<slug>.<star>`

A draft is a star in a slug's constellation: `<slug>.sirius`,
`<slug>.aquila`. Star names come from an arbitrary, memorable,
collision-free namespace (stars) because a draft's identity has not yet
crystallized — the handle must not pretend to meaning.

**Stars carry no `.stella` extension — deliberately.** The extension is
not a file suffix; it is a semantic claim: "this file is a lint-
disciplined native entry." A draft must not carry that claim. Stars are
loose form: no required block, no lint, no grammar discipline — the
constellation absorbs raw material exactly as it falls.

- **The constellation is the naming.** `<slug>.*` is self-evident grouping;
  no membership registry exists.
- **Inside the constellation, loose wires are allowed.** Drafts may cross-
  reference freely, in any ad-hoc form. No edge schema is presupposed;
  discipline is required only at consolidation.
- **Drafts sync but do not follow git** (gitignored). Fragments that no
  single session can pull into a `.stella` still survive — via sync, not
  via commit.
- **Retrieval:** stars are excluded from the default index view; queryable
  with an explicit flag. Canonical entries are the active face of the
  constellation.
- **Star naming is assisted, not governed.** Picking a star is micro-
  friction; sync/lint prints `next unused star in this constellation:
  <name>` so the namespace is always at hand.

### 3.3 Lifecycle

```
write stars freely            →  <slug>.sirius, <slug>.aquila
consolidate (sync)            →  <slug>.stella   (canonical; block carries
                                                  stars: [sirius, aquila])
overturn yourself             →  <slug>.stella is RENAMED to <slug>.vega —
                                 the file LOSES the .stella extension, which
                                 IS the demotion (the extension carries
                                 canonical status); `demoted: <reason>` is
                                 added inside; the canonical slot stays
                                 vacant until a new consolidation earns it
```

- **Collected:** a star named in the canonical's `stars:` list.
- **Dismissed:** a star deliberately not collected (dead end, kept as a
  lesson) — marked `status: dismissed` in its own block.
- **Vacant head:** stars exist but no `<slug>.stella` — the structural
  representation of an *open question*. Not an error; a state.

Demotion preserves intent without resurrecting the evolution graph: the
reason is a footnote in the demoted star, not a typed edge in a registry.

**Collection bookkeeping is lint-checked, never auto-written.** Handwriting
`stars: [...]` errs; lint warns when a canonical does not list a star in
its constellation — `collected or dismissed?` — pushing the judgment to
the human instead of making it for them (no --fix applies here too).

### 3.4 Identity: slug + hash

`volume:id` is replaced by slug (meaning identity) + content hash (version
identity):

- `refs` target slugs (`dumb-pipe-routing`) or pinned versions
  (`dumb-pipe-routing@a1b2c3`).
- Typed ref bullets carry the relations the evolution graph used to:
  `- supersedes: old-slug@a1b2c3 — reason`. The graph becomes a greppable,
  lint-verifiable property of files, not a database structure.
- Entry-side drift becomes checkable: B refs `A@hash`; A changed → B's
  premise may be stale (reported, not auto-invalidated).

### 3.5 Reporting — the hygiene function

`stellario sync --status` reports, per constellation:

| Condition | Meaning |
|-----------|---------|
| uncollected stars | fragments never distilled (nor dismissed) — memory debt |
| vacant head | open question under exploration |
| stale refs | referenced `slug@hash` no longer matches the target's current hash |

The report must be **in-path, not on-demand**: query hits on a slug carry
"3 uncollected stars in this constellation" as a side note. A report
nobody is forced to see is a report that decays.

## 4. CLI Consequences

- `stella` — query, lint, show (unchanged; gains constellation side-notes
  and a `--stars` flag). Lint scans the edit plane (files) only.
- `stellario` — **sync only**:
  - `sync --repo <path>` harvests embed blocks (existing) **and native
    `.stella` entries** (this proposal).
  - `sync --capsule` carries `.stella` files ↔ capsule (native entries and
    stars — drafts survive sessions without git).
  - `sync --status` — the constellation report.
  - `doctor` — storage-side validation (heavy): lint capsule-resident
    entries, check storage invariants. The counterpart of `stella lint`.
- **create is retired.** `stellario write`/`expand-new` are removed (or
  gated behind `--dangerous` during transition). Authoring happens in
  editors, as files. Create was never an API — it was always "write a
  file". Programmatic repair is a storage-internal act, not an API.

## 5. Capsule as First-Class Unit

The capsule replaces the volume in the ecological position:

- Capsules are **global** (registered under `~/.stellario`) and carry
  **metadata**: purpose, bound repos, schema extensions, authority.
- Permissions (volume boundaries today) move to capsule level.
- Inside a capsule, entries are flat + tags; volumes' grouping role is
  absorbed by slugs and constellations.
- Existing volumes migration is **independent follow-up work**, explicitly
  non-blocking: the current `volume:id` entries keep working via
  `--reindex-memory` until migrated.

## 6. Retrieval Semantics

- Index gains entry `form`: `embed` (comment block) | `native` (`.stella`
  file) | `star` (`<slug>.<star>` draft). Default query view: `embed` +
  `native` (active). `--stars` includes drafts.
- Slug-segment scoring (shipped in Phase 4) applies unchanged; native
  entries and embed entries rank in the same space.
- `refs` edges are ingested for future structural retrieval (citation
  expansion); v1 indexes them as text only.

## 7. Consequences

**Positive**
- Site-free knowledge gains a native, self-contained file form — docs/
  practice becomes optional, not required.
- Drafts stop dying with sessions; exploration is no longer forced into
  premature consolidation or silence.
- The evolution graph's value (intent, supersedes) survives as typed ref
  bullets — greppable, lint-verifiable — while its registry dies.
- Falsified positions persist as named stars: the ensnared function is
  built into the lifecycle.
- Open questions become structural (vacant heads), visible to `status`.

**Negative / costs**
- Filename conventions do more work; renaming tooling (lint) must handle
  constellation-wide renames.
- Constellations can become graveyards if the report is not wired into
  the query path (in-path requirement, §3.5).
- Two identity schemes coexist until volumes migrate (`volume:id` legacy
  vs slug). Tolerated explicitly; migration is separate work.
- Stars (`.<star>` files) need gitignore discipline; canonical `.stella`
  files are git-tracked.

## 8. Alternatives Considered

- **Keep create API + typed evolution graph** — rejected: ceremony at the
  moment of maximum uncertainty; edges minted during exploration are
  guesses, and guessed structure is worse than none (the constellation
  holds raw material instead).
- **Drafts in git** — rejected: commits are for consolidated truth; draft
  churn pollutes history and review. Sync carries drafts; git carries
  canonicals.
- **Star drafts without topic slug (bare `<star>.stella`)** — rejected:
  grouping by constellation is the whole point; bare stars would need a
  topic registry (principle 2).
- **Uniform `<slug>[.<star>].stella` (extension for drafts too)** —
  rejected: `.stella` is not a file suffix, it is a semantic claim — a
  lint-disciplined native entry. Drafts must not carry that claim; the
  extension IS the canonical marker, which is also why demotion is
  mechanically just losing it.
- **Auto-collect heuristics (content similarity)** — rejected: collection
  is a judgment, and judgment belongs to the consolidating agent. The
  report surfaces candidates; the act stays human/agent.

## 9. Obituary: the Sidecar

`artifact-plane-sidecar.md` is superseded by this model. Its two jobs
found better homes:

- **Content lock** → the lint-owned `auto` field (span hash + commit time,
  shipped in Phase 2) and `codemap` hashes.
- **Binding** → `refs` / `chain` / `codemap` fields (structured, lint-
  verifiable) plus the constellation's naming-is-grouping.

The sidecar proposed a *companion* file per artifact; the constellation
model made artifacts and entries speak the same grammar directly, making
the companion unnecessary. `.stella` the extension survives — reborn as
the native entry file, not the sidecar.

## 10. Open Questions

1. **Star namespace governance.** Fixed star list (IAU names) vs free
   coining. Leaning: curated list, lint warns on unknown stars (vocabulary
   governance via the same natural-convergence practice as tags).
2. **Capsule residence of `.stella` files.** Do canonical natives live in
   repos (git-tracked) or only capsule-side? Leaning: repo when a repo
   claims them; capsule is distribution + draft storage.
3. **Multi-capsule refs.** A slug referenced from two capsules — namespace
   rules needed when capsules go global-with-metadata.
4. **`--dangerous --create` sunset date.** When does the flag go, not just
   the default?

## Resolution

*(Open — draft.)*
