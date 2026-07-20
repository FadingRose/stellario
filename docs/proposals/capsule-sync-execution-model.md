# Proposal: Isolated Memory Capsules and Git Dump Pipeline

Status: Revised draft (distributed-systems framing)

This document records the current design proposal for project identity, memory
isolation, local execution, cross-device revisions, and Git-based transport. It
is intentionally separate from the current implementation. No migration or
compatibility commitment should be inferred from this proposal.

### Revision notes

This proposal has been through two principal reframings.

**Reframe 1 — Trust model.** The capsule's trust boundary is fixed at remote
push access; the protocol no longer claims actor-level permissions, device
enrollment, or revision signatures for V1. `.stellario-project` is now
specified as an addressing hint with no authority, and explicit attachment
replaces automatic remote resolution. See Trust Model and Attachment.

**Reframe 2 — Distributed-systems framing.** Earlier drafts, and the two
independent reviews, treated the protocol primarily as a security design
exercising defensive depth against malicious remote actors. On reflection,
the V1 deployment is a single user with one or more devices. The genuine
opponents are not malicious actors — they are the physical realities of
distributed systems: network partition, message reordering, crash recovery,
and concurrent divergence (brain-split). This revision reframes the protocol
around those distributed-systems problems and removes or downgrades defensive
machinery that was not justified by the actual threat model.

Specific consequences:

- the remote is trusted for V1; revisions fetched from the capsule remote
  are not validated against an untrusted-integration rule set;
- `clean` and `divergent` are presented as locally derived views of the
  observed revision DAG, not as persisted monotonic states;
- the Sync Execution section focuses on brain-split detection, idempotent
  delivery, and non-fast-forward retry rather than on quarantine and
  validation pipelines;
- review-suggested deskchecks that presuppose a malicious remote are
  deferred to V2.

Security-defensive depth (signature, device enrollment, authenticated
authority, malicious-remote validation, quarantine) remains a legitimate
concern for future versions that widen the trust boundary. It is documented
as a non-goal for V1, not denied.

## Review Goal

Reviewers should determine whether the proposed execution model is internally
consistent before implementation work resumes. The principal review concerns
have shifted from security defense to distributed-systems correctness:

- brain-split detection and convergence under concurrent cross-device writes;
- idempotent delivery and order-independence of fetched revisions;
- crash recovery at every point where a local write or sync can fail;
- the separation of Git transport (an unreliable, async, ordered-by-luck
  pipe) from semantic merge (a deterministic computation over the observed
  revision DAG);
- local write acknowledgement independent of network availability;
- snapshot and long-term compaction behavior.

## Motivation

Stellario is global as a control plane, but project memory is not global data.
Putting every project's memory in one Git repository exposes unrelated project
history to every clone and couples otherwise independent sync and lifecycle
operations.

The proposed boundary is:

```text
global control plane
    -> resolves and indexes projects
isolated project capsule
    -> owns memory, history, policy, and remote
device replica
    -> owns immutable revisions
```

Git is a dump and transport pipeline. It does not decide which memory revision
is correct.

The V1 deployment model is a single user with one or more devices. Within that
model the protocol's genuine opponents are not malicious actors but the
physical realities of distributed systems:

- **network partition** — a device must remain writable while offline;
- **message reordering and duplication** — revisions may arrive late, out of
  order, or more than once;
- **concurrent divergence (brain-split)** — two devices may independently
  advance the same base, producing multiple unresolved heads;
- **crash at any point** — local durability and transport state must be
  recoverable to a consistent state on restart;
- **non-deterministic push ordering** — fast-forward may fail because another
  device pushed first; retries must converge rather than silently overwrite.

The protocol's job is to acknowledge local writes immediately, exchange
revisions asynchronously, derive a deterministic view of the resulting DAG,
and let the user (or future automation) produce explicit merge revisions to
collapse divergent heads. It is not the protocol's job, in V1, to defend
against a malicious remote or against forged actor identities — those concerns
are documented as non-goals and revisited when the deployment model widens.

## Trust Model

The capsule's trust boundary is the push access to its remote. Any actor who
can push to a capsule remote is a full-authority participant of that capsule.
The protocol does not define a separate notion of device enrollment, revision
signatures, or revocation epochs in V1 — these are delegated to the hosting
provider's access control and to the user's SSH key set.

