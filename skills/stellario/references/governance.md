# Governance — doctor and migrate

Governance is one topic, lint-loop shaped: **check → suggest → explicit
act → recheck**. Checks are read-only; acts are explicit; destructive
actions appear in doctor reports, never in hints.

## doctor — graded health (read-only)

```
stella doctor [--level error|warning|info]   # default: all
```

| Grade | Meaning | Findings | Exit |
|---|---|---|---|
| error | truth damaged, must handle | dangling refs, orphan tombstones (superseded with no successor) | 1 |
| warning | hygiene debt, should handle | native lint violations, un-distilled legacy (aggregated per volume), staging zombies | 0 (`--strict` future) |
| info | opportunities, optional | migrate candidates, constellation vacancies | 0 |

Each finding carries an executable action. `un-distilled` is aggregated
per volume — the legacy migration is a bulk state, not a per-entry daily
concern.

## migrate — explicit relocation

```
stella migrate <ids...> --to <capsule> [--from <capsule>]
```

- Target capsule auto-created (emergence).
- **Migration = verification + movement**: grammar-violating entries are
  refused and reported.
- Source tombstoned with intent (`migrated to X`, stays in lineage);
  target records provenance in its intent.
- Slugs live in the `native` volume; `volume:id` legacy keeps its volume.
- Reindexes both sides.
- Cross-capsule refs are NOT rewritten — legacy aliases stay as
  provenance (no history rewriting).

## The governance loop

```
stella doctor          → graded report + executable actions
stella migrate ...     → explicit act
stella doctor          → recheck (loop closes)
```

`stella sync --status` is the repo-local constellation report
(in-path); doctor is the full-system view. They complement, not replace.
