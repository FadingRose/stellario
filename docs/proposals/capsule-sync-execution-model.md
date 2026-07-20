# Proposal: Isolated Memory Capsules and Git Dump Pipeline

Status: Draft for review

This document records the current design proposal for project identity, memory
isolation, local execution, cross-device revisions, and Git-based transport. It
is intentionally separate from the current implementation. No migration or
compatibility commitment should be inferred from this proposal.

## Review Goal

Reviewers should determine whether the proposed execution model is internally
consistent before implementation work resumes. In particular, review:

- project and repository isolation boundaries;
- local write acknowledgement and crash recovery;
- the separation of Git transport from semantic merge;
- cross-device revision and configuration behavior;
- remote discovery and provisioning;
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

The proposed file is a stable identity pointer:

```json
{
  "schema": "stellario.project/v1",
  "id": "prj_019c6c35-84d2-7a31-b61a-62e84957dc21"
}
```

The file contains no remote URL, provider, credentials, local path, device ID,
display name, volume configuration, or permissions.

Proposed identity resolution order:

1. nearest applicable `.stellario-project` file;
2. local path binding for that project ID;
3. code repository remote as a bootstrap hint only;
4. explicit initialization for an unbound project.

Copying the same identity file means sharing the same logical memory capsule.
A code fork does not implicitly fork memory. A detach operation creates a new
project ID when independent memory is required.

Projects that cannot add the identity file may use a local-only binding. Such a
binding is not automatically discoverable on another device and requires an
explicit capsule locator or import operation.

## Remote Resolution

Users should not manually maintain a remote URL for every project. A local sync
provider resolves a project ID to an isolated remote:

```yaml
sync:
  provider: gitlab
  remote_template: git@gitlab.example.com:stellario-memory/{project_id}.git
```

The provider is responsible for provisioning or locating the repository. Git
alone cannot provision a remote, so providers may require a hosting API or an
explicit one-time repository creation step.

Project remotes are memory remotes. They are not the code repository's origin.
The code origin may help identify a project during bootstrap but is not a
durable memory identity or transport endpoint.

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
entry_id: active:42
parents: [rev_...]
observed_frontier:
  dev_a: 101
  dev_b: 34
