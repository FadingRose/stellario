# Review 3: Post-Reframe Consistency Check

Status: Independent review — revise before schema freeze

Reviewed proposal: [capsule-sync-execution-model.md](capsule-sync-execution-model.md)
Companion reviews: [review 1](capsule-sync-execution-model-review.md),
[review 2](capsule-sync-execution-model-review-2.md)

This is a third independent pass, focused specifically on whether the two
reframings (trust model and distributed-systems framing) have been applied
consistently across the whole document. It does not raise new security or
distributed-systems concerns that are independent of the reframings; those
were covered in reviews 1 and 2. The scope here is internal consistency,
residual contradictions from earlier drafts, and gaps exposed by the
reframing itself.

## Summary Recommendation

**Revise, but lightly.** The reframings are sound and the document's
direction is correct. The remaining issues are mostly cleanup: stale
terminology, a layout diagram that does not match the body, a redundant
snapshot section, and a few places where the sync / write lock ordering
needs tighter specification. None of these change the protocol's shape.

## Issues by Category

### A. Stale or Inconsistent Terminology

#### A1. "Materialized view" defined in terms of snapshots that V1 does not have

Terminology (line ~158) defines:

> Materialized view: A rebuildable current view derived from a snapshot plus
> later revisions.

But Reframe 2 defers snapshots to V2 (Materialized Views section says the
view is "rebuildable from revision files" and SQLite is the V1 cache). The
terminology entry imports a V2 concept into V1's glossary.

**Fix:** redefine as "A rebuildable current view derived from the observed
event set." Mention snapshots as an optional acceleration structure that V1
does not require.

#### A2. "Frontier" overloaded across three senses

The document uses "frontier" to mean three different things:

- "Transport frontier" (Terminology): revisions known to be committed or
  replicated through Git — a per-revision *transport* concept.
- "Observed frontier" (Independent State Machines, line ~513): the locally
  observed event set, used as the reference point for "locally
  non-divergent at frontier F" — a *semantic* concept.
