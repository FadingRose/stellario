# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added
- **Unified tool surface** — one binary, five verb classes (query / write
  loop / lint / governance / storage). `stellario` is an alias for `stella`.
- **Agent skill** — `skills/stellario/`, the open SKILL.md format, written
  against its own 8-criterion quality framework (first skill in the wild
  with a `verified-against` freshness marker).
- **Constellation model** — native `.stella` entries, star drafts, collection,
  demotion, vacant heads; capsules emerge from sync (no create ceremony).
- **Governance** — `doctor` (graded health: error/warning/info) and
  `migrate` (relocation with provenance).
- **Capsule export** — legacy-exit primitive (`export --capsule --out`).

### Changed
- Removed the TS layer entirely; the Rust CLI is the only surface.
- Removed retired edit-loop verbs (write / expand / expand-new / delete).
- v0.1.0 -> v0.2.0 (pre-1.0; MINOR may break — API not frozen).

## [1.0.0-beta.1] - 2026-06-18

Major architecture cleanup. Breaking changes — existing configs may need updates.
This is a pre-release; `npm install stellario` still gets 0.9.1. Use `npm install stellario@beta` to opt in.

### Breaking Changes

- **System volumes (reserved keywords).** `archived`, `meta`, `handover`, `layer` are now automatically injected into every config at load time. User definitions for these names are silently overridden. System volumes are agent-isolated (runtime author filter, not permission boundaries).
- **Active workspace deprecated.** The `active` workspace pointer is removed. All workspace tools (`open`, `edit`, `add`, `remove`) now require an explicit `id`. Use the roadmap pattern instead: `type:roadmap` entries ref `type:workspace` entries; `buildStatus` renders the hierarchy on session start.
- **Display ID format.** Entry IDs are displayed as `volume:number` (e.g. `active:01`) instead of short prefix format (`a01`). `findEntry` accepts both formats; new ref targets store display format, old ref targets work via prefix derivation (natural migration).

### Added

- **Auto-refs embedding fix.** `create`/`revise` now actually read the keyword index and probe embedding availability (was hardcoded `false` with empty map). Auto-refs produce semantic similarity links when embedding is available.
- **Background index worker.** New `src/index-worker.ts` — keyword indexing is now a batched, fire-and-forget background job. Persistent `.index-pending.json` survives restarts. Search syncs pending before query for consistency. Plugin recovers interrupted work on session start.
- **Display ID namespace.** `formatDisplayId`, `toDisplayId`, `parseDisplayId`, `isDisplayId` helpers in `store.ts`. All display points (show, search, buildStatus, workspace_open, create/revise/forget output) render `volume:number` format.
- **Search empty-string sanitization.** `sanitizeOptionalString` in `telescope-defs.ts` handles opencode's `'""'` encoding of empty string args.

### Changed

- `getActiveWorkspace` / `setActiveWorkspace` removed from `store.ts`.
- `workspace_assemble` no longer auto-sets active; returns next-step hint instead.
- `idPrefix` deprecated (still functional for storage ID generation, ignored in display).
- `resolveDefaultVolume` skips all system volumes.
- `validateConfig` merges system volumes + validates idPrefix uniqueness + workspace uniqueness after merge.
- Config warnings silenced (no stdout/stderr pollution in opencode UI).

### Removed

- `getActiveWorkspace`, `setActiveWorkspace` (store.ts)
- Legacy `active_workspace` / `active_workspaces` volume index fields (stale data harmless — simply ignored)
- `updateEntryIndex` calls in memory-defs (replaced by index-worker `markPending` + `triggerFlush`)

## [0.9.0] - 2026-06-10

### Added