policy_revision: cfg_...
payload: {}
created_at: 2026-07-20T12:00:00Z
```

Revision IDs must be stable independently of file paths and Git commit hashes.
Duplicate revision delivery must be idempotent.

## Local Write Execution

A memory tool acknowledges success after local durability, not after network
replication:

```text
acquire capsule write lock
-> validate against one materialized generation
-> append immutable revision
-> fsync revision
-> publish the next materialized generation
-> record transport pending
-> release lock
-> return success
```

The network may be unavailable without preventing local work. The returned
result should distinguish local durability from remote replication when that
distinction matters to the caller.

Multiple sessions on the same device share the capsule write lock. Device-owned
paths prevent cross-device file conflicts but do not serialize two local
processes.

## Sync Execution

One sync worker operates on one capsule at a time:

```text
acquire capsule sync lock
-> recover any locally durable but uncommitted revisions
-> commit a batch of device-owned revisions
-> fetch the capsule remote
-> rebase local commits onto the remote branch
-> validate fetched revision envelopes
-> build a new materialized generation
-> push with non-fast-forward retry
-> publish transport frontier and sync status
-> release lock
```

Writes need not push immediately. A worker may debounce several writes into one
commit and sync only capsules with pending work. Session startup syncs the
active capsule before generating injected memory context. Other capsules sync
on demand when mounted or searched.

Sync failures must be persisted and observable. They must not be represented
only by a dirty Git working tree or swallowed exception.

## Independent State Machines

Transport and semantic state are orthogonal.

Example transport states:

```text
local-pending -> committed -> pushed
```

Example semantic states:

```text
candidate -> clean
candidate -> divergent -> merged
candidate -> rejected
```

"Dirty" should not be used for both dimensions. A revision may be pushed but
semantically divergent, or locally clean but not yet pushed.

## Cross-Device Revision Behavior

A cross-device write begins as a candidate based on an observed revision and
frontier. After sync:

- if its base remains the unique semantic head and policy allows causal
  fast-forward, it becomes the clean head;
- if another child exists, it becomes one of multiple divergent heads;
- if policy requires explicit review, it remains a proposal even without a
  competing child.

No last-writer-wins rule is proposed.

Suggested volume merge modes:

- `append-union`: independent creates are accepted;
- `causal-fast-forward`: a current base may advance automatically;
- `proposal-only`: every revision requires explicit acceptance;
- `frozen`: no revision proposals are accepted.

Automatic semantic merge should initially be limited to clearly commutative
operations such as independent creates, tag additions, and reference additions.
Content revisions and revise-versus-tombstone conflicts require an explicit
merge revision.

Merge authority belongs to an actor or project policy, not a physical device.
Device identity records provenance. If this distinction is security-relevant,
the protocol must define device enrollment, revocation, and revision signing.

## Project Policy and Device Configuration

Configuration is split into two categories.

Project policy is versioned inside the capsule:

- volume definitions and profiles;
- boundaries and authority;
- required tags;
- merge policy;
- actor permissions.

Device-local configuration is not replicated as project policy:

- local paths and project bindings;
- star aliases;
- embedding runtime selection;
- LSP commands and timeouts;
- credentials and provider configuration.

Every data revision records the project policy revision it observed. A revision
created under an older policy is preserved after sync but may require review
under the current policy.

If project policy has multiple unresolved heads, reads use the most recent
common clean policy where possible. Writes should fail closed when the
ambiguous policy affects permission or mutability decisions. Boundary changes
must not be field-merged automatically.

## Materialized Views

Tools read a stable materialized generation. Fetching revisions must not expose
a partially updated view:

```text
fetch and validate revisions
-> build generation N+1
-> atomically publish generation N+1
```

A tool already using generation N may finish against that generation. A later
tool sees generation N+1. The view is a cache and can be rebuilt from a snapshot
plus later revisions.

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

Consider devices Sirius and Vega in one project capsule.

1. Sirius creates revision `Sirius:101` and acknowledges after local fsync.
2. Sirius produces `Sirius:102` based on `Sirius:101`.
3. Offline Vega produces `Vega:34`, also based on `Sirius:101`.
4. Sirius pushes first. Vega fetches, rebases its disjoint replica file, and
   pushes without a Git file conflict.
5. The semantic graph has two heads, `Sirius:102` and `Vega:34`, and is marked
   divergent.
6. An authorized actor produces a merge revision whose parents are both heads.
7. The next materialized generation has one clean head.

If Sirius changes the volume policy before Vega syncs, Vega's revision remains
durable and replicated but is evaluated as a proposal against the recorded and
current policy revisions. It is never silently discarded or selected by wall
clock order.

If a worker crashes after Git commit but before push, startup detects that the
capsule repository is locally ahead and retries transport without generating a
duplicate revision.

## Execution Invariants

1. A capsule is the unit of permission, repository, remote, locking, and sync.
2. Local append and fsync define memory write acknowledgement.
3. Network push is not a precondition for local write success.
4. A device writes only immutable revisions in its own replica path.
5. Git conflicts and semantic divergence are different states.
6. Materialized views are rebuildable and atomically published by generation.
7. Transport frontiers and semantic heads are tracked separately.
8. A data revision records the project policy revision it observed.
9. Recovery and delivery are idempotent by revision ID.
10. Remote revisions are validated before becoming visible to tools.
11. One project repository never contains another project's memory history.
12. Global indexes are caches, not a route around capsule permissions.

## Current Implementation Gaps

The existing implementation must not be treated as a partial realization of
this protocol. Important differences include:

- `~/.stellario` is currently one parent Git repository;
- projects are subtrees rather than independent repositories;
- tracked volume JSONL files are mutable snapshots;
- writes commit and synchronously attempt a push;
- sync errors are normally silent;
- session context is built before the session-start pull;
- `.stellario-project` identifies a project by name and is only a fallback;
- device-relative migration strips identifiers before the revision protocol is
  defined;
- cross-device aliases and native mounts use filesystem paths rather than
  capsule/revision identities.

No automatic migration to this proposal is defined.

## Open Questions

1. What is the exact revision envelope and canonical serialization?
2. Are revisions signed, and how are devices enrolled and revoked?
3. How are project memory remotes provisioned by each provider?
4. Is `.stellario-project` committed by default or opt-in?
5. How are monorepo and nested project boundaries resolved?
6. Which actor identities may accept, reject, or merge proposals?
7. Which operations are safe for automatic semantic merge?
8. What reads remain available during project policy divergence?
9. What lock implementation coordinates local processes and recovers stale
   owners?
10. What snapshot format and verification rules are required?
11. When may an offline or lost device be excluded from an epoch frontier?
12. How are archived epochs discovered and retrieved for history queries?

## Explicit Non-Goals for This Proposal

- selecting a storage database for the materialized view;
- preserving the current JSONL ABI unchanged;
- defining a user interface for merge review;
- implementing automatic text merges;
- defining remote encryption or hosting-provider credentials;
- defining a migration schedule.

## Requested Review Output

Reviewers should return:

1. violations of the execution invariants;
2. scenarios that cause data loss, privilege expansion, or unrecoverable state;
3. unnecessary complexity that can be removed without weakening isolation;
4. missing state transitions or recovery boundaries;
5. a recommendation to accept, revise, or reject the model before protocol work.
