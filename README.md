# Stellario

Agent memory infrastructure for opencode — structured, permissioned, version-controlled, cross-project.

Agents get memory that survives across sessions. Volumes define how memory behaves (mutable, append-only, scratch, frozen, workspace). Permissions control which agent sees what. Semantic search finds concepts, not just keywords. And agents can link volumes from other projects to observe memories they don't own.

## Quick Start

```bash
npx stellario init --template software
```

This scaffolds everything inside `.opencode/` — config, tools, agents, plugin, memory directory with its own git repo.

Templates: `minimal` · `novel` · `software` · `audit`

### Existing project

```bash
npm --prefix .opencode install stellario
npx stellario init --template audit
```

Init is idempotent — it skips files that already exist.

## How It Works

```
stellario.yaml          ← you define volumes, agents, permissions
        │
        ▼
┌─────────────────┐
│   Stellario      │   config loader + validator
│   core library   │   JSONL storage engine
│                  │   permission engine
│                  │   semantic search (embedding)
│                  │   tool factories (for opencode)
│                  │   volume link/unlink (cross-project)
└─────────────────┘
        │
        ▼
  .opencode/.stellario/   ← runtime data (JSONL + git)
```

## Tools

| Tool | Layer | What it does |
|------|-------|--------------|
| `create` | memory | Write entry to a volume |
| `show` | memory | Read entry by ID |
| `revise` | memory | Edit content via line ranges |
| `forget` | memory | Archive an entry |
| `history` | memory | View git revision history |
| `meta` | memory | Record cross-session behavioral calibration |
| `ref` | memory | Create manual reference between entries |
| `unref` | memory | Remove a reference between entries |
| `search` | telescope | Unified search (text + tags + semantic) |
| `status` | workspace | Dashboard: volume stats, active context, taskboard |
| `assemble` | workspace | Create a workspace theme gathering related entries |
| `open` | workspace | Expand active workspace with all gathered entries |
| `discover` | volume-link | Find stellario projects and their volumes |
| `link` | volume-link | Bind an external project's volume (readonly symlink) |
| `unlink` | volume-link | Unbind a linked volume |

## Profiles

Five profiles drive how entries behave:

| Profile | Create | Revise | Forget | Git | ID Style |
|---------|--------|--------|--------|-----|----------|
| `mutable` | ✓ | ✓ | ✓ | ✓ | sequential |
| `append` | ✓ | — | — | ✓ | sequential |
| `scratch` | ✓ | ✓ | ✓ | — | ephemeral |
| `frozen` | — | — | — | ✓ | sequential |
| `workspace` | ✓ | ✓ | ✓ | ✓ | sequential + active tracking |

## Volume Link

An agent can link volumes from other stellario projects into its working context. The external volume is accessed readonly via symlink — the agent observes without modifying.

```bash
# Discover what's available
discover(path="/path/to/other/project")

# Link an external volume
link(project="/path/to/other/project", volume="active", alias="other_active")

# Search includes linked volumes automatically
search(query="authentication")
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

## Architecture

```
src/
├── types.ts              Profile behavior, config types, storage types
├── config.ts             stellario.yaml loader + validator
├── store.ts              JSONL read/write, volume index, ID generation, linked volumes
├── permissions.ts        Agent resolution + permission engine
├── embedding.ts          Semantic search (embed, index, cosine similarity)
├── auto-refs.ts          Automatic bidirectional linking engine
├── git.ts                Git commit integration
├── context.ts            Project detection + context resolution
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
src/
├── types.ts              Profile behavior, config types, storage types
├── config.ts             stellario.yaml loader + validator
├── store.ts              JSONL read/write, volume index, ID generation, linked volumes
├── permissions.ts        Agent resolution + permission engine
├── embedding.ts          Semantic search (embed, index, cosine similarity)
├── auto-refs.ts          Automatic bidirectional linking engine
├── git.ts                Git commit integration
├── context.ts            Project detection + context resolution
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
```

## Docs

- [Core Concepts](docs/concepts.md) — profiles, authority, permissions, entries, refs
- [Configuration](docs/configuration.md) — full `stellario.yaml` reference
- [API Reference](docs/api.md) — module-level API docs

## License

MIT
