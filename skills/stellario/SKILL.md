---
name: stellario
description: Write and manage <stellario> memory entries — the hybrid-search comment format plus its write loop. Use when writing knowledge into code comments or docs, searching memory, syncing .stella files to a capsule, linting entry blocks, or governing memory health.
whenToUse: When the user asks to write a .stella entry or a <stellario> comment block, query memory with intent, sync staged entries, lint entry blocks, run memory health checks, or migrate entries between capsules.
metadata:
  version: "0.2.0"
  verified-against: "stella/stellario unified CLI (fa43446, 2026-08-02)"
  author: kobayakawaami × kimi-k3
  license: Proprietary
---

# stellario — memory entries, the write loop, and governance

stellario turns prose sections (code comments, docs, standalone files) into
memory entries for a hybrid retrieval index. One tool, five verb classes.
The loop: **query → write → sync → show → govern**.

## The tool

```
stella "query" "intent"          hybrid search (fzf + semantic). Intent is
                                 MANDATORY — it routes hints and is logged.
stella show <id>                 read one entry (slug or volume:id)
stella lint <paths>              edit-plane grammar check (no --fix)
stella sync [--capsule X]        the write loop, shape-aware
stella doctor [--level L]        full-system health (read-only, graded)
stella migrate <ids> --to <cap>  relocate entries (target auto-created)
stella export --capsule X --out D  capsule → files (legacy exit)
stella list | volumes | lineage  registry + history
```

`stellario` is an alias for `stella` — both names work identically.

## The entry format (minimum you must know)

A memory entry is a `<stellario>` block inside comments (`.rs`/`.md`) or at
the end of a standalone `.stella` file:

```rust
//! <stellario>
//! header: dumb-pipe-declaration-scheduling — Subsystems declare reads/writes; the VM derives barrier layers.
//! binding: embed
//! tags: [module:spark-vm]
//! keywords: [dumb-pipe, barrier-derivation]
//! walls:
//!   - not: a lock manager
//!   - traps: round-trip judging ignores the operator
//! author: kimi-k3
//! </stellario>
```

- **header** (required): `slug — tldr`. Slug: 3–5 lowercase hyphenated
  words. Separator is the em-dash ` — ` — NEVER `: ` (breaks YAML).
- **binding** (required, except native files): `embed` (annotates the prose
  above; place at section end) | `cascade` (declares the subtree; place
  under a heading, before prose).
- **walls**: typed bullets only — `not:` (identity negation), `traps:`
  (falsified, cite where), `warning:` (hypothetical danger).
- Block content is **English-only** (the retrieval substrate is
  English-centric); prose outside the block may be any language.
- All fields optional except header/binding. A block with only prose
  around it is valid; absence is valid.

## Decision tree

```
Task is...                                  → do this
  find knowledge / understand a decision    → stella "terms" "intent"
  read one entry fully                      → stella show <id>
  write knowledge into code/doc comments    → write a <stellario> block, then stella lint
  write a standalone native entry           → <slug>.stella in a .stella/ dir, then stella sync
  capture a stray thought (no home yet)     → any dir/.stella/<slug>.stella, stella sync (lands in scratch)
  check grammar of what you wrote           → stella lint <paths>
  check memory health / what to do next     → stella doctor
  organize entries into a topic capsule     → stella migrate <ids> --to <capsule>
```

## Where things live (the shape rule)

A directory's stellario semantics come from its OWN file layout:

- `.stellario` config + `.stella/` → **self-declared home**: `stella sync`
  (no flags) syncs automatically into the declared capsule(s).
- only `.stella/` (no config) → **staging shape**: `stella sync --capsule X`
  (no `--capsule` → the `scratch` inbox, auto-created).
- `.stellario` declares `capsules: [name]` — the repo's memory home.

Truth lives in exactly two places: **inline embeds** (the file) and
**capsule entries** (the capsule). Everything else — the index, `.stella`
files, exports — is derived or a working surface. Capsules EMERGE from
sync targeting them; there is no create ceremony.

## NOT for (walls — read before misfiring)

- **Not** a general note-taking tool for ephemeral chat — that's a star
  draft (`<slug>.<star>`), not a `.stella`.
- **Not** a replacement for code review — it annotates knowledge, not
  diffs.
- **Not** for content that must stay out of search — every entry is
  retrievable; anything indexed is visible.
- **Not** auto-fixing: lint reports, it never rewrites your prose.
- **Not** a database schema — entries are prose first; the block is the
  retrieval interface, never the content itself.

## Freshness

This skill is versioned (`metadata.version`) and verified against the
CLI commit in `verified-against`. If the tool surface diverges (new
verbs, changed flags), update the body AND bump both fields — a stale
skill is stale memory recalled with confidence.

## References (load on demand)

- `references/grammar.md` — full field spec + examples
- `references/binding-cases.md` — the seven binding cases (B1–B7)
- `references/authority.md` — three planes, truth-by-residence, config
- `references/governance.md` — doctor grades, migrate semantics
- `references/constellation.md` — stars, collection, demotion
- `references/quality-framework.md` — how to judge any skill (this one included)
