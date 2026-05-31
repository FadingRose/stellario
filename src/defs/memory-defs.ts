import { z } from "zod"
import type { StellarioConfig, MemoryEntry, ToolContext, ToolDef } from "../types.js"
import { resolveContext, type ResolvedContext } from "../context.js"
import { resolveAgent, canRead, canWrite, canRevise, canForget, isAuthor, writableVolumes } from "../permissions.js"
import {
  readJsonl, writeEntries, generateNextId, findEntry,
  today, truncate, extractTitle, dedupeTags, ensureStringArray, ensureArray,
} from "../store.js"
import { gitCommit } from "../git.js"
import { updateEntryIndex, removeEntryIndex } from "../embedding.js"

// =============================================================================
// Shared Helpers
// =============================================================================

interface ParsedEdit {
  start: number
  end: number
  content: string
  label: string   // human-readable label for error messages
}

function normalizeEditRange(edit: { from?: number; to?: number }, totalLines: number): { start: number; end: number; label: string } | string {
  if (edit.from === undefined || edit.from === null) {
    return `Edit must specify 'from' (1-indexed line number).`
  }
  const f = typeof edit.from === "number" ? edit.from : parseInt(String(edit.from), 10)
  const t = (edit.to !== undefined && edit.to !== null)
    ? (typeof edit.to === "number" ? edit.to : parseInt(String(edit.to), 10))
    : f
  if (isNaN(f) || isNaN(t)) return `Invalid from/to values: from=${edit.from}, to=${edit.to}.`
  if (f < 1 || t < 1 || f > totalLines || t > totalLines) return `Line range ${f}-${t} out of range (1-${totalLines}).`
  if (f > t) return `Invalid range: from (${f}) > to (${t}).`
  return { start: f, end: t, label: `${f}-${t}` }
}

function formatContent(content: string): string {
  const lines = content.split("\n")
  const padWidth = String(lines.length).length
  return lines.map((line, i) => `${String(i + 1).padStart(padWidth)}| ${line}`).join("\n")
}

/**
 * Find the default volume for an agent: first writable mutable (non-workspace) volume.
 */
function resolveDefaultVolume(agent: string, config: StellarioConfig): string | null {
  const writable = writableVolumes(agent, config)
  for (const name of writable) {
    const def = config.volumes[name]
    // Skip meta (reserved for behavioral calibrations) and workspace (has its own tools)
    if (name === "meta") continue
    if (def.profile === "mutable") return name
  }
  // Fallback: first writable that accepts creates
  for (const name of writable) {
    const def = config.volumes[name]
    if (name === "meta") continue
    if (def.profile !== "frozen") return name
  }
  return null
}

// =============================================================================
// Tool Definitions
// =============================================================================

