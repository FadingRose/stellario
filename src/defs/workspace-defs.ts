import type { ToolContext, ToolDef, StellarioConfig, MemoryEntry, MemoryRef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead, canWrite, isAuthor } from "../permissions.js"
import { readJsonl, readVolumeIndex, extractTitle, findEntry, writeEntries, generateNextId, dedupeTags, ensureStringArray, ensureArray, today, getLinkedVolumes, getLinkedVolumeSymlinkPath, formatDisplayId, toDisplayId } from "../store.js"
import { loadConfig, getMemoryDir, getWorkspaceVolume } from "../config.js"
import { queryTasks } from "../coord/store.js"
import { getAllActiveLocks } from "../coord/lock.js"
import { getLspStatus } from "../lsp/manager.js"
import { gitCommit } from "../git.js"
import { existsSync, readFileSync } from "fs"
import { join, basename } from "path"
import { z } from "zod"

// =============================================================================
// Reusable Status Builder (used by both tool and plugin injector)
// =============================================================================

/**
 * Build the full workspace status string for a given project + agent.
 * This is the single source of truth — used by the tool AND the plugin injector.
 */
export function buildStatus(projectRoot: string, agentName: string): string {
  const config = loadConfig(projectRoot)
  const memDir = getMemoryDir(config, projectRoot)

  const lines: string[] = []
  lines.push(`Memory dir: ${memDir}`)
  lines.push(`Agent: ${agentName}`)
  lines.push("")

  if (!existsSync(memDir)) {
    lines.push("Memory: empty (not initialized)")
    lines.push("")
    lines.push("This appears to be a fresh install. If you are the primary agent, enter wizard mode: greet the user, read stellario.yaml together, and help them configure their memory system.")
    return lines.join("\n")
  }

  // ── Volume stats ──
  const volumeIndex = readVolumeIndex(memDir)
  const indexMap = new Map(volumeIndex.map(e => [e.volume, e]))
  const parts: string[] = []
  let totalEntries = 0

  for (const [name, def] of Object.entries(config.volumes)) {
    const idx = indexMap.get(name)
    let count = 0
    if (idx) {
      for (const file of idx.files) {
        const filePath = join(memDir, file)
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8")
          count += content.trim().split("\n").filter(line => line.trim()).length
        }
      }
    } else {
      const filePath = join(memDir, `${name}.jsonl`)
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8")
        count = content.trim().split("\n").filter(line => line.trim()).length
      }
    }
    totalEntries += count
    if (count > 0) parts.push(`${name}: ${count}`)
  }

  const archivedPath = join(memDir, "archived.jsonl")
  if (existsSync(archivedPath)) {
    const content = readFileSync(archivedPath, "utf-8")
    const count = content.trim().split("\n").filter(line => line.trim()).length
    totalEntries += count
    if (count > 0) parts.push(`archived: ${count}`)
  }

  if (totalEntries === 0) {
    lines.push("Memory: empty (no entries yet)")
    lines.push("")
    lines.push("This appears to be a fresh install. If you are the primary agent, enter wizard mode: greet the user, read stellario.yaml together, and help them configure their memory system.")
  } else {
    lines.push(`Volumes: ${parts.join(", ")}`)
  }

  // ── Workspaces and roadmaps ──
  const workspaceVol = getWorkspaceVolume(config)
  if (workspaceVol) {
    const allEntries = readJsonl(memDir, workspaceVol)
    // Filter to this agent's entries
    const agentEntries = allEntries.filter(e => e.author === agentName)
    // Split into roadmaps and standalone workspaces
    const roadmaps = agentEntries.filter(e => e.tags.includes("type:roadmap"))
    const workspaces = agentEntries.filter(e => e.tags.includes("type:workspace"))
    // Workspaces that belong to a roadmap (via roadmap refs)
    const roadmappedIds = new Set<string>()
    for (const r of roadmaps) {
      for (const ref of (r.refs || [])) roadmappedIds.add(ref.target)
    }
    const standaloneWorkspaces = workspaces.filter(e => !roadmappedIds.has(e.id))

    if (roadmaps.length > 0 || standaloneWorkspaces.length > 0) {
      lines.push("")
      lines.push("───")

      // Render roadmaps with their child workspaces
      for (const roadmap of roadmaps) {
        lines.push(`Roadmap: [${formatDisplayId(roadmap)}] ${extractTitle(roadmap.content)}`)
        const childIds = new Set((roadmap.refs || []).map(r => r.target))
        const children = allEntries.filter(e => childIds.has(e.id))
        for (const child of children) {
          const refCount = (child.refs || []).length
          const refStr = refCount > 0 ? ` → ${(child.refs || []).map(r => r.target).join(", ")}` : ""
          lines.push(`  [${formatDisplayId(child)}] ${extractTitle(child.content)}${refStr}`)
        }
      }

      // Render standalone workspaces (not in any roadmap)
      if (standaloneWorkspaces.length > 0) {
        if (roadmaps.length > 0) lines.push("")
        const label = roadmaps.length > 0 ? "Standalone workspaces:" : "Workspaces:"
        lines.push(label)
        for (const ws of standaloneWorkspaces) {
          const refCount = (ws.refs || []).length
          const refStr = refCount > 0 ? ` → ${(ws.refs || []).map(r => r.target).join(", ")}` : ""
          lines.push(`  [${formatDisplayId(ws)}] ${extractTitle(ws.content)}${refStr}`)
        }
      }

      lines.push("Use workspace_open(id) to expand any workspace")
    } else {
      lines.push("")
      lines.push("───")
      lines.push("Workspaces: (none)")
      lines.push(`💡 Use workspace_assemble(content="...", entries=[...]) to create one`)
    }
  }

  // ── Latest handover (append volumes, filtered by agent) ──
  const appendVolumes = Object.entries(config.volumes)
    .filter(([, def]) => def.profile === "append")
    .map(([name]) => name)

  for (const appendVol of appendVolumes) {
    const entries = readJsonl(memDir, appendVol)
    // Filter to entries authored by this agent, take the latest
    const agentEntries = entries.filter(e => e.author === agentName)
    const latest = agentEntries[agentEntries.length - 1]
    if (latest) {
      lines.push("")
      lines.push("\u2500\u2500\u2500")
      lines.push(`Latest ${appendVol}: ${latest.id} (${latest.created})`)
      lines.push(`Title: ${extractTitle(latest.content)}`)
      lines.push("")
      lines.push(latest.content)
    }
  }

  // ── Taskboard ──
  const activeTasks = queryTasks(memDir, {
    status: ["open", "claimed", "in_progress", "pending", "review"],
  })
  const activeLocks = getAllActiveLocks(memDir)

  if (activeTasks.length > 0 || activeLocks.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("Taskboard:")

    if (activeTasks.length > 0) {
      const statusOrder = ["in_progress", "pending", "claimed", "open", "review"] as const
      for (const status of statusOrder) {
        const group = activeTasks.filter(t => t.status === status)
        for (const task of group) {
          const owner = task.owner || "\u2014"
          const paths = (task.paths?.length ?? 0) > 0 ? `  ${task.paths.join(", ")}` : ""
          const reasonStr = task.status_reason ? ` — ${task.status_reason}` : ""
          lines.push(`  [${task.id}] ${status.padEnd(12)} ${owner.padEnd(14)} ${task.title}${reasonStr}`)
          if (paths) lines.push(`    ${paths}`)
        }
      }
    }

    if (activeLocks.length > 0) {
      lines.push("")
      for (const lock of activeLocks) {
        const age = formatLockAge(lock.acquired)
        const taskRef = lock.task_id ? ` \u2192 ${lock.task_id}` : ""
        lines.push(`  \U0001f512 ${lock.path} (${lock.agent}, ${age})${taskRef}`)
      }
    }
  }

  // ── Linked external volumes ──
  const linked = getLinkedVolumes(memDir, agentName)
  if (linked.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("Linked volumes:")
    for (const lv of linked) {
      let count = 0
      try {
        const symlinkPath = getLinkedVolumeSymlinkPath(memDir, lv.alias)
        const content = readFileSync(symlinkPath, "utf-8")
        count = content.trim().split("\n").filter(l => l.trim()).length
      } catch { /* broken symlink */ }
      lines.push(`  ${lv.alias} ← ${lv.source_volume} @ ${basename(lv.source_project)} (${count} entries, readonly)`)
    }
  }

  // ── LSP status ──
  const lspStatus = getLspStatus()
  if (lspStatus.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("LSP:")
    for (const entry of lspStatus) {
      const sec = Math.floor(entry.elapsedMs / 1000)
      const elapsed = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
      switch (entry.state) {
        case "ready":
          lines.push(`  ${entry.name}: ready`)
          break
        case "starting":
          lines.push(`  ${entry.name}: indexing... (${elapsed})`)
          break
        case "error":
        case "crashed":
          lines.push(`  ${entry.name}: ${entry.state}${entry.detail ? ` (${entry.detail})` : ""}`)
          break
        default:
          lines.push(`  ${entry.name}: ${entry.state}`)
      }
    }
  }

  // ── Dynamic prompt injection (type:prompt entries in meta) ──
  const metaVol = findMetaVolume(config)
  if (metaVol) {
    const metaEntries = readJsonl(memDir, metaVol)
    const promptEntries = metaEntries.filter(e =>
      e.tags.some(t => t === "type:prompt")
    )

    if (promptEntries.length > 0) {
      lines.push("")
      lines.push("\u2500\u2500\u2500")
      lines.push(`Prompt (${promptEntries.length} entries from ${metaVol}):`)
      lines.push("")
      for (const entry of promptEntries) {
        lines.push(`[${formatDisplayId(entry)}]`)
        lines.push(entry.content)
        lines.push("")
      }
    }
  }

  // ── Agent-agnostic usage guide (static, shared across all projects) ──
  lines.push("")
  lines.push("───")
  lines.push("## Stellario Memory System")
  lines.push("")
  lines.push("You have a memory system that persists across sessions. What you write now will be available in future sessions.")
  lines.push("")
  lines.push("### Core Tools")
  lines.push("")
  lines.push("| Tool | When to use |")
  lines.push("|---|---|")
  lines.push("| `create` | Write a new memory entry — design decisions, observations, conventions, handoffs |")
  lines.push("| `revise` | Update an existing entry — add detail, correct error, mark as done |")
  lines.push("| `show` | Read a specific entry by ID (with line numbers for precise editing) |")
  lines.push("| `search` | Find relevant entries — text match + semantic search + tag/keyword filters |")
  lines.push("| `workspace_assemble` | Gather related entries into a focused theme for deep context |")
  lines.push("| `workspace_open` | Expand a theme inline — see all gathered entries at once |")
  lines.push("| `workspace_status` | Dashboard: volume stats, active theme, latest handoff (you just saw this) |")
  lines.push("")
  lines.push("### Search Usage")
  lines.push("")
  lines.push("`search(query, volumes, tags, intent)` — Find entries relevant to your current task.")
  lines.push("")
  lines.push("- `query`: keywords or natural language description")
  lines.push("- `volumes`: filter to specific volumes (default: all readable)")
  lines.push("- `tags`: AND filter — entries must have ALL these tags")
  lines.push("- `intent`: (optional) describe what you're looking for — used for profiling search patterns")
  lines.push("")
  lines.push("Example: `search(query=\"auth module\", tags=[\"type:design\"], intent=\"find authentication architecture decisions\")`")
  lines.push("")
  lines.push("### Writing Entries")
  lines.push("")
  lines.push("Use markdown with `##` headings. First heading becomes the title. Add tags in `namespace:value` format.")
  lines.push("")
  lines.push("```")
  lines.push("create(volume=\"layer\", content=\"## Design: Auth Token Format\", tags=[\"type:design\", \"module:auth\"], keywords=[\"jwt\", \"token\", \"security\"])")
  lines.push("```")
  lines.push("")
  lines.push("### Handoff Discipline")
  lines.push("")
  lines.push("Before ending a session, write a handoff to the `handover` volume (append-only, immutable):")
  lines.push("")
  lines.push("```")
  lines.push("create(volume=\"handover\", content=\"## Handoff: Session Summary\\nWhat was done, what's in progress, what's blocked, what's next.\", tags=[\"type:handoff\"], keywords=[\"handoff\"])")
  lines.push("```")
  lines.push("")
  lines.push("The next session's agent will read the latest handoff to continue seamlessly.")

  return lines.join("\n")
}

