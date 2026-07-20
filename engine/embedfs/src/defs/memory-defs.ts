import { z } from "zod"
import type { StellarioConfig, MemoryEntry, ToolContext, ToolDef } from "../types.js"
import { resolveContext, type ResolvedContext } from "../context.js"
import { resolveAgent, canRead, canWrite, canRevise, canForget, isAuthor, writableVolumes } from "../permissions.js"
import {
  readJsonl, writeEntries, generateNextId, findEntry,
  today, truncate, extractTitle, dedupeTags, ensureStringArray, ensureArray,
  writeEntryMd, removeEntryMd, getEntryMdPath,
  formatDisplayId, toDisplayId, parseDisplayId,
} from "../store.js"
import { gitCommit, gitLogEntry } from "../git.js"
import {
  updateEntryIndex, removeEntryIndex,
  readIndex, embedBatch,
  probeEmbeddingAvailability, getEmbeddingAvailability,
  type KeywordIndexEntry,
} from "../embedding.js"
import { markPending, unmarkPending, triggerFlush } from "../index-worker.js"
import { computeAutoRefs, applyAutoRefsPlan, type AutoRefsPlan } from "../auto-refs.js"
import { SYSTEM_VOLUME_NAMES } from "../config.js"

/**
 * Resolve project name for Go fanout.
 * Uses basename of project root as a simple heuristic.
 * In production, this would use cluster.ResolveProject (git remote based).
 */
function resolveProjectName(projectRoot: string): string {
  const { basename } = require("path")
  return basename(projectRoot)
}

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
 * Find the default volume for an agent: first writable mutable (non-system) volume.
 * System volumes (meta, handover, layer) are never used as default.
 */
function resolveDefaultVolume(agent: string, config: StellarioConfig): string | null {
  const writable = writableVolumes(agent, config)
  for (const name of writable) {
    const def = config.volumes[name]
    // Skip system volumes — they have dedicated tools and semantics
    if (SYSTEM_VOLUME_NAMES.has(name)) continue
    if (def.profile === "mutable") return name
  }
  // Fallback: first writable non-system volume that accepts creates
  for (const name of writable) {
    const def = config.volumes[name]
    if (SYSTEM_VOLUME_NAMES.has(name)) continue
    if (def.profile !== "frozen") return name
  }
  return null
}

/**
 * Build the keyword index map for auto-refs, including a freshly-embedded
 * source entry so that newly-created / just-revised entries participate in
 * semantic matching on the same operation that wrote them.
 *
 * Returns { map, available }:
 *   - If embedding is unavailable or the index is empty, returns an empty map
 *     and available=false. computeAutoRefs will then fall back to exact
 *     keyword string matching (its built-in graceful degradation).
 *   - Otherwise returns a map of {id → KeywordIndexEntry} populated from the
 *     on-disk index, with the source entry's keywords embedded and inserted.
 *
 * This helper exists to fix a regression where the create/revise paths passed
 * `embAvail=false` and an empty map unconditionally, causing auto-refs to
 * never use semantic similarity even when the index was fully populated.
 */
