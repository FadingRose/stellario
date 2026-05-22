# Stellario

Volume-based agent memory management for AI-assisted projects.

Stellario gives AI agents structured, permissioned, version-controlled memory — configurable for any project type via a single YAML file.

## Why

When multiple AI agents collaborate on a project (writing a novel, building software, maintaining a knowledge base), they need shared memory with different access patterns:

- A **primary agent** needs to create and edit design decisions
- A **specialist agent** should only write to its domain
- A **scratchpad** for drafts that don't need version control
- A **frozen archive** for historical records
- A **workspace** that tracks which context is currently active

Hardcoding these rules per project doesn't scale. Stellario extracts the pattern into a reusable library.

## How It Works

```
stellario.yaml          ← you define volumes, agents, permissions
        │
        ▼
┌─────────────────┐
│   Stellario      │   provides:
│   core library   │   • config loader + validator
│                  │   • JSONL storage engine
│                  │   • permission engine
│                  │   • tool factories (for opencode)
└─────────────────┘
        │
        ▼
  .stellario/           ← runtime data (JSONL + git)
    volumes.jsonl
    active.jsonl
    drafting.jsonl
    ...
```

## Quick Start

### 1. Install

```bash
# In your project
npm install /path/to/stellario
```

Or via `file:` protocol in `package.json`:

```json
{
  "dependencies": {
    "stellario": "file:../stellario"
  }
}
```

### 2. Configure

Create `stellario.yaml` in your project root:

```yaml
memoryDir: ".stellario"

volumes:
  active:
    profile: mutable
    boundaries:
      write: [stellario]
      read: [all]
  drafting:
    profile: scratch
    boundaries:
      write: [stellario]
      read: [stellario]
  archived:
    profile: frozen
    boundaries:
      read: [all]

agents:
  stellario:
    display: "Stellario"
```

See `templates/` for ready-made configs:
- `minimal.yaml` — single agent, 4 volumes
- `novel.yaml` — multi-agent fiction writing (Lilac-compatible)
- `software.yaml` — multi-agent software development

### 3. Use (Core API)

```typescript
import { loadConfig } from "stellario/config"
import { canWrite, writableVolumes } from "stellario/permissions"
import { generateNextId, writeEntries, readJsonl, findEntry } from "stellario/store"
```

### 4. Use (opencode Tools)

```typescript
import { createMemoryTools, createWorkspaceTools, createTelescopeTool } from "stellario"

const { create, show, revise, forget, history } = createMemoryTools()
const { status } = createWorkspaceTools()
const { search } = createTelescopeTool()
```

## Core Concepts

### Volumes

A **volume** is a named memory store with a behavioral profile. Each volume maps to one or more JSONL files on disk.

### Profiles

Five profiles drive how entries behave:

| Profile | Create | Revise | Forget | Git-tracked | ID Style | Active Tracking |
|---------|--------|--------|--------|-------------|----------|-----------------|
| `mutable` | ✓ | ✓ | ✓ | ✓ | sequential | — |
| `append` | ✓ | — | — | ✓ | sequential | — |
| `scratch` | ✓ | ✓ | ✓ | — | ephemeral hash | — |
| `frozen` | — | — | — | ✓ | sequential | — |
| `workspace` | ✓ | ✓ | ✓ | ✓ | sequential | ✓ |

Profiles are derived from three behavioral dimensions:

- **Mutability**: can entries be revised?
- **Durability**: are entries version-controlled?
- **Reference**: do entries use stable IDs?

`workspace` adds a fourth dimension — active tracking. Only one workspace volume exists per project, and it remembers which entry is currently "active" (shown on `memory_show`).

### Authority

An optional semantic label for each volume:

| Authority | Meaning |
|-----------|---------|
| `source` | Raw material from external input |
| `curated` | Human-judged, high-value knowledge |
| `synthesized` | Agent-derived, rebuildable from source |

Authority does **not** drive system behavior. It's a semantic annotation for agents to reason about content provenance.

### Permissions

Each volume defines a `boundaries` object:

```yaml
boundaries:
  write: [stellario, chronicler]
  read: [all]
```

- `write`: agents that can create/revise/forget entries
- `read`: agents that can view entries (use `"all"` for public volumes)
- Profile restrictions apply on top: `frozen` rejects all writes regardless of boundaries

### Entry

A memory entry is a JSONL record:

```json
{
  "id": "a42",
  "volume": "active",
  "content": "## Design Decision\nWe chose SQLite for local-first storage.",
  "tags": ["type:design", "module:storage"],
  "keywords": ["sqlite", "local-first"],
  "author": "stellario",
  "created": "2026-05-23",
  "updated": "2026-05-23",
  "refs": [{ "target": "m01", "reason": "supersedes previous design" }]
}
```

### IDs

Entry IDs encode volume origin:

- **Sequential** (mutable, append, frozen, workspace): prefix + zero-padded nonce — e.g., `a01`, `h03`, `l12`
- **Ephemeral** (scratch): prefix + short hash — e.g., `d7f3a`

Prefix defaults to the first character of the volume name, overridable via `idPrefix` in config.

## Configuration Reference

### `stellario.yaml`

```yaml
# Required: memory data directory (relative to project root)
memoryDir: ".stellario"

# Required: volume definitions
volumes:
  <name>:
    profile: mutable | append | scratch | frozen | workspace
    boundaries:
      write: [<agent>, ...] | [all]
      read: [<agent>, ...] | [all]
    authority?: source | curated | synthesized
    idPrefix?: string          # custom ID prefix (default: first char of name)
    requiredTagPrefix?: string # enforce tag prefix on all entries

# Required: agent definitions
agents:
  <name>:
    display: string  # human-readable name

# Optional: tag vocabulary
tags:
  namespaces?: [string, ...]  # allowed tag namespaces
  typeValues?: [string, ...]  # closed vocabulary for type:* tags
```

Full docs: [docs/configuration.md](docs/configuration.md)

## Module API

| Module | Exports | Purpose |
|--------|---------|---------|
| `stellario/config` | `loadConfig`, `validateConfig`, `getVolumeIdPrefix`, `getMemoryDir`, `getTrackedVolumes`, `getWorkspaceVolume` | Load and query `stellario.yaml` |
| `stellario/store` | `readJsonl`, `writeEntries`, `generateNextId`, `findEntry`, `getActiveWorkspace`, `setActiveWorkspace`, `readVolumeIndex`, `extractTitle`, `truncate`, `today`, `dedupeTags` | JSONL storage engine |
| `stellario/permissions` | `resolveAgent`, `canRead`, `canWrite`, `canRevise`, `canForget`, `isAuthor`, `readableVolumes`, `writableVolumes`, `canCrossStory` | Config-driven permission checks |
| `stellario/git` | `gitCommit`, `isGitRepo`, `initGitRepo` | Git integration |
| `stellario/context` | `resolveContext`, `isRustProject`, `hasOpencodeConfig`, `getRustCrates` | Runtime context resolution |
| `stellario/types` | `Profile`, `ProfileBehavior`, `VolumeDef`, `StellarioConfig`, `MemoryEntry`, `ToolContext`, etc. | Type definitions |
| `stellario` (index) | `createMemoryTools`, `createWorkspaceTools`, `createTelescopeTool` | opencode tool factories |

Full docs: [docs/api.md](docs/api.md)

## Architecture

```
src/
├── types.ts          Profile behavior, config types, storage types
├── config.ts         stellario.yaml loader + validator
├── store.ts          JSONL read/write, volume index, ID generation
├── permissions.ts    Agent resolution + permission engine
├── git.ts            Git commit integration
├── context.ts        Project detection + context resolution
├── index.ts          Public API (tool factory re-exports)
└── tools/
    ├── memory.ts     create / show / revise / forget / history
    ├── workspace.ts  status overview
    └── telescope.ts  unified search (text + tags + keywords)
```

### Data Flow

```
Tool call → resolveContext() → loadConfig()
                              → getMemoryDir()
                              → resolveAgent()
         → permission check
         → store operation (readJsonl / writeEntries / generateNextId)
         → git commit (if tracked volume)
         → return formatted result
```

### Naming Metaphor

| Stellario Term | Domain Term | Explanation |
|----------------|-------------|-------------|
| Star | Entry | A point of knowledge in the constellation |
| Constellation | Refs | Named connections between stars |
| Star Chart | Volume | A map organizing stars by pattern |
| Telescope | Search | The instrument for observing stars |
| Directed Observation | Active Workspace | The star currently focused on |

## Origin

Stellario was extracted from [Lilac in the Rain](https://github.com/user/lilac-in-the-rain), a multi-agent fiction writing system built with opencode. The memory infrastructure (7 volumes, 5 agents, JSONL + git) proved generic enough to become its own package.

## License

MIT
