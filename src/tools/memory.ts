import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import type { StellarioConfig, MemoryEntry, MemoryRef, ToolContext } from "../types.js"
import { profileBehavior } from "../types.js"
import { resolveContext, type ResolvedContext } from "../context.js"
import { resolveAgent, canRead, canWrite, canRevise, canForget, isAuthor } from "../permissions.js"
import {
  readJsonl, writeEntries, generateNextId, findEntry,
  setActiveWorkspace, getActiveWorkspace,
  today, truncate, extractTitle, dedupeTags,
} from "../store.js"
import { gitCommit } from "../git.js"
import { getWorkspaceVolume } from "../config.js"

// =============================================================================
// Shared Helpers
// =============================================================================

interface ParsedEdit {
  start: number
  end: number
  content: string
  rawRange: string
}

function parseRange(range: string, totalLines: number): { start: number; end: number } | string {
  const trimmed = range.trim()
  const single = trimmed.match(/^(\d+)$/)
  if (single) {
    const n = parseInt(single[1], 10)
    if (n < 1 || n > totalLines) return `Line ${n} out of range (1-${totalLines}).`
    return { start: n, end: n }
  }
  const rangeMatch = trimmed.match(/^(\d+)-(\d+)$/)
  if (rangeMatch) {
    const s = parseInt(rangeMatch[1], 10)
    const e = parseInt(rangeMatch[2], 10)
    if (s < 1 || e > totalLines || s > e) return `Range ${trimmed} invalid (1-${totalLines}).`
    return { start: s, end: e }
  }
  return `Invalid range format "${trimmed}". Use '43' or '43-54'.`
}

