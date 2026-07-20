# Review: Isolated Memory Capsules and Git Dump Pipeline

Status: Review complete - revision required

Reviewed proposal:
[capsule-sync-execution-model.md](capsule-sync-execution-model.md)

This report consolidates three independent reviews covering distributed-system
correctness, security and isolation, and implementation simplicity. The
reviewers did not modify the proposal or implementation.

## Overall Recommendation

Revise before freezing the protocol or implementing migration.

The following direction was consistently accepted:

- one isolated repository and remote per project capsule;
- stable project identity independent of directory and code remote names;
- immutable device-owned revisions;
- local-first write acknowledgement;
- asynchronous Git transport;
- semantic divergence and merge above Git;
- rebuildable local views and indexes.

The current proposal overstates the stability of the execution model in areas
where trust, concurrency, and durability are still undefined.

## Protocol Blockers

### 1. Choose the Trust Model

The proposal assigns merge authority and project permissions to `actor_id` and
uses `device_id` to define replica ownership, but both values are currently
self-asserted. Any Git writer can forge another actor or device, modify another
replica path, emit a merge or tombstone, or create a policy revision granting
itself authority.

Two internally consistent V1 choices exist:

1. Treat repository write access as full capsule authority. Actor and device
   fields are provenance only; finer-grained permissions and revocation are not
   security guarantees.
2. Make canonical serialization, revision signatures, device enrollment,
   revocation, and policy-transition authorization mandatory protocol
   prerequisites.

The protocol must choose explicitly. It cannot claim actor-level permissions
while leaving signatures and enrollment as optional future work. A policy
revision must be authorized by the previously accepted policy and cannot
authorize itself.

### 2. Validate Remote Data Before Integration

The proposed sequence rebases fetched commits before validating revision
envelopes. A faulty or malicious remote can therefore edit or delete local
replica data, metadata, or snapshots before rejection.

Remote commits must first enter an untrusted ref, index, or worktree. Validation
must cover at least:

- capsule/project identity;
- allowed changed paths;
- append-only behavior and path ownership;
- canonical revision IDs and duplicate-ID body equality;
- schema and resource limits;
- parent graph validity and cycle rejection;
- signatures and replica sequence when the authenticated model is selected;
- non-descendant rollback and force-push detection.

Only validated revisions may be imported into the authoritative local event
set. Invalid revisions need quarantine and repair semantics so one bad append
does not permanently block all valid memory.

### 3. Define One Write/Sync Concurrency Protocol

Separate write and sync locks can both start from materialized generation N. A
writer may publish N+local while sync subsequently publishes N+remote, hiding
an acknowledged local revision. A writer can also dirty the same Git worktree
while sync stages or rebases.

The protocol needs either:

- one capsule repository-mutation lock for the simple V1; or
- a precise lock order, frozen sync batches, a private staging worktree/index,
  and generation compare-and-swap.

Network operations should not hold the local write lock indefinitely. A viable
sequence is to capture an immutable batch under the lock, release it for
network work, then reacquire it and rebuild/publish from the latest local and
validated remote event set.

### 4. Complete the Durability and Retry Boundary

`write + fsync(file)` is not sufficient for durable creation of an immutable
revision file. V1 should require:

```text
write temporary file in the target directory
-> fsync temporary file
-> atomic rename to final revision path
-> fsync parent directory
-> acknowledge local durability
```

Temporary or partial files are ignored or quarantined during recovery. The
pending queue remains derivative and is reconstructed by scanning final
revision files.

Revision-ID idempotence does not handle a crash after durable append but before
the tool response. A caller retry may create a second logical operation under a
new revision ID. The protocol must add a caller-stable idempotency key or
explicitly document at-least-once tool semantics.

### 5. Make Semantic State Derived and Frontier-Relative

An offline device can never know that a head is globally clean; a delayed
sibling may arrive later. `clean` and `divergent` should be deterministic views
derived from the locally observed revision DAG, not persisted monotonic states.

The model must cover:

- one locally observed head becoming multiple heads after a later fetch;
- two concurrent merge revisions producing divergence again;
- immutable accept, reject, and merge decision revisions;
- descendants of rejected proposals;
- push success with a lost response;
- validation and materialization repeated on every non-fast-forward retry.

Terminology should say "locally non-divergent at frontier F" rather than imply
global cleanliness.

### 6. Strengthen Identity and Replica Causality

Entry IDs must be globally unique. Human-readable values such as `active:42`
are display aliases, not identity. Otherwise two offline creates may be
incorrectly interpreted as revisions of the same entry.

