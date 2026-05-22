# active

## a01

## Project Status — v0.2.0

### Current Version: 0.2.0

Stellario is at v0.2.0, a significant refactor from v0.1.0.

### Recent Milestones (git history)

- v0.1.0: Initial release — volume-based agent memory management (73ac904)
- Documentation: README + configuration guide + API reference + concepts (fcc6802)
- Agent naming: Renamed primary agent to 'stellario' across all templates (7f669e5)
- v0.2.0: Pure defs + CLI init, zero project-root intrusion (88c5c3f)
- Install source: Use github:FadingRose/stellario for npm (bc25ba2)
- CLI: bin.js as pure JS entry point, no build step (0efc46b)
- Agent roles: 1 primary (Stellario) + subagents (d38bed0)
- Fix: YAML indentation + all agents use mode: primary (9e20c0b)
- Fix: Clean export names in glue files (45f8950)

### Current State

- Core library is stable and self-dogfooding
- 3 templates: minimal, novel, software
- CLI provides `stellario init` scaffolding
- Memory tools, workspace status, and telescope search all functional
- Git history has 9 commits, project is clean

### Self-Boost Status

Memory system initialized with self-referential knowledge entries (this session). The project is now its own first user.

### Repository

- GitHub: FadingRose/stellario
- License: MIT
- Dependencies: yaml, zod (runtime), tsx, typescript (dev)

tags: ``
author: stellario

---

## a02

## Module API Quick Reference

### stellario/config
- loadConfig(projectRoot): StellarioConfig
- validateConfig(raw, path): StellarioConfig (internal)
- getWorkspaceVolume(config): string | null
- getTrackedVolumes(config): string[]
- getVolumeIdPrefix(config, volume): string
- getMemoryDir(config, projectRoot): string

### stellario/store
- readJsonl(memDir, volume): MemoryEntry[]
- writeEntries(memDir, volume, entries, config): void
- generateNextId(memDir, volume, config): string
- findEntry(memDir, id, config): { entry, volume } | null
- getActiveWorkspace(memDir, workspaceVolume): string | null
- setActiveWorkspace(memDir, workspaceVolume, id): void
- readVolumeIndex(memDir): VolumeIndexEntry[]
- extractTitle(content): string
- truncate(s, maxChars): string
- today(): string
- dedupeTags(tags): string[]

### stellario/permissions
- resolveAgent(agentStr, config): string | null
- canRead(agent, volume, config): boolean
- canWrite(agent, volume, config): boolean
- canCreate(volume, config): boolean
- canRevise(volume, config): boolean
- canForget(volume, config): boolean
- isAuthor(agent, entryAuthor): boolean
- readableVolumes(agent, config): string[]
- writableVolumes(agent, config): string[]
- canCrossStory(agent, config): boolean

### stellario/git
- gitCommit(memDir, volume, message, config): string | null
- isGitRepo(memDir): boolean
- initGitRepo(memDir): boolean

### stellario/context
- resolveContext(ctx): ResolvedContext
- isRustProject(projectRoot): boolean
- hasOpencodeConfig(projectRoot): boolean
- getRustCrates(projectRoot): string[]

### stellario (index)
- getMemoryToolDefs(): Record of create, show, revise, forget, history
- getWorkspaceToolDefs(): Record of status
- getTelescopeToolDefs(): Record of search

tags: ``
author: stellario

---
