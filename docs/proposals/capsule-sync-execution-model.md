# Proposal: Isolated Memory Capsules and Git Dump Pipeline

Status: Revised draft (post-review-3 cleanup)

This document records the current design proposal for project identity, memory
isolation, local execution, cross-device revisions, and Git-based transport. It
is intentionally separate from the current implementation. No migration or
compatibility commitment should be inferred from this proposal.

### Revision notes

This proposal has been through two principal reframings and one cleanup pass.

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

**Cleanup pass (review 3).** Review 3 found the two reframings sound but
flagged 14 internal-consistency issues: stale terminology (`frontier`
overloaded, `materialized view` defined via snapshots V1 does not have), a
layout diagram that did not match the body, an undefined `capsule.json`
ownership model, a redundant `local/` directory mention, sync-vs-write lock
ambiguity (V1 actually has one SQLite lock, not two), redundancy in the
sync flow's capture step, an imprecise crash-recovery description, a
snapshots section presented as V1 content despite being V2, an undefined
divergence-surfacing mechanism, a Non-Goals/Materialized-Views tension
about SQLite, a missing operation-enum story for tag/ref mutations, and an
underspecified "personal-memory special capsule."

This revision applies all 14 cleanup items. The protocol shape is
unchanged; the document is now internally consistent. Key decisions made
during cleanup:

- V1 has **one local lock** (SQLite WAL); sync holds it across fetch +
  rebase + view rebuild and releases it only for push.
- The materialized view exposes a **`divergent_heads` query** plus a
  session-start count, making the "divergence is observable" guarantee
  concrete.
- **`capsule.json` is immutable identity metadata**; mutable derived state
  lives in gitignored `local/`.
- **Snapshots and Compaction is explicitly labeled V2** and moved out of
  the V1 mental model.
- **Tag/ref mutations live inside `revise` payloads**; convergence rules
  apply at the payload level.
- **Personal-memory stays a project-local volume in V1**; multi-capsule
  interactions are deferred.

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
  for one project. The user's global personal memory is, in current
  implementation, a project-local volume rather than a separate capsule;
  multi-capsule interactions (mounts, cross-capsule references) are out of
  scope for V1 protocol work.

**Replica**
: Revisions produced by one device inside a capsule.

**Revision**
: An immutable create, revise, merge, tombstone, reference, or policy event.

**Materialized view**
: A rebuildable current view derived from the locally observed event set. In
  V1 the view is backed by a local SQLite database (see Materialized Views);
  snapshots are an optional V2 acceleration structure and are not required
  to define or rebuild the view.

**Transport frontier**
: The revisions known to be committed or replicated through Git.

**Semantic heads**
: The currently unresolved heads of an entry or project policy revision graph.

## Proposed Isolation Model

The global Stellario directory is a control plane and is not itself a memory
Git repository:

```text
~/.stellario/
|-- .project-map.json          # local attachment records (binding: directory ↔ capsule)
|-- .device-id                 # local device identifier (self-asserted, gitignored)
|-- .stars.json                # device → human-readable star name (gitignored)
|-- cache/                     # rebuildable cross-project indexes (gitignored)
|-- global/
|   `-- personal-memory/       # project-local volume in V1; separate capsule deferred to V2
`-- projects/
    |-- <project-id>/          # one capsule per project: own Git repo, optional remote
    `-- <project-id>/
```

Files prefixed with `.` and the `cache/` directory are device-local and
gitignored; they are not replicated. Only the per-capsule Git repositories
under `projects/` and `global/` are synced, and each one syncs only to its
own remote.

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
|-- capsule.json               # immutable: schema version + capsule ID
|-- replicas/
|   |-- <device-a>/
|   |   `-- revisions/
|   `-- <device-b>/
|       `-- revisions/
|-- snapshots/                 # V2: not present in V1
`-- local/                     # device-local runtime state (gitignored)
    |-- <device-id>/
    |   |-- materialized.db    # SQLite materialized view
    |   `-- transport-pending  # derivative marker, rebuilt on recovery
    `-- ...
```