- **LSP integration.** Generic Language Server Protocol client for code navigation. Works with any LSP-compliant server (rust-analyzer, gopls, forge/solc). 4 new tools: `lsp_references`, `lsp_definition`, `lsp_symbols`, `lsp_call_hierarchy`.
- `src/lsp/client.ts` — Generic JSON-RPC 2.0 over stdio LSP client. Language-agnostic, singleton per server.
- `src/lsp/manager.ts` — Singleton manager with sync-readable status for `buildStatus()`. Fire-and-forget init from plugin (non-blocking).
- `src/lsp/types.ts` — LSP protocol types, client state, and config types.
- `src/defs/lsp-defs.ts` — 4 tool definitions for references, definition, symbols, call hierarchy.
- `buildStatus()` now shows LSP server status (indexing / ready / crashed).
- Plugin (`glue/plugin.ts`) triggers LSP init on session start (fire-and-forget, non-blocking).
- `stellario init` auto-detects LSP servers from project files (Cargo.toml → rust-analyzer, go.mod → gopls, *.sol → forge/solc). Missing binaries are noted as comments in yaml + install hints in console.
- `stellario init` runs a tool availability check at the end, showing which tools are installed and how to install missing ones.

- **ast-grep integration.** Structural code search via `ast-grep` CLI. Pattern-matching by AST structure, resilient to formatting changes.
- `src/defs/ast-grep-defs.ts` — `ast_grep_search` tool definition. Supports language auto-detection, path filtering, and result pagination.

- **Coordination glue.** Taskboard tools now deployable via `stellario init`.
- `glue/coordination.ts` — Standard glue file for 7 taskboard tools (plan, claim, update, complete, board, lock, unlock).
- `GLUE_FILES` mapping in `bin.js` now includes `coordination.ts`, `lsp.ts`, `ast-grep.ts`.

- **Taskboard: pending state.** New `pending` status for blocked tasks (mid-work, waiting on dependency). Transitions: `in_progress → pending → in_progress`.
- `Task.status_reason` field — optional reason attached to status changes.
- Updated transition table in `src/coord/types.ts`.

### Config

- `lsp:` section in `stellario.yaml`. Key = server name, value = `{ command, indexing }`.
- `indexing.strategy`: `timeout` (wait fixed time), `poll-symbol` (poll until indexed), `none` (ready immediately).
- `StellarioConfig.lsp` field added.
- Package exports: `stellario/defs/lsp`, `stellario/defs/ast-grep`, `stellario/lsp/*`.

## [0.8.4] - 2026-06-10

### Added

- **`pending` task status.** New lifecycle state for tasks blocked mid-work. `in_progress → pending` (blocked), `pending → in_progress` (resumed). Semantically distinct from `cancelled` — pending tasks are expected to continue.
- `status_reason` field on tasks. Optional reason attached to any status transition (e.g. "blocked by tb03", "dependency resolved"). Displayed in board and inject.
- `taskboard_update` tool accepts optional `reason` parameter.
- `pending` displayed in board (⏸ icon) and `buildStatus` inject, sorted between `in_progress` and `claimed`.

### Changed

- Task status lifecycle diagram updated:
  ```
  open → claimed → in_progress → review → done
                          ↓  ↑            ↓
                       pending        in_progress
                          ↓
                       cancelled
  ```

## [0.8.3] - 2026-06-10

### Added

- `glue/coordination.ts` — glue file for taskboard tools, enabling `stellario init` to deploy coordination tools to `.opencode/tools/` ([this commit]).
- `GLUE_FILES` mapping in `bin.js` now includes `coordination.ts` → `stellario-coordination.ts`.

## [0.8.2] - 2026-06-10

### Added

- Author filter in telescope search — filter entries by `author` field.

### Fixed

- Dynamic import in plugin (`stellario-inject.ts`) to prevent session freeze when Stellario fails to load.
- Pre-download embedding model (~22MB) during `stellario init` instead of on first search.

## [0.8.0] - 2026-06-08

### Changed

