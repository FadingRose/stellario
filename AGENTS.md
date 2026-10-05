# AGENTS.md

Guidance for AI coding agents working in this repository. Everything here is
derived from the checked-in code, docs, and git history. When the code and this
file disagree, the code wins — then update this file.

## Project overview

**stellario** is memory for agents: a hybrid-search comment format, a write
loop, and governance. Prose (code comments, docs, standalone files) becomes
retrievable memory through a tiny `<stellario>` YAML block. The block is the
retrieval interface; the prose is the content. Everything is a file, everything
is greppable, nothing is a database schema.

The current product is a single Rust CLI, `stella` (alias `stellario`): one
tool, five verb classes — query / write loop / lint / governance / storage.
Version `0.10.0` (see `engine-rs/Cargo.toml`). The project is **pre-1.0**:
MINOR releases may break the interface.

The loop: `query → write → sync → show → govern`.

Repository: `git@github.com:FadingRose/stellario.git` (branch `main`).

Architecture in one line: **three planes** — storage (Automerge capsule, the
truth), index (sqlite-vec, derived and rebuildable), edit (files, transient).
Truth lives in exactly two places: inline embeds (the file, bound to the code)
and capsule entries (the capsule).

## Repository layout — live vs. legacy

Read this before editing anything: a large part of the tree is from the
pre-Rust era and is **not part of the build**.

### Live

| Path | Role |
|---|---|
| `engine-rs/` | The Rust engine and the only built product. Library `stellario` + four binaries. |
| `skills/stellario/` | The agent skill (`SKILL.md` + `references/`), a standard open Agent Skills document. |
| `.stellario`, `.stella/` | This repo's own memory declaration (`capsules: [stellario-dev]`) and two self-hosted native entries. The project manages its own memory. |
| `Makefile` | Release packaging (build → tarball → sha256). |
| `install.sh` | End-user installer (downloads a GitHub release tarball, links the skill). |
| `README.md`, `CHANGELOG.md` | Product README and Keep-a-Changelog history. |
| `docs/proposals/` | Design history (P-series, constellation model, evolution graph, artifact plane, capsule sync, etc.). These are **proposals and reviews, not a current spec**. Read them to understand *why*; do not treat them as behavior contracts. |

### Legacy — retained, not built

`engine/` (Go backend), `glue/` (opencode TS tool bindings), `templates/`
(config + agent templates), `tests/` (TS/vitest tests), and
`prototype/automerge-poc/` (a standalone Automerge convergence PoC) are
remnants of the TypeScript/Go era replaced in 0.10.0. The root `Makefile` does
not touch them.

Concrete staleness signals, so you do not chase them:

- `tests/*.ts` import `../src/*`, but the root `src/` directory was removed in
  0.10.0, and there is no root `package.json` or vitest config. These tests
  cannot run.
- `glue/*.ts` import the `stellario/defs/*` npm package, which no longer exists
  in this repo.
- `engine/Makefile`'s `embed` target copies `../src` → `engine/embedfs/src`,
  but `../src` no longer exists, so the documented Go build flow is stale.
  `engine/embedfs/` still holds a committed snapshot of the TS source, glue,
  and templates (they are tracked despite `.gitignore` patterns matching them).
- `.gitignore` has unanchored `embedfs/src/`, `embedfs/glue/`,
  `embedfs/templates/` entries that also match `engine/embedfs/...`. New files
  added there would be ignored; the existing ones are tracked.

Do not spend effort fixing or extending the legacy trees unless a task
explicitly asks for it.

## Build, test, and release

All commands run from the repo root unless noted.

```bash
# Unit tests — the standard check (make check wraps exactly this)
cd engine-rs && cargo test -p stellario-engine

# Debug build of the CLI
cd engine-rs && cargo build

# Release build (opt-level=z, LTO, stripped)
cd engine-rs && cargo build --release --bin stella
```

There is **no CI workflow** in the repo (no `.github/`). Verification is local.

Packaging (root `Makefile`; runs `check` first):

```bash
make release VERSION=0.10.0                       # host platform
make release VERSION=0.10.0 TARGET=aarch64-apple-darwin
make check                                        # cargo test -p stellario-engine
make install                                      # extract to ~/.local/bin, link skill
```