The intended V1 deployment is a single user with one or more devices. Multi-
device collaboration is the core scenario; multi-user capsule sharing is an
edge case and is not optimized here. Within the core scenario, every device
that shares the user's SSH key is equivalent and trusted.

`actor_id` and `device_id` fields in revisions are provenance — they record
who produced a revision and on which device — but they are not permissions.
The protocol never makes an authorization decision based on these fields
alone. A revision's authority comes from the fact that it was pushed by
someone with write access to the capsule remote.

This choice has consequences:

- Forgery of `actor_id` or `device_id` by a push-capable actor is not a
  protocol violation; it is bad provenance at most.
- Revocation of a device is performed at the hosting provider (removing its
  SSH key from the collaborator list). The protocol does not need to know.
- A revoked device that has already cloned the capsule retains its local
  copy. Revocation cannot retract plaintext already cloned. This is accepted
  as a property of any distributed system and is not solvable at the protocol
  layer without encryption-at-rest, which is out of scope.
- The `prj_...` identifier in `.stellario-project` is public. Knowing it
  reveals the existence of a capsule remote (if the hosting provider
  confirms repository existence on unauthenticated requests), but confers no
  access. This is accepted as a minor information leak.

Future versions that require actor-level permissions, signed revisions, or
multi-tenant isolation must define these as additional layers on top of the
V1 trust model, not as replacements for it.

## Terminology

**Project**
: A stable logical memory domain identified by an opaque project ID.

**Capsule**
: The isolated local directory, Git repository, policy, and revision history
  for one project. Global personal memory is a special capsule.

**Replica**
: Revisions produced by one device inside a capsule.

**Revision**
: An immutable create, revise, merge, tombstone, reference, or policy event.

**Materialized view**
: A rebuildable current view derived from a snapshot plus later revisions.

**Transport frontier**
: The revisions known to be committed or replicated through Git.

**Semantic heads**
: The currently unresolved heads of an entry or project policy revision graph.

## Proposed Isolation Model

The global Stellario directory is a control plane and is not itself a memory
Git repository:

```text
~/.stellario/
|-- registry.json              # local project/path bindings
|-- devices.json               # local device information
|-- cache/                     # rebuildable cross-project indexes
|-- global/
|   `-- personal-memory/       # independent capsule and Git repository
`-- projects/
    |-- <project-id>/          # independent capsule and Git repository
    `-- <project-id>/
