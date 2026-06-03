import type { ToolContext, ToolDef, StellarioConfig, MemoryEntry, MemoryRef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead, canWrite, isAuthor } from "../permissions.js"
import { readJsonl, readVolumeIndex, extractTitle, findEntry, getActiveWorkspace, setActiveWorkspace, writeEntries, generateNextId, dedupeTags, ensureStringArray, ensureArray, today, getLinkedVolumes, getLinkedVolumeSymlinkPath } from "../store.js"
import { loadConfig, getMemoryDir, getWorkspaceVolume } from "../config.js"
import { queryTasks } from "../coord/store.js"
import { getAllActiveLocks } from "../coord/lock.js"
import { gitCommit } from "../git.js"
import { existsSync, readFileSync } from "fs"
import { join, basename } from "path"
import { z } from "zod"
import { updateEntryIndex } from "../embedding.js"

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

  // ── Active workspace ──
  const workspaceVol = getWorkspaceVolume(config)
  if (workspaceVol) {
    const activeId = getActiveWorkspace(memDir, workspaceVol, agentName)
    lines.push("")
    lines.push("\u2500\u2500\u2500")

    if (activeId) {
      const found = findEntry(memDir, activeId, config)
      if (found) {
        const refs = found.entry.refs || []
        lines.push(`Workspace: [${activeId}] ${extractTitle(found.entry.content)}`)
        if (refs.length > 0) {
          lines.push(`  refs: ${refs.map(r => r.target).join(", ")}`)
        }
        lines.push(`Use workspace_open() to expand`)
      } else {
        lines.push(`Workspace: [${activeId}] (not found)`)
      }
    } else {
      lines.push(`Workspace: (none)`)
      lines.push(`\uD83D\uDCA1 Use workspace_assemble(content="...", entries=[...]) to create one`)
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
    status: ["open", "claimed", "in_progress", "review"],
  })
  const activeLocks = getAllActiveLocks(memDir)

  if (activeTasks.length > 0 || activeLocks.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("Taskboard:")

    if (activeTasks.length > 0) {
      const statusOrder = ["in_progress", "claimed", "open", "review"] as const
      for (const status of statusOrder) {
        const group = activeTasks.filter(t => t.status === status)
        for (const task of group) {
          const owner = task.owner || "\u2014"
          const paths = (task.paths?.length ?? 0) > 0 ? `  ${task.paths.join(", ")}` : ""
          lines.push(`  [${task.id}] ${status.padEnd(12)} ${owner.padEnd(14)} ${task.title}`)
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
        lines.push(`[${entry.id}]`)
        lines.push(entry.content)
        lines.push("")
      }
    }
  }

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
      "The new theme automatically becomes the active workspace.",
    args: {
      content: z.string().describe("Theme description (title + context). E.g. '## Authentication Refactor\nGathering all entries related to the auth module redesign.'"),
      entries: z.array(z.string()).optional().describe("Entry IDs to gather into this theme."),
      tags: z.array(z.string()).optional().describe("Tags for the theme entry."),
      keywords: z.array(z.string()).optional().describe("2-5 keywords for discovery."),
    },
    async execute(args, context: ToolContext) {
      if (!args.content?.trim()) return "\u274c content is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "\u274c No workspace volume defined in config."

      if (!canWrite(agent, workspaceVol, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to workspace volume "${workspaceVol}".`
      }

      // Resolve entry IDs to refs
      const entryIds = ensureStringArray(args.entries)
      const refs: MemoryRef[] = []
      for (const id of entryIds) {
        const found = findEntry(ctx.memDir, id, ctx.config)
        if (!found) return `\u274c Entry "${id}" not found.`
        if (id === args.content) continue // can't reference self (not created yet, but guard)
        if (!canRead(agent, found.volume, ctx.config)) {
          return `\u274c Agent "${agent}" cannot read entry "${id}" (volume: ${found.volume}).`
        }
        refs.push({ target: found.entry.id, reason: `gathered in theme`, source: "manual" })
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

      setActiveWorkspace(ctx.memDir, workspaceVol, id, agent)

      if (keywords.length > 0) {
        updateEntryIndex(ctx.memDir, id, keywords).catch(() => {})
      }

      const commitHash = gitCommit(
        ctx.memDir, workspaceVol,
        `assemble: ${extractTitle(args.content)}\n\nEntry: ${id}\nGathered: ${refs.map(r => r.target).join(", ") || "none"}\nAuthor: ${agent}`,
        ctx.config,
      )

      const lines = [
        `Assembled [${id}] → ${workspaceVol}`,
        `Author: ${agent}`,
        `Gathered: ${refs.length > 0 ? refs.map(r => r.target).join(", ") : "none"}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
      ]
      return lines.join("\n")
    },
  }

  // ─── open: expand the active workspace, showing all gathered entries inline ─

  const open: ToolDef = {
    description:
      "Open the active workspace theme and expand all gathered entries inline. " +
      "Unlike memory_show which only lists ref IDs, this tool shows the full content " +
      "of every gathered entry — so you see the complete picture of the theme.",
    args: {
      id: z.string().optional().describe("Theme entry ID. If omitted, opens the currently active workspace."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (!workspaceVol) return "\u274c No workspace volume defined in config."

      // Resolve target ID
      let targetId = args.id
      if (!targetId) {
        targetId = getActiveWorkspace(ctx.memDir, workspaceVol, agent) || undefined
      }

      if (!targetId) return "\u274c No active workspace. Use workspace_assemble to create one."

      const found = findEntry(ctx.memDir, targetId, ctx.config)
      if (!found) return `\u274c Entry "${targetId}" not found.`

      const { entry } = found

      if (!canRead(agent, found.volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot read volume "${found.volume}".`
      }

      // Activate if in workspace volume
      if (found.volume === workspaceVol) {
        setActiveWorkspace(ctx.memDir, workspaceVol, entry.id, agent)
      }

      // Build output
      const lines: string[] = []
      lines.push(`\u2501\u2501\u2501 [${entry.id}] ${workspaceVol} — ${extractTitle(entry.content)} \u2501\u2501\u2501`)
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
            lines.push(`\u250C\u2500 [${refFound.entry.id}] ${refFound.volume} — ${extractTitle(refFound.entry.content)}`)
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
      id: z.string().optional().describe("Theme entry ID. Defaults to active workspace."),
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
      if (!targetId) {
        targetId = getActiveWorkspace(ctx.memDir, workspaceVol, agent) || undefined
      }
      if (!targetId) return "\u274c No active workspace."
      if (!args.message) return "\u274c edit requires a 'message'."
      if (args.from === undefined || args.from === null) return "\u274c edit requires 'from'."

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

      return `Edited [${entry.id}] lines ${f}-${t}`
    },
  }

  // ─── add: gather entries into the active workspace theme ────────────────────

  const add: ToolDef = {
    description:
      "Gather one or more memory entries into the active workspace theme. " +
      "The entries will appear when you workspace_open the theme.",
    args: {
      entries: z.array(z.string()).describe("Entry IDs to gather into the active workspace theme."),
      id: z.string().optional().describe("Theme entry ID. Defaults to active workspace."),
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
      if (!targetId) {
        targetId = getActiveWorkspace(ctx.memDir, workspaceVol, agent) || undefined
      }
      if (!targetId) return "\u274c No active workspace. Use workspace_assemble to create one."

      const found = findEntry(ctx.memDir, targetId, ctx.config)
      if (!found) return `\u274c Theme "${targetId}" not found.`

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
          newRefs.push({ target: refFound.entry.id, reason: `gathered in theme`, source: "manual" })
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

      return `Gathered ${newRefs.length} entries into [${entry.id}]: ${newRefs.map(r => r.target).join(", ")}`
    },
  }

  // ─── remove: remove entries from the active workspace theme ─────────────────

  const remove: ToolDef = {
    description:
      "Remove gathered entries from the active workspace theme. " +
      "This only removes the reference — the original entries are not affected.",
    args: {
      entries: z.array(z.string()).describe("Entry IDs to remove from the workspace theme."),
      id: z.string().optional().describe("Theme entry ID. Defaults to active workspace."),
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
      if (!targetId) {
        targetId = getActiveWorkspace(ctx.memDir, workspaceVol, agent) || undefined
      }
      if (!targetId) return "\u274c No active workspace."

      const found = findEntry(ctx.memDir, targetId, ctx.config)
      if (!found) return `\u274c Theme "${targetId}" not found.`

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

      return `Removed ${removed} entries from [${entry.id}]`
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