/**
 * Find the meta volume name (first mutable volume named "meta", or null).
 */
function findMetaVolume(config: StellarioConfig): string | null {
  for (const [name, def] of Object.entries(config.volumes)) {
    if (name === "meta" && def.profile === "mutable") return name
  }
  return null
}

// =============================================================================
// Tool Definition
// =============================================================================

export function getWorkspaceToolDefs(): Record<string, ToolDef> {
  const status: ToolDef = {
    description:
      "Memory dashboard: volume stats, active workspace, latest handoff, and dynamic prompt. " +
      "Auto-injected via plugin on session start — only call this manually for debugging or inspection.",
    args: {},
    async execute(_args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      return buildStatus(ctx.projectRoot, agent)
    },
  }

  // ─── assemble: create a new workspace theme that gathers related entries ────

  const assemble: ToolDef = {
    description:
      "Create a workspace theme that aggregates related memory entries. " +
      "A theme is a focused context — its content describes the purpose, " +
      "and the specified entries are linked as gathered material. " +
      "Tag type:workspace for a workspace, type:roadmap for a roadmap.",
    args: {
      content: z.string().describe("Theme description (title + context). E.g. '## Authentication Refactor\nGathering all entries related to the auth module redesign.'"),
      entries: z.array(z.string()).optional().describe("Entry IDs to gather into this theme."),
      tags: z.array(z.string()).optional().describe("Tags for the theme entry. Use type:workspace or type:roadmap."),
      keywords: z.array(z.string()).optional().describe("2-5 keywords for discovery."),
    },
    async execute(args, context: ToolContext) {
      if (!args.content?.trim()) return "❌ content is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `❌ Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "❌ No workspace volume defined in config."

      if (!canWrite(agent, workspaceVol, ctx.config)) {
        return `❌ Agent "${agent}" cannot write to workspace volume "${workspaceVol}".`
      }

      // Resolve entry IDs to refs
      const entryIds = ensureStringArray(args.entries)
      const refs: MemoryRef[] = []
      for (const id of entryIds) {
        const found = findEntry(ctx.memDir, id, ctx.config)
        if (!found) return `❌ Entry "${id}" not found.`
        if (id === args.content) continue // can't reference self (not created yet, but guard)
        if (!canRead(agent, found.volume, ctx.config)) {
          return `❌ Agent "${agent}" cannot read entry "${id}" (volume: ${found.volume}).`
        }
        refs.push({ target: toDisplayId(found.entry.id, found.entry.volume), reason: `gathered in theme`, source: "manual" })
      }

      const tags = dedupeTags(ensureStringArray(args.tags))
      let keywords = ensureStringArray(args.keywords)
      keywords = [...new Set(keywords.map(k => k.trim()).filter(Boolean))]

      const id = generateNextId(ctx.memDir, workspaceVol, ctx.config)
      const entry: MemoryEntry = {
        id,
        volume: workspaceVol,
        content: args.content.trim(),
        tags,
        keywords,
        author: agent,
        created: today(),
        updated: today(),
        refs: refs.length > 0 ? refs : undefined,
      }

      const entries = readJsonl(ctx.memDir, workspaceVol)
      entries.push(entry)
      writeEntries(ctx.memDir, workspaceVol, entries, ctx.config)

      // Mark for background indexing
      if (keywords.length > 0) {
        try {
          const { markPending, triggerFlush } = await import("../index-worker.js")
          markPending(ctx.memDir, id)
          triggerFlush(ctx.memDir, ctx.config)
        } catch {}
      }

      const commitHash = gitCommit(
        ctx.memDir, workspaceVol,
        `assemble: ${extractTitle(args.content)}\n\nEntry: ${id}\nGathered: ${refs.map(r => r.target).join(", ") || "none"}\nAuthor: ${agent}`,
        ctx.config,
      )

      const lines = [
        `Assembled [${toDisplayId(id, workspaceVol)}] → ${workspaceVol}`,
        `Author: ${agent}`,
        `Gathered: ${refs.length > 0 ? refs.map(r => r.target).join(", ") : "none"}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
      ]

      // Helpful next-step hint
      const hasRoadmapTag = tags.includes("type:roadmap")
      if (hasRoadmapTag) {
        lines.push("")
        lines.push(`To add workspaces to this roadmap: ref(id="${id}", target="lXX")`)
      } else if (refs.length === 0) {
        lines.push("")
        lines.push(`To gather entries: workspace_add(entries=[...], id="${id}")`)
      }

      return lines.join("\n")
    },
  }

  // ─── open: expand a workspace, showing all gathered entries inline ──────────

  const open: ToolDef = {
    description:
      "Open a workspace theme and expand all gathered entries inline. " +
      "Unlike memory_show which only lists ref IDs, this tool shows the full content " +
      "of every gathered entry — so you see the complete picture of the theme.",
    args: {
      id: z.string().describe("Workspace entry ID to open."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "❌ open requires 'id'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `❌ Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "❌ No workspace volume defined in config."

      const found = findEntry(ctx.memDir, args.id, ctx.config)
      if (!found) return `❌ Entry "${args.id}" not found.`

      const { entry } = found

      if (!canRead(agent, found.volume, ctx.config)) {
        return `❌ Agent "${agent}" cannot read volume "${found.volume}".`
      }

      // Build output
      const lines: string[] = []
      lines.push(`\u2501\u2501\u2501 [${formatDisplayId(entry)}] ${workspaceVol} — ${extractTitle(entry.content)} \u2501\u2501\u2501`)
      lines.push("")
      lines.push(entry.content)

      const refs = entry.refs || []
      if (refs.length > 0) {
        lines.push("")
        lines.push(`\u2500\u2500\u2500 Gathered (${refs.length}) \u2500\u2500\u2500`)

        for (const ref of refs) {
          const refFound = findEntry(ctx.memDir, ref.target, ctx.config)
          if (refFound) {
            lines.push("")
            lines.push(`\u250C\u2500 [${formatDisplayId(refFound.entry)}] ${refFound.volume} — ${extractTitle(refFound.entry.content)}`)
            lines.push(`\u2502`)
            // Indent each line of the ref's content
            for (const line of refFound.entry.content.split("\n")) {
              lines.push(`\u2502 ${line}`)
            }
            lines.push(`\u2514\u2500 tags: ${refFound.entry.tags.length > 0 ? refFound.entry.tags.join(", ") : "(none)"} | ${refFound.entry.author} | ${refFound.entry.updated}`)
          } else {
            lines.push("")
            lines.push(`\u250C\u2500 [${ref.target}] — not found (may have been archived)`)
            lines.push(`\u2514\u2500 reason: ${ref.reason}`)
          }
        }
      }

      if (entry.tags.length > 0) {
        lines.push("")
        lines.push(`tags: ${entry.tags.map(t => `[${t}]`).join(" ")}`)
      }
      if (entry.keywords.length > 0) {
        lines.push(`keywords: ${entry.keywords.join(", ")}`)
      }

      return lines.join("\n")
    },
  }

  // ─── edit: revise the theme's own content ──────────────────────────────────

  const edit: ToolDef = {
    description:
      "Edit the content of the active workspace theme (description, notes, etc.). " +
      "This only changes the theme's own text — use workspace_add/remove to manage gathered entries.",
    args: {
      id: z.string().describe("Workspace entry ID to edit."),
      from: z.number().describe("First line number to replace (1-indexed)."),
      to: z.number().optional().describe("Last line number to replace. Defaults to 'from'."),
      content: z.string().describe("Replacement text."),
      message: z.string().describe("Why this edit was made."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "\u274c No workspace volume defined in config."

      let targetId = args.id
      if (!targetId) return "❌ edit requires 'id'."
      if (!args.message) return "❌ edit requires a 'message'."
      if (args.from === undefined || args.from === null) return "❌ edit requires 'from'."

      const found = findEntry(ctx.memDir, targetId, ctx.config)
      if (!found) return `\u274c Entry "${targetId}" not found.`

      const { entry, volume } = found

      if (!canWrite(agent, volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${volume}".`
      }
      if (!isAuthor(agent, entry.author || "")) {
        return `\u274c Only the author can edit. (author: ${entry.author || "unknown"})`
      }

      // Apply content edit using from/to
      const lines = entry.content.split("\n")
      const totalLines = lines.length

      const f = args.from
      const t = args.to ?? f
      if (f < 1 || t < 1 || f > totalLines || t > totalLines) return `\u274c Line range ${f}-${t} out of range (1-${totalLines}).`
      if (f > t) return `\u274c Invalid range: from (${f}) > to (${t}).`

      const replacementLines = args.content === "" ? [] : args.content.split("\n")
      lines.splice(f - 1, t - f + 1, ...replacementLines)

      const newContent = lines.join("\n")
      const updatedEntry: MemoryEntry = { ...entry, content: newContent, updated: today() }

      const entries = readJsonl(ctx.memDir, volume)
      const idx = entries.findIndex(e => e.id === entry.id)
      if (idx === -1) return `\u274c Entry "${entry.id}" not found in ${volume}.`
      entries[idx] = updatedEntry
      writeEntries(ctx.memDir, volume, entries, ctx.config)

      gitCommit(ctx.memDir, volume, `workspace edit: ${args.message}\n\nEntry: ${entry.id}\nLines: ${f}-${t}`, ctx.config)

      return `Edited [${formatDisplayId(entry)}] lines ${f}-${t}`
    },
  }

  // ─── add: gather entries into the active workspace theme ────────────────────

  const add: ToolDef = {
    description:
      "Gather one or more memory entries into a workspace theme. " +
      "The entries will appear when you workspace_open the theme.",
    args: {
      entries: z.array(z.string()).describe("Entry IDs to gather into the workspace."),
      id: z.string().describe("Workspace entry ID to add into."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "\u274c No workspace volume defined in config."

      const entryIds = ensureStringArray(args.entries)
      if (entryIds.length === 0) return "\u274c 'entries' must contain at least one entry ID."

      let targetId = args.id
      if (!targetId) return "❌ add requires 'id'."

      const found = findEntry(ctx.memDir, targetId, ctx.config)
      if (!found) return `❌ Theme "${targetId}" not found.`

      const { entry, volume } = found

      if (!canWrite(agent, volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${volume}".`
      }
      if (!isAuthor(agent, entry.author || "")) {
        return `\u274c Only the author can modify this theme. (author: ${entry.author || "unknown"})`
      }

      // Validate and add new refs
      const existingTargets = new Set((entry.refs || []).map(r => r.target))
      const newRefs: MemoryRef[] = []
      for (const id of entryIds) {
        if (id === entry.id) return `\u274c Cannot gather the theme into itself.`
        const refFound = findEntry(ctx.memDir, id, ctx.config)
        if (!refFound) return `\u274c Entry "${id}" not found.`
        if (!canRead(agent, refFound.volume, ctx.config)) {
          return `\u274c Agent "${agent}" cannot read entry "${id}".`
        }
        if (!existingTargets.has(refFound.entry.id)) {
          newRefs.push({ target: toDisplayId(refFound.entry.id, refFound.entry.volume), reason: `gathered in theme`, source: "manual" })
          existingTargets.add(refFound.entry.id)
        }
      }

      if (newRefs.length === 0) return `\u274c All specified entries are already gathered.`

      const updatedRefs = [...(entry.refs || []), ...newRefs]
      const updatedEntry: MemoryEntry = { ...entry, refs: updatedRefs, updated: today() }

      const entries = readJsonl(ctx.memDir, volume)
      const idx = entries.findIndex(e => e.id === entry.id)
      if (idx === -1) return `\u274c Entry "${entry.id}" not found in ${volume}.`
      entries[idx] = updatedEntry
      writeEntries(ctx.memDir, volume, entries, ctx.config)

      gitCommit(ctx.memDir, volume, `workspace add: gathered ${newRefs.map(r => r.target).join(", ")}\n\nTheme: ${entry.id}`, ctx.config)

      return `Gathered ${newRefs.length} entries into [${formatDisplayId(entry)}]: ${newRefs.map(r => r.target).join(", ")}`
    },
  }

  // ─── remove: remove entries from the active workspace theme ─────────────────

  const remove: ToolDef = {
    description:
      "Remove gathered entries from a workspace theme. " +
      "This only removes the reference — the original entries are not affected.",
    args: {
      entries: z.array(z.string()).describe("Entry IDs to remove from the workspace."),
      id: z.string().describe("Workspace entry ID to remove from."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "\u274c No workspace volume defined in config."

      const entryIds = ensureStringArray(args.entries)
      if (entryIds.length === 0) return "\u274c 'entries' must contain at least one entry ID."

      let targetId = args.id
      if (!targetId) return "❌ remove requires 'id'."

      const found = findEntry(ctx.memDir, targetId, ctx.config)
      if (!found) return `❌ Theme "${targetId}" not found.`

      const { entry, volume } = found

      if (!canWrite(agent, volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${volume}".`
      }
      if (!isAuthor(agent, entry.author || "")) {
        return `\u274c Only the author can modify this theme. (author: ${entry.author || "unknown"})`
      }

      const removeSet = new Set(entryIds)
      const before = (entry.refs || []).length
      const newRefs = (entry.refs || []).filter(r => !removeSet.has(r.target))
      const removed = before - newRefs.length

      if (removed === 0) return `\u274c None of the specified entries were gathered in this theme.`

      const updatedEntry: MemoryEntry = {
        ...entry,
        refs: newRefs.length > 0 ? newRefs : undefined,
        updated: today(),
      }

      const entries = readJsonl(ctx.memDir, volume)
      const idx = entries.findIndex(e => e.id === entry.id)
      if (idx === -1) return `\u274c Entry "${entry.id}" not found in ${volume}.`
      entries[idx] = updatedEntry
      writeEntries(ctx.memDir, volume, entries, ctx.config)

      gitCommit(ctx.memDir, volume, `workspace remove: removed ${removed} entries from ${entry.id}`, ctx.config)

      return `Removed ${removed} entries from [${formatDisplayId(entry)}]`
    },
  }

  return { status, assemble, open, edit, add, remove }
}

// =============================================================================
// Helpers
// =============================================================================

function formatLockAge(isoTimestamp: string): string {
  const acquired = new Date(isoTimestamp).getTime()
  const diffMs = Date.now() - acquired
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`
}