export function getMemoryToolDefs(): Record<string, ToolDef> {
  const create: ToolDef = {
    description:
      "Create a memory entry. " +
      "Author is auto-filled from agent identity. " +
      "Volume is optional — defaults to your primary mutable volume.",
    args: {
      content: z.string().describe("Entry text content."),
      volume: z.string().optional().describe("Target volume name. Defaults to your primary mutable volume."),
      tags: z.array(z.string()).optional().describe("Tags in namespace:name format."),
      keywords: z.array(z.string()).optional().describe("2-5 free-form keywords for discovery."),
    },
    async execute(args, context: ToolContext) {
      if (!args.content?.trim()) return "\u274c content is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      // Resolve volume: explicit or default to first writable mutable volume
      let volumeName = args.volume
      if (!volumeName) {
        volumeName = resolveDefaultVolume(agent, ctx.config)
        if (!volumeName) return `\u274c No writable volume found for agent "${agent}". Specify 'volume' explicitly.`
      }

      const def = ctx.config.volumes[volumeName]
      if (!def) return `\u274c Unknown volume: "${volumeName}". Available: ${Object.keys(ctx.config.volumes).join(", ")}`

      if (!canWrite(agent, volumeName, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${volumeName}".`
      }

      let tags = dedupeTags(ensureStringArray(args.tags))

      if (def.requiredTagPrefix) {
        if (!tags.some(t => t.startsWith(def.requiredTagPrefix!))) {
          return `\u274c Entries in "${volumeName}" must have a tag with prefix "${def.requiredTagPrefix}".`
        }
      }

      let keywords = ensureStringArray(args.keywords)
      keywords = [...new Set(keywords.map(k => k.trim()).filter(Boolean))]

      const id = generateNextId(ctx.memDir, volumeName, ctx.config)

      const entry: MemoryEntry = {
        id,
        volume: volumeName,
        content: args.content.trim(),
        tags,
        keywords,
        author: agent,
        created: today(),
        updated: today(),
      }

      const entries = readJsonl(ctx.memDir, volumeName)
      entries.push(entry)
      writeEntries(ctx.memDir, volumeName, entries, ctx.config)

      const commitHash = gitCommit(ctx.memDir, volumeName, `create: ${truncate(args.content, 50)}\n\nEntry: ${id}\nVolume: ${volumeName}\nAuthor: ${agent}`, ctx.config)

      // Update keyword index (async, non-blocking)
      if (keywords.length > 0) {
        updateEntryIndex(ctx.memDir, id, keywords).catch(() => {})
      }

      const lines = [
        `Created [${id}] → ${volumeName}`,
        `Author: ${agent}`,
        `Tags: ${tags.length > 0 ? tags.join(", ") : "(none)"}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
      ]

      return lines.join("\n")
    },
  }

  const show: ToolDef = {
    description:
      "Read a memory entry by ID. Shows full content with line numbers, tags, and keywords.",
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

      return lines.join("\n")
    },
  }

  const revise: ToolDef = {
    description:
      "Edit a memory entry's content. " +
      "Only the entry's author can revise. Append-only volumes disallow revision. " +
      "Line numbers come from memory_show output (1-indexed, left of the '|' separator). " +
      "Each edit uses 'from'/'to' to specify which lines to replace with 'content'. " +
      "'to' defaults to 'from' (single line) if omitted. " +
      "Multiple edits are applied back-to-front (highest line first) to avoid offset drift. " +
      "Changes are committed to git automatically.",
    args: {
      id: z.string().describe("Entry ID to revise (must be your own entry)."),
      edits: z.array(z.object({
        from: z.number().describe("First line number to replace (1-indexed, from memory_show output). Required."),
        to: z.number().optional().describe("Last line number to replace (1-indexed, inclusive). Defaults to 'from' if omitted."),
        content: z.string().describe("Replacement text for the specified lines. Use empty string to delete lines."),
      })).optional().describe("Line-level content edits. Multiple edits are processed highest-line-first to preserve line numbers."),
      message: z.string().describe("Commit message describing why this revision was made."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c revise requires 'id'."

      // Defensive: opencode may pass arrays as JSON strings or with broken element shapes.
      // Validate each element with Zod to guarantee correct types before use.
      const editSchema = z.object({ from: z.number().optional(), to: z.number().optional(), content: z.string() })
      const edits = ensureArray(args.edits, editSchema)
      if (args.edits && !edits.length) {
        return `\u274c 'edits' was provided but all elements failed validation. Each edit needs 'from' (number) and 'content' (string). Raw input: ${JSON.stringify(args.edits).slice(0, 200)}`
      }

      if (!edits.length) return "\u274c revise requires 'edits'."
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

      let newContent = entry.content
      if (edits.length > 0) {
        const lines = entry.content.split("\n")
        const totalLines = lines.length
        const parsedEdits: ParsedEdit[] = []

        for (const edit of edits) {
          const result = normalizeEditRange(edit, totalLines)
          if (typeof result === "string") return `\u274c ${result}`
          parsedEdits.push({ start: result.start, end: result.end, content: edit.content, label: result.label })
        }

        parsedEdits.sort((a, b) => b.start - a.start)

        for (let i = 0; i < parsedEdits.length - 1; i++) {
          if (parsedEdits[i].start <= parsedEdits[i + 1].end) {
            return `\u274c Range "${parsedEdits[i].label}" and "${parsedEdits[i + 1].label}" overlap.`
          }
        }

        for (const edit of parsedEdits) {
          const replacementLines = edit.content === "" ? [] : edit.content.split("\n")
          lines.splice(edit.start - 1, edit.end - edit.start + 1, ...replacementLines)
        }

        newContent = lines.join("\n")
        changes.push(`content(${parsedEdits.map((e) => e.label).join(", ")})`)
      }

      const updatedEntry: MemoryEntry = {
        ...entry,
        content: newContent,
        updated: today(),
      }
      entries[entryIndex] = updatedEntry
      writeEntries(ctx.memDir, volume, entries, ctx.config)

      // Re-index keywords if content changed (async, non-blocking)
      if (edits.length > 0 && updatedEntry.keywords.length > 0) {
        updateEntryIndex(ctx.memDir, args.id, updatedEntry.keywords).catch(() => {})
      }

      const commitHash = gitCommit(ctx.memDir, volume, `revise: ${args.message}\n\nEntry: ${args.id}\nChanges: ${changes.join(", ")}`, ctx.config)

      return [
        `Revised [${args.id}] \u2192 ${volume}`,
        `Changes: ${changes.join(", ")}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
        `Message: ${args.message}`,
      ].join("\n")
    },
  }

  const forget: ToolDef = {
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

      const archivedEntry: MemoryEntry = {
        ...entry,
        volume: "archived",
        archived_at: new Date().toISOString(),
        archived_reason: "forget",
      }
      const archivedEntries = readJsonl(ctx.memDir, "archived")
      archivedEntries.push(archivedEntry)
      writeEntries(ctx.memDir, "archived", archivedEntries, ctx.config)

      // Remove from keyword index
      removeEntryIndex(ctx.memDir, args.id)

      const commitHash = gitCommit(ctx.memDir, volume, `archive: ${truncate(entry.content, 50)}\n\nEntry: ${args.id}\nFrom: ${volume} \u2192 archived`, ctx.config)

      return [
        `Archived [${args.id}] ${volume} \u2192 archived`,
        `Author: ${entry.author || "unknown"}`,
        commitHash ? `Commit: ${commitHash}` : "(volume not version-controlled)",
      ].join("\n")
    },
  }

  const history: ToolDef = {
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

      return `History for [${args.id}] in ${found.volume}: (git history lookup - see Lilac implementation for full detail)`
    },
  }

  // ─── meta: calibrate agent behavior across sessions ────────────────────────

  const meta: ToolDef = {
    description:
      "Record a behavioral calibration that persists across sessions. " +
      "Use this when you notice you should adjust your approach — the calibration " +
      "is injected into your system context on next session startup. " +
      "Examples: prefer brevity, always read files before editing, confirm before destructive ops.",
    args: {
      content: z.string().describe("The behavioral calibration. Be specific and actionable."),
    },
    async execute(args, context: ToolContext) {
      if (!args.content?.trim()) return "\u274c content is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      // Find the meta volume (first mutable volume named "meta")
      let metaVol: string | null = null
      for (const [name, def] of Object.entries(ctx.config.volumes)) {
        if (name === "meta" && def.profile === "mutable") {
          metaVol = name
          break
        }
      }
      if (!metaVol) return "\u274c No meta volume defined. Add a 'meta' volume with profile: mutable to stellario.yaml."

      if (!canWrite(agent, metaVol, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to meta volume.`
      }

      const tags = ["type:prompt"]
      const id = generateNextId(ctx.memDir, metaVol, ctx.config)

      const entry: MemoryEntry = {
        id,
        volume: metaVol,
        content: args.content.trim(),
        tags,
        keywords: [],
        author: agent,
        created: today(),
        updated: today(),
      }

      const entries = readJsonl(ctx.memDir, metaVol)
      entries.push(entry)
      writeEntries(ctx.memDir, metaVol, entries, ctx.config)

      gitCommit(ctx.memDir, metaVol, `meta: ${truncate(args.content, 50)}\n\nEntry: ${id}\nAuthor: ${agent}`, ctx.config)

      return [
        `Calibrated [${id}] → ${metaVol}`,
        `This calibration will take effect on next session startup.`,
        `Author: ${agent}`,
      ].join("\n")
    },
  }

  return { create, show, revise, forget, history, meta }
}
