# Stellario

Agent memory infrastructure for opencode — structured, permissioned, version-controlled, cross-project.

Agents get memory that survives across sessions. Volumes define how memory behaves (mutable, append-only, scratch, frozen, workspace). Permissions control which agent sees what. Semantic search finds concepts, not just keywords. And agents can link volumes from other projects to observe memories they don't own.

## Quick Start

```bash
cd /path/to/your-project
npx stellario init --template software
```

This scaffolds everything inside `.opencode/` — config, tools, agents, plugin, memory directory with its own git repo. Init is idempotent — it skips files that already exist.

Templates: `minimal` · `novel` · `software` · `audit`

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

## Troubleshooting

### Clean rebuild (preserving memory)

Init is idempotent but skips existing files. To do a full rebuild without losing memory:

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

What each file contains:

| File | User data? | Notes |
|------|-----------|-------|
| `.opencode/stellario.yaml` | ✏️ Config | You edited this — **don't delete** unless you want to reset |
| `.opencode/.stellario/` | 🗃️ Memory | JSONL + git — **never delete** |
| `.opencode/tools/stellario-*.ts` | 🔧 Generated | Glue bindings, safe to rebuild |
| `.opencode/plugin/stellario-inject.ts` | 🔧 Generated | Plugin injector, safe to rebuild |
| `.opencode/agents/*.md` | ✏️ Mixed | Generated skeleton, but you may have edited agent instructions |
| `.opencode/package.json` | 🔧 Generated | Dependencies, safe to rebuild |

### Tools not showing up in opencode

1. Check `.opencode/tools/` has the glue files: `ls .opencode/tools/stellario-*.ts`
2. Check `.opencode/node_modules/stellario` exists: `ls .opencode/node_modules/stellario/package.json`
3. If missing, run `cd .opencode && npm install`

### Plugin not injecting context on session start

1. Check `.opencode/plugin/stellario-inject.ts` exists
2. Check `.opencode/stellario.yaml` is valid YAML with `agents:` and `volumes:` defined
3. The plugin silently skips if memory isn't initialized — call `status` manually to bootstrap

### Embedding model download fails

The semantic search model (~22MB) downloads on first use. If behind a proxy or offline:

```bash
STELLARIO_EMBEDDING=off  # Disable semantic search, text-only mode
```

## Docs

- [Core Concepts](docs/concepts.md) — profiles, authority, permissions, entries, refs
- [Configuration](docs/configuration.md) — full `stellario.yaml` reference
- [Volume Link](docs/volume-link.md) — cross-project memory observation
- [Architecture & Module API](docs/architecture.md) — source layout and module exports
- [API Reference](docs/api.md) — full API with types and examples

## License

MIT
