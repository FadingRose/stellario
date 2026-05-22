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
