# Configuration Guide

Stellario is configured via a single `stellario.yaml` file at the project root. This file defines:

- Where memory data is stored
- What volumes exist and how they behave
- What agents exist and what they can access
- Optional tag vocabulary constraints

## Minimal Example

```yaml
memoryDir: ".stellario"

volumes:
  active:
    profile: mutable
    boundaries:
      write: [stellario]
      read: [all]
  archived:
    profile: frozen
    boundaries:
      read: [all]

agents:
  stellario:
    display: "Stellario"
```

This gives you a single agent with a writable `active` volume and a read-only `archived` volume.

## Full Schema

```yaml
# ─── Top Level ──────────────────────────────────────────────────────────────

# Optional. Directory for JSONL data, relative to project root.
# Default: ".stellario"
memoryDir: ".writer-memory"

# Required. Volume definitions. Key = volume name (lowercase, no spaces).
volumes:
  <name>:
    # Required. Behavioral profile.
    profile: mutable | append | scratch | frozen | workspace

    # Required. Access boundaries.
    boundaries:
      write: [<agent>, ...] | [all]
      read: [<agent>, ...] | [all]

    # Optional. Semantic authority label. Does NOT drive behavior.
    authority: source | curated | synthesized

    # Optional. Custom ID prefix character(s).
    # Default: first character of volume name.
    idPrefix: "h"

    # Optional. Enforce that all entries must have at least one tag
    # starting with this prefix.
    requiredTagPrefix: "lore:"

# Required. Agent definitions. Key = agent name (lowercase, no spaces).
agents:
  <name>:
    # Required. Human-readable name shown in tool output.
    display: "Agent Name"

# Optional. Tag vocabulary configuration.
tags:
  # Allowed tag namespaces (e.g., ["work", "role", "type"]).
  namespaces: [string, ...]

  # Closed vocabulary for type:* tags.
  typeValues: [string, ...]
```

## Field Reference

### `memoryDir`

- **Type**: `string`
- **Default**: `".stellario"`
- **Required**: No

Path to the memory data directory, relative to the project root. Stellario creates JSONL files and a `volumes.jsonl` index here.

Common choices:
- `.stellario` — default, works for most projects
- `.writer-memory` — Lilac convention for fiction projects
- `.memory` — generic alternative

The directory is automatically created on first write. If the volume profile is `scratch`, the directory is excluded from git tracking.

### `volumes`

- **Type**: `Record<string, VolumeDef>`
- **Required**: Yes
- **Minimum**: 1 volume

Each key is a volume name. Names should be lowercase with no spaces. Names are used in tool arguments and file names.

#### `profile`

- **Type**: `"mutable" | "append" | "scratch" | "frozen" | "workspace"`
- **Required**: Yes

Determines the behavioral profile of the volume. See [concepts.md](concepts.md) for detailed behavioral dimensions.

| Profile | Create | Revise | Forget | Git-tracked | ID Style | Active Tracking |
|---------|--------|--------|--------|-------------|----------|-----------------|
| `mutable` | ✓ | ✓ | ✓ | ✓ | sequential | — |
| `append` | ✓ | — | — | ✓ | sequential | — |
| `scratch` | ✓ | ✓ | ✓ | — | ephemeral hash | — |
| `frozen` | — | — | — | ✓ | sequential | — |
| `workspace` | ✓ | ✓ | ✓ | ✓ | sequential | ✓ |

**When to use each:**

| Profile | Use case |
|---------|----------|
| `mutable` | Design docs, decisions, knowledge base — anything that evolves |
| `append` | Handoff logs, audit trails — entries that must never be edited |
| `scratch` | Drafts, experiments, temporary notes — throwaway work |
| `frozen` | Archive destination — entries land here via `forget` |
| `workspace` | Context Layer — the agent's current task workspace |

**Only one `workspace` volume is allowed.** If multiple are defined, the first one wins.

#### `boundaries`

- **Type**: `{ read: string[], write: string[] }`
- **Required**: Yes

Controls which agents can access the volume.

