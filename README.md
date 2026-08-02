# stellario

Memory entries for agents — a hybrid-search comment format, a write loop,
and governance. One tool, five verb classes.

Prose sections (code comments, docs, standalone files) become retrievable
memory via a tiny `<stellario>` block. The block is the retrieval
interface; the prose is the content. Everything is a file, everything is
greppable, nothing is a database schema.

## Install

```bash
# Linux (amd64)
curl -fsSL https://raw.githubusercontent.com/FadingRose/stellario/main/install.sh | sh

# or build from source
cd engine-rs && cargo install --path . --root ~/.local
```

This installs `stella` (+ `stellario` alias, `stellario-mcp`, `stellario-migrate`)
and the agent skill to `~/.agents/skills/stellario/` (kimi, codex and
opencode read that directory; Claude Code reads `~/.claude/skills/` —
symlink it there if you use Claude).

## Quick start

```bash
# 1. Create a memory surface anywhere — any directory with a .stella/
mkdir thoughts/.stella

# 2. Write a native entry
cat > thoughts/.stella/why-dumb-pipe.stella <<'EOF'
# Why the VM stays dumb

The scheduler derives order from declarations. The center never interprets.

<stellario>
header: dumb-pipe-declaration-scheduling — Subsystems declare reads/writes; the VM derives barrier layers.
tags: [module:spark-vm]
keywords: [dumb-pipe, barrier-derivation]
walls:
  - not: a lock manager
author: you
</stellario>
EOF

# 3. Sync — the capsule emerges (no create ceremony; default: 'scratch' inbox)
stella sync

# 4. Query — intent is mandatory (it routes hints and is logged)
stella "dumb pipe" "why the VM stays dumb"
```

## The loop

```
query → write → sync → show → govern
```

| Class | Verbs |
|---|---|
| Read | `stella "query" "intent"` · `stella show <id>` |
| Write loop | `stella sync [--capsule X]` (shape-aware) |
| Discipline | `stella lint <paths>` (no --fix; suggestions only) |
| Governance | `stella doctor [--level]` · `stella migrate <ids> --to <capsule>` |
| Storage | `stella export` · `list` · `volumes` · `lineage` |

`stellario` is an alias for `stella` — both names behave identically.

## The format, in one block

```rust
//! <stellario>
//! header: slug-word-word-word — One sentence tldr. (3-5 words, em-dash separator)
//! binding: embed            // embed = annotates prose above; cascade = declares subtree
//! tags: [module:x]          // closed-ish, gating
//! keywords: [anchor-word]   // open, semantic signal
//! walls:
//!   - not: what it is NOT
//!   - traps: falsified judgment (cite where)
//!   - warning: hypothetical danger
//! </stellario>
```

English-only inside blocks; prose may be any language. Full spec in
`skills/stellario/references/grammar.md`.

## Where things live

A directory's semantics come from its own layout (the shape rule):

- `.stellario` config + `.stella/` → **self-declared home**: `stella sync`
  is automatic (the config names the capsule)
- only `.stella/` → **staging shape**: `stella sync --capsule X`
  (default: the `scratch` inbox, auto-created)

```yaml
# .stellario
version: 1
capsules: [your-capsule]
```

Truth lives in exactly two places: inline embeds (the file) and capsule
entries (the capsule). Capsules **emerge** from sync targeting them —
there is no create ceremony.

## The agent skill

`skills/stellario/` is a standard `SKILL.md` (open Agent Skills format,
works in kimi / claude / codex / opencode) written against its own
quality framework (`references/quality-framework.md` — eight testable
criteria for judging any skill). The skill teaches the format; the CLI
is the engine. Format without CLI still works (write `.stella` files);
the CLI completes the loop.

## Self-hosting

stellario manages itself: this repository carries its own `.stellario`
(→ the `stellario-dev` capsule) and `.stella/` entries. Its memory is
queryable and governed by the same tool it ships.

```bash
cd stellario && stella "constellation" "our own design"
```

## Development

```bash
cd engine-rs && cargo test -p stellario-engine && cargo build --release
make release VERSION=0.2.0   # dist/ tarball + checksum (linux; darwin on mac/CI)
```

Architecture: three planes — storage (automerge capsule, truth), index
(sqlite-vec, derived, rebuildable), edit (files, transient). Proposals
in `docs/proposals/` are the design history (P-series, constellation
model, artifact plane).
