# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/FadingRose/stellario/compare/v0.5.0...HEAD
[0.5.0]: https://github.com/FadingRose/stellario/compare/v0.4.0...v0.5.0
[0.4.0]: https://github.com/FadingRose/stellario/compare/v0.3.0...v0.4.0
[0.3.0]: https://github.com/FadingRose/stellario/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/FadingRose/stellario/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FadingRose/stellario/releases/tag/v0.1.0
