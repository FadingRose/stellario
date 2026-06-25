# API Reference

Module-level reference for all Stellario exports.

---

## `stellario/types`

Core type definitions and behavioral logic.

### Types

#### `Profile`

```typescript
type Profile = "mutable" | "append" | "scratch" | "frozen" | "workspace"
```

Volume behavioral profile. See [concepts.md](concepts.md) for behavioral dimensions.

#### `ProfileBehavior`

```typescript
interface ProfileBehavior {
  canRevise: boolean      // can entries be revised?
  canForget: boolean      // can entries be deleted/archived?
  isTracked: boolean      // is the volume git-tracked?
  hasStableId: boolean    // do entries use sequential IDs?
  tracksActive: boolean   // does this volume track active entry?
}
```

#### `Authority`

```typescript
type Authority = "source" | "curated" | "synthesized"
```

Semantic label. Does not drive behavior.

#### `Boundaries`

```typescript
interface Boundaries {
  read: string[]    // agent names or ["all"]
  write: string[]   // agent names or ["all"]
}
```

#### `VolumeDef`

```typescript
interface VolumeDef {
  profile: Profile
  boundaries: Boundaries
  authority?: Authority
  requiredTagPrefix?: string
  idPrefix?: string
}
```

#### `AgentDef`

```typescript
interface AgentDef {
  display: string
  role?: "primary" | "subagent"
}
```

#### `StellarioConfig`

```typescript
interface StellarioConfig {
  memoryDir?: string
  volumes: Record<string, VolumeDef>
  agents: Record<string, AgentDef>
  tags?: TagConfig
  embedding?: EmbeddingConfig
  lsp?: Record<string, any>
}
```

#### `EmbeddingConfig`

```typescript
interface EmbeddingConfig {
  enabled?: boolean | "auto"
  model?: string    // default: "Xenova/all-MiniLM-L6-v2"
}
```

#### `MountRef`

```typescript
interface MountRef {
  project: string        // source project name in global library
  source_volume: string  // source volume name
  source_path: string    // absolute path to source JSONL
  mounted_at: string     // ISO timestamp
}
```

Native mount reference — stored in `volumes.jsonl`, injected into `config.volumes` as frozen/readonly by `resolveContext`. No symlinks involved.

#### `MemoryEntry`

```typescript
interface MemoryEntry {
  id: string
  volume: string
  content: string
  tags: string[]
  keywords: string[]
  author: string
  created: string      // YYYY-MM-DD
  updated: string      // YYYY-MM-DD
  refs?: MemoryRef[]
  archived_at?: string
  archived_reason?: string
}
```

#### `MemoryRef`

```typescript
interface MemoryRef {
  target: string   // referenced entry ID
  reason: string   // why this entry references the target
  source: "manual" | "auto"
}
```

#### `VolumeIndexEntry`

```typescript
interface VolumeIndexEntry {
  volume: string
  files: string[]
  next_nonce: number
  active_workspace?: string
  active_workspaces?: Record<string, string>
  mount?: MountRef   // present if this is a native mount entry
}
```

#### `ToolContext`

```typescript
interface ToolContext {
  directory: string    // absolute path to project root
  agent: string        // agent identity string
}
```

### Functions

#### `profileBehavior(profile: Profile): ProfileBehavior`

Resolve behavioral flags for a given profile.

```typescript
import { profileBehavior } from "stellario/types"

profileBehavior("mutable")
// { canRevise: true, canForget: true, isTracked: true, hasStableId: true, tracksActive: false }

profileBehavior("scratch")
// { canRevise: true, canForget: true, isTracked: false, hasStableId: false, tracksActive: false }
```

#### `canCreate(profile: Profile): boolean`

Check if a profile allows new entries. Returns `true` for all profiles except `frozen`.

```typescript
canCreate("mutable")   // true
canCreate("frozen")    // false
canCreate("scratch")   // true
```

---

## `stellario/config`

Configuration loading and querying.

#### `loadConfig(searchFrom: string): StellarioConfig`

Load and validate `stellario.yaml`. Searches upward from `searchFrom` until the config file is found.

```typescript
import { loadConfig } from "stellario/config"

const config = loadConfig("/home/user/my-project")
```

**Throws** if:
- No `stellario.yaml` found
- Required fields are missing
- Unknown profile values

#### `validateConfig(raw: unknown): StellarioConfig`

Validate a parsed YAML object. Called internally by `loadConfig`.