**`capsule.json`** is immutable identity and schema metadata. It contains
the capsule ID and the schema version. It does not contain policy, derived
state, or anything that changes after capsule creation. If the schema or
identity need to evolve, that evolution is expressed as a new capsule
(migration) rather than as a mutation of `capsule.json`. Mutating this file
on one device and pushing it would silently fork the capsule's identity,
which is exactly the failure mode immutable metadata prevents.

**`local/`** is a gitignored directory holding device-local runtime state
that does not sync. In V1 it contains one subdirectory per device that has
written to this capsule, holding that device's SQLite materialized view and
any derivative markers. The transport-pending marker is rebuilt on recovery
by scanning revision files; it is never itself authoritative.

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

**Operation enum** is `create | revise | merge | tombstone | policy`. Tag
additions and removals, and reference additions and removals, are encoded
inside `revise` payloads rather than as separate operation values. The
convergence rules in Cross-Device Revision Behavior are applied at the
payload level: two `revise` revisions whose payloads add disjoint tags to
the same entry auto-converge at view-build time; two `revise` revisions
whose payloads conflict (one adds a tag, another removes the same tag)
require an explicit merge revision.

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
acquire the SQLite write lock (see Local write lock below)
-> validate against one materialized generation
-> write revision content to a temporary file in the replica directory
-> fsync the temporary file
-> atomic rename to the final revision path
-> fsync the replica directory
-> record transport pending
-> publish the next materialized generation (commit the SQLite transaction)
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
(push) release the lock for the duration of the network I/O and reacquire
it before reconciling post-push state. The lock is never held across the
push itself. Fetch and rebase, although they involve the network, do not
release the lock: their result (the post-fetch event set) must be reconciled
with the materialized view atomically, before any new local write is
acknowledged against the post-fetch generation.

Multiple sessions on the same device share the lock. Device-owned replica
paths prevent cross-device Git file conflicts but do not, by themselves,
serialize two local processes.

## Sync Execution

Sync is the asynchronous exchange of revisions between this device and the
capsule remote. The remote is trusted for V1 (see Trust Model); the protocol's
job here is to converge with the remote despite network partition, message
duplication, non-deterministic push ordering, and concurrent pushes by other
devices — not to defend against a malicious remote.

V1 has a single local lock: the SQLite write lock that also serializes local
writes (see Local Write Execution). There is no separate sync lock. The
consequence is that local writes are blocked while sync holds the lock, but
sync holds the lock for the minimum time required for atomic reconciliation
and releases it for the slow network operation (push).

One sync worker operates on one capsule at a time:

```text
acquire the SQLite write lock
scan the replica directory for locally durable but uncommitted revisions
commit the scanned revisions into the device-owned replica path (Git)
fetch the capsule remote
  (network I/O, but does not release the lock)
rebase the device-owned commits onto the fetched branch
  (file conflicts should not occur; each device writes its own replica path)
apply the fetched revisions to the local event set
rebuild the materialized generation from the full observed event set
release the SQLite write lock
push with non-fast-forward retry
  (network I/O; the lock is not held)
if push was rejected as non-fast-forward:
  loop back to "acquire the SQLite write lock" and retry
publish transport frontier and sync status
```

The critical property is that **fetch, rebase, event-set update, and view
rebuild happen atomically under the lock**. A local writer that obtains the
lock after sync releases it sees a post-fetch materialized generation; it
never validates against a pre-fetch generation while the post-fetch event
set is partially applied. This is what makes sync's effect on the view
indivisible from the perspective of local writers.

Push is the only step that releases the lock. If push is rejected as
non-fast-forward, sync loops back, reacquires the lock, fetches the now-
advanced remote, and reconciles. The reconciliation is idempotent (see
below), so retrying after a successful-but-unconfirmed push has no effect.

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

Derived terminology is relative to the locally observed event set:

- a head is **locally non-divergent at observed event set E** if E, applied
  to the entry's revision DAG, leaves exactly one head for that entry;
- a head is **locally divergent at observed event set E** if E leaves two or
  more.

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
observed event set that includes the merge.

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

### Surfacing divergence

The materialized view exposes a `divergent_heads` query that returns every
entry currently with more than one observed head, along with the head
revision IDs. Session-start context injection includes the count of
divergent entries and a brief pointer (volume, entry ID) for each. A tool
or user may then produce a merge revision explicitly. Auto-merge of
non-commutative operations is out of scope for V1.

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
  non-divergent policy heads — most restrictive wins. If any non-divergent
  head forbids a read, the read fails closed. This is deterministic: it
  depends only on the observed policy DAG, not on wall-clock order.
