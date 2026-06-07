import { z } from "zod"
import type { ToolContext, MemoryEntry, ToolDef, LinkedVolume } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead } from "../permissions.js"
import { readJsonl, extractTitle, truncate, ensureStringArray, getLinkedVolumes } from "../store.js"
import {
  probeEmbeddingAvailability,
  semanticSearch,
  rebuildIndex,
  indexExists,
  setModelId,
  readIndex,
  type KeywordIndexEntry,
} from "../embedding.js"
import { readLinkedVolume } from "./volume-link-defs.js"
import { existsSync, readFileSync, readlinkSync } from "fs"
import { join } from "path"

// =============================================================================
// Search Engine
// =============================================================================

interface SearchResult {
  entry: MemoryEntry
  volume: string
  score: number
}

/**
 * Enhanced fzf-style text matching.
 * Scores based on where the match is found (ID > tag > keyword > content).
 */
function fzfSignal(entry: MemoryEntry, terms: string[]): number {
  const contentLower = entry.content.toLowerCase()
  const tagsLower = entry.tags.map((t) => t.toLowerCase())
  const keywordsLower = (entry.keywords || []).map((k) => k.toLowerCase())
  const idLower = entry.id.toLowerCase()

  let totalScore = 0

  for (const term of terms) {
    const termLower = term.toLowerCase()
    let termScore = 0

    // ID exact match (highest signal)
    if (idLower === termLower) termScore += 10
    // Tag match
    for (const tag of tagsLower) {
      if (tag.includes(termLower)) { termScore += 6; break }
    }
    // Keyword match
    for (const kw of keywordsLower) {
      if (kw.includes(termLower)) { termScore += 5; break }
    }
    // Content match
    if (contentLower.includes(termLower)) termScore += 3

    totalScore += termScore
  }

  return totalScore
}

/** Legacy textMatch for backwards compatibility (unused but kept as reference). */
function textMatch(entry: MemoryEntry, terms: string[]): number {
  const text = `${entry.content} ${entry.tags.join(" ")} ${(entry.keywords || []).join(" ")}`.toLowerCase()
  let score = 0
  for (const term of terms) {
    const lower = term.toLowerCase()
    if (text.includes(lower)) {
      score += 1
      if (entry.tags.some(t => t.toLowerCase().includes(lower))) score += 2
      if ((entry.keywords || []).some(k => k.toLowerCase().includes(lower))) score += 1
    }
  }
  return score
}

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
// Tool Definition
// =============================================================================