- "Epoch frontier" (Open Questions #7, Snapshots): the set of devices
  included in a compaction epoch — a *compaction* concept.

All three are legitimate, but using the same word for all three invites
confusion, especially given that Reframe 2 explicitly removed
`observed_frontier` from the envelope. A reader who sees "frontier" in the
derived-view definition may think the envelope still carries one.

**Fix:** rename. Suggest "transport frontier" stays; "observed event set"
replaces "observed frontier" everywhere in the semantic-state section;
"epoch frontier" becomes "epoch participant set" or similar.

#### A3. "Clean" used as both a state-machine shorthand and a derived property

Independent State Machines (line ~519) says the terms "clean" and
"divergent" are user-facing shorthand and that the protocol never persists
them. Execution Invariant #19 and Project Policy then use "clean heads" as
a defined protocol concept ("intersection of all clean heads"). This is
internally consistent — both refer to "locally non-divergent heads" — but
the dissonance between "shorthand only" and "invariant uses it" reads as a
contradiction on first pass.

**Fix:** introduce one defined term, e.g. "non-divergent head," and use it
consistently. Note explicitly that user-facing output may abbreviate it to
"clean." Make sure invariants and the policy section use the defined term
rather than the abbreviation.

### B. Layout and File Naming Inconsistencies

#### B1. Proposed Isolation Model directory diagram uses fictional filenames

Lines ~172-180 show:

```text
~/.stellario/
|-- registry.json              # local project/path bindings
|-- devices.json               # local device information
|-- cache/                     # rebuildable cross-project indexes
|-- global/
|   `-- personal-memory/       # independent capsule and Git repository
`-- projects/
    |-- <project-id>/          # independent capsule and Git repository
```

But the Attachment section (line ~245) uses `.project-map.json` as the
local attachment record, and the current implementation (per the reality
check) uses `.device-id` and `.stars.json` for device information. The
diagram's `registry.json` and `devices.json` are filenames that appear
nowhere else.

**Fix:** align the diagram with the rest of the document. Use
`.project-map.json`, `.device-id`, `.stars.json`, or document the rename
explicitly. Also reconcile `cache/` — the current implementation keeps
cross-project indexes inside each project's directory, not in a global
`cache/`.

#### B2. `capsule.json` ownership is undefined

Capsule Layout (line ~279) shows `capsule.json` at the shared capsule root.
Review 1 (section "Shared Capsule Files") flagged this: a mutable file at
a shared path turns semantic divergence into Git file conflict. Reframe 2
does not address it.

**Fix:** specify `capsule.json` as immutable identity/schema metadata
(capsule ID, schema version) — not policy, not derived state. Mutable
derived state lives in `local/` (gitignored) or in the device-owned replica
path.

#### B3. `local/` directory mentioned but never specified

Capsule Layout shows `local/` as "ignored runtime state, if stored here."
This is the only mention. It is unclear what lives there in V1 — the
SQLite materialized view? the transport-pending marker? device-local
config? All of these are specified elsewhere as living in different
places.

**Fix:** either enumerate what `local/` contains in V1 (SQLite database,
attachment record cache, etc.) or remove the entry from the diagram and
let each piece of device-local state be specified in its own section.

### C. Sync Execution Precision

#### C1. "Sync lock" and "local write lock" are presented as separate locks but are the same lock in the SQLite implementation

Sync Execution (line ~415) says:

> acquire the capsule sync lock (mutually exclusive with other sync workers
> on this device, not with the local write lock)

But the Local Write Execution section (line ~386) says the local write
lock is "SQLite's own database-level write lock." And sync's final step
(line ~424) rebuilds the materialized generation — which requires updating
SQLite — which requires SQLite's write lock.

In the SQLite implementation, the "sync lock" and "write lock" are the
same lock. The spec presents them as separate, which would be a real
design choice if true (it would mean sync holds an outer lock while
releasing the inner write lock for network work), but the spec does not
actually define what backs the sync lock.

**Fix:** either define two distinct locks (sync lock = something like a
`capsule.sync.lock` file with PID + TTL; write lock = SQLite WAL lock) and
explain their ordering precisely, or collapse them into one lock and
rewrite the sync flow to say "the SQLite write lock is released for
network I/O and reacquired before view rebuild." The latter is simpler and
matches the implementation.

#### C2. Steps 1 and 4 of sync flow are redundant

Sync Execution (line ~412-418):

```text
1. capture an immutable batch of locally durable but uncommitted revisions
   (under the local write lock)
2. release the local write lock
3. acquire the capsule sync lock
4. recover any locally durable but uncommitted revisions added since the
   snapshot above
```

Step 4's "recover" makes step 1's "capture" pointless: if step 4 is going
to scan for everything anyway, why capture under the lock at step 1?

**Fix:** remove step 1. Do all scanning under the sync lock at step 4. The
reason to scan *under a lock* is to get a consistent snapshot of the
revision directory, not to "capture" anything. If the sync lock is the
SQLite lock, scanning the revision directory still requires protection
against concurrent writers — but that's what the lock is for. Step 1 adds
no information.

#### C3. Order of "fetch → rebase → build event set" is unspecified

Sync Execution says "fetch the capsule remote → rebase the device-owned
commits → push." But the deskcheck scenario (step 4, line ~728) says "Vega
fetches, rebases its disjoint replica file, and pushes without a Git file
conflict." Neither explicitly says when the materialized view is rebuilt
from the full event set.

Concretely: after fetch, the local Git tree now contains revisions from
other devices (e.g. Sirius:102). Before push, those revisions need to be
in the event set the view is built from. But the spec only says view
rebuild happens at the end of sync (step "rebuild a new materialized
generation"). If a writer acquires the lock between fetch and view rebuild,
its "validate against one materialized generation" (Local Write Execution
line ~358) sees the pre-fetch generation and may make wrong decisions.

**Fix:** specify that the event set is updated as part of the same atomic
operation that completes the fetch + rebase, before any new write is
acknowledged. The simplest way: hold the write lock across fetch + rebase +
view rebuild, and only release it for the actual push (which is the slow
network operation). This changes the lock ordering slightly: capture batch
→ release lock for *push only* → reacquire → reconcile. Or: do fetch +
rebase + view rebuild atomically under the lock, then release for push.

#### C4. Crash recovery between rename and dir-fsync is described imprecisely

Deskcheck step 13 (line ~760):

> A worker crashes after the rename-fsync but before the directory-fsync.
> The revision file is on disk; the directory entry may or may not be
> present.

This is technically wrong. `rename` is atomic: at any instant, the file is
either at its old path or its new path, never both, never neither. The
issue with skipping dir-fsync is that *on power loss*, the directory entry
may not be durably recorded, so after recovery the file may appear not to
exist even though the rename call returned successfully.

So the accurate description is: "the rename call returned, but the
directory update may not have been persisted to disk; after crash
recovery, the file may or may not appear in the directory." The current
wording is correct in spirit but loose.

**Fix:** rephrase to be precise about the atomicity of rename and the
persistence guarantee of dir-fsync.

### D. Snapshots Section is a V2 Relic

#### D1. Snapshots and Compaction section assumes a V1 that does not exist

Section "Snapshots and Compaction" (line ~688) shows a snapshot YAML
example with `frontier: { dev_a, dev_b }` and `semantic_heads` — both
concepts that Reframe 2 either removed from the V1 envelope or
reclassified as derived. The section is entirely about future work but
appears between Materialized Views and Deskcheck Scenario as if it were
part of the V1 protocol.

**Fix:** either (a) move the section to the end as "Future Work —
Snapshots and Compaction," or (b) prefix with "V1 does not implement
snapshots; this section describes the shape they would take when
introduced." Option (b) is less disruptive.

### E. Operational Observability Gap

#### E1. Divergence is "observable" but the observation mechanism is undefined

Cross-Device Revision Behavior (line ~542):

> Divergence is observable, not auto-resolved. The materialized view
> surfaces the divergent heads to the user...

Open Question #5 then asks how this should be surfaced. But the document
presents observable divergence as a *guarantee* ("What the protocol
guarantees") while simultaneously listing the mechanism as an *open
question*. A guarantee whose mechanism is undefined is not yet a
guarantee.

**Fix:** either (a) weaken the guarantee to "the protocol preserves the
information needed to surface divergence; the surfacing mechanism is an
open question," or (b) commit to a minimum V1 mechanism — e.g. "the
materialized view exposes a `divergent_heads` query that returns all
entries with more than one head; session-start context injection includes
the count." Option (b) is small and worth pinning down.

### F. Minor Issues

#### F1. Non-Goals list contradicts Materialized Views on storage choice

Explicit Non-Goals (line ~902):

> selecting a storage database for the materialized view (V1 candidate:
> SQLite, see Materialized Views — but the protocol does not require it)

Materialized Views (line ~671):

> V1 candidate storage for the materialized view is a local SQLite database
> in WAL mode

The Non-Goal hedges ("candidate," "does not require it") while Materialized
Views commits ("is a local SQLite database"). The two should agree on
whether SQLite is decided or just a candidate.

**Fix:** if SQLite is decided, remove it from Non-Goals. If it is still a
candidate, soften Materialized Views to match.

#### F2. Operation enum lacks tag/ref operations

Revision Envelope (line ~309):

> operation: create | revise | merge | tombstone | policy

Cross-Device Revision Behavior (line ~553) recognizes "tag additions" and
"reference additions" as auto-converging operations. But there is no
`add_tag`, `remove_tag`, `add_ref`, or `remove_ref` in the operation enum.
These are presumably encoded inside `revise` payloads or inside `create`
payloads, but the spec does not say.

**Fix:** either extend the enum, or state explicitly that tag/ref mutations
are encoded inside `revise` payloads and that the convergence rules in
Cross-Device Revision Behavior apply at the payload level. The latter is
simpler.

#### F3. Personal-memory capsule is mentioned in Terminology but never specified

Terminology (line ~149):

> Capsule: ... Global personal memory is a special capsule.

The Proposed Isolation Model diagram shows `global/personal-memory/` as an
independent capsule and Git repository. Review 2 raised this as an
underspecification; Reframe 2 does not address it. Specifically:
- Is `personal-memory` mounted into every project session by default?
- Are cross-capsule references `(capsule_id, entry_id)` stable if the
  personal capsule is migrated to a new device?
- Does `personal-memory` have its own remote, separate from every project
  remote?

**Fix:** either commit to V1 behavior (e.g. "personal-memory is a
project-local volume mounted into every capsule; it is not a separate
capsule and has no separate remote") or explicitly defer the
multi-capsule case to V2 and remove the "special capsule" mention from
Terminology.

## Issues I Did Not Find

For completeness, these are areas where I expected problems but did not
find them on this pass:

- The Trust Model section is internally consistent with itself and with
  Attachment, Project Identity, and the Cross-Device "Who may merge"
  subsection. Reframe 1 landed cleanly.
- The brain-split and convergence model (Cross-Device Revision Behavior)
  is well-specified for V1: the four guarantees, the three auto-converging
  operation types, and the requirement for explicit merge revisions on
  non-commutative operations are clear and consistent.
- The independent state machines split (transport state persisted,
  semantic state derived) is correct and well-argued.
- The deskcheck scenarios cover the right cases for V1 — concurrent
  divergence, delayed arrival, concurrent merges, crash at each point,
  push race, policy divergence, SSH revocation.
- The non-goals list correctly absorbs the V2 deferrals without
  contradiction.

## Recommended Edits Before Schema Freeze

In priority order:

1. **Specify the lock model precisely** (C1, C2, C3). This is the only
   issue that could cause implementation ambiguity. Either commit to
   "SQLite WAL is the only lock; sync releases it only for push" or
   define two distinct locks with explicit ordering.
2. **Define the minimum V1 divergence-surfacing mechanism** (E1). The
   protocol's central guarantee (brain-split is observable) currently
   rests on an undefined mechanism.
3. **Reconcile the directory diagram with the body** (B1) and define
   `capsule.json` ownership (B2). These are small but they affect the
   Capsule Layout section's credibility.
4. **Move Snapshots and Compaction into a clearly-labeled Future Work
   section** (D1) and redefine "materialized view" without snapshot
   dependency (A1).
5. **Disambiguate "frontier" and "clean" terminology** (A2, A3).
6. **Decide tag/ref operation encoding** (F2) — small but it affects the
   envelope schema freeze.
7. **Resolve personal-memory capsule status** (F3) — either commit or
   defer.
8. **Tighten the crash-recovery wording** (C4) and the Non-Goals vs
   Materialized Views tension (F1).

## Disposition

Accept the post-reframe direction unconditionally. Apply the cleanup edits
above before schema freeze. The reframings have done their job — this
review did not find any issue that would force a third reframe or a
fundamental change to the protocol shape. The next revision should be
editorial-and-precision, not architectural.
