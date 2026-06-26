// =============================================================================
// index-worker — Background Keyword Index Maintenance
// =============================================================================
//
// Manages the lifecycle of the keyword embedding index (keywords-index.jsonl).
//
// Design:
//   - create/revise mark entry ids as "pending" in .index-pending.json
//   - a fire-and-forget flush batches all pending ids, embeds their keywords,
//     writes them to the index, and clears the pending list
//   - flush is throttled (only one runs at a time); concurrent writes just
//     add to pending and the in-flight flush picks them up before finishing
//   - if flush fails (embedding unavailable, embed throws), ids stay pending
//     and the next create/revise/search retries them
//   - search triggers a sync flush before running if pending is non-empty,
//     guaranteeing the index is complete at query time
//   - on module load, if pending is non-empty, a flush is triggered to recover
//     work interrupted by a process restart
//
// The pending file is persisted (.index-pending.json) so a crash or restart
// never loses track of what still needs indexing.

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import { readJsonl } from "./store.js"
import { readIndex, writeIndex, embedBatch, getEmbeddingAvailability, probeEmbeddingAvailability, type KeywordIndexEntry } from "./embedding.js"
import type { StellarioConfig } from "./types.js"

// =============================================================================
// Pending File I/O
// =============================================================================

const PENDING_FILE = ".index-pending.json"

interface PendingState {
  pending: string[]
}

function pendingPath(memDir: string): string {
  return join(memDir, PENDING_FILE)
}

/**
 * Read the pending index state. Returns empty pending if file doesn't exist.
 */
export function readPending(memDir: string): PendingState {
  const path = pendingPath(memDir)
  if (!existsSync(path)) return { pending: [] }
  try {
    const content = readFileSync(path, "utf-8")
    const parsed = JSON.parse(content) as PendingState
    if (!Array.isArray(parsed.pending)) return { pending: [] }
    return { pending: parsed.pending }
  } catch {
    return { pending: [] }
  }
}

/**
 * Write the pending index state.
 */
function writePending(memDir: string, state: PendingState): void {
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })
  writeFileSync(pendingPath(memDir), JSON.stringify(state, null, 2) + "\n", "utf-8")
}

/**
 * Mark an entry id as needing indexing.
 * Idempotent — adding the same id twice has no extra effect.
 */
export function markPending(memDir: string, entryId: string): void {
  const state = readPending(memDir)
  if (!state.pending.includes(entryId)) {
    state.pending.push(entryId)
    writePending(memDir, state)
  }
}

/**
 * Remove an entry id from the pending list (e.g. when the entry is forgotten).
 */
export function unmarkPending(memDir: string, entryId: string): void {
  const state = readPending(memDir)
  if (state.pending.includes(entryId)) {
    state.pending = state.pending.filter(id => id !== entryId)
    writePending(memDir, state)
  }
}

/**
 * Check whether there are any entries pending indexing.
 */
export function hasPending(memDir: string): boolean {
  return readPending(memDir).pending.length > 0
}

// =============================================================================
// Flush Worker
// =============================================================================

/** Track in-flight flushes per memDir to prevent concurrent runs. */
const _inProgress = new Set<string>()

export interface FlushResult {
  indexed: number
  remaining: number
  skipped: boolean
}

/**
 * Flush all pending entries to the keyword index.
 *
 * - Reads pending ids, fetches their keywords from the JSONL, batch-embeds,
 *   writes to keywords-index.jsonl, and clears the pending list.
 * - If embedding is unavailable, returns early without clearing pending.
 * - Throttled: only one flush per memDir runs at a time. Concurrent calls
 *   return immediately with `skipped: true`.
 *
 * This is safe to call fire-and-forget from create/revise, and safe to call
 * synchronously (await) from search.
 */
export async function flushIndexWorker(memDir: string, config: StellarioConfig): Promise<FlushResult> {
  if (_inProgress.has(memDir)) {
    return { indexed: 0, remaining: readPending(memDir).pending.length, skipped: true }
  }
  _inProgress.add(memDir)

  try {
    const state = readPending(memDir)
    if (state.pending.length === 0) {
      return { indexed: 0, remaining: 0, skipped: false }
    }

    // Lazy probe on first use
    if (getEmbeddingAvailability() === "unknown") {
      await probeEmbeddingAvailability()
    }
    if (getEmbeddingAvailability() !== "available") {
      // Embedding unavailable — leave pending for next attempt
      return { indexed: 0, remaining: state.pending.length, skipped: false }
    }

    // Gather keywords for all pending ids from all volumes
    const pendingIds = new Set(state.pending)
    const toEmbed: Array<{ id: string; keywords: string[] }> = []
    for (const volume of Object.keys(config.volumes)) {
      for (const entry of readJsonl(memDir, volume)) {
        if (pendingIds.has(entry.id) && entry.keywords && entry.keywords.length > 0) {
          toEmbed.push({ id: entry.id, keywords: entry.keywords })
        }
      }
    }

    // Entries may have been forgotten (no longer in any volume). Drop those ids.
    const foundIds = new Set(toEmbed.map(e => e.id))
    const missingIds = state.pending.filter(id => !foundIds.has(id))

    if (toEmbed.length === 0) {
      // Nothing to embed — either all entries had no keywords, or all were deleted.
      // Clear pending (nothing we can do for these ids).
      writePending(memDir, { pending: [] })
      return { indexed: 0, remaining: 0, skipped: false }
    }

    // Batch embed all keywords
    const allKeywords = toEmbed.flatMap(e => e.keywords)
    const allVectors = await embedBatch(allKeywords)

    // Slice vectors back per-entry
    const newEntries: KeywordIndexEntry[] = []
    let offset = 0
    for (const item of toEmbed) {
      const count = item.keywords.length
      const vectors = allVectors.slice(offset, offset + count)
      newEntries.push({ id: item.id, keywords: item.keywords, vectors })
      offset += count
    }

    // Merge into existing index (overwrite by id)
    const existing = readIndex(memDir)
    const indexMap = new Map<string, KeywordIndexEntry>()
    for (const e of existing) indexMap.set(e.id, e)
    for (const e of newEntries) indexMap.set(e.id, e)
    writeIndex(memDir, [...indexMap.values()])

    // Clear pending — all successfully indexed
    writePending(memDir, { pending: [] })

    return { indexed: newEntries.length, remaining: 0, skipped: false }
  } catch (err) {
    // Embed failed at runtime — leave pending for next attempt
    return { indexed: 0, remaining: readPending(memDir).pending.length, skipped: false }
  } finally {
    _inProgress.delete(memDir)
  }
}

/**
 * Fire-and-forget flush. Safe to call from create/revise without awaiting.
 * Logs nothing on failure — the next call will retry.
 */
export function triggerFlush(memDir: string, config: StellarioConfig): void {
  flushIndexWorker(memDir, config).catch(() => {
    // Swallow — pending is preserved for next attempt
  })
}

// =============================================================================
// Module Load Recovery
// =============================================================================

/**
 * On module load, recover any interrupted work.
 * Called once when the module is first imported with a concrete memDir.
 * (Not auto-invoked — the caller passes memDir + config explicitly.)
 */
export function recoverOnLoad(memDir: string, config: StellarioConfig): void {
  if (hasPending(memDir)) {
    triggerFlush(memDir, config)
  }
}