export function getTelescopeToolDefs(): Record<string, ToolDef> {
  const search: ToolDef = {
    description:
      "Unified search across memory entries. " +
      "Supports text matching, semantic search, tag filtering, and keyword discovery. " +
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
      author: z.string().optional()
        .describe("Filter by entry author (exact match, case-insensitive)."),
    },
    async execute(args, context: ToolContext) {
      // Defensive: opencode may pass array params as JSON strings
      const queryVolumes = ensureStringArray(args.volumes)
      const queryTags = ensureStringArray(args.tags)
      const queryTagsAny = ensureStringArray(args.tags_any)
      const queryTagsNot = ensureStringArray(args.tags_not)

      const queryAuthor = args.author?.trim().toLowerCase() || undefined

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      if (!existsSync(ctx.memDir)) {
        return "Memory directory not found. Create entries first."
      }

      // Configure embedding model from config
      if (ctx.config.embedding?.model) {
        setModelId(ctx.config.embedding.model)
      }

      const allVolumes = Object.keys(ctx.config.volumes)
      const readable = allVolumes.filter(v => canRead(agent, v, ctx.config))
      const canReadArchived = true
      const searchableVolumes = queryVolumes.length > 0
        ? queryVolumes.filter(v => readable.includes(v) || (v === "archived" && canReadArchived))
        : [...readable, ...(canReadArchived ? ["archived"] : [])]

      let allEntries: Array<{ entry: MemoryEntry; volume: string }> = []
      for (const vol of searchableVolumes) {
        for (const entry of readJsonl(ctx.memDir, vol)) {
          allEntries.push({ entry, volume: vol })
        }
      }

      // ── Include linked external volumes ──
      const linked = getLinkedVolumes(ctx.memDir, agent)
      const linkedAliases: string[] = []
      for (const lv of linked) {
        try {
          const entries = readLinkedVolume(ctx.memDir, lv.alias)
          for (const entry of entries) {
            allEntries.push({ entry, volume: `linked:${lv.alias}` })
          }
          if (entries.length > 0) linkedAliases.push(lv.alias)
        } catch {
          // Broken symlink — skip
        }
      }

      // ── Merge external keyword indices for semantic search ──
      // Linked volumes have their keyword vectors in the external project's memDir.
      // We read them and make them available to semanticSearch via a merged approach.
      const linkedKeywordIndices: KeywordIndexEntry[] = []
      for (const lv of linked) {
        try {
          // The symlink points to {extMemDir}/{volume}.jsonl
          // Keywords index lives at {extMemDir}/keywords-index.jsonl
          // We resolve the external memDir by following the symlink's directory
          const symlinkPath = join(ctx.memDir, "linked", `${lv.alias}.jsonl`)
          const targetPath = readlinkSync(symlinkPath)
          const extMemDir = join(targetPath, "..") // parent of {volume}.jsonl
          const extIndexPath = join(extMemDir, "keywords-index.jsonl")
          if (existsSync(extIndexPath)) {
            const content = readFileSync(extIndexPath, "utf-8")
            if (content.trim()) {
              for (const line of content.split("\n").filter(l => l.trim())) {
                linkedKeywordIndices.push(JSON.parse(line) as KeywordIndexEntry)
              }
            }
          }
        } catch {
          // Best effort
        }
      }

      // ── Author filter (applies to all modes) ──
      if (queryAuthor) {
        allEntries = allEntries.filter(({ entry }) =>
          entry.author?.toLowerCase() === queryAuthor
        )
      }

      // Tag enumeration mode
      if (args.returns === "tags") {
        const tagCounts = new Map<string, number>()
        let filtered = allEntries
        if (queryTags.length || queryTagsAny.length || queryTagsNot.length) {
          filtered = filtered.filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))
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

      // Keyword enumeration mode
      if (args.returns === "keywords") {
        // Semantic keyword discovery (if embedding available + query provided)
        if (args.query) {
          const embeddingAvailable = await probeEmbeddingAvailability()
          if (embeddingAvailable) {
            // Auto-rebuild index if empty
            if (!indexExists(ctx.memDir)) {
              try {
                await rebuildIndex(ctx.memDir, ctx.config)
              } catch {
                // Graceful degradation — fall through to substring matching
              }
            }

            try {
              const semResults = await semanticSearch(ctx.memDir, args.query, (args.limit || 50) * 2, linkedKeywordIndices.length > 0 ? linkedKeywordIndices : undefined)
              if (semResults.length > 0) {
                // Build keyword scores from semantic results
                const kwScores = new Map<string, number>()
                for (const r of semResults) {
                  kwScores.set(r.matchedKeyword, Math.max(
                    kwScores.get(r.matchedKeyword) || 0,
                    r.score,
                  ))
                }
                const sorted = [...kwScores.entries()]
                  .sort((a, b) => b[1] - a[1])
                  .slice(0, args.limit || 50)
                return sorted.map(([kw, score]) => `${kw} (${(score * 100).toFixed(0)}%)`).join("\n")
              }
            } catch {
              // Fall through to substring matching
            }
          }
        }

        // Fallback: substring keyword enumeration
        const kwCounts = new Map<string, number>()
        let filtered = allEntries
        if (queryTags.length || queryTagsAny.length || queryTagsNot.length) {
          filtered = filtered.filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))
        }
        if (args.query) {
          const queryLower = args.query.toLowerCase()
          filtered = filtered.filter(({ entry }) =>
            (entry.keywords || []).some(k => k.toLowerCase().includes(queryLower))
          )
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

      // Entry search mode
      let results: SearchResult[] = []

      if (!args.query && (queryTags.length || queryTagsAny.length || queryTagsNot.length)) {
        results = allEntries
          .filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))
          .map(({ entry, volume }) => ({ entry, volume, score: 1 }))
      }
      else if (args.query) {
        const terms = args.query.split(/\s+/).filter(Boolean)

        // Fzf signal (text matching)
        const fzfResults = allEntries
          .filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))
          .map(({ entry, volume }) => ({
            entry,
            volume,
            score: fzfSignal(entry, terms),
          }))

        // Semantic signal (optional)
        const embeddingAvailable = await probeEmbeddingAvailability()
        const semanticScores = new Map<string, number>()

        if (embeddingAvailable) {
          // Auto-rebuild index if empty
          if (!indexExists(ctx.memDir)) {
            try {
              await rebuildIndex(ctx.memDir, ctx.config)
            } catch {
              // Graceful degradation — fzf only
            }
          }

          try {
            const query = terms.join(" ").slice(0, 50)
            const semResults = await semanticSearch(ctx.memDir, query, allEntries.length * 2, linkedKeywordIndices.length > 0 ? linkedKeywordIndices : undefined)
            for (const r of semResults) {
              // Normalize semantic score to [0, 10] range
              const normalized = r.score * 10
              semanticScores.set(r.id, normalized)
            }
          } catch {
            // Graceful degradation — fzf only
          }
        }

        // Merge scores: fzf is primary (weight 1.0), semantic is secondary (weight 0.5)
        const entryMap = new Map<string, { entry: MemoryEntry; volume: string; fzfScore: number }>()
        for (const r of fzfResults) {
          entryMap.set(r.entry.id, { entry: r.entry, volume: r.volume, fzfScore: r.score })
        }

        for (const [id, semScore] of semanticScores) {
          if (entryMap.has(id)) {
            // Entry already has fzf score — merge
            const existing = entryMap.get(id)!
            existing.fzfScore += semScore * 0.5
          } else {
            // Entry only has semantic score — look up from allEntries
            const found = allEntries.find(({ entry }) => entry.id === id)
            if (found) {
              entryMap.set(id, { entry: found.entry, volume: found.volume, fzfScore: semScore * 0.5 })
            }
          }
        }

        results = [...entryMap.values()]
          .map(({ entry, volume, fzfScore }) => ({ entry, volume, score: fzfScore }))
          .filter(r => r.score > 0)
      }
      else {
        const counts = new Map<string, number>()
        for (const { volume } of allEntries) {
          counts.set(volume, (counts.get(volume) || 0) + 1)
        }
        const parts = [...counts.entries()].map(([v, c]) => `${v}: ${c}`)
        return `Memory overview (${allEntries.length} entries)\n${parts.join(", ")}`
      }

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
  }

  return { search }
}