```

Each project capsule has its own repository and optional remote. Repository
access is therefore also the project memory access boundary. A project remote
must not contain another project's objects or history.

Cross-project search indexes are local, rebuildable caches. They are not pushed
to any project remote. Cross-project mounts refer to capsule and entry IDs, not
absolute source paths.

## Project Identity

The current `.stellario-project` implementation is a fallback that reads only a
JSON `name` field. It is lower priority than both the local project map and the
code repository remote. The current registration command does not create it.

The proposed file is an addressing hint that resolves a code repository to a
capsule:

```json
{
  "schema": "stellario.project/v1",
  "id": "prj_019c6c35-84d2-7a31-b61a-62e84957dc21"
}
```

The file contains no remote URL, provider, credentials, local path, device ID,
display name, volume configuration, permissions, or authority. It may be
committed, forked, copied, or shared freely — it confers no access. Anyone who
can read the file learns the capsule ID at most, which is not a secret (see
Trust Model).

A binding between a directory and a capsule becomes effective only when the
user explicitly attaches the directory to a capsule remote (see Attachment).
The `.stellario-project` file is checked for consistency — the ID it declares
must match the attached capsule manifest's ID — but it is never the source of
the binding. Changing or removing the file after attachment does not unbind
the directory.

Proposed identity resolution order:

1. local attachment record (`.project-map.json`) — authoritative;
2. nearest applicable `.stellario-project` file — addressing hint only, never
   sufficient on its own;
3. explicit `stellario attach` invocation for an unbound directory;
4. code repository remote — bootstrap hint for display only.

A code fork does not implicitly fork memory. A detach operation creates a new
project ID when independent memory is required.

Projects that cannot add the identity file may use a local-only binding
established by `stellario attach`. Such a binding is not automatically
discoverable on another device and requires explicit attachment there.

## Attachment

A directory is bound to a capsule by explicit user action:

```text
stellario attach --remote <url> [--project-id <id>]
```

The command writes a local attachment record:

```json
{
  "/Users/yuu/code/stellario": {
    "remote": "git@gitlab.example.com:stellario.memory.git",
    "project_id": "prj_019c6c35-84d2-7a31-b61a-62e84957dc21",
    "attached_at": "2026-07-20T12:00:00Z"
  }
}
```

The attachment record is local and not replicated. It is the authoritative
source of the directory-to-capsule binding on this device.

If `.stellario-project` is present, the capsule manifest's `project_id` must
match its declared ID; otherwise attachment is refused. This prevents typos
and accidental cross-binding, not adversarial forgery — an attacker who can
write `.stellario-project` cannot gain push access by doing so.

Detachment is an explicit user action (`stellario detach`). Removing or
altering `.stellario-project` does not detach a directory.

Capsule remote creation is also explicit. The user creates the empty remote
on their hosting provider, then attaches a fresh capsule to it, then pushes.
V1 does not implement provider API automation, remote naming conventions, or
remote URL derivation from a capsule ID. These are out of scope and would
require the protocol to assume a naming convention it cannot enforce.

## Capsule Layout

The exact file format is not frozen. The logical ownership model is:

```text
<capsule>/
|-- .git/
|-- capsule.json
|-- replicas/
|   |-- <device-a>/
|   |   `-- revisions/
|   `-- <device-b>/
|       `-- revisions/
|-- snapshots/
`-- local/                    # ignored runtime state, if stored here
```

Each device writes only its own replica path. Revisions are immutable and have
globally unique IDs. Mutable shared files should be avoided because they turn a
semantic divergence into an incidental Git file conflict.

A single main branch per capsule is the current recommendation. Per-device Git
branches add materialization and lifecycle complexity without adding project
isolation. Concurrent pushes use fetch, rebase, and retry; replica paths should
normally merge without file conflicts.

## Revision Envelope

The final schema is open, but every revision needs enough causal information to
support deterministic recovery and semantic merge. An illustrative envelope is:

```yaml
schema: stellario.revision/v1
revision_id: rev_...
project_id: prj_...
device_id: dev_...
actor_id: agent_...
operation: create | revise | merge | tombstone | policy
entry_id: 019c6c35-84d2-7a31-b61a-62e84957dc21
parents: [rev_...]
policy_revision: cfg_...
payload: {}
created_at: 2026-07-20T12:00:00Z
```

**Revision IDs** must be stable independently of file paths and Git commit
hashes, and must be globally unique so that duplicate delivery is idempotent.
A suitable format is a UUIDv7 or an equivalent monotonic-time-ordered unique
identifier, prefixed (`rev_...`).

**Entry IDs** must also be globally unique. A value such as `active:42` is a
display alias scoped to one materialized view, not an identity: two devices
creating an entry offline may both pick `active:42` and be incorrectly treated
as revisions of the same entry. The envelope uses a globally unique entry ID;
the volume-prefixed alias is rendered by the materialized view and is not
stored authoritatively.

**`parents`** is the causal basis of the revision. The protocol uses this
field directly for brain-split detection, head computation, and merge
construction. It is the only authoritative source of causal structure.

**`observed_frontier` is omitted from V1.** Earlier drafts carried a per-device
frontier vector (`{ dev_a: 101, dev_b: 34 }`) as causal metadata. With semantic
state derived from the observed DAG (see Independent State Machines), the
revision's `parents` field already encodes its causal basis and the frontier
vector is redundant. Carrying it would implicitly require monotonic per-replica
sequence semantics that V1 does not otherwise need. Frontier vectors may
reappear as checkpoint or snapshot metadata when compaction requires them;
they are not in the per-revision envelope.

**`device_id` and `actor_id` are provenance.** They record which device and
which agent produced the revision. They are displayed in history views and
may be used for filtering, but they do not participate in authorization
decisions (see Trust Model).

Duplicate revision delivery must be idempotent: receiving the same
`revision_id` twice, in either order, leaves the event set unchanged.

## Local Write Execution

A memory tool acknowledges success after local durability, not after network
replication. Local durability means the revision file is on disk and survives
a crash that occurs after acknowledgement.

```text
acquire capsule write lock (see below)
-> validate against one materialized generation
-> write revision content to a temporary file in the replica directory
-> fsync the temporary file
-> atomic rename to the final revision path
-> fsync the replica directory
-> record transport pending
-> publish the next materialized generation
-> release lock
-> return success
```

The temporary file, and any partial file left by a crash before rename, is
ignored on recovery. The transport-pending marker is derivative and is
rebuilt by scanning final revision files; it is never itself authoritative.

Revision-ID idempotence does not handle a crash after durable append but
before the tool response. A caller retry may produce a second logical
operation under a new revision ID. The protocol accepts at-least-once tool
semantics for V1: callers that require exactly-once must use a caller-stable
idempotency key (not yet specified) or tolerate the duplicate.

The network may be unavailable without preventing local work. The returned
result should distinguish local durability from remote replication when that
distinction matters to the caller.

### Local write lock

The local write lock coordinates multiple processes on the same device that
share the capsule. V1 delegates this to the storage backing the materialized
view (see Materialized Views). When SQLite in WAL mode backs the view, the
lock is SQLite's own database-level write lock, acquired as part of the
transaction that publishes the next generation. No custom lock file is
defined.

The lock is held only across local disk operations. Network operations
(fetch, push) capture an immutable batch of revisions under the lock, release
it, perform network I/O, then reacquire the lock and reconcile from the
latest local and remote state. The lock is never held across network I/O.

Multiple sessions on the same device share the lock. Device-owned replica
paths prevent cross-device Git file conflicts but do not, by themselves,
serialize two local processes.

## Sync Execution

Sync is the asynchronous exchange of revisions between this device and the
capsule remote. The remote is trusted for V1 (see Trust Model); the protocol's
job here is to converge with the remote despite network partition, message
duplication, non-deterministic push ordering, and concurrent pushes by other
devices — not to defend against a malicious remote.

One sync worker operates on one capsule at a time:

```text
capture an immutable batch of locally durable but uncommitted revisions
  (under the local write lock)
