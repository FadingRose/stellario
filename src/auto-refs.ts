// =============================================================================
// auto-refs — Automatic Bidirectional Linking Engine
// =============================================================================
//
// CL-8:  source:"auto" only created/cleaned by this engine
// CL-9:  refs_removed[] targets are never re-linked
// CL-10: auto links are bidirectional; unlinking one side removes both
// CL-11: auto_refs is same-volume only

import type { StellarioConfig, MemoryEntry } from "./types.js"
import { entryKeywordSimilarity, type KeywordIndexEntry } from "./embedding.js"

// =============================================================================
// Types
// =============================================================================

export interface AutoRefPair {
  entry1Id: string
  entry2Id: string
  reason: string
}

export interface AutoRefRemove {
  entry1Id: string
  entry2Id: string
}

export interface AutoRefsPlan {
  add: AutoRefPair[]
  remove: AutoRefRemove[]
  gcRefsRemoved: string[]
}

// =============================================================================
// Public API (pure functions, no IO)
// =============================================================================

/**
 * Compute auto-refs for a source entry. Pure function — caller provides all data.
 *
 * CL-8:  Only adds source:"auto" references
 * CL-9:  Respects refs_removed on BOTH sides
 * CL-10: All additions/removals are bidirectional
 * CL-11: Same-volume only (caller passes entries from a single volume)
 */
export function computeAutoRefs(
  source: MemoryEntry,
  allEntries: MemoryEntry[],
  config: StellarioConfig,
  embeddingAvailable: boolean,
  kwIndexMap: Map<string, KeywordIndexEntry>,
): AutoRefsPlan {
  const plan: AutoRefsPlan = { add: [], remove: [], gcRefsRemoved: [] }

  const volume = source.volume
  const def = config.volumes[volume]
  if (!def?.autoRefs?.enabled) return plan

  const threshold = def.autoRefs.threshold ?? 0.65

  // Normalize
  if (!source.refs) source.refs = []
  if (!source.refs_removed) source.refs_removed = []

  // 1. Find new auto-ref candidates
  for (const candidate of allEntries) {
    if (candidate.id === source.id) continue
    if (!candidate.refs) candidate.refs = []
    if (!candidate.refs_removed) candidate.refs_removed = []

    if (!hasTagOverlap(source, candidate)) continue
    if (isRefsRemovedBlocked(source, candidate)) continue
    if (hasAutoLink(source, candidate)) continue

    const kwResult = matchKeywords(source, candidate, kwIndexMap, embeddingAvailable)
    if (!kwResult) continue
    if (!kwResult.embeddingFallback && kwResult.score < threshold) continue

    const sharedTag = source.tags.find(t => candidate.tags.includes(t))!
    const reason = formatAutoReason(
      sharedTag, kwResult.kwPair, kwResult.score, kwResult.embeddingFallback,
    )

    plan.add.push({ entry1Id: source.id, entry2Id: candidate.id, reason })
  }

  // 2. Find stale auto refs to remove (CL-8 + CL-10)
  for (const ref of source.refs) {
    if (ref.source !== "auto") continue

    const target = allEntries.find(e => e.id === ref.target)
    if (!target) {
      plan.remove.push({ entry1Id: source.id, entry2Id: ref.target })
      continue
    }

    if (!hasTagOverlap(source, target)) {
      plan.remove.push({ entry1Id: source.id, entry2Id: ref.target })
      continue
    }

    const kwResult = matchKeywords(source, target, kwIndexMap, embeddingAvailable)
    if (!kwResult || (!kwResult.embeddingFallback && kwResult.score < threshold)) {
      plan.remove.push({ entry1Id: source.id, entry2Id: ref.target })
    }
  }

  // 3. GC refs_removed
  const volIds = new Set(allEntries.map(e => e.id))
  for (const tid of source.refs_removed) {
    if (!volIds.has(tid)) {
      plan.gcRefsRemoved.push(tid)
    }
  }

  return plan
}

