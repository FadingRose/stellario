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
import { toDisplayId } from "./store.js"

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
  // Build lookup that matches both short id and display id
  const entryById = new Map<string, MemoryEntry>()
  for (const e of allEntries) {
    entryById.set(e.id, e)
    entryById.set(toDisplayId(e.id, e.volume), e)
  }

  for (const ref of source.refs) {
    if (ref.source !== "auto") continue

    const target = entryById.get(ref.target)
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
  // Build a set of all entry IDs (both short and display format) for lookup
  const volIds = new Set<string>()
  for (const e of allEntries) {
    volIds.add(e.id)
    volIds.add(toDisplayId(e.id, e.volume))
  }
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

  // Build lookup for add matching (both short and display id)
  const addLookup = new Map<string, MemoryEntry>()
  for (const e of entries) {
    addLookup.set(e.id, e)
    addLookup.set(toDisplayId(e.id, e.volume), e)
  }

  for (const pair of plan.add) {
    const e1 = addLookup.get(pair.entry1Id)
    const e2 = addLookup.get(pair.entry2Id)
    if (!e1 || !e2) continue
    if (!e1.refs) e1.refs = []
    if (!e2.refs) e2.refs = []
    // Store display ID in ref target (volume:number format)
    e1.refs.push({ target: toDisplayId(e2.id, e2.volume), reason: pair.reason, source: "auto" })
    e2.refs.push({ target: toDisplayId(e1.id, e1.volume), reason: pair.reason, source: "auto" })
    changed.add(pair.entry1Id)
    changed.add(pair.entry2Id)
  }

  // Build lookup for removal matching (both short and display id)
  const entryLookup = new Map<string, MemoryEntry>()
  for (const e of entries) {
    entryLookup.set(e.id, e)
    entryLookup.set(toDisplayId(e.id, e.volume), e)
  }

  for (const removal of plan.remove) {
    const e1 = entryLookup.get(removal.entry1Id)
    const e2 = entryLookup.get(removal.entry2Id)
    // Match both old format (storage id) and new format (display id)
    const targetsToRemove = new Set([removal.entry2Id])
    if (e2) targetsToRemove.add(toDisplayId(e2.id, e2.volume))
    if (e1?.refs) e1.refs = e1.refs.filter(
      r => !(targetsToRemove.has(r.target) && r.source === "auto")
    )
    const targetsToRemove2 = new Set([removal.entry1Id])
    if (e1) targetsToRemove2.add(toDisplayId(e1.id, e1.volume))
    if (e2?.refs) e2.refs = e2.refs.filter(
      r => !(targetsToRemove2.has(r.target) && r.source === "auto")
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
  // Match both old format (b.id) and new format (displayId)
  const bIds = new Set([b.id, toDisplayId(b.id, b.volume)])
  const aIds = new Set([a.id, toDisplayId(a.id, a.volume)])
  const aBlocked = a.refs_removed?.some(t => bIds.has(t))
  const bBlocked = b.refs_removed?.some(t => aIds.has(t))
  return !!(aBlocked || bBlocked)
}

export function hasAutoLink(a: MemoryEntry, b: MemoryEntry): boolean {
  // Match both old format (b.id) and new format (displayId)
  const bIds = new Set([b.id, toDisplayId(b.id, b.volume)])
  return !!a.refs?.some(r => bIds.has(r.target) && r.source === "auto")
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