- **Wizard redesign**: two-phase flow — Demo → Setup. Phase 1 runs a self-guided demo (no user questions). Phase 2 generates agents and writes first real entries.
- `stellario init` only generates `stellario.md` guide agent; other agents are delegated to the wizard.

### Added

- Template-agnostic wizard with dynamic volume/agent selection and permissions demo.
- Handoff demo in Phase 1 + handoff prompt section in all primary agent templates.
- Shared memory demo — multi-agent collaboration via shared volumes.
- `audit` template registered in CLI `TEMPLATES` list.

### Fixed

- Use npm registry instead of GitHub ref for stellario dependency in generated `package.json`.

## [0.7.2] - 2026-06-08

### Fixed

- `bin.js` brace balance, unified `.js` imports, restructured README.

## [0.7.1] - 2026-06-08

### Fixed

- Moved `packageRoot` resolution to outer scope for config-exists path.

### Changed

- README restructured for glue architecture.
- README slimmed from 302 to 132 lines.

### Added

- Structured onboarding walkthrough in primary agent template.
- `stellario.md` guide agent always generated regardless of template.
- Audit template agent renamed `kira` → `auditor`.
- Pre-built `glue/` files shipped with package, eliminating inline templates from CLI.
- `dtype=fp32` specified for transformers to suppress warnings.

## [0.7.0] - 2026-06-03

### Added

- **Volume-level link/unlink.** New `volume-link` tools for cross-project memory observation — `discover`, `link`, `unlink`. Linked volumes appear as readonly symlinks; entries are visible via search but cannot be modified. Replaces the previous entry-level `link`/`unlink` tools (renamed to `ref`/`unref`).

### Fixed

- Task array fields (`paths`, `depends_on`, `tags`) normalized on read for defensive parsing.

## [0.6.1] - 2026-06-03

### Fixed

- `autoRefs` config field passthrough and refs display in `show`.
- Removed duplicate `auto:` prefix in show refs display.

## [0.6.0] - 2026-06-03

### Added

- **Git history subsystem.** Every `create`/`revise`/`forget` is auto-committed to the memory directory's git repo. `memory_history` shows full revision log with diffs.
- **Refs subsystem.** Manual `ref`/`unref` for explicit knowledge graph edges. Auto-refs engine links entries with overlapping tags/keywords.
- `meta` tool for cross-session behavioral calibration. Entries tagged `type:prompt` are auto-injected into system context on session start.
- Workspace theme tools: `assemble`, `open`, `edit`, `add`, `remove` for gathering related entries into a focused context.
- Per-agent workspace and handover isolation — each agent has its own active workspace and sees its own latest handoff.
- `revise` API simplified: `volume` parameter optional, range string replaced with `from`/`to` line numbers.

### Fixed

- `memory_revise` off-by-one error and empty content deletion bug.
- Guard against undefined `task.paths`/`depends_on`/`tags` in board rendering.
- Clarified revise tool API descriptions.

## [0.5.0] - 2026-05-30

### Added

