# Constellation — stars, collection, demotion

A constellation is a slug's family in a `.stella/` directory. No registry:
**the naming IS the grouping**.

```
<slug>.stella       canonical native entry (lint-disciplined, indexed)
<slug>.<star>       draft — loose form, gitignored, no grammar discipline
```

## Lifecycle

```
write stars freely      →  <slug>.sirius, <slug>.aquila
consolidate (sync)      →  <slug>.stella  (canonical; block carries
                                          stars: [sirius, aquila])
overturn yourself       →  <slug>.stella is RENAMED to <slug>.vega —
                            the file LOSES the .stella extension, which
                            IS the demotion; `demoted: <reason>` added
                            inside; the canonical slot stays vacant
```

- **collected**: a star named in the canonical's `stars:` list
- **dismissed**: a star deliberately not collected — `status: dismissed`
- **vacant head**: stars exist but no canonical — an OPEN QUESTION, a
  state not an error

## Reporting (in-path, not on-demand)

- `stella sync --status` — the hygiene report: uncollected stars, vacant
  heads, demoted, next-star hints.
- Query hits carry side notes: "△ N uncollected star(s) in constellation
  '<slug>'". The report must reach you; you must not have to seek it.

## Collection bookkeeping

Lint-checked, never auto-written: lint warns when a canonical does not
list a star in its constellation — `collected or dismissed?` — pushing
the judgment to you. No `--fix` applies here either.

## Star names

Curated namespace (sirius, canopus, vega, rigel, polaris, …). The hint
engine and sync suggest `next unused star` so the namespace is always at
hand.
