# Stellario

Agent memory infrastructure — structured, permissioned, version-controlled, cross-project, cross-device.

Agents get memory that survives across sessions. Volumes define how memory behaves (mutable, append-only, scratch, frozen, workspace). Permissions control which agent sees what. Semantic search finds concepts, not just keywords. A global library unifies memory across projects and devices via git. Auto-sync keeps everything up to date.

## Install

### One-liner (recommended)

```bash
curl -fsSL https://raw.githubusercontent.com/FadingRose/stellario/main/install.sh | sh
```

This downloads the binary for your platform, installs it to `~/.local/bin/`, and runs `stellario setup` automatically.

### Manual download

Grab the binary from [GitHub Releases](https://github.com/FadingRose/stellario/releases):

| File | Platform |
|------|----------|
| `stellario-darwin-arm64` | Apple Silicon Mac |
| `stellario-darwin-amd64` | Intel Mac |
| `stellario-linux-amd64` | Linux x86_64 |
| `stellario-linux-arm64` | Linux ARM |

```bash
curl -fsSL https://github.com/FadingRose/stellario/releases/latest/download/stellario-darwin-arm64 -o stellario
chmod +x stellario
./stellario setup
```

### Build from source

```bash
git clone https://github.com/FadingRose/stellario.git
cd stellario/engine
make install VERSION=v1.0.0-dev
```

## Setup

After install, run setup (the installer does this automatically):

```bash
stellario setup
```

This will:
1. Initialize the global library (`~/.stellario/`)
2. Assign a star name to your device (e.g. Sirius)
3. Write the TS runtime (memory engine)
4. Inject the Stellario agent into opencode
5. Write diagnostic specs

Then open opencode and switch to the **Stellario** agent.

### First conversation

Stellario will ask how you'd like to be called and how you prefer to communicate. She remembers this across sessions.

After that, tell her about a project you're working on — she'll create a project agent for it with its own memory.

## Cross-device sync

The global library at `~/.stellario/` is a single git repo. Set up a remote once:

```bash
cd ~/.stellario
git remote add origin <your-remote.git>
git push -u origin main
```

On another device:

```bash
# Install stellario (same one-liner)
curl -fsSL https://raw.githubusercontent.com/FadingRose/stellario/main/install.sh | sh

# Clone your memory
git clone <your-remote.git> ~/.stellario

# Run setup to link this device
stellario setup
```

After that, **sync is automatic**:
- **Session start**: pulls remote changes (other device's memory)
- **Every write**: pushes to remote immediately
- **Network down**: both operations fail silently — local commits queue up, sync resumes when connectivity returns

## Architecture

```
stellario.yaml          ← you define volumes, agents, permissions
        │
        ▼
┌──────────────────────────────────┐
│         Stellario Engine          │
│  ┌────────────┐  ┌─────────────┐  │
│  │  TS Core   │  │  Go Engine  │  │
│  │            │  │             │  │
│  │ config     │  │ resolve     │  │
│  │ tools      │  │ migrate     │  │
│  │ perms      │  │ doctor      │  │
│  │ search     │  │ volume      │  │
│  │ mounts     │  │ sync        │  │
│  │ git sync   │  │             │  │
│  └────────────┘  └─────────────┘  │
└──────────────────────────────────┘
        │                    │
        ▼                    ▼
  .opencode/.stellario/   ~/.stellario/
  (legacy project-scoped) (global library)
  JSONL + git             projects/{name}/
                          single git repo
                          auto push/pull
```

### Global Library Layout

```
~/.stellario/                    ← global library (one git repo)
├── .git/                        ← auto push/pull on every commit
├── .gitignore                   ← device-local files excluded from sync
├── .project-map.json            ← device-local: cwd → project name mapping
├── .device-id                   ← device-local: identity + star name
├── projects/
│   ├── valhalla/                ← one directory per project
│   │   ├── stellario.yaml       ← project config
│   │   ├── active.jsonl         ← volume data
│   │   ├── handover.jsonl
│   │   ├── volumes.jsonl        ← volume index + mount records
│   │   └── .track/              ← per-entry markdown for git diffs
│   ├── edelweiss/
│   └── stellario-dev/
└── global/                      ← cross-project volumes
```

### Identity Model

```
agent (stellario)                ← cognitive identity (first class)
  └─ project (valhalla)          ← memory domain (first class)
       └─ session (stellario#a3f7) ← work instance
            └─ device (Sirius)    ← physical environment (star name)
```

- **Memory layer**: identity = agent (role). Same agent's sessions share memory.
- **Project is first class**: same project across devices shares memory. Project identity derived from git remote or `.project-map.json`.
- **Star suffix**: entry IDs include the device's star name (e.g. `a42.Sirius`) for cross-device uniqueness. Display IDs strip the suffix: `active:42`.

## Tools (opencode)

| Tool | Layer | What it does |
|------|-------|--------------|
| `create` | memory | Write entry to a volume |
| `show` | memory | Read entry by ID |
| `revise` | memory | Edit content via line ranges |
| `forget` | memory | Archive an entry |
| `history` | memory | View git revision history |
| `ref` | memory | Create manual reference between entries |
| `unref` | memory | Remove a reference between entries |
| `search` | telescope | Unified search (text + tags + semantic) |
| `status` | workspace | Dashboard: volume stats, active context, mounts |
| `assemble` | workspace | Create a workspace theme gathering related entries |
| `open` | workspace | Expand active workspace with all gathered entries |
| `discover` | volume-link | Find stellario projects and their volumes in the global library |
| `link` | volume-link | Mount an external project's volume (native, readonly) |
| `unlink` | volume-link | Unmount a linked volume |

## CLI Commands (Go engine)

### Cluster Management

```bash
stellario status                          # cluster overview: all projects, volumes, sync state
stellario doctor --root <dir>             # diagnose config + memory integrity (read-only)
stellario migrate --root <dir>            # copy memory data into global library
stellario resolve --root <dir>            # resolve project to global library path (JSON)
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

## Native Volume Mount

Cross-project memory reference — no symlinks, no filesystem artifacts. A mount is just a record in `volumes.jsonl` pointing to another project's volume in the global library.

```
# Mount edelweiss's active volume
link(project="edelweiss", volume="active")
  → creates mount record in volumes.jsonl
  → resolveContext injects as frozen/readonly in config.volumes
  → readJsonl reads source_path directly

# All tools see it transparently
search(query="rendering")
  → includes edelweiss entries with volume="edelweiss/active"
```

## Profiles

Five profiles drive how entries behave:

| Profile | Create | Revise | Forget | Git | ID Style |
|---------|--------|--------|--------|-----|----------|
| `mutable` | ✓ | ✓ | ✓ | ✓ | sequential + star suffix |
| `append` | ✓ | — | — | ✓ | sequential + star suffix |
| `scratch` | ✓ | ✓ | ✓ | — | ephemeral hash |
| `frozen` | — | — | — | ✓ | sequential (inherited) |
| `workspace` | ✓ | ✓ | ✓ | ✓ | sequential + star suffix |

## Meta Volume — Behavioral Calibration

The `meta` volume holds cross-session calibrations: methodology lessons, tool quirks, reusable mental models. **All meta entries are injected into the agent's system prompt at session startup** — the agent sees them automatically, no need to search.

- Write with `create(volume="meta", content=..., tags=[...], keywords=[...])`.
- To exclude an entry from injection (e.g. it's superseded or project-specific), add the `meta:disable` tag via `revise`.
- The agent self-manages this: it knows the injection rules from the tool-level usage guide, and decides what to calibrate vs. what to record elsewhere.

## Troubleshooting

### Tools not loading after stellario source changes

Opencode loads stellario from `~/.config/opencode/node_modules/stellario`. If source changes aren't taking effect, rerun setup to sync the embedded TS runtime:

```bash
cd stellario/engine
make install   # rebuild binary with updated embedded source
stellario setup  # re-extract TS runtime + relink opencode
```

Then reload opencode (restart or `/reload`).

### Go resolve not working

The Go binary must support `resolve --help`. If `which stellario` finds the Node CLI script instead:

```bash
# Verify
stellario resolve --root /path/to/project

# If it says "Unknown command: resolve", the Go binary isn't in PATH
# Build and install it:
cd engine && go build -o stellario ./cmd/stellario
cp stellario ~/.local/bin/stellario
```

### Clean rebuild (preserving memory)

```bash
# Remove opencode integration files — safe to delete
rm ~/.config/opencode/tools/stellario-*.ts
rm ~/.config/opencode/plugin/stellario-inject.ts
rm ~/.config/opencode/agent/stellario.md
rm -rf ~/.config/opencode/node_modules/stellario

# Re-init from the Go binary
stellario setup
```

Your memory at `~/.stellario/` is preserved.

### Config validation fails

```bash
stellario config validate --root /path/to/project
stellario doctor --root /path/to/project
```

Common issues:
- Multiple volumes with `profile: workspace` (only one allowed)
- Missing `boundaries` on user-defined volumes
- `idPrefix` conflicts between volumes

## Docs

- [Core Concepts](docs/concepts.md) — profiles, authority, permissions, entries, refs, star suffixes
- [Configuration](docs/configuration.md) — full `stellario.yaml` reference
- [Volume Mount](docs/volume-link.md) — cross-project memory reference (native, symlink-free)
- [Architecture & Module API](docs/architecture.md) — source layout and module exports
- [API Reference](docs/api.md) — full API with types and examples

## License

MIT
