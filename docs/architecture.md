# Architecture

Source layout and module API reference.

---

## Source Layout

```
src/
├── types.ts              Profile behavior, config types, storage types (MountRef, MemoryEntry)
├── config.ts             stellario.yaml loader + validator
├── store.ts              JSONL read/write, volume index, ID generation (star suffix), native mounts
├── permissions.ts        Agent resolution + permission engine
├── embedding.ts          Semantic search (embed, index, cosine similarity)
├── auto-refs.ts          Automatic bidirectional linking engine
├── git.ts                Git commit + auto sync (push on commit, pull on session start)
├── context.ts            Go resolve bridge + runtime context resolution + mount injection
├── index-worker.ts       Background keyword index updates
├── index.ts              Public API (tool factory re-exports)
├── coord/
│   ├── types.ts          Task lifecycle, file lock types
│   ├── lock.ts           Advisory file lock + path lock map
│   └── store.ts          Task CRUD with state machine + plan tree
├── defs/
│   ├── memory-defs.ts     create / show / revise / forget / history / meta / ref / unref
│   ├── workspace-defs.ts  status (with mount display) / assemble / open / edit / add / remove
│   ├── telescope-defs.ts  unified search (fzf text + semantic) — mount volumes transparent
│   ├── coordination-defs.ts taskboard plan/claim/update/complete + lock/unlock
│   ├── constellation-defs.ts Go constellation integration
│   ├── lsp-defs.ts        LSP query tools
│   ├── ast-grep-defs.ts   AST pattern search
│   └── volume-link-defs.ts discover / link / unlink (native mount, no symlinks)
└── cli/
    └── bin.js             npm bin entry (init command)

glue/                       Pre-built opencode tool bindings (shipped with npm package)
├── memory.ts
├── telescope.ts
├── workspace.ts
├── volume-link.ts
├── coordination.ts
├── constellation.ts
├── lsp.ts
├── ast-grep.ts
└── plugin.ts              system.transform hook: buildStatus + gitPull on session start

engine/                     Go binary (cluster management + CLI)
├── cmd/
│   ├── stellario/main.go  CLI entry point
│   ├── resolve.go         resolve project dir → global library path + star name
│   ├── migrate.go         copy memory data into global library
│   ├── doctor.go          config + memory integrity diagnostics
│   ├── status.go          cluster overview
│   ├── sync_subtree.go    git subtree push/pull
│   ├── volume.go          volume list/stats/grep
│   ├── project.go         project registration management
│   ├── remote.go          subtree remote management
│   ├── create_native.go   Go-native entry creation (graph engine)
│   └── config_cmd.go      config show/validate/edit
└── cluster/
    ├── cluster.go         global library paths, device identity, project map
    ├── stars.go           star name assignment (constellation)
    └── json.go            JSON helpers
```

## Module API

```typescript
import { getMemoryToolDefs, getTelescopeToolDefs, getWorkspaceToolDefs, getVolumeLinkDefs } from "stellario"
```

| Module | Purpose |
|--------|---------|
| `stellario/config` | Load and query `stellario.yaml` |
| `stellario/store` | JSONL storage engine + native mounts |
| `stellario/permissions` | Config-driven permission checks |
| `stellario/embedding` | Semantic search / embedding engine |
| `stellario/git` | Git integration + auto sync (push/pull) |
| `stellario/context` | Go resolve bridge + mount injection |
| `stellario/types` | Type definitions (MountRef, AgentDef, etc.) |

Full API reference with types, function signatures, and examples: [api.md](api.md)
