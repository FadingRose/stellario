# Proposal: Declarative Volume GC and Auto-Archive

## Status
Draft — awaiting review.

## Motivation

Memory volumes accumulate stale entries with no retention mechanism. The
symptom that surfaced this: `taskboard` holds 499 entries, of which ~450 are
`done`/`cancelled` (dead) and ~30 are `claimed` but stale (untouched for
weeks). Only ~10 are live. The active coordination queue is drowned in
history, and every `taskboard_board` call sifts through corpses.

This is not unique to taskboard. `active`, `handover`, and scratch volumes
all grow indefinitely. Today the only retention tool is manual `forget`
(per-entry), which no agent does proactively.

The declaration-first refactor (see `7634029`) established that volumes
declare their own properties and the system respects them. Retention should
be no different: **a volume declares its own GC policy, the system executes
it.**

## Proposed Model

A volume may declare a `gc` block. When declared, the system archives
entries matching the policy at session start. Archive is always reversible
(entries move to the `archived` volume); nothing is ever silently deleted.

### Schema

```yaml
volumes:
  taskboard:
    profile: scratch
    gc:
      archiveWhen:
        status: [done, cancelled]   # entries carrying one of these statuses
      maxAge: "30d"                  # entries older than this
      maxEntries: 500                # keep only the most recent N
  active:
    profile: mutable
    gc:
      maxEntries: 200
  handover:
    profile: mutable
    gc:
      maxAge: "90d"
```

### Trigger semantics

- Conditions are **OR**, not AND — any matching condition archives the entry.
- `maxEntries` keeps the most recently updated N entries; older ones archive.
- `maxAge` compares against `updated` (falling back to `created`).
- `archiveWhen.status` matches entries whose coordination `status` field is
  in the list (applies to taskboard-style entries carrying status).

### Execution point

GC runs at **session start**, after context resolution, before the status
string is built. The injected status reports what GC did this session:

```
GC this session: archived 12 entries from taskboard (policy: status=done,cancelled)
```

This keeps GC **observable** — the agent sees it happened, and the user can
audit the `archived` volume. No silent background sweeping.

### Defaults

- No `gc` block → no GC. Explicit opt-in.
- `archived` volume itself is never GC'd (it is the destination).
- `frozen` profile volumes are never GC'd (read-only by definition).

## Open Design Questions

1. **Explicit trigger vs automatic.** Should GC also be invocable via
   `stellario gc --volume taskboard` for manual runs, or is session-start
   enough? Lean: provide the command, but session-start runs automatically
   when a policy is declared.

2. **Ref awareness.** Should GC refuse to archive an entry that is still
   referenced (has incoming `refs` from live entries)? This prevents
   orphaning a dependency. Lean: yes, respect downstream refs; log skipped
   entries in the GC report.

3. **scratch profile.** Scratch volumes are ephemeral (not git-tracked).
   Should GC on scratch `archive` (to the tracked `archived` volume,
   promoting ephemeral to permanent) or `expire` (delete, unrecoverable)?
   Lean: archive, for safety. Deletion is a separate explicit action.

4. **Per-status vs per-tag.** `archiveWhen.status` targets coordination
   status. Should there also be `archiveWhen.tags` (e.g. archive entries
   tagged `superseded`)? Likely yes for symmetry.

5. **Rate limiting.** If a volume has 400 stale entries, archiving all 400
   in one session start is a big write. Cap per-session archive count?
   Lean: no cap initially; observability over throttling.

## Impact

- New config field on `VolumeDef` (`gc`), parsed in TS + Go validators.
- A GC runner invoked from `buildStatus` (session-start path) and optionally
  a CLI command.
- The `archived` volume gains importance as the universal GC destination.
- No breaking change — `gc` is optional; volumes without it behave exactly
  as today.

## Relationship to Other Proposals

- **Declarative inject sections** — GC reporting lives in the status string,
  which is itself becoming declarative. The GC report should be a section an
  agent can opt into.
- **Token context management** — GC is the structural answer to bloat; token
  warnings are the informational answer. They compose: GC keeps volumes lean,
  warnings surface when injection is still heavy.