function formatContent(content: string): string {
  const lines = content.split("\n")
  const padWidth = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(padWidth)}| ${line}`).join("\n")
}

function formatRefs(refs: MemoryRef[]): string {
  return refs.map(r => `  \u2192 ${r.target} \u2014 ${r.reason}`).join("\n")
}

// =============================================================================
// Tool Factory
// =============================================================================

/**
 * Create the 5 memory tools (create, revise, forget, show, history).
 * Returns named exports ready for opencode registration.
 */
export function createMemoryTools() {
  // ── create ──────────────────────────────────────────────────────────────

  const create = tool({
    description:
      "Create a memory entry in a specified volume. " +
      "Volume determines storage location; permissions are auto-checked. " +
      "Author is auto-filled from agent identity.",
    args: {
      volume: z.string().describe("Target volume name (as defined in stellario.yaml)."),
      content: z.string().describe("Entry text content."),
      tags: z.array(z.string()).optional().describe("Tags in namespace:name format."),
      keywords: z.array(z.string()).optional().describe("2-5 free-form keywords for discovery."),
    },
    async execute(args, context: ToolContext) {
      if (!args.content?.trim()) return "\u274c content is required."
      if (!args.volume) return "\u274c volume is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const def = ctx.config.volumes[args.volume]
      if (!def) return `\u274c Unknown volume: "${args.volume}". Available: ${Object.keys(ctx.config.volumes).join(", ")}`

      if (!canWrite(agent, args.volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${args.volume}".`
      }

      if (!profileBehavior(def.profile).isTracked) {
        // scratch volume: no tag/keyword enforcement
      }

      let tags = args.tags || []
      tags = dedupeTags(tags)

      // Enforce required tag prefix
      if (def.requiredTagPrefix) {
        if (!tags.some(t => t.startsWith(def.requiredTagPrefix!))) {
          return `\u274c Entries in "${args.volume}" must have a tag with prefix "${def.requiredTagPrefix}".`
        }
      }

      let keywords = args.keywords || []
      keywords = [...new Set(keywords.map(k => k.trim()).filter(Boolean))]

      const id = generateNextId(ctx.memDir, args.volume, ctx.config)

      const entry: MemoryEntry = {
        id,
        volume: args.volume,
        content: args.content.trim(),
        tags,
        keywords,
        author: agent,
        created: today(),
        updated: today(),
      }

      const entries = readJsonl(ctx.memDir, args.volume)
      entries.push(entry)
      writeEntries(ctx.memDir, args.volume, entries, ctx.config)

      const commitHash = gitCommit(ctx.memDir, args.volume, `create: ${truncate(args.content, 50)}\n\nEntry: ${id}\nVolume: ${args.volume}\nAuthor: ${agent}`, ctx.config)

      const lines = [
        `Created [${id}] \u2192 ${args.volume}`,
        `Author: ${agent}`,
        `Tags: ${tags.length > 0 ? tags.join(", ") : "(none)"}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
      ]

      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (workspaceVol === args.volume) {
        lines.push("")
        lines.push(`\uD83D\uDCA1 Use memory_show(id="${id}") to activate as current workspace`)
      }

      return lines.join("\n")
    },
  })

  // ── show ────────────────────────────────────────────────────────────────

  const show = tool({
    description:
      "Read a memory entry by ID. Shows full content with line numbers, tags, and refs. " +
      "For entries in the workspace volume, automatically activates as current context.",
    args: {
      id: z.string().describe("Entry ID to read."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c show requires 'id'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const found = findEntry(ctx.memDir, args.id, ctx.config)
      if (!found) return `\u274c Entry "${args.id}" not found.`

      const { entry, volume } = found

      if (!canRead(agent, volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot read volume "${volume}".`
      }

      const lines: string[] = [
        `\u2501\u2501\u2501 [${entry.id}] \u2500\u2500\u2500 ${volume} \u2500\u2500\u2500 ${entry.author || "?"} \u2500\u2500\u2500 ${entry.created} \u2500\u2500\u2500`,
        "",
        formatContent(entry.content),
      ]

      if (entry.tags.length > 0) {
        lines.push("")
        lines.push(`tags: ${entry.tags.map(t => `[${t}]`).join(" ")}`)
      }

      if (entry.keywords.length > 0) {
        lines.push(`keywords: ${entry.keywords.join(", ")}`)
      }

      const refs = entry.refs || []
      if (refs.length > 0) {
        lines.push("")
        lines.push(`refs (${refs.length}):`)
        lines.push(formatRefs(refs))
      }

      // Activate if workspace volume
      const workspaceVol = getWorkspaceVolume(ctx.config)
      if (workspaceVol && volume === workspaceVol) {
        setActiveWorkspace(ctx.memDir, workspaceVol, args.id)
        lines.push("")
        lines.push(`\u2713 Activated as current workspace`)
      }

      return lines.join("\n")
    },
  })

  // ── revise ─────────────────────────────────────────────────────────────

  const revise = tool({
    description:
      "Edit a memory entry: modify content lines and/or manage refs. " +
      "Content edits use line ranges. Changes are committed to git automatically.",
    args: {
      id: z.string().describe("Entry ID to edit."),
      edits: z.array(z.object({
        range: z.string().describe("Line range: '43' or '43-54'."),
        content: z.string().describe("Replacement text."),
      })).optional().describe("Content edits, applied back-to-front."),
      refs_add: z.array(z.object({
        target: z.string().describe("Target entry ID."),
        reason: z.string().describe("Why this entry references the target."),
      })).optional().describe("Refs to add."),
      refs_remove: z.array(z.string()).optional().describe("Entry IDs to remove from refs."),
      message: z.string().describe("Why this edit was made."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c revise requires 'id'."
      const hasMutation = args.edits?.length || args.refs_add?.length || args.refs_remove?.length
      if (!hasMutation) return "\u274c revise requires at least one of: edits, refs_add, refs_remove."
      if (!args.message) return "\u274c revise requires a 'message'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const found = findEntry(ctx.memDir, args.id, ctx.config)
      if (!found) return `\u274c Entry "${args.id}" not found.`

      const { entry, volume } = found

      if (!canRevise(volume, ctx.config)) {
        return `\u274c Volume "${volume}" does not allow revisions (profile: ${ctx.config.volumes[volume]?.profile}).`
      }

      if (!isAuthor(agent, entry.author || "")) {
        return `\u274c Agent "${agent}" is not the author of [${args.id}] (author: ${entry.author || "unknown"}).`
      }

      const entries = readJsonl(ctx.memDir, volume)
      const entryIndex = entries.findIndex((e) => e.id === args.id)
      if (entryIndex === -1) return `\u274c Entry "${args.id}" not found in ${volume}.`

      const changes: string[] = []

      // Content edits
      let newContent = entry.content
      if (args.edits && args.edits.length > 0) {
        const lines = entry.content.split("\n")
        const totalLines = lines.length
        const parsedEdits: ParsedEdit[] = []

        for (const edit of args.edits) {
          const result = parseRange(edit.range, totalLines)
          if (typeof result === "string") return `\u274c ${result}`
          parsedEdits.push({ start: result.start, end: result.end, content: edit.content, rawRange: edit.range.trim() })
        }

        parsedEdits.sort((a, b) => b.start - a.start)

        for (let i = 0; i < parsedEdits.length - 1; i++) {
          if (parsedEdits[i].start <= parsedEdits[i + 1].end) {
            return `\u274c Range "${parsedEdits[i].rawRange}" and "${parsedEdits[i + 1].rawRange}" overlap.`
          }
        }

        for (const edit of parsedEdits) {
          const replacementLines = edit.content.split("\n")
          lines.splice(edit.start, edit.end - edit.start + 1, ...replacementLines)
        }

        newContent = lines.join("\n")
        changes.push(`content(${parsedEdits.map((e) => e.rawRange).join(", ")})`)
      }

      // Refs edits
      let newRefs: MemoryRef[] = [...(entry.refs || [])]

      if (args.refs_remove && args.refs_remove.length > 0) {
        const removeSet = new Set(args.refs_remove)
        const before = newRefs.length
        newRefs = newRefs.filter((r) => !removeSet.has(r.target))
        const removed = before - newRefs.length
        if (removed > 0) changes.push(`refs(-${removed})`)
      }

      if (args.refs_add && args.refs_add.length > 0) {
        for (const ref of args.refs_add) {
          const target = findEntry(ctx.memDir, ref.target, ctx.config)
          if (!target) return `\u274c Ref target "${ref.target}" not found.`
          if (ref.target === args.id) return `\u274c Cannot self-reference.`
        }
        const existingTargets = new Set(newRefs.map((r) => r.target))
        let added = 0
        for (const ref of args.refs_add) {
          if (!existingTargets.has(ref.target)) {
            newRefs.push({ target: ref.target, reason: ref.reason })
            existingTargets.add(ref.target)
            added++
          }
        }
        if (added > 0) changes.push(`refs(+${added})`)
      }

      const updatedEntry: MemoryEntry = {
        ...entry,
        content: newContent,
        refs: newRefs.length > 0 ? newRefs : undefined,
        updated: today(),
      }
      entries[entryIndex] = updatedEntry
      writeEntries(ctx.memDir, volume, entries, ctx.config)

      const commitHash = gitCommit(ctx.memDir, volume, `revise: ${args.message}\n\nEntry: ${args.id}\nChanges: ${changes.join(", ")}`, ctx.config)

      const resultLines = [
        `Revised [${args.id}] \u2192 ${volume}`,
        `Changes: ${changes.join(", ")}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
        `Message: ${args.message}`,
      ]

      return resultLines.join("\n")
    },
  })

  // ── forget ─────────────────────────────────────────────────────────────

  const forget = tool({
    description:
      "Archive a memory entry. Moves to 'archived' (frozen, read-only). " +
      "Only the entry's author can archive it. Append volumes cannot be archived.",
    args: {
      id: z.string().describe("Entry ID to archive."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c forget requires 'id'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const found = findEntry(ctx.memDir, args.id, ctx.config)
      if (!found) return `\u274c Entry "${args.id}" not found.`

      const { entry, volume } = found

      if (!canForget(volume, ctx.config)) {
        return `\u274c Volume "${volume}" does not allow forget (profile: ${ctx.config.volumes[volume]?.profile}).`
      }

      if (!isAuthor(agent, entry.author || "")) {
        return `\u274c Agent "${agent}" is not the author of [${args.id}] (author: ${entry.author || "unknown"}).`
      }

      const sourceEntries = readJsonl(ctx.memDir, volume)
      const filtered = sourceEntries.filter((e) => e.id !== args.id)
      if (filtered.length === sourceEntries.length) {
        return `\u274c Entry "${args.id}" not found in ${volume}.`
      }
      writeEntries(ctx.memDir, volume, filtered, ctx.config)

      // Add to archived
      const archivedEntry: MemoryEntry = {
        ...entry,
        volume: "archived",
        archived_at: new Date().toISOString(),
        archived_reason: "forget",
      }
      const archivedEntries = readJsonl(ctx.memDir, "archived")
      archivedEntries.push(archivedEntry)
      writeEntries(ctx.memDir, "archived", archivedEntries, ctx.config)

      const commitHash = gitCommit(ctx.memDir, volume, `archive: ${truncate(entry.content, 50)}\n\nEntry: ${args.id}\nFrom: ${volume} \u2192 archived`, ctx.config)

      return [
        `Archived [${args.id}] ${volume} \u2192 archived`,
        `Author: ${entry.author || "unknown"}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
      ].join("\n")
    },
  })

  // ── history ────────────────────────────────────────────────────────────

  const history = tool({
    description: "View the git revision history of a memory entry.",
    args: {
      id: z.string().describe("Entry ID."),
      limit: z.number().optional().describe("Max revisions (default 10)."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c history requires 'id'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const found = findEntry(ctx.memDir, args.id, ctx.config)
      if (!found) return `\u274c Entry "${args.id}" not found.`

      if (!canRead(agent, found.volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot read volume "${found.volume}".`
      }

      // Delegate to git history lookup (simplified)
      return `History for [${args.id}] in ${found.volume}: (git history lookup - see Lilac implementation for full detail)`
    },
  })

  return { create, revise, forget, show, history }
}