/**
 * Apply an AutoRefsPlan to an in-memory entries array.
 * Mutates entries in-place. Returns the set of changed entry IDs.
 */
export function applyAutoRefsPlan(
  plan: AutoRefsPlan,
  entries: MemoryEntry[],
  sourceId: string,
): string[] {
  const changed = new Set<string>([sourceId])

  for (const pair of plan.add) {
    const e1 = entries.find(e => e.id === pair.entry1Id)
    const e2 = entries.find(e => e.id === pair.entry2Id)
    if (!e1 || !e2) continue
    if (!e1.refs) e1.refs = []
    if (!e2.refs) e2.refs = []
    e1.refs.push({ target: pair.entry2Id, reason: pair.reason, source: "auto" })
    e2.refs.push({ target: pair.entry1Id, reason: pair.reason, source: "auto" })
    changed.add(pair.entry1Id)
    changed.add(pair.entry2Id)
  }

  for (const removal of plan.remove) {
    const e1 = entries.find(e => e.id === removal.entry1Id)
    const e2 = entries.find(e => e.id === removal.entry2Id)
    if (e1?.refs) e1.refs = e1.refs.filter(
      r => !(r.target === removal.entry2Id && r.source === "auto")
    )
    if (e2?.refs) e2.refs = e2.refs.filter(
      r => !(r.target === removal.entry1Id && r.source === "auto")
    )
    changed.add(removal.entry1Id)
    if (e2) changed.add(removal.entry2Id)
  }

  const src = entries.find(e => e.id === sourceId)
  if (src && plan.gcRefsRemoved.length > 0 && src.refs_removed) {
    src.refs_removed = src.refs_removed.filter(
      t => !plan.gcRefsRemoved.includes(t)
    )
  }

  return [...changed]
}

// =============================================================================
// Helpers (exported for testing)
// =============================================================================

export function hasTagOverlap(a: MemoryEntry, b: MemoryEntry): boolean {
  return a.tags.some(t => b.tags.includes(t))
}

export function isRefsRemovedBlocked(a: MemoryEntry, b: MemoryEntry): boolean {
  const aBlocked = a.refs_removed?.includes(b.id)
  const bBlocked = b.refs_removed?.includes(a.id)
  return !!(aBlocked || bBlocked)
}

export function hasAutoLink(a: MemoryEntry, b: MemoryEntry): boolean {
  return !!a.refs?.some(r => r.target === b.id && r.source === "auto")
}

export function formatAutoReason(
  sharedTag: string,
  kwPair: string,
  score: number,
  fallback: boolean,
): string {
  if (fallback) {
    return `auto: shared tag:${sharedTag}, keyword:${kwPair} (exact match, embedding unavailable)`
  }
  return `auto: shared tag:${sharedTag}, kw:${kwPair} sim=${score.toFixed(2)}`
}

// =============================================================================
// Internal: keyword matching
// =============================================================================

interface KeywordMatchResult {
  score: number
  kwPair: string
  embeddingFallback: boolean
}

function matchKeywords(
  source: MemoryEntry,
  candidate: MemoryEntry,
  kwIndexMap: Map<string, KeywordIndexEntry>,
  embeddingAvailable: boolean,
): KeywordMatchResult | null {
  if (source.keywords.length === 0 || candidate.keywords.length === 0) return null

  if (embeddingAvailable) {
    const srcIdx = kwIndexMap.get(source.id)
    const candIdx = kwIndexMap.get(candidate.id)
    if (srcIdx && candIdx && srcIdx.vectors.length > 0 && candIdx.vectors.length > 0) {
      const { score, kwPair } = entryKeywordSimilarity(
        srcIdx.keywords, srcIdx.vectors,
        candIdx.keywords, candIdx.vectors,
      )
      if (score > 0) {
        return { score, kwPair, embeddingFallback: false }
      }
    }
  }

  // Fallback: exact keyword match
  const sharedKw = source.keywords.find(k => candidate.keywords.includes(k))
  if (sharedKw) {
    return { score: 0, kwPair: sharedKw, embeddingFallback: true }
  }

  return null
}