```yaml
boundaries:
  write: [stellario, chronicler]  # only these agents can write
  read: [all]                    # all agents can read
```

**Special values:**

| Value | Meaning |
|-------|---------|
| `[all]` | All defined agents have access |
| `[]` | No agent has access (useful for future volumes) |

**Interaction with profiles:**

Profile restrictions are applied **on top of** boundaries. For example:
- A `frozen` volume rejects all writes even if `write: [all]`
- An `append` volume allows creates but rejects revisions even for listed agents

#### `authority`

- **Type**: `"source" | "curated" | "synthesized"`
- **Required**: No

Semantic label describing the epistemological nature of the content:

| Authority | Meaning | Example |
|-----------|---------|---------|
| `source` | Raw material from external input | User conversations, scraped data |
| `curated` | Human-judged, high-value knowledge | Design decisions, conventions |
| `synthesized` | Agent-derived, rebuildable from source | Generated lore, extracted summaries |

**This field does NOT drive any system behavior.** It's a semantic annotation that agents can use to reason about content provenance in their prompts.

#### `idPrefix`

- **Type**: `string`
- **Default**: first character of the volume name
- **Required**: No

Custom prefix for entry IDs in this volume.

```yaml
volumes:
  handover:
    profile: append
    idPrefix: "h"     # IDs: h01, h02, h03, ...
    boundaries:
      write: [stellario]
      read: [stellario]
```