async function buildKwIndexForAutoRefs(
  memDir: string,
  source: MemoryEntry,
): Promise<{ map: Map<string, KeywordIndexEntry>; available: boolean }> {
  // Lazy probe: if availability has never been checked in this process,
  // probe now (async). Subsequent calls hit the cached "available" state.
  if (getEmbeddingAvailability() === "unknown") {
    await probeEmbeddingAvailability()
  }
  if (getEmbeddingAvailability() !== "available") return { map: new Map(), available: false }

  const indexed = readIndex(memDir)
  if (indexed.length === 0 && source.keywords.length === 0) {
    return { map: new Map(), available: false }
  }

  const map = new Map<string, KeywordIndexEntry>()
  for (const entry of indexed) map.set(entry.id, entry)

  // Embed the source entry's keywords synchronously so it participates in
  // semantic matching on this very create/revise. (The on-disk index is
  // updated asynchronously after the write, so without this the source
  // would have no vectors during its own auto-refs computation.)
  if (source.keywords.length > 0) {
    try {
      const vectors = await embedBatch(source.keywords)
      map.set(source.id, { id: source.id, keywords: source.keywords, vectors })
    } catch {
      // Embedding failed at runtime — fall back to whatever index we have.
      // Source won't have vectors, but candidates still do; matchKeywords
      // handles missing source vectors by returning null for that pair.
    }
  }

  return { map, available: true }
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

      const id = generateNextId(ctx.memDir, volumeName, ctx.config, ctx.star)

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

      // Auto-refs: find bidirectional links before writing (CL-8/CL-10)
      let autoRefChangedIds: string[] = []
      if (def.autoRefs?.enabled) {
        const { map: kwIndexMap, available: embAvail } = await buildKwIndexForAutoRefs(ctx.memDir, entry)
        const plan = computeAutoRefs(entry, entries, ctx.config, embAvail, kwIndexMap)
        autoRefChangedIds = applyAutoRefsPlan(plan, entries, entry.id)
      }

      writeEntries(ctx.memDir, volumeName, entries, ctx.config)

      // Per-entry md for source and all auto-ref touched entries
      writeEntryMd(ctx.memDir, volumeName, entry)
      for (const cid of autoRefChangedIds) {
        if (cid === entry.id) continue
        const changed = entries.find(e => e.id === cid)
        if (changed) writeEntryMd(ctx.memDir, volumeName, changed)
      }

      const autoRefNote = autoRefChangedIds.length > 1
        ? `\n[auto_refs: ${autoRefChangedIds.filter(cid => cid !== entry.id).map(cid => {
            const e = entries.find(e => e.id === cid)
            return `↔${e ? toDisplayId(e.id, e.volume) : cid}`
          }).join(", ")}]`
        : ""
      const commitHash = gitCommit(
        ctx.memDir, volumeName,
        `create: ${truncate(args.content, 50)}\n\nEntry: ${id}\nVolume: ${volumeName}\nAuthor: ${agent}${autoRefNote}`,
        ctx.config, [id, ...autoRefChangedIds],
      )

      // Mark for background indexing (batch-flushed, fire-and-forget)
      if (keywords.length > 0) {
        markPending(ctx.memDir, id)
        triggerFlush(ctx.memDir, ctx.config)
      }

      // ── Go fanout: mirror this create to SQLite ──
      // This is the dual-write verification path. TS is ground truth (JSONL).
      // Go writes a shadow copy to SQLite with the SAME ID (no star suffix).
      // doctor --compare detects divergence by exact ID match.
      // If Go is unavailable, the fanout is silently skipped (non-blocking).
      try {
        const projectName = resolveProjectName(ctx.projectRoot)
        const { execFileSync } = await import("child_process")
        const goArgs = [
          "create", "--native",
          "--id", id,
          "--project", projectName,
          "--volume", volumeName,
          "--content", args.content.trim(),
          "--author", agent,
        ]
        if (tags.length > 0) goArgs.push("--tags", tags.join(","))
        if (keywords.length > 0) goArgs.push("--keywords", keywords.join(","))
        execFileSync("stellario", goArgs, {
          stdio: "pipe",
          timeout: 5000,
        })
      } catch {
        // Go binary not available or errored — silently skip
      }

      const displayId = toDisplayId(id, volumeName)
      const lines = [
        `Created [${displayId}] → ${volumeName}`,
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
      if (!found) return `❌ Entry "${args.id}" not found.`

      const { entry, volume } = found

      if (!canRead(agent, volume, ctx.config)) {
        return `❌ Agent "${agent}" cannot read volume "${volume}".`
      }

      // ── Auto-refs reconciliation (conditional) ──
      // If the volume has autoRefs enabled, recompute auto-refs for this entry.
      // This catches links that should exist but weren't created (e.g. a related
      // entry was created after this one). Only writes if there are changes.
      let autoRefNote = ""
      const volDef = ctx.config.volumes[volume]
      if (volDef?.autoRefs?.enabled) {
        const entries = readJsonl(ctx.memDir, volume)
        const entryIdx = entries.findIndex(e => e.id === entry.id)
        if (entryIdx !== -1) {
          const currentEntry = entries[entryIdx]
          const { map: kwIndexMap, available: embAvail } = await buildKwIndexForAutoRefs(ctx.memDir, currentEntry)
          const plan = computeAutoRefs(currentEntry, entries, ctx.config, embAvail, kwIndexMap)

          if (plan.add.length > 0 || plan.remove.length > 0) {
            const changedIds = applyAutoRefsPlan(plan, entries, currentEntry.id)
            writeEntries(ctx.memDir, volume, entries, ctx.config)
            for (const cid of changedIds) {
              if (cid === currentEntry.id) continue
              const changed = entries.find(e => e.id === cid)
              if (changed) writeEntryMd(ctx.memDir, volume, changed)
            }
            writeEntryMd(ctx.memDir, volume, currentEntry)

            const addedIds = plan.add
              .filter(p => p.entry1Id === currentEntry.id || p.entry2Id === currentEntry.id)
              .map(p => {
                const otherId = p.entry1Id === currentEntry.id ? p.entry2Id : p.entry1Id
                const other = entries.find(e => e.id === otherId)
                return other ? toDisplayId(other.id, other.volume) : otherId
              })

            if (addedIds.length > 0) {
              autoRefNote = `\n[auto_refs: discovered ${addedIds.map(id => `+${id}`).join(", ")}]`
            }

            gitCommit(
              ctx.memDir, volume,
              `show: auto-refs reconciled for ${currentEntry.id}\n\nChanges: +${plan.add.length} -${plan.remove.length}`,
              ctx.config, changedIds,
            )

            // Use the updated entry for display
            entry.refs = currentEntry.refs
          }
        }
      }

      const lines: string[] = [
        `━━━ [${formatDisplayId(entry)}] ─── ${volume} ─── ${entry.author || "?"} ─── ${entry.created} ───`,
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

      if (entry.refs && entry.refs.length > 0) {
        lines.push("")
        for (const ref of entry.refs) {
          const icon = ref.source === "auto" ? "⟷" : "→"
          lines.push(`ref: ${icon} [${ref.target}] (${ref.reason})`)
        }
      }

      if (entry.refs_removed && entry.refs_removed.length > 0) {
        lines.push(`refs_removed: [${entry.refs_removed.join("], [")}]`)
      }

      if (autoRefNote) {
        lines.push(autoRefNote)
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
      tags: z.array(z.string()).optional().describe("Replace entry tags (namespace:name format). Omit to keep existing tags."),
      keywords: z.array(z.string()).optional().describe("Replace entry keywords. Omit to keep existing keywords."),
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

      if (!edits.length && !args.tags && !args.keywords) {
        return "\u274c revise requires 'edits', 'tags', or 'keywords'."
      }
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
      const entryIndex = entries.findIndex((e) => e.id === entry.id)
      if (entryIndex === -1) return `❌ Entry "${entry.id}" not found in ${volume}.`

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

      // Update tags if provided
      let tagsChanged = false
      if (args.tags !== undefined) {
        const newTags = dedupeTags(ensureStringArray(args.tags))
        if (JSON.stringify(newTags) !== JSON.stringify(entry.tags)) {
          tagsChanged = true
          changes.push("tags")
        }
        updatedEntry.tags = newTags
      }

      // Update keywords if provided
      let keywordsChanged = false
      if (args.keywords !== undefined) {
        const newKeywords = ensureStringArray(args.keywords)
        if (JSON.stringify(newKeywords) !== JSON.stringify(entry.keywords)) {
          keywordsChanged = true
          changes.push("keywords")
        }
        updatedEntry.keywords = newKeywords
      }

      entries[entryIndex] = updatedEntry

      // Auto-refs if tags or keywords changed (CL-8/CL-9/CL-10)
      let autoRefChangedIds: string[] = []
      const autoRefEnabled = ctx.config.volumes[volume]?.autoRefs?.enabled
      if (autoRefEnabled && (tagsChanged || keywordsChanged)) {
        const { map: kwIndexMap, available: embAvail } = await buildKwIndexForAutoRefs(ctx.memDir, updatedEntry)
        const plan = computeAutoRefs(updatedEntry, entries, ctx.config, embAvail, kwIndexMap)
        autoRefChangedIds = applyAutoRefsPlan(plan, entries, updatedEntry.id)
      }

      writeEntries(ctx.memDir, volume, entries, ctx.config)

      // Per-entry md for source and all auto-ref touched entries
      writeEntryMd(ctx.memDir, volume, updatedEntry)
      for (const cid of autoRefChangedIds) {
        if (cid === updatedEntry.id) continue
        const changed = entries.find(e => e.id === cid)
        if (changed) writeEntryMd(ctx.memDir, volume, changed)
      }

      // Mark for background indexing if content or keywords changed
      if ((edits.length > 0 || keywordsChanged) && updatedEntry.keywords.length > 0) {
        markPending(ctx.memDir, args.id)
        triggerFlush(ctx.memDir, ctx.config)
      }

      const allChangedIds = [args.id, ...autoRefChangedIds]
      const autoRefNote = autoRefChangedIds.length > 0
        ? `\n[auto_refs: ${autoRefChangedIds.filter(cid => cid !== updatedEntry.id).map(cid => {
            const e = entries.find(e => e.id === cid)
            return `↔${e ? toDisplayId(e.id, e.volume) : cid}`
          }).join(", ")}]`
        : ""
      const commitHash = gitCommit(
        ctx.memDir, volume,
        `revise: ${args.message}\n\nEntry: ${args.id}\nChanges: ${changes.join(", ")}${autoRefNote}`,
        ctx.config, allChangedIds,
      )

      return [
        `Revised [${formatDisplayId(updatedEntry)}] → ${volume}`,
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
      const filtered = sourceEntries.filter((e) => e.id !== entry.id)
      if (filtered.length === sourceEntries.length) {
        return `❌ Entry "${entry.id}" not found in ${volume}.`
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

      // Remove from keyword index and pending
      removeEntryIndex(ctx.memDir, args.id)
      unmarkPending(ctx.memDir, args.id)

      // Per-entry md: remove from source volume, create in archived
      removeEntryMd(ctx.memDir, volume, args.id)
      writeEntryMd(ctx.memDir, "archived", archivedEntry)

      const commitHash = gitCommit(ctx.memDir, volume, `archive: ${truncate(entry.content, 50)}\n\nEntry: ${args.id}\nFrom: ${volume} \u2192 archived`, ctx.config, [args.id])

      // Also commit the archived volume changes
      gitCommit(ctx.memDir, "archived", `archived: ${truncate(entry.content, 50)}\n\nEntry: ${args.id}\nFrom: ${volume}`, ctx.config, [args.id])

      return [
        `Archived [${formatDisplayId(entry)}] ${volume} → archived`,
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

      const limit = typeof args.limit === "number" ? args.limit : 10
      const vol = found.volume
      const log = gitLogEntry(ctx.memDir, vol, args.id, limit)

      if (!log) {
        return `No git history for [${args.id}] in ${vol}.\n(The memory directory may not be a git repo, or the entry has no tracked changes yet.)`
      }

      return [
        `History for [${args.id}] in ${vol}:`,
        "",
        log,
      ].join("\n")
    },
  }

  // NOTE: The dedicated `meta` tool has been removed.
  // To write a behavioral calibration, use `create(volume="meta", content=..., tags=[...], keywords=[...])`.
  // Meta entries are injected into the system prompt at session startup by default.
  // To exclude an entry from injection, add the `meta:disable` tag via `revise`.

  // ─── ref: create a manual reference between entries ───────────────────────

  const ref: ToolDef = {
    description:
      "Create a manual reference from one entry to another. " +
      "Manual refs are permanent — the auto_refs engine never removes them. " +
      "If the target was previously unref'd (in refs_removed), it is restored.",
    args: {
      id: z.string().describe("Source entry ID to link from."),
      target: z.string().describe("Target entry ID to link to."),
      reason: z.string().describe("Why this link is created."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id || !args.target) return "\u274c link requires 'id' and 'target'."
      if (!args.reason?.trim()) return "\u274c link requires 'reason'."
      if (args.id === args.target) return "\u274c Cannot link an entry to itself."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      // Validate source
      const sourceFound = findEntry(ctx.memDir, args.id, ctx.config)
      if (!sourceFound) return `\u274c Source entry "${args.id}" not found.`
      if (!canWrite(agent, sourceFound.volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${sourceFound.volume}".`
      }

      // Validate target
      const targetFound = findEntry(ctx.memDir, args.target, ctx.config)
      if (!targetFound) return `\u274c Target entry "${args.target}" not found.`
      if (!canRead(agent, targetFound.volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot read target volume "${targetFound.volume}".`
      }
      if (targetFound.entry.archived_at) {
        return `\u274c Cannot link to archived entry "${args.target}".`
      }

      const volume = sourceFound.volume
      const entries = readJsonl(ctx.memDir, volume)
      const source = entries.find(e => e.id === sourceFound.entry.id)
      if (!source) return `❌ Source entry "${sourceFound.entry.id}" not found in ${volume}.`

      // Already linked? (match both display and short format)
      const targetStored = parseDisplayId(args.target, ctx.config)?.storedId ?? args.target
      if (source.refs?.some(r => r.target === args.target || r.target === targetStored)) {
        return `\u274c [${args.id}] is already linked to [${args.target}].`
      }

      // Restore from refs_removed if needed (CL-9)
      if (source.refs_removed?.includes(args.target)) {
        source.refs_removed = source.refs_removed.filter(t => t !== args.target)
      }

      if (!source.refs) source.refs = []
      source.refs.push({
        target: args.target,
        reason: args.reason.trim(),
        source: "manual",
      })
      source.updated = today()

      writeEntries(ctx.memDir, volume, entries, ctx.config)
      writeEntryMd(ctx.memDir, volume, source)

      const commitHash = gitCommit(
        ctx.memDir, volume,
        `ref: ${args.id} → ${args.target}\n\nReason: ${args.reason}`,
        ctx.config, [args.id],
      )

      return [
        `Ref'd [${args.id}] → [${args.target}]`,
        `Reason: ${args.reason}`,
        commitHash ? `Commit: ${commitHash}` : "",
      ].filter(Boolean).join("\n")
    },
  }

  // ─── unref: remove a reference between entries ────────────────────────────

  const unref: ToolDef = {
    description:
      "Remove a reference from one entry to another. " +
      "For auto refs (source:'auto'): both sides are removed, and the target " +
      "is added to refs_removed to prevent auto_re-linking. " +
      "For manual refs (source:'manual'): only the specified ref is removed.",
    args: {
      id: z.string().describe("Entry ID to remove a ref from."),
      target: z.string().describe("Target entry ID to unref."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id || !args.target) return "\u274c unref requires 'id' and 'target'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const sourceFound = findEntry(ctx.memDir, args.id, ctx.config)
      if (!sourceFound) return `\u274c Source entry "${args.id}" not found.`
      if (!canWrite(agent, sourceFound.volume, ctx.config)) {
        return `\u274c Agent "${agent}" cannot write to volume "${sourceFound.volume}".`
      }

      const volume = sourceFound.volume
      const entries = readJsonl(ctx.memDir, volume)
      const source = entries.find(e => e.id === sourceFound.entry.id)
      if (!source) return `❌ Source entry "${sourceFound.entry.id}" not found in ${volume}.`

      // Match ref target in both display and short format
      const targetStored = parseDisplayId(args.target, ctx.config)?.storedId ?? args.target
      const refIdx = source.refs?.findIndex(r => r.target === args.target || r.target === targetStored) ?? -1
      if (refIdx === -1) {
        // Already unref'd — check refs_removed
        if (source.refs_removed?.includes(args.target)) {
          return `\u274c [${args.id}] is already unref'd from [${args.target}].`
        }
        return `\u274c No ref from [${args.id}] to [${args.target}].`
      }

      const ref = source.refs![refIdx]
      const changedIds = [source.id]

      if (ref.source === "auto") {
        // CL-10 + CL-12: remove from both sides, add to refs_removed
        source.refs!.splice(refIdx, 1)
        if (!source.refs_removed) source.refs_removed = []
        source.refs_removed.push(args.target)

        // Remove reverse auto ref from target (CL-10)
        // ref.target may be displayId or short format — find target entry
        const targetEntryId = parseDisplayId(ref.target, ctx.config)?.storedId ?? ref.target
        const target = entries.find(e => e.id === targetEntryId)
        if (target?.refs) {
          target.refs = target.refs.filter(
            r => !((r.target === args.id || r.target === sourceFound.entry.id) && r.source === "auto")
          )
          target.updated = today()
          changedIds.push(target.id)
        }
      } else {
        // CL-12: manual ref — just remove, no refs_removed
        source.refs!.splice(refIdx, 1)
      }

      source.updated = today()

      // Write all changed entries
      writeEntries(ctx.memDir, volume, entries, ctx.config)
      for (const cid of changedIds) {
        const e = entries.find(x => x.id === cid)
        if (e) writeEntryMd(ctx.memDir, volume, e)
      }

      const commitHash = gitCommit(
        ctx.memDir, volume,
        `unref: ${args.id} ⊥ ${args.target}`,
        ctx.config, changedIds,
      )

      const refType = ref.source === "auto" ? "auto (bidirectional)" : "manual"
      return [
        `Unref'd [${args.id}] ⊥ [${args.target}] (${refType})`,
        commitHash ? `Commit: ${commitHash}` : "",
      ].filter(Boolean).join("\n")
    },
  }

  return { create, show, revise, forget, history, ref, unref }
}