release the local write lock
acquire the capsule sync lock (mutually exclusive with other sync workers
  on this device, not with the local write lock)
recover any locally durable but uncommitted revisions added since the
  snapshot above
commit the batch into the device-owned replica path
fetch the capsule remote
rebase the device-owned commits onto the fetched branch
push with non-fast-forward retry
reacquire the local write lock
rebuild a new materialized generation from the full observed event set
publish transport frontier and sync status
release both locks
```

The lock ordering — capture-then-release, never holding across network I/O —
is what allows local writes to remain acknowledged while sync is in flight.
A writer that arrives during sync obtains the write lock against the
currently published generation; its revision is queued for the next sync
batch rather than blocking on this one.

### Idempotent delivery

A revision delivered more than once — whether by retry, by re-fetch after a
partial success, or by message replay — has no effect. Revision IDs are
globally unique; receiving a revision whose ID is already in the local event
set is a no-op. The protocol does not require that revisions arrive in any
particular order; the final observed event set is determined by the set of
revision IDs present, not by the order in which they were received.

### Non-fast-forward retry

Two devices that push concurrently will race: one succeeds, the other's push
is rejected because the remote has advanced. The rejected device must fetch
the now-advanced remote, rebase its device-owned commits onto it, and retry.
Because each device writes only its own replica path, file-level conflicts
during rebase should not occur; if they do, sync fails closed and surfaces
the failure to the user (see Failure observability). Retries are bounded;
exhausted retries leave the capsule locally ahead of the remote and surface
a sync error.

### Session-start ordering

Session startup syncs the active capsule **before** generating injected
memory context, not after. A session that reads from a stale materialized
view because it skipped the pre-context sync is considered buggy. Other
capsules sync on demand when mounted or searched. Sync failures during
session startup are tolerated (the session continues against the local
view) but must be observable.

### Failure observability

Sync failures must be persisted and observable. They must not be represented
only by a dirty Git working tree or by a swallowed exception. The capsule's
sync status — local-pending, committed, pushed, or in-error — is queryable
by tools and surfaced to the user.

### What sync does not do

Sync does not validate the contents of fetched revisions against an
untrusted-integration rule set. It does not quarantine or reject individual
revisions. It does not require revision signatures or device enrollment
checks. These are V2 concerns that arise only when the trust boundary widens
beyond "any actor with push access."

## Independent State Machines

Transport and semantic state are orthogonal, and one of them is not really a
state machine at all.

### Transport state (per-revision, persisted)

A revision moves through these transport states durably, and the state is
queryable:

```text
local-pending -> committed -> pushed
```

`local-pending` means the revision file exists on disk but is not yet in a Git
commit; `committed` means it is in a local commit; `pushed` means the remote
has accepted it. Recovery on startup reconstructs this state by scanning
revision files and the local commit graph.

### Semantic state (per-entry, derived — not persisted)

The semantic state of an entry — whether its head revisions form a single
clean line or have diverged — is **derived** from the locally observed
revision DAG and recomputed on every sync. It is not a persisted monotonic
field on the entry.

Two reasons it cannot be persisted:

1. **An offline device can never know a head is globally clean.** A delayed
   sibling revision may arrive on the next fetch and split a previously clean
   head into two. Persisting `clean` would lie.
2. **Two concurrent merges may themselves diverge.** The merge "state" is just
   another revision in the DAG and must obey the same derivation rule.

Derived terminology is relative to the observed frontier:

- a head is **locally non-divergent at frontier F** if the locally observed
  DAG has exactly one head for that entry at F;
- a head is **locally divergent at frontier F** if there are two or more.

The terms "clean" and "divergent" may appear in user-facing output as
shorthand, but the protocol never persists them and never treats them as
inputs to a state transition.

"Dirty" must not be used for either dimension. A revision may be pushed but
semantically divergent, or locally non-divergent but not yet pushed.

## Cross-Device Revision Behavior

Cross-device revision behavior is the protocol's central distributed-systems
concern. The motivating scenario is brain-split: two devices have both
observed revision `R` as the head of an entry, both go offline, both produce
a child of `R` against the same base. When they later sync, the observed DAG
has two heads for the same entry.

### What the protocol guarantees

- **No last-writer-wins.** A later push does not silently displace an
  earlier one. Both children survive in the event set.
- **Order-independence.** Whichever device pushes first, the eventual
  observed DAG is the same set of revisions; only the intermediate states
  differ.
- **Idempotent delivery.** Receiving a revision twice has no effect.
- **Divergence is observable, not auto-resolved.** The materialized view
  surfaces the divergent heads to the user (or to a future auto-merge layer)
  rather than silently picking one.

### What converges automatically

Operations whose effects commute are accepted without an explicit merge
revision. V1 recognizes:

- **independent creates**: two devices create different entries; both are
  present in the materialized view, no merge needed.
- **tag additions**: two devices add disjoint tags to the same entry; the
  union is taken at view time, no merge needed.
- **reference additions**: two devices add disjoint outgoing references to
  the same entry; the union is taken at view time.

These work because the operations are commutative on the materialized view;
the underlying revisions still form a divergent DAG, but the divergence is
resolved deterministically at view-build time without a merge revision.

### What requires an explicit merge revision

Operations whose effects do not commute require an explicit merge revision to
collapse divergent heads. V1 requires merge revisions for:

- concurrent content edits to the same entry;
- revise-versus-tombstone on the same entry;
- conflicting tag or reference changes (rare, but possible if a tag is
  added on one branch and removed on another).

A merge revision is a revision whose `parents` field lists all the divergent
heads of an entry and whose payload describes the merged result. After the
merge revision is delivered, the entry has a single head again at every
frontier that observes the merge.

A merge revision may itself diverge from another merge revision (two devices
produce merges of the same pair concurrently). This is normal and is handled
by the same rule: the resulting DAG is observed to have two merge-revision
heads, and a further merge revision is required to collapse them.

### Who may merge

Any actor with push access may produce a merge revision. There is no merge
authority distinct from transport authority in V1 (see Trust Model). Future
versions may add policy restricting which actors may merge which volumes; that
policy would be layered above the V1 trust model.

### Volume merge modes

Volume policy may restrict automatic convergence even for commutative
operations:

- `append-union` — independent creates accepted automatically (default);
- `causal-fast-forward` — a current base may advance automatically;
- `proposal-only` — every revision requires explicit acceptance;
- `frozen` — no revision proposals are accepted.

A volume in `proposal-only` or `frozen` mode keeps its revisions as
candidates that do not appear in the default materialized view until accepted.
Candidate state is derived from policy at view-build time, not persisted as
a per-revision flag.

## Project Policy and Device Configuration

Configuration is split into two categories.

Project policy is versioned inside the capsule:

- volume definitions and profiles;
- boundaries and authority;
- required tags;
- merge policy.

Actor permissions are not part of project policy in V1. Trust is delegated
entirely to remote push access (see Trust Model). Future versions that
introduce actor-level permissions would version them here.

Device-local configuration is not replicated as project policy:

- local paths and project bindings;
- star aliases;
- embedding runtime selection;
- LSP commands and timeouts;
- credentials and provider configuration.

Every data revision records the project policy revision it observed. A revision
created under an older policy is preserved after sync but may require review
under the current policy.

### Reads and writes under policy divergence

Project policy is itself a revision DAG and may diverge in the same way data
does. Two devices may have produced different policy revisions against the
same base. The protocol must define behavior during this divergence — falling
back to a stale permissive policy is unsafe, and freezing the capsule is
unusable.

The split between reads and writes matters here:

- **Reads** under divergent policy use the **intersection** of all current
  clean heads — most restrictive wins. If any clean head forbids a read, the
  read fails closed. This is deterministic: it depends only on the observed
  policy DAG, not on wall-clock order.
- **Writes** under divergent policy fail closed unless the write is valid
  under all current clean heads. A write that one head permits and another
  forbids is rejected.

This avoids the "fall back to old permissive policy" trap without freezing
the capsule for the duration of divergence. Divergence is collapsed by a
policy merge revision in the same way data divergence is (see Cross-Device
Revision Behavior). Boundary changes (volume additions, profile changes,
attachment-rule changes) must not be field-merged automatically; they require
an explicit merge revision.

## Materialized Views

Tools read a stable materialized generation. Fetching revisions must not expose
a partially updated view:

```text
apply fetched revisions to the event set
-> build generation N+1 from the full observed event set
-> atomically publish generation N+1
```

A tool already using generation N may finish against that generation. A later
tool sees generation N+1. The view is a cache and can be rebuilt from a snapshot
plus later revisions.

V1 candidate storage for the materialized view is a local SQLite database in
WAL mode, gitignored and rebuildable from revision files. SQLite provides
atomic readers, crash-safe writes, and process-local locking, which together
replace a custom lock primitive and a custom "generation" abstraction. The
revision files in device-owned paths remain the source of truth; the SQLite
database is a derived cache and may be deleted at any time.

In the SQLite-backed V1, "publishing a generation" corresponds to committing
a transaction that updates the derived tables from the current event set.
Readers using WAL mode see a consistent snapshot from before the commit until
they open a new read transaction. There is no separate "generation pointer";
the WAL snapshot mechanism serves that role.

Generation building is deterministic: building from the same observed event
set produces byte-equivalent view contents. This invariant is what makes the
view a safe cache.

## Snapshots and Compaction

Snapshots reduce replay time. They do not initially delete authoritative
revisions:

```yaml
snapshot_id: checkpoint_20
frontier:
  dev_a: 1000
  dev_b: 220
