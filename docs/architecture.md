# Architecture

Source layout and module API reference.

---

## Source Layout

```
src/
├── types.ts              Profile behavior, config types, storage types
├── config.ts             stellario.yaml loader + validator
├── store.ts              JSONL read/write, volume index, ID generation, linked volumes
├── permissions.ts        Agent resolution + permission engine
├── embedding.ts          Semantic search (embed, index, cosine similarity)
├── auto-refs.ts          Automatic bidirectional linking engine
├── git.ts                Git commit integration
├── context.ts            Project context detection + resolution
├── index.ts              Public API (tool factory re-exports)
├── coord/
│   ├── types.ts          Task lifecycle, file lock types
│   ├── lock.ts           Advisory file lock + path lock map
│   └── store.ts          Task CRUD with state machine
└── defs/
    ├── memory-defs.ts     create / show / revise / forget / history / meta / ref / unref
    ├── workspace-defs.ts  status / assemble / open / edit / add / remove
    ├── telescope-defs.ts  unified search (fzf text + semantic)
    ├── coordination-defs.ts taskboard plan/claim/update/complete + lock/unlock
    └── volume-link-defs.ts discover / link / unlink (cross-project)

glue/                       Pre-built opencode tool bindings (shipped with npm package)
├── memory.ts
├── telescope.ts
├── workspace.ts
├── volume-link.ts
└── plugin.ts
```

## Module API

```typescript
import { getMemoryToolDefs, getTelescopeToolDefs, getWorkspaceToolDefs, getVolumeLinkDefs } from "stellario"
```

| Module | Purpose |
|--------|---------|
| `stellario/config` | Load and query `stellario.yaml` |
| `stellario/store` | JSONL storage engine |
| `stellario/permissions` | Config-driven permission checks |
| `stellario/embedding` | Semantic search / embedding engine |
| `stellario/git` | Git integration |
| `stellario/context` | Runtime context resolution |
| `stellario/types` | Type definitions |

Full API reference with types, function signatures, and examples: [api.md](api.md)