- **Coordination layer for multi-agent sync.** New `src/coord/` module providing task board and file-level mutual exclusion, enabling multiple agents to work on the same codebase without merge conflicts ([`fdaf674`](https://github.com/FadingRose/stellario/commit/fdaf674)).
- `src/coord/types.ts` — Task lifecycle state machine (`open→claimed→in_progress→review→done`), FileLock with TTL, valid transition table.
- `src/coord/lock.ts` — Two-layer locking: advisory file lock (mkdir-atomic) for inter-process mutex on `.coord/`, plus path lock map (`locks.json`) for project file exclusions. Stale lock eviction, TTL-based auto-release.
- `src/coord/store.ts` — Task CRUD with state machine enforcement, dependency validation (can't start if deps aren't done), authorization checks (only owner can transition claimed tasks).
- `src/defs/coordination-defs.ts` — 7 new tool definitions:
  - `taskboard_plan` — create task + optional path locks
  - `taskboard_claim` — claim open task + auto-lock paths
  - `taskboard_update` — status transitions with validation
  - `taskboard_complete` — mark done + release locks
  - `taskboard_board` — view tasks + active locks
  - `taskboard_lock` — explicit file path locking
  - `taskboard_unlock` — release locks (specific paths or all)
- `buildStatus()` now includes a Taskboard section showing active tasks and file locks in the workspace dashboard.
- Export paths: `stellario/defs/coordination`, `stellario/coord/types`, `stellario/coord/lock`, `stellario/coord/store`.

### Design

- Task = intent declaration (communication protocol between agents).
- Lock = file-level mutual exclusion (enforcement mechanism).
- These are orthogonal: tasks can exist without locks, locks can exist without tasks.
- Default lock TTL: 60 minutes. Advisory lock stale timeout: 2 minutes.
- Task IDs use `tb` prefix (e.g., `tb01`, `tb02`).

## [0.4.0] - 2026-05-23

### Added

- **Semantic search via local embeddings.** Telescope search now combines fzf text matching with vector similarity for concept-level discovery. Searching "user login" finds entries about "authentication"; "container orchestration" matches "Kubernetes" — no exact keyword overlap required.
- `src/embedding.ts` — standalone embedding module using `@huggingface/transformers` with `all-MiniLM-L6-v2` (384-dim, ~22MB, English-optimized). Lazy-loaded, graceful degradation when unavailable.
- Keyword vector index: `keywords-index.jsonl` stores per-keyword embeddings. Auto-maintained on `create`/`revise`/`forget`. Auto-rebuilt on first search if empty.
- Hybrid scoring: `fzf_signal × 1.0 + semantic_score × 0.5`. Enhanced fzf weights: ID match +10, tag +6, keyword +5, content +3.
- `EmbeddingConfig` type: optional `embedding:` section in `stellario.yaml` for model selection and enable/disable. Env override: `STELLARIO_EMBEDDING=off|on`.
- `@huggingface/transformers` added as a dependency. Model downloads on first use (~22MB).
- CLI `stellario init` now generates `.gitignore` inside memory dir (excludes `keywords-index.jsonl`).
- E2E test environment and test plan at `test-repo/`.

### Performance

- Single embed: ~1.3ms. Batch embed (×12): ~0.5ms/item.
- Search at 100 entries: ~11ms. Linear scaling confirmed up to 5000 entries.
- Bottleneck is index I/O (JSON parse), not cosine computation.

### Fixed

- Memory storage path migrated from `.stellario/` to `.opencode/memory/`, ensuring data lives in the directory with its own git repo instead of polluting the host project's git history.
- Removed 12 accidentally committed memory entries from main repo history via `git-filter-repo`.
- Added `.stellario/` to `.gitignore` as a safety net.

## [0.3.0] - 2026-05-23

### Added

- Dynamic prompt injection via plugin system. `buildStatus()` extracted as reusable function; `type:prompt` entries in the meta volume are auto-injected into the system message by the `stellario-inject` plugin. Agents can revise their own prompts at runtime ([`cadff92`](https://github.com/FadingRose/stellario/commit/cadff92)).
- Agent roles. `AgentDef` gains optional `role` field (`primary | subagent`). CLI generates different frontmatter per role — primary agents get full tool access, subagents get memory tools based on volume permissions ([`d38bed0`](https://github.com/FadingRose/stellario/commit/d38bed0)).

### Fixed

- Defensive array parsing for opencode tool args serialization — opencode may pass array params as JSON strings, all tool definitions now handle this gracefully ([`79f1462`](https://github.com/FadingRose/stellario/commit/79f1462)).
- Plugin hook API corrected for `system.transform` ([`2480f12`](https://github.com/FadingRose/stellario/commit/2480f12)).
- Leftover code in workspace-defs removed, dynamic prompt injection finalized ([`1277217`](https://github.com/FadingRose/stellario/commit/1277217)).
- Clean export names in glue files ([`45f8950`](https://github.com/FadingRose/stellario/commit/45f8950)).
- YAML indentation in generated configs, all agents use `mode: primary` ([`9e20c0b`](https://github.com/FadingRose/stellario/commit/9e20c0b)).
- `bin.js` as pure JS entry point, no build step required ([`0efc46b`](https://github.com/FadingRose/stellario/commit/0efc46b)).

## [0.2.0] - 2026-05-23

### Changed

- **Architecture refactor**: `src/tools/` renamed to `src/defs/`. Tools no longer call `tool()` from `@opencode-ai/plugin` — instead they return pure `ToolDef` objects. Stellario is now a pure library with zero runtime coupling to opencode ([`88c5c3f`](https://github.com/FadingRose/stellario/commit/88c5c3f)).
- `stellario init` CLI command generates all scaffolding inside `.opencode/` only — the project root remains completely untouched.

### Added

- CLI scaffolding generates: `stellario.yaml` config, `memory/` data dir with own git repo, `tools/stellario-*.ts` glue files, `agents/*.md` skeletons, and `plugin/stellario-inject.ts`.
- Three templates: `minimal` (1 agent, 4 volumes), `software` (3 agents, 6 volumes), `novel` (5 agents, 8 volumes).
- GitHub install source support ([`bc25ba2`](https://github.com/FadingRose/stellario/commit/bc25ba2)).

### Removed

- Direct `@opencode-ai/plugin` dependency from the library. Glue files in each project handle the binding.

## [0.1.0] - 2026-05-23

### Added

- Core type system: 5 volume profiles (`mutable`, `append`, `scratch`, `frozen`, `workspace`) with behavioral dimensions (canRevise, canForget, isTracked, hasStableId, tracksActive).
- `stellario.yaml` config loader with validation — volumes, agents, boundaries, authority, tag vocabularies.
- JSONL storage engine with volume index, multi-file support, and workspace tracking.
- Config-driven permission system: read/write/revise/forget per agent per volume.
- Git integration: auto-commit for tracked volumes.
- 5 memory tools: `create`, `show`, `revise`, `forget`, `history`.
- Workspace tool: `status` (volume stats, active workspace, latest handover, dynamic prompt).
- Telescope tool: unified search with text matching, tag filtering (`AND`/`OR`/`NOT`), and keyword enumeration modes.
- Documentation: README, API reference, configuration guide, concepts guide.

[Unreleased]: https://github.com/FadingRose/stellario/compare/v0.9.0...HEAD
[0.9.0]: https://github.com/FadingRose/stellario/compare/v0.8.4...v0.9.0
[0.8.4]: https://github.com/FadingRose/stellario/compare/v0.8.3...v0.8.4
[0.8.4]: https://github.com/FadingRose/stellario/compare/v0.8.3...v0.8.4
[0.8.3]: https://github.com/FadingRose/stellario/compare/v0.8.2...v0.8.3
[0.8.2]: https://github.com/FadingRose/stellario/compare/v0.8.0...v0.8.2
[0.8.0]: https://github.com/FadingRose/stellario/compare/v0.7.2...v0.8.0
[0.7.2]: https://github.com/FadingRose/stellario/compare/v0.7.1...v0.7.2
[0.7.1]: https://github.com/FadingRose/stellario/compare/v0.7.0...v0.7.1
[0.7.0]: https://github.com/FadingRose/stellario/compare/v0.6.1...v0.7.0
[0.6.1]: https://github.com/FadingRose/stellario/compare/v0.6.0...v0.6.1
[0.6.0]: https://github.com/FadingRose/stellario/compare/v0.5.0...v0.6.0
[0.5.0]: https://github.com/FadingRose/stellario/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/FadingRose/stellario/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/FadingRose/stellario/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/FadingRose/stellario/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FadingRose/stellario/releases/tag/v0.1.0