#### `getVolumeIdPrefix(config: StellarioConfig, volume: string): string`

Get the ID prefix for a volume. Falls back to first character of volume name.

```typescript
getVolumeIdPrefix(config, "handover")  // "h"
getVolumeIdPrefix(config, "meta")      // "m"
```

#### `getMemoryDir(config: StellarioConfig, projectRoot: string): string`

Resolve the absolute memory directory path.

```typescript
getMemoryDir(config, "/home/user/my-project")
// "/home/user/my-project/.stellario"
```

#### `getTrackedVolumes(config: StellarioConfig): string[]`

Get all volume names that are git-tracked (profiles: mutable, append, frozen, workspace).

```typescript
getTrackedVolumes(config)
// ["meta", "active", "handover", "layer"]
```

#### `getWorkspaceVolume(config: StellarioConfig): string | null`

Get the name of the workspace volume, or `null` if none exists.

```typescript
getWorkspaceVolume(config)  // "layer"
```

---

## `stellario/store`

JSONL storage engine.

### Reading

#### `readJsonl(memDir: string, volume: string): MemoryEntry[]`

Read all entries for a volume. Supports index-aware multi-file volumes and single-file fallback.

```typescript
const entries = readJsonl("/path/.stellario", "active")
console.log(entries.length)  // 42
```

Returns an empty array if the volume has no data file.

#### `readVolumeIndex(memDir: string): VolumeIndexEntry[]`

Read the volume index (`volumes.jsonl`).

```typescript
const index = readVolumeIndex("/path/.stellario")
for (const entry of index) {
  console.log(entry.volume, entry.next_nonce, entry.active_workspace)
}
```

#### `findEntry(memDir: string, id: string, config: StellarioConfig): { entry: MemoryEntry, volume: string } | null`

Find an entry by ID across all volumes. Uses ID prefix for fast lookup, then falls back to exhaustive search including `archived`.

```typescript
const result = findEntry(memDir, "a42", config)
if (result) {
  console.log(result.entry.id, "found in", result.volume)
}
```

### Writing

#### `writeEntries(memDir: string, volume: string, entries: MemoryEntry[], config: StellarioConfig): void`

Write the complete entry list for a volume (overwrites existing). Regenerates companion `.md` file for tracked volumes.

```typescript
const entries = readJsonl(memDir, "active")
entries.push(newEntry)
writeEntries(memDir, "active", entries, config)
```

**Note**: This is a full overwrite, not append. Always `readJsonl` first, modify, then `writeEntries`.

### ID Generation

#### `generateNextId(memDir: string, volume: string, config: StellarioConfig): string`

Generate the next available ID for a volume.

- **Stable profiles** (mutable, append, frozen, workspace): prefix + sequential nonce — `a01`, `h03`, `l12`
- **Scratch profile**: prefix + 4-char random hash — `d7f3a`

```typescript
generateNextId(memDir, "active", config)   // "a43"
generateNextId(memDir, "drafting", config) // "db8f2"
```

Bumps the `next_nonce` in `volumes.jsonl` atomically.

### Workspace

#### `getActiveWorkspace(memDir: string, workspaceVolume: string): string | null`

Get the active workspace entry ID. Returns `null` if not set.

```typescript
getActiveWorkspace(memDir, "layer")  // "l05"
```

#### `setActiveWorkspace(memDir: string, workspaceVolume: string, id: string): void`

Set the active workspace entry ID. Updates `volumes.jsonl`.

```typescript
setActiveWorkspace(memDir, "layer", "l05")
```

### Utilities

#### `extractTitle(content: string): string`

Extract the first `##` heading from content, or fall back to first line.

```typescript
extractTitle("## Design Decision\nWe chose SQLite.")
// "Design Decision"
```

#### `truncate(s: string, maxChars: number): string`

Truncate with ellipsis character.

```typescript
truncate("A very long string...", 10)  // "A very lo…"
```

#### `dedupeTags(tags: string[]): string[]`

Deduplicate tags (case-insensitive).

```typescript
dedupeTags(["type:design", "type:Design", "role:stellario"])
// ["type:design", "role:stellario"]
```

#### `today(): string`

Current date as `YYYY-MM-DD` string.

---

## `stellario/permissions`

Config-driven permission engine.

#### `resolveAgent(agentStr: string, config: StellarioConfig): string | null`

Normalize an agent string to a known agent name. Case-insensitive with partial matching.

