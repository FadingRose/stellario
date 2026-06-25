# Volume Mount

Cross-project memory reference — native, symlink-free, readonly.

---

## Overview

In the global library model, all projects are siblings at `~/.stellario/projects/{name}/`. "Mounting" another project's volume is just a record in `volumes.jsonl` — no symlinks, no filesystem artifacts. The source data is read directly at runtime.

```bash
# Discover what's available in the global library
discover()
# → Mounts: (none)
# → Local volumes: active (mutable, 6 entries), ...
# → Available projects:
#     edelweiss: active (87), handover (135), layer (171), ...

# Mount edelweiss's active volume
link(project="edelweiss", volume="active")
# → Mounted "active" from edelweiss
# → Alias: edelweiss/active
# → Entries: 87, Access: readonly

# Search includes mounted volumes transparently
search(query="rendering")
# → [edelweiss/active:57] Edelweiss 3D Workspace — Formal Specification
# → [edelweiss/active:65] Faceted Surface Spec
# → [active:03] ...

# Unmount
unlink(alias="edelweiss/active")
```

## How It Works

1. **discover** lists projects in the global library (`~/.stellario/projects/`) and their volumes by reading each project's `stellario.yaml`
2. **link** adds a mount record to `volumes.jsonl` — just a JSON line with the source path
3. `resolveContext` injects mount volumes into `config.volumes` as `frozen` profile with `read: ["all"]`
4. `readJsonl` checks for a mount record and reads the source JSONL directly
5. All tools (search, status, etc.) see mount volumes transparently — zero ad-hoc code
6. **unlink** removes the mount record from `volumes.jsonl`

### Data Model

Mount records live in `volumes.jsonl` as entries with a `mount` field:

```jsonl
{"volume":"edelweiss/active","files":[],"next_nonce":0,
 "mount":{"project":"edelweiss","source_volume":"active",
          "source_path":"/home/user/.stellario/projects/edelweiss/active.jsonl",
          "mounted_at":"2026-06-26T22:26:27.455Z"}}
```

### Alias Naming

- Default alias: `{project}/{volume}` (e.g. `edelweiss/active`)
- Aliases **must not contain `:`** (used as display ID separator)
- Custom aliases can be set via the `alias` parameter

### Display IDs

Mount volume entries use the alias as the volume name in display IDs:

```
stored ID:    a57.Sirius
display ID:   edelweiss/active:57
```

The `stripStarSuffix` and `idMatch` helpers in `store.ts` handle the suffix transparently.

## Constraints

- Mounts are **project-level** (not per-agent) — all agents in the project see the same mounts
- Mount volumes are **always readonly** (frozen profile injected by `resolveContext`)
- `writeEntries` has a defense-in-depth check that throws if called on a mount volume
- `generateNextId` only scans local volumes — no ID collision with mount entries

## Use Cases

- Reference another project's design decisions while working on a related project
- Share a knowledge base across projects without duplication
- Audit a client project's memory without modifying it
- Cross-project search for related work
