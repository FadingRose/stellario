# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/),
and this project adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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

[Unreleased]: https://github.com/FadingRose/stellario/compare/v0.3.0...HEAD
[0.3.0]: https://github.com/FadingRose/stellario/compare/v0.2.0...v0.3.0
[0.2.0]: https://github.com/FadingRose/stellario/compare/v0.1.0...v0.2.0
[0.1.0]: https://github.com/FadingRose/stellario/releases/tag/v0.1.0
