# Grammar — full field spec

A `<stellario>` block is a YAML subset between `<stellario>` and
`</stellario>`, inside host comments (`//!`, `///`, `//`, `#`, or raw in
markdown; `.stella` files are markdown-shaped). Two-phase parse: host
comment stripping, then zone extraction — the zone grammar is
host-independent.

## Fields

| Field | Required | Meaning |
|---|---|---|
| `header` | ✓ | `slug — tldr.` Slug: 3–5 lowercase hyphenated words (alnum only), repo-unique — THE identity. Separator is the em-dash; `: ` is illegal in YAML plain scalars. |
| `binding` | ✓ (native files exempt) | `embed` (annotates preceding prose, place at section end) \| `cascade` (declares following subtree, place under heading before prose; fields inherit down, union-only) |
| `tags` | | `ns:value`, closed-ish, gating/filter signal |
| `keywords` | | open anchors, semantic signal. Must be earnable from the prose. |
| `walls` | | typed bullets: `not:` identity negation / `traps:` falsified (cite) / `warning:` hypothetical danger. One line each. |
| `refs` | | entry ids (slug, `slug@hash`, or legacy `volume:id`) — typed bullets like `- supersedes: old-slug@hash — reason` |
| `chain` | | doc citations, one `path[#anchor]` per bullet. lint-verified resolvable. |
| `codemap` | | `path:linerange` pins; `#hash` appended by lint |
| `owner` | | work attribution (coordination) |
| `author` | | cognitive author (e.g. `kimi-k3`), distinct from commit author |
| `auto` | lint-owned | `<hash> at <commit-time>` — a verifiable blame cache. NEVER hand-write. |
| `stars` | | collected star names in the canonical (constellation) |

## Rules

- English-only inside the block (fzf + embedding substrate).
- Strip test: deleting all blocks loses zero narrative information.
- Earnability: everything in the block must be derivable from the prose.
- Bullet values must not START with a quote (YAML quoted-scalar trap);
  mid-sentence quotes are safe.
- Opt-in: absence of a block is a valid state.

## Native entries (`.stella` files)

A whole `<slug>.stella` file is one entry: the file's prose is the
description, one block at the end carries the fields. `binding` is exempt
(embed implied; `cascade` is an error there).

## Star drafts (`<slug>.<star>`)

Drafts carry NO `.stella` extension — the extension IS the canonical
claim. Stars are loose form: no required block, no lint. `status:
dismissed` and `demoted: <reason>` are footnotes inside star files.
