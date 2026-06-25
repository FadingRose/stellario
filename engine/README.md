# Stellario Graph Engine

Go backend for Stellario's memory system. Replaces JSONL + TS with SQLite + Go binary.

## Architecture

```
stellario binary (Go) → SQLite (storage + graph query)
OpenCode Tools (TS)   → calls stellario binary (glue layer)
```

## Core Concepts

### Entry

An entry is a unit of memory — a single assertion, observation, or finding.

### Frame Type

Each entry has a frame type that defines its operational semantics on the memory graph:

| Frame | Operation | Example |
|-------|-----------|---------|
| `assert` | Establishes a new dimension | "FluxPool operator is semi-trusted" |
| `derive` | Derives from existing entries | "p01*p10 > SCALE^2 enables extraction" |
| `supersede` | Replaces existing entries | "Timeline corrected from 2050 to 2041" |
| `validate` | Confirms/disconfirms an entry | "Forge PoC verifies the formal model" |
| `checkpoint` | Snapshots current graph state | "Session checkpoint — round 2 complete" |
| `constrain` | Constrains future entries | "Character X must not be portrayed as weak" |

### Edge

Typed directed relationships between entries:

| Edge Type | Source → Target | Meaning |
|-----------|----------------|---------|
| `derive_from` | entry → entry | "I was derived from this" |
| `supersede` | entry → entry | "I replace this" |
| `validates` | entry → entry | "I verify/disprove this" |
| `constrains` | entry → dimension | "I constrain this dimension" |
| `ref` | entry → entry | "I reference this" (untyped link) |

### Active State

An entry is **active** unless it has been superseded. The "current mental state" is the fold of all active entries' content.

## Build

```bash
cd engine
go build -o stellario ./cmd/stellario
cp stellario ~/.local/bin/stellario  # install to PATH
```

## Usage

```bash
# Resolve (TS runtime uses this as the bridge)
stellario resolve --root /path/to/project
# → { "project": "valhalla", "mem_dir": "~/.stellario/projects/valhalla",
#     "star": "Sirius", "exists": true }

# Cluster management
stellario status                    # all projects, volumes, sync state
stellario doctor --root <dir>       # diagnostics
stellario migrate --root <dir>      # copy memory into global library

# Volume inspection
stellario volume list               # all projects
stellario volume list --project x   # single project
stellario volume grep <pattern>     # search content

# Sync (subtree-based, in addition to TS auto push/pull)
stellario memory-sync --status
stellario memory-sync --push [--project x]
stellario memory-sync --pull [--project x]
```
