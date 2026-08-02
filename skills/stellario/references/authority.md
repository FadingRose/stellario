# Authority — where truth lives

## Three planes

| Plane | Holds | Authority |
|---|---|---|
| storage (automerge capsule) | entry versions + version graph | **truth** — append-only, replayable |
| index (index.db) | projected rows + anchor vectors | none — derived, rebuildable |
| edit (files: `.stella/`, staging) | working surface | none — transient |

All transitions are explicit tool acts (`sync`, `export`, `lint`,
`migrate`); none is magic. Index is never edited; capsule is never edited
directly; edits happen on files.

## Truth by residence

- **inline embeds** (in `.rs`/`.md`): truth stays with the file — the
  knowledge is bound to the code.
- **capsule entries** (natives after sync): truth is the capsule. The
  repo `.stella` file is an edit/review surface, never authoritative.

## The shape rule

- `.stellario` (config) + `.stella/` → self-declared home: `stella sync`
  is automatic (the config names the capsule).
- only `.stella/` → staging shape: `stella sync --capsule X` required
  (default: `scratch`, auto-created). ANY directory can be staging;
  upgrading = adding one `.stellario` file.

## Config

```yaml
# .stellario
version: 1
capsules: [edelweiss-core]   # sync targets; may list several
creation_dir: .stella/       # convention, configurable
```

Discovery walks up from cwd (git-like). A subtree may declare its own
home; the repo root is the common case.

## Emergence, not ceremony

Capsules EMERGE from sync targeting them (`ensure_capsule` creates
`~/.stellario/projects/<name>/<device>/capsule.automerge` on first use).
There is no create command: structure is discovered from writing, never
declared. `stella list` shows what sync has materialized.

## Index

`~/.stellario/index.db` (sqlite + sqlite-vec). One row per slug —
mirror pairs (repo/native + memory/native) collapse to the capsule row;
repo/embed rows coexist (different residence). Derived: delete and
rebuild (`stella sync --reindex-memory` + `stella sync --repo`).