If omitted, the default is `volumeName.charAt(0)`. Make sure prefixes are unique across volumes to avoid ID collisions (Stellario does not enforce this — it's your responsibility).

**Common conventions:**

| Volume | Default prefix | Custom override |
|--------|---------------|-----------------|
| meta | `m` | — |
| active | `a` | — |
| handover | `h` | — |
| layer | `l` | — |
| drafting | `d` | — |
| lore | `l` | `s` (if layer also exists) |
| animus | `a` | `n` (if active also exists) |

#### `requiredTagPrefix`

- **Type**: `string`
- **Required**: No

Enforces that all entries in this volume must have at least one tag starting with this prefix.

```yaml
volumes:
  lore:
    profile: mutable
    requiredTagPrefix: "lore:"
    boundaries:
      write: [worldbuilder]
      read: [all]
```

When `create` is called without a matching tag, the tool returns an error. This prevents entries from being filed without proper categorization.

### `agents`

- **Type**: `Record<string, AgentDef>`
- **Required**: Yes
- **Minimum**: 1 agent

Each key is an agent name. Names should be lowercase with no spaces. Names are matched against the `agent` field in `ToolContext` (case-insensitive, with partial matching).

#### `display`

- **Type**: `string`
- **Required**: Yes

Human-readable name shown in tool output, error messages, and formatted displays.

```yaml
agents:
  stellario:
    display: "Stellario"    # shown as "Agent Stellario cannot write to..."
```

**Special semantics:**

The **first agent** listed in the config has a special privilege: `canCrossStory()` returns `true` for it. This is used in multi-story projects where the primary agent needs to search across all stories.

### `tags`

- **Type**: `{ namespaces?: string[], typeValues?: string[] }`
- **Required**: No

Optional tag vocabulary configuration. This is informational for agents — Stellario does not enforce tag validity at the engine level.

#### `namespaces`

Allowed tag namespace prefixes. Tags use the format `namespace:value`.

```yaml
tags:
  namespaces: [work, role, chapter, file, arc, type]
```

Valid tags: `work:origins`, `role:stellario`, `chapter:06`, `type:design`

#### `typeValues`

Closed vocabulary for `type:*` tags.

```yaml
tags:
  typeValues: [handoff, design, locked, layer, convention, polish]
```

This helps agents understand the available tag vocabulary for the `type:` namespace.

## Template Configs

Stellario ships three ready-made configs in `templates/`:

### minimal.yaml

Single agent, 4 volumes. For simple projects.

```yaml
memoryDir: ".stellario"
volumes:
  active:    { profile: mutable,  boundaries: { write: [stellario], read: [all] } }
  handover:  { profile: append,  boundaries: { write: [stellario], read: [stellario] } }
  drafting:  { profile: scratch, boundaries: { write: [stellario], read: [stellario] } }
  workspace: { profile: workspace, boundaries: { write: [stellario], read: [stellario] } }
agents:
  stellario: { display: "Stellario" }
```

### novel.yaml

5 agents, 8 volumes. Multi-agent fiction writing.

```yaml
memoryDir: ".writer-memory"
volumes:
  meta:      { profile: mutable,   authority: curated,     idPrefix: m }
  active:    { profile: mutable,   authority: curated,     idPrefix: a }
  handover:  { profile: append,    authority: curated,     idPrefix: h }
  layer:     { profile: workspace, authority: curated,     idPrefix: l }
  drafting:  { profile: scratch,   authority: curated,     idPrefix: d }
  lore:      { profile: mutable,   authority: synthesized, idPrefix: s, requiredTagPrefix: "lore:" }
  animus:    { profile: mutable,   authority: curated,     idPrefix: n }
  archived:  { profile: frozen }
agents:
  stellario:    { display: "Stellario" }
  chronicler:   { display: "Chronicler" }
  worldbuilder: { display: "Worldbuilder" }
  penna:        { display: "Penna" }
  vilicus:      { display: "Vilicus" }
tags:
  namespaces: [work, role, chapter, file, arc, type]
  typeValues: [handoff, design, locked, layer, convention, polish, role-card, foreshadow]
```

Permission matrix:

```
Agent        | meta | active | handover | layer | drafting | lore | animus
────────────────────────────────────────────────────────────────────────────
Stellario    |  W   |  W     |  W       |  W    |  W       |  -   |  -
Chronicler   |  -   |  -     |  -       |  W    |  -       |  -   |  -
Worldbuilder |  -   |  -     |  -       |  -    |  -       |  W   |  -
Penna        |  -   |  -     |  -       |  -    |  W       |  -   |  -
Vilicus      |  -   |  -     |  -       |  -    |  -       |  -   |  W
```

### software.yaml

4 agents, 6 volumes. Software development.

```yaml
memoryDir: ".stellario"
volumes:
  meta:      { profile: mutable,   idPrefix: m }
  active:    { profile: mutable,   idPrefix: a }
  handover:  { profile: append,    idPrefix: h }
  layer:     { profile: workspace, idPrefix: l }
  drafting:  { profile: scratch,   idPrefix: d }
  archived:  { profile: frozen }
agents:
  stellario: { display: "Stellario" }
  analyst:   { display: "Analyst" }
  executor:  { display: "Executor" }
  guardian:  { display: "Guardian" }
tags:
  namespaces: [module, feature, crate, file, type]
  typeValues: [handoff, design, adr, convention, layer, polish, bug, investigation]
```

Permission matrix:

```
Agent      | meta | active | handover | layer | drafting | archived
───────────────────────────────────────────────────────────────────
Stellario  |  W   |  W     |  W       |  W    |  W       |  R
Analyst    |  -   |  -     |  -       |  W    |  -       |  R
Executor   |  -   |  -     |  -       |  -    |  W       |  R
Guardian   |  -   |  -     |  -       |  -    |  -       |  R
```

### novel.yaml

5 agents, 8 volumes. Multi-agent fiction writing.

```yaml
memoryDir: ".writer-memory"
volumes:
  meta:      { profile: mutable,   authority: curated,     idPrefix: m }
  active:    { profile: mutable,   authority: curated,     idPrefix: a }
  handover:  { profile: append,    authority: curated,     idPrefix: h }
  layer:     { profile: workspace, authority: curated,     idPrefix: l }
  drafting:  { profile: scratch,   authority: curated,     idPrefix: d }
  lore:      { profile: mutable,   authority: synthesized, idPrefix: s, requiredTagPrefix: "lore:" }
  animus:    { profile: mutable,   authority: curated,     idPrefix: n }
  archived:  { profile: frozen }
agents:
  stellario:    { display: "Stellario" }
  chronicler:   { display: "Chronicler" }
  worldbuilder: { display: "Worldbuilder" }
  penna:        { display: "Penna" }
  vilicus:      { display: "Vilicus" }
tags:
  namespaces: [work, role, chapter, file, arc, type]
  typeValues: [handoff, design, locked, layer, convention, polish, role-card, foreshadow]
```

Permission matrix:

```
Agent        | meta | active | handover | layer | drafting | lore | animus
────────────────────────────────────────────────────────────────────────────
Stellario    |  W   |  W     |  W       |  W    |  W       |  -   |  -
Chronicler   |  -   |  -     |  -       |  W    |  -       |  -   |  -
Worldbuilder |  -   |  -     |  -       |  -    |  -       |  W   |  -
Penna        |  -   |  -     |  -       |  -    |  W       |  -   |  -
Vilicus      |  -   |  -     |  -       |  -    |  -       |  -   |  W
```

Permission matrix:

```
Agent       | meta | active | handover | layer | drafting | lore | animus
────────────────────────────────────────────────────────────────────────────
Maestro     |  W   |  W     |  W       |  W    |  W       |  -   |  -
Chronicler  |  -   |  -     |  -       |  W    |  -       |  -   |  -
Stellario   |  -   |  -     |  -       |  -    |  -       |  W   |  -
Penna       |  -   |  -     |  -       |  -    |  W       |  -   |  -
Vilicus     |  -   |  -     |  -       |  -    |  -       |  -   |  W
```

### software.yaml

4 agents, 6 volumes. Software development.

```yaml
memoryDir: ".stellario"
volumes:
  meta:      { profile: mutable,   idPrefix: m }
  active:    { profile: mutable,   idPrefix: a }
  handover:  { profile: append,    idPrefix: h }
  layer:     { profile: workspace, idPrefix: l }
  drafting:  { profile: scratch,   idPrefix: d }
  archived:  { profile: frozen }
agents:
  stellario: { display: "Stellario" }
  analyst:   { display: "Analyst" }
  executor:  { display: "Executor" }
  guardian:  { display: "Guardian" }
tags:
  namespaces: [module, feature, crate, file, type]
  typeValues: [handoff, design, adr, convention, layer, polish, bug, investigation]
```

Permission matrix:

```
Agent      | meta | active | handover | layer | drafting | archived
───────────────────────────────────────────────────────────────────
Stellario  |  W   |  W     |  W       |  W    |  W       |  R
Analyst    |  -   |  -     |  -       |  W    |  -       |  R
Executor   |  -   |  -     |  -       |  -    |  W       |  R
Guardian   |  -   |  -     |  -       |  -    |  -       |  R
```

Permission matrix:

```
Agent     | meta | active | handover | layer | drafting | archived
───────────────────────────────────────────────────────────────────
Lead      |  W   |  W     |  W       |  W    |  W       |  R
Analyst   |  -   |  -     |  -       |  W    |  -       |  R
Executor  |  -   |  -     |  -       |  -    |  W       |  R
Guardian  |  -   |  -     |  -       |  -    |  -       |  R
```

## Validation Rules

`loadConfig()` and `validateConfig()` enforce:

1. **At least 1 volume** — empty `volumes` is invalid
2. **At least 1 agent** — empty `agents` is invalid
3. **Valid profile** — must be one of the 5 known profiles
4. **Valid boundaries** — `read` and `write` arrays must exist
5. **Known agent references** — boundary agent names must be defined in `agents` (or `"all"`)
6. **Unique ID prefixes** — (warning only, not enforced)

## Config Loading

```typescript
import { loadConfig } from "stellario/config"

// Searches up from directory for stellario.yaml
const config = loadConfig("/path/to/project")

// Access directly
console.log(config.volumes.active.profile)  // "mutable"
console.log(config.agents.stellario.display) // "Stellario"
```

The config loader searches upward from the given directory until it finds `stellario.yaml`, then caches the result.
