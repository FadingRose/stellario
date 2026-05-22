# meta

## m01

## Architecture Overview

Stellario is a volume-based agent memory management library for AI-assisted projects, built with TypeScript and designed for opencode integration.

### Module Structure

```
src/
├── types.ts          Core types: Profile, ProfileBehavior, VolumeDef, StellarioConfig, MemoryEntry, VolumeIndexEntry, ToolContext, ToolDef
├── config.ts         stellario.yaml loader + validator (searches .opencode/ then root)
├── store.ts          JSONL storage: readJsonl, writeEntries, generateNextId, findEntry, volume index, MD regeneration
├── permissions.ts    Agent resolution + permission engine: canRead, canWrite, canRevise, canForget, isAuthor
├── git.ts            Git commit integration for tracked volumes
├── context.ts        Runtime context resolution + project detection helpers
├── index.ts          Public API re-exports (tool definition factories)
├── defs/
│   ├── memory-defs.ts      create / show / revise / forget / history tool definitions
│   ├── workspace-defs.ts   status tool (bootstrap overview)
│   └── telescope-defs.ts   unified search (text + tags + keywords)
└── cli/
    └── bin.js         CLI entry point — stellario init scaffolding
```

### Data Flow

```
Tool call → resolveContext(ctx) → loadConfig()
                                → getMemoryDir()
                                → resolveAgent()
         → permission check (canRead/canWrite/canRevise/canForget)
         → store operation (readJsonl / writeEntries / generateNextId)
         → git commit (if tracked volume)
         → return formatted result
```

### Storage Model

- JSONL: Each volume stored as {volume}.jsonl in the memory directory
- Volume Index: volumes.jsonl tracks per-volume file lists, next nonce, active workspace
- Markdown mirror: .md files regenerated from JSONL for tracked volumes (human-readable)
- Git: Version control for tracked volumes (mutable, append, frozen, workspace)

### Integration Pattern

Stellario exports pure ToolDef objects (description + args + execute). Host projects write thin glue files that call tool() from @opencode-ai/plugin:

```typescript
import { tool } from "@opencode-ai/plugin"
import { getMemoryToolDefs } from "stellario/defs/memory"
const defs = getMemoryToolDefs()
export const create = tool(defs.create)
```

tags: ``
author: stellario

---

## m02

## Core Concepts — Profiles, Boundaries, Authority

### Five Profiles

Each volume has a behavioral profile that determines entry lifecycle:

| Profile | Create | Revise | Forget | Git-tracked | ID Style | Active Tracking |
|---------|--------|--------|--------|-------------|----------|-----------------|
| mutable | yes | yes | yes | yes | sequential | no |
| append | yes | no | no | yes | sequential | no |
| scratch | yes | yes | yes | no | ephemeral hash | no |
| frozen | no | no | no | yes | sequential | no |
| workspace | yes | yes | yes | yes | sequential | yes |

Profiles are derived from three behavioral dimensions:
- Mutability: can entries be revised?
- Durability: are entries version-controlled?
- Reference: do entries use stable IDs?

Workspace adds a fourth dimension: active tracking. Only one workspace volume per project, it remembers which entry is currently "active" (shown on memory_show).

### Boundaries (Permissions)

Each volume defines read/write access per agent:

```yaml
boundaries:
  write: [stellario, chronicler]
  read: [all]
```

- write: agents that can create/revise/forget entries
- read: agents that can view entries (use "all" for public)
- Profile restrictions apply on top: frozen rejects all writes regardless of boundaries
- Only the entry author can revise or forget (isAuthor check)

### Authority (Semantic Label)

Optional epistemological layer annotation:
- source: Raw material from external input
- curated: Human-judged, high-value knowledge
- synthesized: Agent-derived, rebuildable from source

Authority does NOT drive system behavior. It is a semantic hint for agents.

### Entry IDs

- Sequential (mutable, append, frozen, workspace): prefix + zero-padded nonce — e.g., a01, h03, l12
- Ephemeral (scratch): prefix + short hash — e.g., d7f3a
- Prefix defaults to first char of volume name, overridable via idPrefix in config
- Nonce tracking via volumes.jsonl index (legacy fallback: scan max ID)

tags: ``
author: stellario

---

## m03

## Configuration Reference — stellario.yaml

### Schema

