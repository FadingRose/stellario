import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { existsSync } from "fs"
import type { ToolContext, MemoryEntry } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead } from "../permissions.js"
import { readJsonl, extractTitle, truncate } from "../store.js"

// =============================================================================
// Search Engine
// =============================================================================

interface SearchResult {
  entry: MemoryEntry
  volume: string
  score: number
}

/**
 * Text matching: check if query terms appear in content, tags, or keywords.
 * Returns a score based on match quality.
 */
function textMatch(entry: MemoryEntry, terms: string[]): number {
  const text = `${entry.content} ${entry.tags.join(" ")} ${(entry.keywords || []).join(" ")}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    const lower = term.toLowerCase()
    if (text.includes(lower)) {
      score += 1
      // Boost for tag match
      if (entry.tags.some(t => t.toLowerCase().includes(lower))) {
        score += 2
      }
      // Boost for keyword match
      if ((entry.keywords || []).some(k => k.toLowerCase().includes(lower))) {
        score += 1
      }
    }
  }
  return score
}

/**
 * Filter entries by tag requirements.
 */
function matchTags(entry: MemoryEntry, tags?: string[], tagsAny?: string[], tagsNot?: string[]): boolean {
  if (tags && tags.length > 0) {
    if (!tags.every(t => entry.tags.includes(t))) return false
  }
  if (tagsAny && tagsAny.length > 0) {
    if (!tagsAny.some(t => entry.tags.includes(t))) return false
  }
  if (tagsNot && tagsNot.length > 0) {
    if (tagsNot.some(t => entry.tags.includes(t))) return false
  }
  return true
}

// =============================================================================
// Tool Factory
// =============================================================================

export function createTelescopeTool() {
  const search = tool({
    description:
      "Unified search across memory entries. " +
      "Supports text matching, tag filtering, and keyword discovery. " +
      "Use returns='tags' or returns='keywords' to enumerate values.",
    args: {
      query: z.string().optional()
        .describe("Space-separated search terms. Omit for index/overview mode."),
      volumes: z.array(z.string()).optional()
        .describe("Volumes to search. Default: all readable volumes."),
      tags: z.array(z.string()).optional()
        .describe("AND filter: entries must have ALL these tags."),
      tags_any: z.array(z.string()).optional()
        .describe("OR filter: entries must have at least ONE of these tags."),
      tags_not: z.array(z.string()).optional()
        .describe("NOT filter: exclude entries with any of these tags."),
      limit: z.number().optional()
        .describe("Max results (default 20)."),
      returns: z.enum(["entries", "tags", "keywords"]).optional()
        .describe("What to return. 'entries' (default), 'tags' (enumerate tag values), 'keywords' (enumerate keywords)."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      if (!existsSync(ctx.memDir)) {
        return "Memory directory not found. Create entries first."
      }

      // Determine searchable volumes
      const allVolumes = Object.keys(ctx.config.volumes)
      const readable = allVolumes.filter(v => canRead(agent, v, ctx.config))
      // Also check archived
      const canReadArchived = true // archived is frozen with read: [all]
      const searchableVolumes = args.volumes
        ? args.volumes.filter(v => readable.includes(v) || (v === "archived" && canReadArchived))
        : [...readable, ...(canReadArchived ? ["archived"] : [])]

      // Collect all entries from searchable volumes
      const allEntries: Array<{ entry: MemoryEntry; volume: string }> = []
      for (const vol of searchableVolumes) {
        for (const entry of readJsonl(ctx.memDir, vol)) {
          allEntries.push({ entry, volume: vol })
        }
      }

      // ── Tag enumeration mode ──────────────────────────────────────────
      if (args.returns === "tags") {
        const tagCounts = new Map<string, number>()
        let filtered = allEntries
        if (args.tags || args.tags_any || args.tags_not) {
          filtered = filtered.filter(({ entry }) => matchTags(entry, args.tags, args.tags_any, args.tags_not))
        }
        if (args.query) {
          const prefix = args.query.toLowerCase()
          filtered = filtered.filter(({ entry }) =>
            entry.tags.some(t => t.toLowerCase().startsWith(prefix))
          )
        }
        for (const { entry } of filtered) {
          for (const tag of entry.tags) {
            tagCounts.set(tag, (tagCounts.get(tag) || 0) + 1)
          }
        }
        if (tagCounts.size === 0) return "No tags found."
        const sorted = [...tagCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.limit || 50)
        return sorted.map(([tag, count]) => `${tag} (${count})`).join("\n")
      }

      // ── Keyword enumeration mode ──────────────────────────────────────
      if (args.returns === "keywords") {
        const kwCounts = new Map<string, number>()
        let filtered = allEntries
        if (args.tags || args.tags_any || args.tags_not) {
          filtered = filtered.filter(({ entry }) => matchTags(entry, args.tags, args.tags_any, args.tags_not))
        }
        for (const { entry } of filtered) {
          for (const kw of (entry.keywords || [])) {
            kwCounts.set(kw, (kwCounts.get(kw) || 0) + 1)
          }
        }
        if (kwCounts.size === 0) return "No keywords found."
        const sorted = [...kwCounts.entries()].sort((a, b) => b[1] - a[1]).slice(0, args.limit || 50)
        return sorted.map(([kw, count]) => `${kw} (${count})`).join("\n")
      }

      // ── Entry search mode ─────────────────────────────────────────────
      let results: SearchResult[] = []

      // Tag-only filter (no query)
      if (!args.query && (args.tags || args.tags_any || args.tags_not)) {
        results = allEntries
          .filter(({ entry }) => matchTags(entry, args.tags, args.tags_any, args.tags_not))
          .map(({ entry, volume }) => ({ entry, volume, score: 1 }))
      }
      // Query-based search
      else if (args.query) {
        const terms = args.query.split(/\s+/).filter(Boolean)
        results = allEntries
          .filter(({ entry }) => matchTags(entry, args.tags, args.tags_any, args.tags_not))
          .map(({ entry, volume }) => ({
            entry,
            volume,
            score: textMatch(entry, terms),
          }))
          .filter(r => r.score > 0)
      }
      // No query, no tags — overview mode
      else {
        // Count per volume
        const counts = new Map<string, number>()
        for (const { volume } of allEntries) {
          counts.set(volume, (counts.get(volume) || 0) + 1)
        }
        const parts = [...counts.entries()].map(([v, c]) => `${v}: ${c}`)
        return `Memory overview (${allEntries.length} entries)\n${parts.join(", ")}`
      }

      // Sort by score desc, then by created desc
      results.sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score
        return (b.entry.created || "").localeCompare(a.entry.created || "")
      })

      const limit = args.limit || 20
      results = results.slice(0, limit)

      if (results.length === 0) return "No matching entries found."

      return results.map(({ entry, volume, score }) => {
        const title = extractTitle(entry.content)
        return `[${entry.id}] ${volume} ${score.toFixed(0)} \u2014 ${title}`
      }).join("\n")
    },
  })

  return { search }
}