```typescript
resolveAgent("Stellario", config)  // "stellario"
resolveAgent("unknown-agent", config)  // null
```

#### `canRead(agent: string, volume: string, config: StellarioConfig): boolean`

Check if an agent can read a volume.

```typescript
canRead("chronicler", "meta", config)   // false
canRead("chronicler", "active", config) // true (read: [all])
```

#### `canWrite(agent: string, volume: string, config: StellarioConfig): boolean`

Check if an agent can write to a volume. Respects profile restrictions (e.g., frozen rejects all).

```typescript
canWrite("stellario", "active", config)    // true
canWrite("executor", "active", config) // false
```

#### `canRevise(volume: string, config: StellarioConfig): boolean`

Check if a volume's profile allows revisions.

```typescript
canRevise("active", config)   // true (mutable)
canRevise("handover", config) // false (append)
```

#### `canForget(volume: string, config: StellarioConfig): boolean`

Check if a volume's profile allows forgetting (archiving).

```typescript
canForget("active", config)   // true (mutable)
canForget("handover", config) // false (append)
```

#### `isAuthor(agent: string, entryAuthor: string): boolean`

Check if an agent is the author of an entry. Case-insensitive.

```typescript
isAuthor("stellario", "Stellario") // true
```

#### `readableVolumes(agent: string, config: StellarioConfig): string[]`

Get all volumes an agent can read.

```typescript
readableVolumes("executor", config)
// ["active", "archived"]
```

#### `writableVolumes(agent: string, config: StellarioConfig): string[]`

Get all volumes an agent can write to (excluding frozen).

```typescript
writableVolumes("stellario", config)
// ["meta", "active", "handover", "layer", "drafting"]
```

#### `canCrossStory(agent: string, config: StellarioConfig): boolean`

Check if an agent can search across all stories. Only the first listed agent has this privilege.

```typescript
canCrossStory("stellario", config)  // true (first agent)
canCrossStory("chronicler", config)  // false
```

---

## `stellario/git`

Git integration for version-controlled volumes + auto sync.

#### `gitCommit(memDir: string, volume: string, message: string, config: StellarioConfig, entryIds?: string[]): string | null`

Stage and commit a volume's JSONL + MD files. After commit, attempts `gitPush` (tolerates network failure silently). Returns short commit hash on success, `null` if skipped (untracked volume) or failed.

Only commits volumes with `isTracked: true` in their profile.

```typescript
const hash = gitCommit(memDir, "active", "create: new design decision", config)
// "a3f2b1c"  (also auto-pushes to remote)
```

#### `gitPush(memDir: string): void`

Push commits to remote. Silently fails on network error. Called automatically after every `gitCommit`.

#### `gitPull(memDir: string): void`

Pull remote changes with rebase. Silently fails on network error. Called at session start by the plugin.

#### `isGitRepo(memDir: string): boolean`

Check if a git repo exists in the memory directory.

#### `initGitRepo(memDir: string): boolean`

Initialize a git repo if one doesn't exist. Returns `true` if created, `false` if already exists.

---

## `stellario/context`

Runtime context resolution and project detection.

#### `resolveContext(ctx: ToolContext): ResolvedContext`

Resolve the full runtime context from a `ToolContext`. Tries Go resolve first (Path A: global library), falls back to project-scoped config (Path B: legacy). Injects native mounts into `config.volumes` as frozen/readonly.

```typescript
import { resolveContext } from "stellario/context"

const resolved = resolveContext({ directory: "/home/user/project", agent: "stellario" })
// { config, projectRoot, memDir, agent, star: "Sirius", projectName: "valhalla" }
```

#### `tryGoResolve(projectRoot: string): GoResolveResult | null`

Call Go `stellario resolve --root <dir>` to find the global library location. Returns null if Go binary unavailable, project not migrated, or resolve fails. Null results expire from cache after 60s.

#### `isRustProject(projectRoot: string): boolean`

Detect if the project has a `Cargo.toml`.

#### `hasOpencodeConfig(projectRoot: string): boolean`

Detect if the project has an `.opencode/` directory.

#### `getRustCrates(projectRoot: string): string[]`

Parse workspace members from `Cargo.toml`.

---

## `stellario` (index)

Tool factories for opencode integration.

### `createMemoryTools()`

Returns 5 opencode tool instances:

```typescript
const { create, show, revise, forget, history } = createMemoryTools()
```

