# Stellario

Agent memory infrastructure — structured, permissioned, version-controlled, cross-project, cross-device.

Agents get memory that survives across sessions. Volumes define how memory behaves (mutable, append-only, scratch, frozen, workspace). Permissions control which agent sees what. Semantic search finds concepts, not just keywords. A global library unifies memory across projects and devices via git.

## Quick Start

### For existing projects (opencode integration)

```bash
cd /path/to/your-project
npx stellario init --template software
```

This scaffolds everything inside `.opencode/` — config, tools, agents, plugin, memory directory with its own git repo. Init is idempotent — it skips files that already exist.

Templates: `minimal` · `novel` · `software` · `audit`

### Global library + CLI (Go engine)

```bash
# Install the Go CLI
cd engine && go install ./cmd/stellario

# Migrate a project's memory into the global library
stellario migrate --root /path/to/your-project

# Check cluster health
stellario doctor --root /path/to/your-project
stellario status
```

### Cross-device sync

```bash
# Device A: push memory to remote
stellario migrate --root ~/code/my-project
cd ~/.stellario && git remote add origin <your-remote.git> && git push -u origin main

# Device B: pull everything
git clone <your-remote.git> ~/.stellario
stellario status   # all projects visible
```

## Architecture

```
stellario.yaml          ← you define volumes, agents, permissions
        │
        ▼
┌──────────────────────────────────┐
│         Stellario Engine          │
│  ┌──────────┐  ┌───────────────┐  │
│  │ TS Core  │  │  Go Engine    │  │
│  │ (legacy) │  │  (SQLite +    │  │
│  │          │  │   graph +     │  │
│  │ config,  │  │   CLI)        │  │
│  │ tools,   │  │               │  │
│  │ perms    │  │  status,      │  │
│  └──────────┘  │  doctor,      │  │
│                │  migrate,     │  │
│                │  sync         │  │
│                └───────────────┘  │
└──────────────────────────────────┘
        │                    │
        ▼                    ▼
  .opencode/.stellario/   ~/.stellario/
  (project-scoped)        (global library)
  JSONL + git             projects/ + global/
                          subtree git repos
```

### Global Library Layout

```
~/.stellario/                    ← global library (one git repo)
├── .git/                        ← parent repo (subtree model)
├── .gitignore                   ← device-local files excluded from sync
├── .project-map.json            ← device-local: cwd → project name mapping
├── .device-id                   ← device-local: identity
├── global/                      ← cross-project volumes
└── projects/
    ├── valhalla/                ← subtree (independent push/pull)
    │   ├── stellario.yaml       ← project config
    │   ├── active.jsonl
    │   └── ...
    ├── stellario/
    └── zanshin/
```

### Identity Model

```
agent (stellario)                ← cognitive identity (first class)
  └─ project (valhalla)          ← memory domain (first class)
       └─ session (stellario#a3f7) ← work instance
            └─ device (macbook-m3) ← physical environment
```

- **Memory layer**: identity = agent (role). Same agent's sessions share memory.
- **Coordination layer**: identity = agent#nonce. Different sessions are different workers.
- **Project is first class**: same project across devices shares memory. Project identity derived from git remote.

## Tools (opencode)

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

## CLI Commands (Go engine)

### Cluster Management

```bash
stellario status                          # cluster overview: all projects, volumes, sync state
stellario doctor --root <dir>             # diagnose config + memory integrity (read-only)
stellario migrate --root <dir>            # copy memory data into global library
stellario memory-sync --status            # check sync state
stellario memory-sync --push [--project]  # push to remote (subtree)
stellario memory-sync --pull [--project]  # pull from remote (subtree)
```

### Project Management

```bash
stellario project list                    # list registered projects
stellario project register <dir>          # register a local project
stellario project add <git-url>           # add from remote (subtree)
stellario project add --local <dir>       # import local project
stellario project info <name>             # detailed project info
stellario project remote <name> [url]     # set/show/remove subtree remote
stellario project forget <name>           # remove from device registry
```

### Config & Volume

```bash
stellario config show [--root <dir>]      # show effective config
stellario config show --global            # check all project configs
stellario config validate [--root <dir>]  # validate config
stellario config edit [--root <dir>]      # open in $EDITOR

stellario volume list [--project <name>]  # list volumes with stats
stellario volume stats <name> --project   # detailed statistics
stellario volume grep <pattern>           # search entry content
```

### Graph Engine

```bash
stellario create --volume <vol> --content "..." [--tags "a,b"]
stellario show <id> --volume <vol> --project <name>
stellario search [--volume <vol>] [--tag <tag>]
stellario supersede <new_id> <old_id>     # mark entry as superseded
stellario downstream <id>                 # transitive derive_from
stellario propagate <id>                  # what goes stale if superseded
stellario constellation --bid "<intent>"  # intent-driven retrieval
```

## Profiles

Five profiles drive how entries behave:

| Profile | Create | Revise | Forget | Git | ID Style |
|---------|--------|--------|--------|-----|----------|
| `mutable` | ✓ | ✓ | ✓ | ✓ | sequential |
| `append` | ✓ | — | — | ✓ | sequential |
| `scratch` | ✓ | ✓ | ✓ | — | ephemeral |
| `frozen` | — | — | — | ✓ | sequential |
| `workspace` | ✓ | ✓ | ✓ | ✓ | sequential + active tracking |

## Troubleshooting

### Clean rebuild (preserving memory)

```bash
# Generated files — safe to delete
rm .opencode/tools/stellario-*.ts
rm .opencode/plugin/stellario-inject.ts
rm .opencode/agents/*.md
rm .opencode/package.json .opencode/package-lock.json
rm -rf .opencode/node_modules

# Then re-init
npx stellario init --template <your-template>
```

### Tools not showing up in opencode

1. Check `.opencode/tools/` has the glue files: `ls .opencode/tools/stellario-*.ts`
2. Check `.opencode/node_modules/stellario` exists
3. If missing, run `cd .opencode && npm install`

### Config validation fails

```bash
stellario config validate --root /path/to/project
stellario doctor --root /path/to/project
```

Common issues:
- Multiple volumes with `profile: workspace` (only one allowed — system volume `layer` already uses it)
- Missing `boundaries` on user-defined volumes
- `idPrefix` conflicts between volumes

### Cross-device sync issues

```bash
# Check what would happen
stellario memory-sync --status

# Verify data integrity after clone
stellario doctor --root /path/to/project
stellario status
```

## Migration Path (opencode → Go engine)

Stellario is migrating from a TS-only engine to a Go backend. Current status:

| Phase | Status | What |
|-------|--------|------|
| Phase 1 | ✅ Done | Go `doctor` command (read-only diagnostics) |
| Phase 2 | ✅ Done | Go `migrate` + global library layout |
| Phase 3 | ✅ Done | Go CLI: status, config, volume, sync (subtree) |
| Phase 4 | 🔄 Next | Go takes over write operations (create/revise/forget) |
| Phase 5 | ⏳ Planned | TS engine retirement |
| Phase 6 | ⏳ Planned | LSP + embedding migration to Go |

The TS engine and Go engine coexist. TS handles agent tools (opencode plugin), Go handles cluster management and will gradually take over writes.

## Docs

- [Core Concepts](docs/concepts.md) — profiles, authority, permissions, entries, refs
- [Configuration](docs/configuration.md) — full `stellario.yaml` reference
- [Volume Link](docs/volume-link.md) — cross-project memory observation
- [Architecture & Module API](docs/architecture.md) — source layout and module exports
- [API Reference](docs/api.md) — full API with types and examples

## License

MIT
