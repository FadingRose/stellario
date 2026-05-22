# Core Concepts

Understanding Stellario's design philosophy and behavioral model.

---

## The Problem

When multiple AI agents collaborate on a project, they need shared memory. But not all memory is the same:

- Design decisions are **permanent and editable** — they evolve as the project grows
- Handoff logs are **permanent but immutable** — they're a historical record
- Drafts are **temporary** — they're working material that may be discarded
- Archives are **read-only** — they preserve history without allowing modification
- A task workspace needs to know **which context is currently active** — so the agent picks up where it left off

Hardcoding these distinctions per project leads to duplication and inconsistency. Stellario extracts a clean abstraction.

## Volumes

A **volume** is a named container for memory entries. Each volume has:

1. A **profile** that determines behavioral rules (mutability, durability, etc.)
2. **Boundaries** that control which agents can read/write
3. Optional **authority** label for semantic categorization
4. Optional **constraints** (required tag prefix, custom ID prefix)

Volumes map to JSONL files on disk. A tracked volume also generates a companion `.md` file for human readability and git diffing.

## Profiles

A **profile** is a bundle of behavioral flags derived from three underlying dimensions:

### Behavioral Dimensions

| Dimension | Question | Values |
|-----------|----------|--------|
| **Mutability** | Can entries be revised after creation? | Yes / No |
| **Durability** | Are entries version-controlled (git-tracked)? | Yes / No |
| **Reference** | Do entries use stable sequential IDs? | Yes (stable) / No (ephemeral) |

These three dimensions produce the four core profiles:

```
                      Mutability
                    ↙ Yes        ↘ No
              ┌──────────┐  ┌──────────┐
  Durability  │          │  │          │
   Yes        │ MUTABLE  │  │ APPEND   │
              │          │  │          │
              ├──────────┤  ├──────────┤
   No         │          │  │          │
              │ SCRATCH  │  │ (unused) │
              │          │  │          │
              └──────────┘  └──────────┘
              ──────────────────────────
              Reference:   stable     ephemeral
                           (all)      (scratch only)
```

The fifth profile, **workspace**, extends mutable with active tracking:

```
workspace = mutable + tracksActive
```

### Profile Details

#### `mutable` — The Knowledge Base

- **Create**: ✓
- **Revise**: ✓ (author only)
- **Forget**: ✓ (author only, archives to `archived`)
- **Git-tracked**: ✓
- **ID style**: sequential (`a01`, `a02`, ...)

The workhorse profile. Use for anything that evolves: design decisions, conventions, knowledge entries.

#### `append` — The Audit Trail

- **Create**: ✓
- **Revise**: ✗
- **Forget**: ✗
- **Git-tracked**: ✓
- **ID style**: sequential (`h01`, `h02`, ...)

Once written, entries are permanent. Use for handoff logs, session records, audit trails — anything where immutability is the point.

#### `scratch` — The Workbench

- **Create**: ✓
- **Revise**: ✓
- **Forget**: ✓
- **Git-tracked**: ✗
- **ID style**: ephemeral hash (`d7f3a`, `db2e1`, ...)

Temporary working material. Not version-controlled. IDs are random 4-character hashes — unique but not sequential. Use for drafts, experiments, notes that might be discarded.

Because scratch volumes are not git-tracked:
- No commit history
- No companion `.md` file
- Entries are lost if the JSONL file is deleted

#### `frozen` — The Archive

- **Create**: ✗
- **Revise**: ✗
- **Forget**: ✗
- **Git-tracked**: ✓
- **ID style**: sequential (inherited from source volume)

Read-only. Entries land here via the `forget` operation, which moves an entry from its source volume to the `archived` volume. The entry keeps its original ID.

You should always define an `archived` volume with the `frozen` profile.

#### `workspace` — The Active Context

- **Create**: ✓
- **Revise**: ✓ (author only)
- **Forget**: ✓ (author only)
- **Git-tracked**: ✓
- **ID style**: sequential
- **Active tracking**: ✓

Like `mutable`, but with one special behavior: the volume remembers which entry is currently "active". When an agent calls `show` on a workspace entry, that entry is automatically set as active.

The workspace volume is where an agent tracks its current task context — what it's working on, what's blocked, what's next. This survives across sessions.

**Only one workspace volume should exist per project.** If multiple are defined, the first one is used.

## Authority

Authority is a semantic label that describes the **epistemological nature** of the content in a volume:

| Authority | Source | Rebuildable? | Example |
|-----------|--------|-------------|---------|
| `source` | External input (user, system) | No | Conversations, raw data |
| `curated` | Human judgment | No | Design decisions, conventions |
| `synthesized` | Agent derivation | Yes | Generated summaries, extracted patterns |

**Authority is orthogonal to behavioral dimensions.** It does not drive any system behavior. Its purpose is to give agents semantic context:

- An agent reading `source` entries knows they're raw material
- An agent reading `curated` entries knows they represent human intent
- An agent reading `synthesized` entries knows they can be regenerated

This helps agents decide how to weight and cross-reference information.

## Permissions

### Boundaries

Each volume defines **boundaries** — which agents can read and write:

```yaml
boundaries:
  write: [stellario, chronicler]
  read: [all]
```

The `"all"` keyword grants access to every defined agent.

### Permission Checks

Stellario checks permissions in two layers:

1. **Profile check** (structural): Does the volume's profile allow the operation?
   - `frozen` → all writes rejected
   - `append` → revisions and forgets rejected
   - `scratch` → not git-tracked (affects commit behavior)

2. **Boundary check** (agent-level): Is the agent listed in the volume's boundaries?
   - `canWrite(agent, volume)` → agent ∈ write list
   - `canRead(agent, volume)` → agent ∈ read list

3. **Author check** (entry-level): For revise/forget, is the agent the entry's original author?

```
Operation   Profile Check    Boundary Check     Author Check
──────────────────────────────────────────────────────────────
create      canCreate?       canWrite?           —
read        —                canRead?            —
revise      canRevise?       —                   isAuthor?
forget      canForget?       —                   isAuthor?
```

### Why Author-Only for Revise/Forget?

Only the agent who created an entry can modify or archive it. This prevents accidental clobbering across agents. The primary agent can always read everything (via `read: [all]`) but cannot silently edit another agent's entries.

## Entries

An entry is the fundamental unit of memory. Each entry is a JSONL record:

```json
{
  "id": "a42",
  "volume": "active",
  "content": "## Architecture\nWe chose a modular design...",
  "tags": ["type:design", "module:core"],
  "keywords": ["architecture", "modular"],
  "author": "stellario",
  "created": "2026-05-23",
  "updated": "2026-05-23",
  "refs": []
}
```

### Content

Free-form text. Stellario extracts the title from the first `## ` heading (or first line as fallback). Content is displayed with line numbers for revise operations.

### Tags

Structured categorization using `namespace:value` format:

- `type:design`, `type:convention`, `type:handoff`
- `work:origins`, `work:lore`
- `role:stellario`, `role:penna`
- `chapter:06`, `file:src/store.ts`

Tags enable precise filtering in telescope search.

### Keywords

2-5 free-form terms for semantic discovery. Unlike tags, keywords are unstructured and don't require a namespace.

### Refs (Constellations)

Directed links between entries:

```json
{
  "refs": [
    { "target": "m01", "reason": "supersedes initial design" },
    { "target": "l03", "reason": "context for this decision" }
  ]
}
```

Refs form a knowledge graph. Each ref has a `target` (entry ID) and a `reason` (why the link exists). This enables traceability: "Why did we make this decision?" → follow refs back to context.

### IDs (Star Names)

Entry IDs encode their volume origin:

- **Sequential** (`a01`, `h03`, `l12`): stable, predictable, sortable. Used by tracked profiles.
- **Ephemeral** (`d7f3a`, `db2e1`): unique but not sequential. Used by scratch profile.

The prefix character(s) come from the volume config (default: first character of volume name). This enables fast volume lookup from an ID — `h03` is probably in `handover`.

## Storage

### JSONL Format

Each volume stores entries as JSONL (one JSON object per line):

```
{"id":"a01","volume":"active","content":"## First Entry\n...","tags":[],"keywords":[],"author":"stellario","created":"2026-05-23","updated":"2026-05-23"}
{"id":"a02","volume":"active","content":"## Second Entry\n...","tags":[],"keywords":[],"author":"stellario","created":"2026-05-23","updated":"2026-05-23"}
```

JSONL is chosen over JSON arrays for:
- **Append-friendliness**: new entries add a line, no need to parse/rewrite the whole file
- **Git diffability**: each entry is one line, diffs are meaningful
- **Streaming**: entries can be processed one at a time

### Volume Index

`volumes.jsonl` tracks metadata for each volume:

```jsonl
{"volume":"meta","files":["meta.jsonl"],"next_nonce":3}
{"volume":"active","files":["active.jsonl"],"next_nonce":43}
{"volume":"layer","files":["layer.jsonl"],"next_nonce":12,"active_workspace":"l05"}
```

Fields:
- `files`: ordered list of JSONL data files (supports sharding)
- `next_nonce`: next available sequential ID number
- `active_workspace`: (workspace volume only) the currently active entry ID

### Markdown Companion

Tracked volumes also generate a `.md` file:

```markdown
# active

## a01

## First Entry
...

tags: `type:design · module:core`
keywords: architecture, modular
author: stellario

---
```

This enables:
- **Human readability**: browse memory in a text editor
- **Git diff review**: see changes in standard diff tools
- **Search**: grep/find across memory files

## Naming Metaphor

Stellario uses an astronomical metaphor:

| Stellario Term | Domain Term | Explanation |
|----------------|-------------|-------------|
| Star | Entry | A point of knowledge in the sky |
| Constellation | Refs | Named patterns connecting stars |
| Star Chart | Volume | A map organizing stars by type |
| Telescope | Search | The instrument for observing stars |
| Directed Observation | Active Workspace | The star currently focused on |
| Stellar Cartography | The whole system | Mapping and navigating the knowledge sky |

The name "Stellario" evokes stellar cartography — the systematic mapping and navigation of a knowledge space.