If replica frontiers are retained, revisions need protocol backing such as:

- replica incarnation;
- monotonic replica sequence;
- previous-revision hash or link;
- deterministic handling of restored/cloned device identities.

For a smaller V1, causal parents plus an immutable policy reference may be
sufficient for entry operations. Full observed frontiers can remain transport
or checkpoint metadata until an operation requires them.

## Recommended V1 Reductions

### Remote Provisioning

Provider templates and hosting APIs are control-plane UX, not revision protocol
requirements. V1 may use an explicit local capsule-to-remote binding. Automatic
provider provisioning can be layered on later without changing capsule data.

### Project Policy

Replicated mutable policy introduces authorization and deterministic-evaluation
requirements too early. A smaller V1 can use:

- an immutable initial capsule manifest;
- exactly one explicitly accepted effective policy;
- proposal-only policy revisions; or
- no replicated policy mutation until authenticated authority is designed.

"Most recent common clean policy" is not sufficiently deterministic. During a
security-relevant policy ambiguity, permissions must fail closed or use a
well-defined intersection; falling back to an older permissive policy is not
acceptable.

### Materialized Views and Snapshots

V1 needs atomic replacement of a local rebuildable cache, not a full normative
MVCC protocol. A tool may retain an immutable in-memory view for one call.

Snapshots should initially be local, ignored, and disposable. Shared tracked
`snapshots/` would reintroduce cross-device conflicts and creates an additional
trust root. Synced checkpoints, archive refs, and epoch rollover should remain
future work until replay cost requires them.

### Shared Capsule Files

`capsule.json` must be immutable identity/schema metadata if it remains in a
shared path. Mutable derived state belongs in local ignored storage or a
device-owned replica path.

## Additional Security Boundaries

### Project Locator Confirmation

`.stellario-project` is controlled by the checked-out code repository. It must
not act as a capability or silently cause access/provisioning with the user's
global provider credentials.

First attachment should require explicit confirmation and a local pin of the
accepted capsule/remote binding. The capsule manifest must confirm the same
project ID. Monorepo roots, nested manifests, worktrees, and symlinks require
defined resolution rules.

### Local Process Boundary

Separate repositories isolate remote history, not processes running as the
same OS user. If actor permissions are intended as a security boundary, raw
filesystem access and global search caches can bypass them.

The threat model must state whether local actors are trusted. Cross-project
search and mount dereferences must authorize each result against current
capsule policy, invalidate cached access after policy changes, and never treat
an entry ID as a capability.

### Revocation and Rollback

Signing alone does not define whether an offline revision remains valid after a
device is revoked. The authenticated design needs revocation epochs or cutoffs,
locally pinned accepted frontiers, and rejection of non-descendant rollback.
Revocation cannot retract plaintext already cloned by a device.

## Required Deskchecks for the Next Revision

1. A remote writer forges another device path and privileged actor ID.
2. A remote fast-forward deletes or modifies a previously accepted revision.
3. Local write and sync concurrently publish from the same view generation.
4. Power fails after file fsync but before directory fsync.
5. A tool retry follows a durable write whose acknowledgement was lost.
6. A delayed sibling arrives after an entry appeared locally non-divergent.
7. Two actors concurrently merge the same pair of heads.
8. Push succeeds but the client loses the response and retries.
9. A revoked device submits an offline revision under an older policy.
10. Two devices independently create the display alias `active:42`.
11. A malformed remote revision appears between two valid revisions.
12. A malicious checkout points `.stellario-project` at an accessible capsule.

## Minimum Acceptable V1

The reviewers consider the following reduced model implementable after the
blockers above are specified:

- stable `.stellario-project` identity;
- one isolated repository and explicit remote per capsule;
- globally unique entry and revision IDs;
- immutable revision files in device-owned paths;
- atomic local durability and request retry semantics;
- one defined capsule mutation/sync locking protocol;
- asynchronous batch commit, validated fetch, rebase, and push;
- observable sync and quarantine errors;
- DAG parents with head sets derived from the observed event set;
- local rebuildable materialized view;
- either repository-level full trust or mandatory authenticated revisions.

Provider automation, mutable replicated policy, persistent semantic status,
synced snapshots, compaction, and epoch archives can be deferred.

## Disposition

Accept the project-capsule isolation and Git-as-transport direction.

Revise the execution protocol before schema freeze, implementation, or any
automatic migration. The next proposal revision should explicitly resolve the
trust-model fork first, because that choice changes validation, policy,
revocation, and merge authority throughout the protocol.