`make release` maps the Rust target triple to a platform name
(`x86_64-unknown-linux-gnu` → `linux-amd64`, `aarch64-apple-darwin` →
`darwin-arm64`, `x86_64-apple-darwin` → `darwin-amd64`,
`aarch64-unknown-linux-gnu` → `linux-arm64`) and emits
`dist/stella-<version>-<platform>.tar.gz` + `.sha256`. The tarball contains
`stella`, the `stellario` symlink, `stellario-mcp`, `stellario-migrate`,
`skills/stellario/`, and `README.md`. The Makefile stops at the tarball and
checksum — publishing to GitHub Releases (which `install.sh` downloads from) is
a separate manual step.

`install.sh` detects the platform with the same naming, downloads the tarball
from GitHub Releases (or a local `dist/` via `LOCAL=`), installs the binaries
to `$HOME/.local/bin` (override with `INSTALL_DIR`), and copies the skill to
`$HOME/.agents/skills/stellario` (override `SKILL_DIR`). Note: it does **not**
verify the published `.sha256` file.

## Runtime architecture

### Storage plane — Automerge capsule (truth)

- Capsules live at `~/.stellario/projects/<capsule>/<hostname>/capsule.automerge`.
  The device segment is the machine's hostname, so capsules are per-device.
- The atom is a **version**, not an entry. `Version` has a content-addressed
  `hash` over `(content + tags + keywords)`; the full address is
  `volume:id:hash`. An `Entry` is a materialized view: the latest
  non-superseded version for an id.
- An id is `volume:n` (e.g. `active:65`, `task:238`). The legacy prefix-encoded
  id (`a65`, `m03`) was abolished in the migration.
- Every write emits a required `intent` on a vertical parent edge, plus
  optional horizontal typed edges (`Supersede`, `DeriveFrom`, `Validate`,
  `Constrain`). Storage generates the id and enforces the volume's
  `IdStrategy` and `SupersedePolicy`; the caller never picks an id.
- One Automerge document per project: `versions` (hash → Version), `volumes`
  (volume → id → [hashes]), `volumedefs`, `edges`.
- Capsules **emerge** from sync targeting them — there is no create ceremony.
  `ensure_capsule` creates one lazily on first use.
- `stellario-migrate` is the phase-0 risk gate: JSONL → Automerge with strict
  integrity verification (`--dry-run` first; dangling manual refs fail unless
  `--allow-dangling-manual`).

### Index plane — sqlite-vec (derived, rebuildable)

- Default path `~/.stellario/index.db`; override with `--index` or
  `STELLA_INDEX`. The intent log is `~/.stellario/intent-log.jsonl`.
- Two entry kinds share one retrieval space: `repo` (harvested `<stellario>`
  blocks) and `memory` (capsule entries).
- Embedded vectors are for **keywords only** — content is never embedded
  (that would be RAG). Model: `AllMiniLML6V2`, 384-dim via `fastembed`, the
  same ONNX weights as the old TS pipeline. Embedding is lazy-loaded, and the
  weights are cached at `~/.stellario/models` (override with
  `FASTEMBED_CACHE_DIR` or `HF_HOME`); if the model is unavailable, search
  degrades gracefully to fzf-only.
- Authority discipline: the index can be deleted and rebuilt from capsule +
  repo at any time. Corruption is a non-event.

### Edit plane — files (transient)

- `.stella/` under a repo holds native entries; `<slug>.<star>` files are star
  drafts (loose, gitignored, no grammar discipline).
- The shape rule: a directory's stellario semantics come from its own layout.
  `.stellario` + `.stella/` = self-declared home (`stella sync` is automatic);
  only `.stella/` = staging shape (`stella sync --capsule X`, defaulting to the
  `scratch` inbox). `config::discover` walks up like git.

### Identity

- Identity is an entry in the `identity` volume of the global capsule,
  addressed `name:<agent>`. Selecting an identity mints an ephemeral instance
  `name:<agent>#<hash>` and returns the identity's meta (recall bootstrap).

### MCP

- `stellario-mcp` is **not** an operations server. Its single tool reports CLI
  readiness (binary path, capsules, usage guide) so frontends without a shell
  learn the CLI exists; all real work then goes through `stella` via Bash.

## CLI surface

