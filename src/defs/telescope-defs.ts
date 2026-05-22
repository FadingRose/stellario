import type { ToolContext, MemoryEntry, ToolDef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead } from "../permissions.js"
import { readJsonl, readVolumeIndex, extractTitle, truncate, findEntry, getActiveWorkspace, ensureStringArray } from "../store.js"
import { loadConfig, getMemoryDir, getWorkspaceVolume, getTrackedVolumes } from "../config.js"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { probeEmbeddingAvailability, semanticSearch } from "../embedding.js"

// =============================================================================
// Search Engine — Dual Signal (fzf + semantic)
// =============================================================================

interface SearchResult {
  entry: MemoryEntry
  volume: string
  score: number
}

/**
 * Fzf text matching signal.
 * Weights: ID exact (+10), tag (+6), keyword (+5), content (+3)
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
      "Dual-signal: fzf text matching + semantic keyword matching (parallel). " +
      "Supports tag filtering and keyword discovery. " +
      "Use returns='tags' or returns='keywords' to enumerate values.",
    args: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "Space-separated search terms. Omit for index/overview mode.",
        },
        volumes: {
          type: "array",
          items: { type: "string" },
          description: "Volumes to search. Default: all readable volumes.",
        },
        tags: {
          type: "array",
          items: { type: "string" },
          description: "AND filter: entries must have ALL these tags.",
        },
        tags_any: {
          type: "array",
          items: { type: "string" },
          description: "OR filter: entries must have at least ONE of these tags.",
        },
        tags_not: {
          type: "array",
          items: { type: "string" },
          description: "NOT filter: exclude entries with any of these tags.",
        },
        limit: {
          type: "number",
          description: "Max results (default 20).",
        },
        returns: {
          type: "string",
          enum: ["entries", "tags", "keywords"],
          description: "What to return. 'entries' (default), 'tags' (enumerate tag values), 'keywords' (enumerate keywords).",
        },
      },
    },
    async execute(args, context: ToolContext) {
      // Defensive: opencode may pass array params as JSON strings
      const queryVolumes = ensureStringArray(args.volumes)
      const queryTags = ensureStringArray(args.tags)
      const queryTagsAny = ensureStringArray(args.tags_any)
      const queryTagsNot = ensureStringArray(args.tags_not)

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      if (!existsSync(ctx.memDir)) {
        return "Memory directory not found. Create entries first."
      }

      const allVolumes = Object.keys(ctx.config.volumes)
      const readable = allVolumes.filter(v => canRead(agent, v, ctx.config))
      const canReadArchived = true
      const searchableVolumes = queryVolumes.length > 0
        ? queryVolumes.filter(v => readable.includes(v) || (v === "archived" && canReadArchived))
        : [...readable, ...(canReadArchived ? ["archived"] : [])]

      const allEntries: Array<{ entry: MemoryEntry; volume: string }> = []
      for (const vol of searchableVolumes) {
        for (const entry of readJsonl(ctx.memDir, vol)) {
          allEntries.push({ entry, volume: vol })
        }
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
        // With query: semantic discovery via embedding
        if (args.query) {
          const embeddingAvailable = await probeEmbeddingAvailability()

          if (embeddingAvailable) {
            const keywordScores = new Map<string, number>()
            try {
              const semResults = await semanticSearch(ctx.memDir, args.query, (args.limit || 50) * 3)
              for (const r of semResults) {
                keywordScores.set(r.matchedKeyword, Math.max(
                  keywordScores.get(r.matchedKeyword) || 0,
                  r.score,
                ))
              }
            } catch {
              // Graceful degradation
            }

            if (keywordScores.size === 0) {
              // Fallback to substring matching
              return keywordSubstringDiscovery(allEntries, queryTags, queryTagsAny, queryTagsNot, args.query, args.limit || 50)
            }

            const sorted = [...keywordScores.entries()].sort((a, b) => b[1] - a[1])
            const shown = sorted.slice(0, args.limit || 50)
            const lines: string[] = []
            lines.push(`## Keywords semantic discovery (related to "${args.query}")`)
            lines.push("")
            for (const [kw, score] of shown) {
              lines.push(`  ${kw} (${(score * 100).toFixed(0)}%)`)
            }
            return lines.join("\n")
          }

          // No embedding: substring fallback
          return keywordSubstringDiscovery(allEntries, queryTags, queryTagsAny, queryTagsNot, args.query, args.limit || 50)
        }

        // No query: enumerate all keywords with frequency ranking
        const kwCounts = new Map<string, number>()
        let filtered = allEntries
        if (queryTags.length || queryTagsAny.length || queryTagsNot.length) {
          filtered = filtered.filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))
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

      // ── Entry search mode (fzf + semantic dual signal) ──

      let results: SearchResult[] = []

      if (!args.query && (queryTags.length || queryTagsAny.length || queryTagsNot.length)) {
        // Tag-only filter (no scoring)
        results = allEntries
          .filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))
          .map(({ entry, volume }) => ({ entry, volume, score: 1 }))
      }
      else if (args.query) {
        const terms = args.query.split(/\s+/).filter(Boolean)

        // Filter by tags first
        const tagged = allEntries
          .filter(({ entry }) => matchTags(entry, queryTags, queryTagsAny, queryTagsNot))

        // Fzf signal
        const fzfScores = new Map<string, number>()
        for (const { entry } of tagged) {
          const score = fzfSignal(entry, terms)
          if (score > 0) {
            fzfScores.set(entry.id, score)
          }
        }

        // Semantic signal (optional, graceful degradation)
        let semanticScores = new Map<string, number>()
        const embeddingAvailable = await probeEmbeddingAvailability()
        if (embeddingAvailable) {
          try {
            const query = terms.join(" ").slice(0, 50)
            const semResults = await semanticSearch(ctx.memDir, query, (args.limit || 20) * 2)
            for (const r of semResults) {
              // Normalize semantic score to [0, 10] range
              const normalized = r.score * 10
              semanticScores.set(r.id, normalized)
            }
          } catch {
            // Graceful degradation — fzf only
          }
        }

        // Merge scores
        const mergedScores = new Map<string, number>()
        const allIds = new Set([...fzfScores.keys(), ...semanticScores.keys()])
        for (const id of allIds) {
          const fzf = fzfScores.get(id) || 0
          const sem = semanticScores.get(id) || 0
          // Weight: fzf is primary (1.0), semantic is secondary (0.5)
          mergedScores.set(id, fzf + sem * 0.5)
        }

        // Build results
        const entryMap = new Map<string, { volume: string; entry: MemoryEntry }>()
        for (const item of tagged) {
          entryMap.set(item.entry.id, item)
        }

        for (const [id, score] of mergedScores) {
          const item = entryMap.get(id)
          if (!item) continue
          results.push({ entry: item.entry, volume: item.volume, score })
        }
      }
      else {
        // Index/overview mode
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

      // Show signal type indicator
      const embeddingAvailable = await probeEmbeddingAvailability()
      const signalLabel = embeddingAvailable ? "fzf+semantic" : "fzf"

      return results.map(({ entry, volume, score }) => {
        const title = extractTitle(entry.content)
        return `[${entry.id}] ${volume} ${score.toFixed(0)} \u2014 ${title}`
      }).join("\n")
    },
  }

  return { search }
}

// =============================================================================
// Keyword Substring Discovery (fallback when no embedding)
// =============================================================================

function keywordSubstringDiscovery(
  allEntries: Array<{ entry: MemoryEntry; volume: string }>,
  tagsFilter: string[],
  tagsAnyFilter: string[],
  tagsNotFilter: string[],
  query: string,
  limit: number,
): string {
  const counts = new Map<string, number>()
  const queryLower = query.toLowerCase()

  let filtered = allEntries
  if (tagsFilter.length || tagsAnyFilter.length || tagsNotFilter.length) {
    filtered = filtered.filter(({ entry }) => matchTags(entry, tagsFilter, tagsAnyFilter, tagsNotFilter))
  }

  for (const { entry } of filtered) {
    for (const kw of (entry.keywords || [])) {
      if (kw.toLowerCase().includes(queryLower)) {
        counts.set(kw, (counts.get(kw) || 0) + 1)
      }
    }
  }

  if (counts.size === 0) return `No keywords matching "${query}".`

  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1])
  const shown = sorted.slice(0, limit)
  const lines: string[] = []
  lines.push(`## Keywords discovery (substring: "${query}", ${sorted.length} unique)`)
  lines.push("")
  for (const [kw, count] of shown) {
    lines.push(`  ${kw} (${count})`)
  }
  return lines.join("\n")
}