- **Writes** under divergent policy fail closed unless the write is valid
  under all current non-divergent heads. A write that one head permits and
  another forbids is rejected.

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
tool sees generation N+1. The view is a cache and can be rebuilt from the
full observed event set.

V1 storage for the materialized view is a local SQLite database in WAL mode,
gitignored and rebuildable from revision files. SQLite provides atomic
readers, crash-safe writes, and process-local locking, which together
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

## Snapshots and Compaction (V2 — not in V1)

V1 does not implement snapshots, checkpoints, or compaction. The materialized
view is rebuilt from the full observed event set on every sync. This section
describes the shape snapshots would take when replay cost justifies them; it
is not part of the V1 protocol.

Snapshots reduce replay time. They do not initially delete authoritative
revisions:

```yaml
snapshot_id: checkpoint_20
observed_event_set_summary:
  devices_present: [dev_a, dev_b]
  revision_count: 1220
# semantic_heads and materialized_entries are derived at load time
# from the event set; they are not stored authoritatively in the snapshot.
```

Note: V1 has no `frontier` vector in the revision envelope (see Revision
Envelope). A snapshot format that summarizes the observed event set would
need to derive any per-device causal information from the revision DAG
itself, not from an envelope field.

Deleting files from the current Git tree does not remove their historical Git
objects. Physical compaction therefore requires an epoch operation rather than
ordinary file deletion.

A future epoch rollover may:

1. produce a verified checkpoint containing the known observed event set,
   semantic heads, unresolved proposals, and tombstones;
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
   marks the entry as locally non-divergent at this observed event set.
9. Later, Vega comes online and pushes `Vega:34`, also a child of
   `Sirius:101`.
10. Sirius's next fetch receives `Vega:34`. The view is rebuilt; the entry
    is now divergent. The previously-observed "non-divergent" state is not
    persisted and is not violated — it was true at the earlier observed
    event set and is false at the current one.

**Concurrent merges themselves diverge.**

11. Both Sirius and Vega produce merge revisions of the same pair of heads,
    independently, while offline.
12. After sync, the DAG has two merge-revision heads for the same entry. The
    view marks it divergent again. A further merge revision is required to
    collapse them. The protocol does not prefer one merge over the other by
    wall-clock order.

**Crash recovery.**

13. A worker crashes after the rename returns but before the directory-fsync
    completes. The rename call is atomic, so at the moment of crash the file
    is either at its old path or its new path, never both. The risk is that
    the directory update recording the rename was not durably persisted to
    disk. After crash recovery, the file may or may not appear in its final
    path. Recovery scans final revision paths only: revisions that appear
    are accepted; revisions that do not appear are treated as never written.
    Temporary files left by crashes earlier in the sequence are ignored.
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
10. The local write lock is held across local disk operations, fetch, rebase,
    and view rebuild. It is released only for push.

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
19. Reads under divergent policy use the intersection of all non-divergent
    policy heads (most restrictive wins); writes under divergent policy
    fail closed unless valid under all non-divergent policy heads.

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
  intersection of all non-divergent heads. See Project Policy.
- ~~How does sync surface the "you have N divergent heads across M entries"
  state to the user?~~ Resolved for V1: `divergent_heads` query and
  session-start count. See Cross-Device Revision Behavior, "Surfacing
  divergence."

Still open:

1. What is the exact revision envelope and canonical serialization?
2. How are monorepo and nested project boundaries resolved?
3. Which operations beyond independent creates, tag-add, and ref-add are
   safe for automatic convergence in the materialized view?
4. What caller-stable idempotency key scheme (if any) is required for
   exactly-once tool semantics, or is at-least-once permanently accepted?
5. What snapshot format and verification rules are required?
6. When may an offline or lost device be excluded from an epoch's participant
   set?
7. How are archived epochs discovered and retrieved for history queries?
8. What is the on-disk shape of the SQLite materialized view, and how is it
   rebuilt on demand from revision files?

## Explicit Non-Goals for This Proposal

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