`stella` and `stellario` are the same binary (argv[0] is not inspected).
Global flags: `--capsule`, `--index`.

```
stella "query" "intent"        hybrid search. INTENT IS MANDATORY.
                               Missing intent prints an error and exits 2.
                               --repo/--memory filter kind; --stars and
                               --sealed include excluded forms; --limit (20).
stella show <id>               one entry (slug or volume:id)
stella lint <paths>            grammar check; NO --fix. Exits 1 on errors.
stella sync [--repo P] [--reindex-memory] [--status]
                               shape-aware write loop
stella doctor [--level L]      graded health (error|warning|info). Read-only.
                               Exits 1 if any error-level finding.
stella migrate <ids> --to <cap> [--from <cap>]
stella archive <ids>           seal legacy out of default search (copy →
                               archived volume + in-place `> Superseded by …`)
stella export --out <dir>      capsule → <out>/<volume>/<id>.md + manifest.jsonl
stella cluster <volume>        design-thread candidates for distillation
stella list | volumes | lineage <id>
stella search "q"              legacy telescope surface (fzf + semantic)
```

Conventions baked into the code:

- Query is the primary verb (`stella "dumb pipe" "why the VM stays dumb"`).
- `stella ... | head` must not panic: `cli::run` resets SIGPIPE to default via
  `libc` before parsing.
- Hints (max 3, deterministic, read-only) prefix query/show output; they are
  buttons, never auto-executed.

## Entry format

A memory entry is a `<stellario>` block inside host comments (`//!`, `///`,
`//` in `.rs` and `.go`) or raw markdown (`.stella` files are markdown-shaped).
Key fields: `header` (required, `slug — tldr.`, 3–5 lowercase hyphenated
words, em-dash separator — `: ` breaks YAML plain scalars), `binding`
(`embed` | `cascade`; required except in native files), `tags`, `keywords`,
`walls` (typed bullets: `not:` / `traps:` / `warning:`), `refs`, `chain`,
`codemap`, `author`, `auto`.

Rules to respect:

- Block content is **English-only** (the retrieval substrate is
  English-centric). Prose outside the block may be any language.
- `auto` is lint-owned (`<hash> at <commit-time>`); never hand-write it. Lint
  is the one thing allowed to write, and it prints a notice.
- `stella sync` enforces the lint gate: a `.stella` file with error-level
  grammar violations is skipped, not ingested.
- Full spec: `skills/stellario/references/grammar.md`; authority rules:
  `skills/stellario/references/authority.md`.

## Code organization (`engine-rs/src`)

Module doc comments (`//!`) carry the design rationale, often citing the
relevant proposal filename. They are the primary onboarding material.

| Module | Responsibility |
|---|---|
| `lib.rs` | Crate root; re-exports the public surface; declares all modules. |
| `model.rs` | `Version` / `Edge` / `EdgeKind` / `Entry` / `VolumeDef` / `IdStrategy` / `SupersedePolicy`. |
| `storage.rs` | `Storage` trait + `AutomergeStorage`. The only mutation path; owns content-addressing, parent-edge auto-linking, id generation, supersede enforcement. |
| `index.rs` | sqlite + sqlite-vec derived index; ingest, scoped replace, knn, intent log, `is_sealed`. |
| `parse.rs` | Two-phase `<stellario>` parser (host comment stripping → zone extraction). Syntax only. |
| `lint.rs` | Grammar rules + driver, repair suggestions. Owns the `auto` field. |
| `harvest.rs` | Repo → index (walk `.rs`/`.go`/`.md`), and `.stella` natives → capsule (`mirror_natives_to_capsule`). |
| `telescope.rs` | Hybrid search core: fzf weighted substrings (id ×10, tag/slug ×6, keyword ×5, content ×3) fused with semantic cosine (×0.5). |
| `hints.rs` | The read-only guide layer on top of query/show. Relevance-gated, max 3. |
| `govern.rs` | Governance plane: `doctor` (graded check) + `migrate` (relocation with provenance) + `archive` (seal out of default retrieval). |
| `migrate.rs` | JSONL → Automerge migration. |
| `constellation.rs` | `.stella/` family discovery, star names, hygiene reports. |
| `identity.rs` | Agent identity registration/selection. |
| `cluster.rs` | Design-thread clustering for layer-scale distill (hard supersede signals, soft shared-keyword signals). |
| `export.rs` | Capsule → files (legacy-exit primitive). |
| `config.rs` | `.stellario` parsing + upward discovery + staging-shape detection. |
| `cli.rs` | clap definition + `run()`; USAGE_GUIDE; all command dispatch. |
| `bin/` | `stella.rs` and `stellario.rs` (both call `cli::run`), `mcp.rs`, `migrate.rs`. |