| Tool | Description |
|------|-------------|
| `create` | Create an entry in a volume. Auto-checks write permission. Auto-fills author and ID. |
| `show` | Read entry by ID. Shows content with line numbers. Auto-activates workspace entries. |
| `revise` | Edit content via line ranges. Manage refs. Author-only. Profile must allow revisions. |
| `forget` | Archive an entry to `archived` volume. Author-only. Profile must allow forgetting. |
| `history` | View git revision history for an entry. |

#### `create` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `volume` | `string` | ✓ | Target volume name |
| `content` | `string` | ✓ | Entry text content |
| `tags` | `string[]` | — | Tags in `namespace:value` format |
| `keywords` | `string[]` | — | 2-5 free-form keywords |

#### `show` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` | ✓ | Entry ID to read |

#### `revise` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` | ✓ | Entry ID to edit |
| `edits` | `{ from: number, to?: number, content: string }[]` | — | Content edits (line ranges, applied back-to-front) |
| `refs_add` | `{ target: string, reason: string }[]` | — | Refs to add |
| `refs_remove` | `string[]` | — | Target IDs to remove from refs |
| `message` | `string` | ✓ | Why this edit was made |

`from`/`to` format: `from` is the first line to replace (1-indexed), `to` is the last (inclusive, defaults to `from`). Use `content: ""` to delete lines.

#### `forget` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` | ✓ | Entry ID to archive |

#### `history` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` | ✓ | Entry ID |
| `limit` | `number` | — | Max revisions (default 10) |

### `createWorkspaceTools()`

Returns 6 opencode tool instances:

```typescript
const { status, assemble, open, edit, add, remove } = createWorkspaceTools()
```

| Tool | Description |
|------|-------------|
| `status` | Show workspace overview: volume sizes, active workspace entry |
| `assemble` | Create a new workspace theme that gathers related memory entries |
| `open` | Open the active workspace theme with all gathered entries expanded inline |
| `edit` | Edit the theme's own content (description, notes) |
| `add` | Gather additional entries into the active workspace theme |
| `remove` | Remove entries from the active workspace theme (original entries unaffected) |

#### `assemble` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `content` | `string` | ✓ | Theme description (title + context) |
| `entries` | `string[]` | — | Entry IDs to gather into this theme |
| `tags` | `string[]` | — | Tags for the theme entry |
| `keywords` | `string[]` | — | 2-5 keywords for discovery |

#### `open` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `id` | `string` | — | Theme entry ID (defaults to active workspace) |

#### `edit` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `from` | `number` | ✓ | First line number to replace (1-indexed) |
| `to` | `number` | — | Last line number to replace (defaults to `from`) |
| `content` | `string` | ✓ | Replacement text |
| `message` | `string` | ✓ | Why this edit was made |
| `id` | `string` | — | Theme entry ID (defaults to active workspace) |

#### `add` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `entries` | `string[]` | ✓ | Entry IDs to gather into the theme |
| `id` | `string` | — | Theme entry ID (defaults to active workspace) |

#### `remove` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `entries` | `string[]` | ✓ | Entry IDs to remove from the theme |
| `id` | `string` | — | Theme entry ID (defaults to active workspace) |

### `createTelescopeTool()`

Returns 1 opencode tool instance:

```typescript
const { search } = createTelescopeTool()
```

| Tool | Description |
|------|-------------|
| `search` | Unified search across entries |

#### `search` args

| Arg | Type | Required | Description |
|-----|------|----------|-------------|
| `query` | `string` | — | Space-separated search terms |
| `volumes` | `string[]` | — | Volumes to search (default: all readable) |
| `tags` | `string[]` | — | AND filter: entries must have ALL these tags |
| `tags_any` | `string[]` | — | OR filter: entries must have at least ONE tag |
| `tags_not` | `string[]` | — | NOT filter: exclude entries with any of these tags |
| `limit` | `number` | — | Max results (default 20) |
| `returns` | `"entries" \| "tags" \| "keywords"` | — | Return mode (default: `"entries"`) |

**Return modes:**

- `"entries"` (default): matched entries with score, formatted as `[id] volume score — title`
- `"tags"`: enumerate unique tag values with counts, optionally filtered by `query` prefix
- `"keywords"`: enumerate unique keyword values with counts

**Special behavior:**

- No `query`, no tags → returns overview mode: entry count per volume
- `returns="tags"` + `query="role:"` → lists all tags starting with `role:`
