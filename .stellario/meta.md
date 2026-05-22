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