semantic_heads: {}
materialized_entries: {}
```

Deleting files from the current Git tree does not remove their historical Git
objects. Physical compaction therefore requires an epoch operation rather than
ordinary file deletion.

A future epoch rollover may:

1. produce a verified checkpoint containing the known frontier, semantic heads,
   unresolved proposals, and tombstones;
2. archive the old epoch under an archive ref or Git bundle;
3. start a new main history from the checkpoint;
4. load archived epochs on demand for full history queries.

No destructive compaction should occur until revision references, retention,
missing-device behavior, and archive retrieval are specified.

## Deskcheck Scenario

Consider devices Sirius and Vega in one project capsule, both owned by the same
user.

**Concurrent divergence and convergence.**

1. Sirius creates revision `Sirius:101` and acknowledges after local durability
   (rename + dir-fsync).
2. Sirius produces `Sirius:102` based on `Sirius:101`.
3. Offline Vega produces `Vega:34`, also based on `Sirius:101`.
4. Sirius pushes first. Vega fetches, rebases its disjoint replica file, and
   pushes without a Git file conflict.
5. After Vega's fetch, the observed event set on Vega has two heads for the
   entry: `Sirius:102` and `Vega:34`. The view-build marks the entry as
   divergent.
6. The user (on either device) produces a merge revision whose parents are
   both heads.
7. The next materialized generation has one head and the entry is no longer
   marked divergent.

**Delayed arrival splits a previously clean head.**

8. Suppose only `Sirius:102` exists on Sirius at sync time. Sirius's view
   marks the entry as locally non-divergent at this frontier.
9. Later, Vega comes online and pushes `Vega:34`, also a child of
   `Sirius:101`.
10. Sirius's next fetch receives `Vega:34`. The view is rebuilt; the entry
    is now divergent. The previously-observed "non-divergent" state is not
    persisted and is not violated — it was true at the earlier frontier and
    is false at the current one.

**Concurrent merges themselves diverge.**

11. Both Sirius and Vega produce merge revisions of the same pair of heads,
    independently, while offline.
12. After sync, the DAG has two merge-revision heads for the same entry. The
    view marks it divergent again. A further merge revision is required to
    collapse them. The protocol does not prefer one merge over the other by
    wall-clock order.

**Crash recovery.**

13. A worker crashes after the rename-fsync but before the directory-fsync.
    The revision file is on disk; the directory entry may or may not be
    present. Recovery scans final revision paths; partial or temporary files
    are ignored.
14. A worker crashes after Git commit but before push. Startup detects that
    the capsule repository is locally ahead and retries transport without
    generating a duplicate revision (idempotent delivery by revision ID).
15. A worker crashes after durable write but before sending the tool
    response. The caller retries and produces a second revision under a new
    revision ID. The protocol accepts at-least-once tool semantics; the
    duplicate is visible in the view and may be tombstoned by the user.

**Push race and retry.**

16. Sirius and Vega both push concurrently. One succeeds; the other's push is
    rejected as non-fast-forward. The rejected device fetches the advanced
    remote, rebases its device-owned commits, and retries. The final remote
    history is linear; the revision DAG is unaffected.

**Policy divergence during data work.**

17. Sirius changes the volume policy before Vega syncs. Vega's data revision
    remains durable and replicated. At view-build time it is evaluated under
    the intersection of all clean policy heads. It is never silently discarded
    or selected by wall-clock order.

**SSH key revocation.**

18. If Vega's SSH key is revoked at the hosting provider before it pushes,
    its local revisions remain durable on Vega but cannot reach the capsule
    remote. The user must either re-add Vega's key or manually carry the
    revisions to a device that still has push access. The protocol does not
    offer an out-of-band transport.

## Execution Invariants

**Capsule and trust**

1. A capsule is the unit of repository, remote, locking, and sync.
2. The capsule's trust boundary is its remote push access (V1).
3. `.stellario-project` is an addressing hint with no authority. Bindings
   become effective only through explicit user attachment.
4. `actor_id` and `device_id` are provenance, not permissions.
5. One project repository never contains another project's memory history.
6. Global indexes are caches, not a route around capsule boundaries.

**Local writes and durability**

7. A device writes only immutable revisions in its own replica path.
8. Local durability uses tempfile → fsync → atomic-rename → dir-fsync.
9. Network push is not a precondition for local write success.
10. The local write lock is held only across disk operations, never across
    network I/O.

**Sync and convergence**

11. Recovery and delivery are idempotent by revision ID.
12. Sync is order-independent: the observed event set depends only on which
    revision IDs have been received, not on the order of receipt.
13. Sync never silently overwrites an unmerged divergent head. Last-writer-
    wins is not a protocol rule.
14. Non-fast-forward push retries converge by fetch + rebase, not by force-
    push.
15. Session startup syncs the active capsule before generating injected
    memory context.

**Views and policy**

16. Materialized views are rebuildable and atomically published by
    generation; building from the same event set produces byte-equivalent
    contents.
17. `clean` and `divergent` are derived views of the observed DAG, not
    persisted monotonic states.
18. A data revision records the project policy revision it observed.
19. Reads under divergent policy use the intersection of all clean heads;
    writes under divergent policy fail closed unless valid under all clean
    heads.

## Current Implementation Gaps

The existing implementation must not be treated as a partial realization of
this protocol. Important differences include:

- `~/.stellario` is currently one parent Git repository;
- projects are subtrees rather than independent repositories;
- tracked volume JSONL files are mutable snapshots;
- writes commit and synchronously attempt a push;
- sync errors are normally silent (caught and discarded);
- session context is built before the session-start pull;
- `.stellario-project` identifies a project by name and is only a fallback;
- device-relative migration has begun (per-device subdirectories exist) but
  the working tree is in a half-migrated state: old-path tracked files are
  deleted, new-path files are untracked. This is the concrete shape of
  "migration before the revision protocol is defined";
- cross-device aliases and native mounts use filesystem paths rather than
  capsule/revision identities.

The V1 deployment has exactly one user, which makes the migration window
tolerable but does not eliminate it. A V1 that does not provide a one-shot
read-only importer from the current JSONL layout will silently break the
existing memory at cutover. The importer is not part of this protocol spec
but is a prerequisite for shipping V1.

No automatic migration to this proposal is defined.

## Open Questions

Resolved by this revision:

- ~~Are revisions signed, and how are devices enrolled and revoked?~~
  Resolved: V1 delegates to remote push access. See Trust Model.
- ~~How are project memory remotes provisioned by each provider?~~
  Resolved: explicit user creation and `stellario attach`. See Attachment.
- ~~Is `.stellario-project` committed by default or opt-in?~~
  Resolved: the file confers no authority; it may be committed or omitted at
  the user's discretion.
- ~~Which actor identities may accept, reject, or merge proposals?~~
  Resolved: any actor with push access.
- ~~What lock implementation coordinates local processes and recovers stale
  owners?~~ Resolved for V1: SQLite WAL. See Materialized Views and Local
  Write Execution.
- ~~What reads remain available during project policy divergence?~~ Resolved:
  intersection of all clean heads. See Project Policy.

Still open:

1. What is the exact revision envelope and canonical serialization?
2. How are monorepo and nested project boundaries resolved?
3. Which operations beyond independent creates, tag-add, and ref-add are
   safe for automatic convergence in the materialized view?
4. What caller-stable idempotency key scheme (if any) is required for
   exactly-once tool semantics, or is at-least-once permanently accepted?
5. How does sync surface the "you have N divergent heads across M entries"
   state to the user, and what user action initiates a merge?
6. What snapshot format and verification rules are required?
7. When may an offline or lost device be excluded from an epoch frontier?
8. How are archived epochs discovered and retrieved for history queries?
9. What is the on-disk shape of the SQLite materialized view, and how is it
   rebuilt on demand from revision files?

## Explicit Non-Goals for This Proposal

- selecting a storage database for the materialized view (V1 candidate: SQLite,
  see Materialized Views — but the protocol does not require it);
- preserving the current JSONL ABI unchanged;
- defining a user interface for merge review;
- implementing automatic text merges;
- defining remote encryption or hosting-provider credentials;
- defining a migration schedule;
- actor-level permissions, revision signatures, device enrollment, or
  revocation epochs (delegated to remote push access in V1);
- automatic remote provisioning via provider APIs or remote-URL derivation
  from capsule IDs (V1 uses explicit attachment);
- multi-user capsule sharing optimizations (V1 optimizes for one user across
  multiple devices);
- **validating remote revisions against an untrusted-integration rule set**
  (V1 trusts the remote; this is a V2 concern if the trust boundary widens);
- **quarantine, rejection, or per-revision signature verification of fetched
  data** (deferred to V2 for the same reason);
- **defending against a malicious capsule remote or a forged actor identity**
  (out of scope until the deployment model includes actors without push
  access).

## Requested Review Output

Reviewers should return:

1. violations of the execution invariants;
2. scenarios that cause data loss, lost writes, unrecoverable state, or
   non-convergent divergence under the V1 deployment model (single user,
   multiple devices, async sync);
3. unnecessary complexity that can be removed without weakening convergence
   or durability guarantees;
4. missing recovery boundaries or unhandled crash points in the write or
   sync paths;
5. a recommendation to accept, revise, or reject the model before protocol
   work.

Reviews that presuppose a malicious remote or a multi-tenant deployment are
out of scope for V1; their concerns are noted in the non-goals and deferred
to V2.
