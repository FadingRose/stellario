# Review 2: Isolated Memory Capsules and Git Dump Pipeline

Status: Independent review — revise before protocol freeze

Reviewed proposal: [capsule-sync-execution-model.md](capsule-sync-execution-model.md)
Companion review: [capsule-sync-execution-model-review.md](capsule-sync-execution-model-review.md)

This is a second independent pass. It does not repeat the first review's points
unless they need reinforcement; it focuses on areas the first review under-covered
and on factual consistency between the proposal and the current implementation.

## Summary Recommendation

**Revise.** The direction is correct and the proposal is unusually disciplined
about distinguishing itself from the current implementation. The blocking issues
identified in review 1 (trust model, remote validation, write/sync concurrency,
durability boundary, semantic-state derivation, replica causality) are real and
must be addressed before schema freeze. This second pass adds concerns about
the practical migration story, the locking layer, the policy model's interaction
with reads, and the gap between the deskcheck narrative and the actual Git
mechanics the proposal depends on.

## Direction Accepted Without Reservation

- One repository per project capsule is the right isolation unit.
- Stable opaque project ID decoupled from filesystem path and code remote.
- Immutable, device-owned revisions as the source of truth.
- Local-first acknowledgement; asynchronous transport.
- Git as dump, semantic merge as a separate layer above it.
- Rebuildable materialized views; no MVCC orthogonality required for V1.

These match the project's existing direction (device-relative directories,
`.track/` per-entry files, asynchronous fire-and-forget push) and are not the
contested surface.

## Issues the First Review Under-Covered

### A. The Migration Question Cannot Be Deferred as Long as Claimed

The proposal explicitly lists migration as an out-of-goal and review 1 concurs.
That is correct as a *protocol-design* stance. But the current implementation
already advertises multi-device sync (constellation sync, star assignment) to
users today, and the proposal's "Current Implementation Gaps" section reads as
if the present model is a prototype rather than a shipping feature.

Concrete implication: any V1 that does not provide a **read path** from the
current `~/.stellario/projects/<name>/{volume}.jsonl` shape into the capsule
model will silently break every existing user. The proposal should add an
explicit "no automatic migration, but a one-shot read-only importer for current
JSONL" goal, or explicitly accept that V1 ships without backward compatibility
and document the user-visible cutover.

This is a *protocol-adjacent* concern, not protocol work itself, and it should
not be silently deferred.

### B. The Lock Layer Is Hand-Waved in Both Documents

The proposal says "acquire capsule write lock" and "acquire capsule sync lock"
as if these were primitives. Review 1 correctly demands a single defined
mutation lock for V1, but neither document specifies what backs the lock.

On a single device, candidates with very different tradeoffs are:

- **Filesystem flock on the capsule root** — works across processes but not
  across machines; recovers poorly from a killed holder.
- **A `capsule.lock` JSON file with PID, boot id, and TTL** — observable and
  debuggable, but requires stale-lock detection and human repair path.
- **An SQLite WAL-mode database as the local materialized view** — gives MVCC,
  atomic readers, and crash-safe writes for free, replacing both the lock and
  the "materialized generation" abstraction almost entirely.

The proposal lists "selecting a storage database for the materialized view" as
an explicit non-goal, but in practice the storage choice is the lock choice.
The next revision should either (a) commit to a JSON-files-plus-flock V1 with
documented stale-lock recovery, or (b) acknowledge that the lock question is
open and gate the protocol on it.

### C. The Deskcheck Scenario Relies on Git Mechanics That Are Not Specified

Step 4 of the deskcheck says: "Vega fetches, rebases its disjoint replica file,
and pushes without a Git file conflict." This is the load-bearing claim of the
entire layout — it is the reason device-owned replica paths exist.

It is also underspecified. For this to actually work:

- The capsule's `main` must allow non-fast-forward push with retry semantics,
  but review 1 correctly demands rejection of non-descendant rollback. The
  rebase-and-retry path and the reject-rollback path share the same observable
  signal (target is not an ancestor of HEAD) and the proposal does not
  distinguish them.