Storage-layer names are volume-based (not entry-based) on purpose; keep new
primitives operation-shaped rather than entry-shaped.

## Development conventions

- **Documentation style.** This codebase uses long module-level `//!` comments
  as design prose. New modules should follow suit: state the layer, the
  authority rule, and the invariants. Keep comments in sync with behavior when
  you change it.
- **Commit messages.** Conventional-commit style with a scope, then a
  sentence-style summary, often with an em-dash subclause. Observed scopes:
  `stella`, `skill`, `govern`, `parse`, `cluster`, `docs`, `build`, `test`,
  `fix`, `feat`, `chore`. Examples:
  `feat(stella): cluster — design-thread identification for layer-scale distill`,
  `fix(skill): quote description — the unquoted ": " broke frontmatter`.
- **No `--fix` philosophy.** Lint reports; it never rewrites human content. Any
  new tooling should follow the check → suggest → explicit-act shape.
- **Errors.** `anyhow::Result` throughout; `Context` for path/IO messages.
- **Rust edition** 2021; there is no `rustfmt.toml`, `clippy.toml`, or
  toolchain pin — use a current stable toolchain.
- **Safety surface.** The only deliberate `unsafe` is the SIGPIPE reset in
  `cli.rs` (`--version`, `-v` and `version` are also handled).
- **Self-hosting.** This repo carries its own `.stellario` (→ capsule
  `stellario-dev`) and `.stella/` entries. After changing behavior, refresh the
  memory when relevant; the project is meant to be queried with itself:
  `stella "constellation" "our own design"`.

## Testing

- Unit tests are colocated `#[cfg(test)] mod tests` blocks inside the modules
  (`engine-rs/src/`), not a separate `tests/` directory in the crate. Run with
  `cd engine-rs && cargo test -p stellario-engine` (also `make check`). As of
  this writing: 63 tests, all passing (~0.3s after build).
- Tests lean on temp dirs and temp index files; they do not require network.
  Semantic embedding tests tolerate the model being unavailable.
- The legacy `tests/*.ts` (vitest) do not run — see the legacy section.
- Before calling work done, run the full `cargo test -p stellario-engine`. If
  you changed the CLI, also exercise the real binary end-to-end (e.g. `stella
  lint`, `stella sync` in a scratch dir) rather than only unit tests.

## Security and authority considerations

- Everything is local and file-based. The tool reads/writes the user's repo and
  `$HOME/.stellario/` (capsules, index, intent log). It is not a sandbox and
  has no permission boundary — the only network use is the one-time
  `fastembed` model download on first semantic search.
- **Authority by residence.** The file is truth for inline embeds; the capsule
  is truth for natives. The index is a derived copy — never treat index
  contents as authoritative.
- `doctor` and `lint` exit non-zero on error-level findings, which makes them
  usable as gates.
- `migrate`, `archive`, and `sync` mutate capsules (migrate tombstones the
  source with intent; archive seals the source in place and copies it to the
  `archived` volume; provenance stays in lineage) — treat them as
  state-changing.
- `install.sh` downloads a release tarball over HTTPS from GitHub but does not
  verify the accompanying `.sha256`; check it manually if you need integrity.
- The MCP server exposes no read/write operations, only a readiness notice.

## Where to look first

- Product behavior and install: `README.md`, `skills/stellario/SKILL.md`.
- Entry grammar: `skills/stellario/references/grammar.md`.
- Design rationale: `docs/proposals/` — start with `constellation-model.md`
  (naming/grouping, star drafts), `evolution-graph-memory-history.md` (version
  graph, intent), `automerge-storage-architecture.md` (storage plane), and
  `capsule-sync-execution-model*.md` (cross-device sync, plus its reviews).
- Release history and breaking changes: `CHANGELOG.md`.