```yaml
memoryDir: ".stellario"          # Required: memory data directory (relative to project root)

volumes:                          # Required: volume definitions
  <name>:
    profile: mutable | append | scratch | frozen | workspace
    boundaries:
      write: [<agent>, ...] | [all]
      read: [<agent>, ...] | [all]
    authority?: source | curated | synthesized
    idPrefix?: string             # custom ID prefix (default: first char of name)
    requiredTagPrefix?: string    # enforce tag prefix on all entries

agents:                           # Required: agent definitions
  <name>:
    display: string               # human-readable name
    role?: primary | subagent     # default: subagent

tags:                             # Optional: tag vocabulary
  namespaces?: [string, ...]     # allowed tag namespaces
  typeValues?: [string, ...]     # closed vocabulary for type:* tags
```

### Config Discovery

loadConfig() searches in order:
1. .opencode/stellario.yaml (preferred)
2. stellario.yaml (project root)

### Provided Templates

- minimal.yaml — Single agent, 4 volumes (active, handover, drafting, workspace)
- novel.yaml — Multi-agent fiction writing: 8 volumes, 5 agents (stellario, chronicler, worldbuilder, penna, vilicus)
- software.yaml — Multi-agent software dev: 6 volumes, 3 agents (stellario, analyst, executor)

### This Project's Config

Stellario uses its own software template at .opencode/stellario.yaml:
- 6 volumes: meta, active, handover, layer, drafting, archived
- 3 agents: stellario (primary), analyst (subagent), executor (subagent)
- Tag namespaces: module, feature, crate, file, type
- Type values: handoff, design, adr, convention, layer, polish, bug, investigation

tags: ``
author: stellario

---

## m04

## Design Decisions — Key Architectural Choices

### 1. JSONL over Database

Decision: Use JSONL (JSON Lines) files for storage instead of SQLite or a database.
Rationale: Zero dependencies for storage, human-readable, easy git versioning, works with any filesystem. Trade-off: no indexing or complex queries — compensated by Telescope search with scoring.

### 2. Pure Definitions (ToolDef) with Glue Files

Decision: Export pure description + args + execute objects, not opencode-coupled tools.
Rationale: Stellario has zero runtime dependency on opencode. Host projects write 2-line glue files that bridge to @opencode-ai/plugin. This means Stellario can be used outside opencode.

### 3. Profile-Based Behavior

Decision: Five named profiles instead of individual boolean flags.
Rationale: Named profiles are self-documenting and prevent invalid combinations (e.g., append that allows revisions). The ProfileBehavior interface derives the actual flags.

### 4. Volume Index (volumes.jsonl)

Decision: Central index file tracking per-volume metadata (file lists, next nonce, active workspace).
Rationale: Enables multi-file volumes, efficient ID generation (nonce-based instead of scanning), and workspace tracking without scanning all entries.

### 5. Config in .opencode/ Directory

Decision: Prefer .opencode/stellario.yaml over root-level config.
Rationale: Keeps agent infrastructure separate from project code. CLI init command follows this convention.

### 6. Markdown Mirror for Tracked Volumes

Decision: Auto-generate .md files alongside .jsonl for tracked volumes.
Rationale: Provides human-readable view of memory contents. Useful for debugging and manual inspection.

### 7. Git Inside Memory Directory

Decision: Separate git repo inside the memory directory, not the project repo.
Rationale: Memory has its own versioning lifecycle. Avoids polluting project git history with memory changes.

### 8. CLI as Pure JS (No Build Step)

Decision: bin.js is plain JavaScript, not compiled TypeScript.
Rationale: The CLI is a scaffolding tool used rarely. Pure JS means zero build step and direct execution via node.

tags: ``
author: stellario

---

## m05

## Role Definition

You are Stellario, the primary agent for this project. You manage the Stellario memory library itself — a volume-based agent memory infrastructure for opencode.

### Identity

- You ARE the Stellario project. This is self-dogfooding — you use your own memory system to work on yourself.
- Your operational knowledge lives in memory (meta + active volumes), not in a static prompt file.
- You can revise this prompt entry to change your own behavior. Changes take effect on the next session.

### Core Workflow

1. Read workspace_status (auto-injected) to understand current state
2. Check latest handover for session continuity
3. Do the work the user asks
4. Before ending a session: update handover, revise layer if focus changed

### Volume Usage

- **meta**: Immutable project knowledge (architecture, concepts, config, design decisions). Only revise when the project changes.
- **active**: Current project state, API references, known issues. Update as things change.
- **layer**: Your current focus/work area. Only one active entry at a time.
- **handover**: Session continuity notes. Append-only — write a new one each session.
- **drafting**: Scratch pad for temporary work, brainstorming, drafts. Not git-tracked.
- **archived**: Frozen. Entries moved here when forgotten.

### Subagents

- **analyst**: Read-only access to most volumes. Use for investigation, code review, research tasks.
- **executor**: Can write to drafting. Use for code generation, file operations.

tags: `type:prompt`
keywords: `role · identity · workflow · prompt`
author: stellario

---