- `git rebase` across device-owned paths will produce a linear history whose
  commit order is *not* the revision-DAG order. Tools that read revisions off
  the capsule must therefore not infer causality from Git commit order. This is
  implied but not stated.
- If Vega's commit is ever amended, squashed, or rewritten by a forced fetch
  (e.g., by a server-side hook), its revision IDs survive but its commit
  identity does not. Recovery semantics need to be defined in terms of revision
  IDs, not Git object identity, everywhere.

The proposal should add a short section: "Git is a transport, not a source of
truth. Commit order, commit hashes, and branch tips are not protocol-relevant.
Revision IDs and the revision parent graph are the only authoritative causal
structure."

### D. Policy Reads Under Divergence Are Specified Insufficiently

The proposal says reads use "the most recent common clean policy where possible"
and writes "fail closed" under ambiguity. Review 1 rejects this and demands
fail-closed or well-defined intersection. The deeper issue is that **read
policy** and **write policy** are different dimensions and the proposal does
not separate them:

- A *read* under divergent policy must still answer: "is this entry visible to
  this actor?" Falling back to a stale permissive policy is unsafe, but failing
  every read during any policy divergence makes the capsule unusable for the
  duration of divergence — which could be long, since merging requires an
  authorized actor.
- A *write* under divergent policy can fail closed cheaply because the actor
  still has the option to retry after merge.

The next revision should define read policy as "intersection of all current
clean heads" (most restrictive wins) and write policy as "fail closed unless
the write is valid under all current clean heads." This is deterministic, safe,
and avoids the "fall back to old policy" trap without freezing the capsule.

### E. `observed_frontier` Is Doing More Work Than the Proposal Admits

The revision envelope carries `observed_frontier: { dev_a: 101, dev_b: 34 }`.
The proposal describes this as causal metadata. In fact it is two different
things conflated:

1. **What the author saw when writing** — needed for causal merge decisions.
2. **A claim about the global state of the capsule** — needed for nothing in V1
   if semantic state is derived (as review 1 demands).

If semantic state is locally derived from the observed DAG, then `observed_frontier`
as a *whole-vector claim* is redundant; the revision's `parents` already encode
its causal basis. Review 1's "smaller V1" hint is correct: drop the frontier
vector from the envelope, keep it as checkpoint/snapshot metadata only.

The proposal should resolve this explicitly. Right now the envelope looks like
it requires the very monotonic-replica-sequence semantics that review 1 flagged
as undefined.

### F. The "Global Personal Memory" Capsule Is Underspecified

The proposal says "global personal memory is a special capsule" and shows
`global/personal-memory/` as its own capsule with its own repository. But the
current implementation's global memory (`~/.stellario/global/`) is *the* shared
cross-project scratch space, used by every project's session-start context
injection.

Questions the proposal does not answer:

- Is `personal-memory` a capsule that every project's session has mounted by
  default? If so, that is a privilege boundary that needs explicit policy.
- Can a project capsule reference entries in `personal-memory` by ref? If so,
  moving the personal capsule across devices breaks those refs unless the ref
  is `(capsule_id, entry_id)`, not a path.
- Does `personal-memory` sync to its own remote, separate from every project
  remote? The user is now maintaining N+1 remotes.

This is not blocking for V1, but the special-capsule carve-out should be
narrowed before implementation rather than discovered during it.

### G. `.stellario-project` and the Bootstrap Trust Issue

Review 1 covers this in "Project Locator Confirmation." A sharpened framing:

`.stellario-project` is the **only** proposal artifact that lives in the
checked-out code repository rather than in the user's memory directory. It is
therefore the only artifact an attacker who controls the code repo can write.
The proposal must treat it as untrusted input forever, not just at first
attachment.

Concretely: a `personal-memory` entry pinned under project ID `prj_A` must not
become readable to project `prj_B` simply because an attacker committed a
`.stellario-project` claiming `prj_A` into `prj_B`'s repo. The capsule
manifest, not the project file, must be the authority for "this directory is
bound to this capsule," and the binding must be locally pinned and require
explicit user action to change.

The proposal gestures at this ("explicit confirmation and a local pin") but
does not elevate it to an invariant. Suggested addition to the invariants
list: "The project identity file is an untrusted hint. The local capsule
binding is the authority."

## Issues Worth Reinforcing from Review 1

These do not need re-derivation, but I want to record that I independently
reached the same conclusions, so the next revision cannot dismiss them as one
reviewer's taste:

- **Trust model fork is the first thing to resolve.** Everything downstream
  (validation, policy authorization, revocation, merge authority) forks on
  this choice. Do not try to leave it open.
- **Validate-before-integrate for remote data is non-negotiable.** The current
  sequence in the proposal is unsafe as written.
- **`active:42` as entry ID is incorrect.** Display aliases must not be
  identity. This is a one-line fix to the envelope example and should not
  survive into the next revision.
- **Durability is `tempfile + fsync + atomic-rename + dir-fsync`.** This is
  table stakes; the proposal under-specifies it.

## Scenarios I Would Add to the Required Deskchecks

The first review lists 12 deskchecks. I would add:

13. **Concurrent merge across devices.** Two devices fetch the same divergent
    pair and both produce merge revisions. The merge revisions themselves
    diverge. Does the protocol detect this, or does the first-pushed merge
    win silently? (This is the "two actors concurrently merge the same pair"
    scenario generalized to devices.)

14. **Cross-capsule ref stability.** A project capsule has a manual ref to an
    entry in `personal-memory`. The user moves `personal-memory` to a new
    device and recreates the entry under a new revision ID. Does the ref
    resolve, dangle, or silently point at the wrong thing?

15. **Policy head diverges from data head.** Data head A was written under
    policy P1. Policy diverges into P2 and P3, both of which forbid A's actor.
    Does A remain readable? Under which policy? (This is the "read under
    divergence" question made concrete.)

16. **Stale lock after crash.** A process holding the capsule write lock is
    SIGKILLed. The next session starts. Does it recover automatically, require
    user intervention, or wedge permanently? What observable signal
    distinguishes "stale lock" from "another live session"?

17. **Server-side history rewrite.** The capsule remote's history is rewritten
    by an administrator (force-push, hook, or bucket wipe-and-restore). The
    next fetch observes commits the client has never seen and is missing
    commits the client previously pushed. What is the recovery path that does
    not involve discarding local revisions?

## Minimum V1 — Points of Disagreement with Review 1

Review 1's "Minimum Acceptable V1" list is broadly correct. Two refinements:

1. **"either repository-level full trust or mandatory authenticated revisions"**
   should be tightened to **"repository-level full trust for V1; authenticated
   revisions explicitly deferred to V2."** The fork should be resolved in
   favor of the simpler option for the first shipping version, with the
   protocol envelope reserving fields for signatures so V2 is additive.

2. **"DAG parents with head sets derived from the observed event set"** should
   add **"and `observed_frontier` is not in the V1 envelope."** The frontier
   vector is not needed if heads are derived, and including it creates an
   implicit requirement on replica sequence semantics that V1 does not
   otherwise need.

## Editorial Notes

- The proposal's tone of "this is not the current implementation" is valuable
  and should be preserved through revision. Many design docs collapse this
  distinction under pressure and become unreadable.
- The "Terminology" section's definition of "Materialized view" as
  "rebuildable from a snapshot plus later revisions" implicitly assumes
  snapshots exist. Review 1's "snapshots are local and disposable in V1" makes
  this definition inapplicable to V1. Either redefine the term without
  snapshots, or mark snapshots as required.
- The "Independent State Machines" section's transport state list
  (`local-pending -> committed -> pushed`) omits the `quarantined` state that
  review 1 requires for invalid remote revisions. Add it.

## Disposition

Accept the direction unconditionally. Revise the protocol before schema freeze.
Resolve the trust-model fork first, in favor of repository-level full trust
for V1, with signature fields reserved. Specify the lock layer, the read
policy under divergence, and the "Git is transport only" invariant
explicitly. Add a read-only importer path from current JSONL so existing
users are not silently broken at cutover.

The next revision should not require a third full review; it should require
only verification that the blockers from this and the first review are
resolved.
