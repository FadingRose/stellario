/**
 * Local embedding for keyword semantic search.
 * Uses @huggingface/transformers with bge-small-zh-v1.5.
 *
 * Model: ~33MB, 512 dimensions, Chinese-optimized.
 * First call triggers model download + WASM compilation (~2-5s).
 * Subsequent calls use cached model (~50ms/query).
 *
 * GRACEFUL DEGRADATION:
 *   If @huggingface/transformers is not installed or the runtime does not
 *   support WASM, all embedding functions fail softly — semantic search
 *   is skipped, fzf-only search continues to work.
 *
 * ENVIRONMENT VARIABLE:
 *   STELLARIO_EMBEDDING=off   — explicitly disable embedding
 *   STELLARIO_EMBEDDING=on    — force enable (will still fail if package missing)
 *   (unset)                   — auto-detect (default)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import type { StellarioConfig } from "./types.js"

// =============================================================================
// Feature Probe — detect embedding availability at runtime
// =============================================================================

type Availability = "available" | "unavailable" | "disabled" | "unknown"
let _availability: Availability = "unknown"

function getEnvOverride(): "on" | "off" | undefined {
  const val = (process.env.STELLARIO_EMBEDDING || "").toLowerCase().trim()
  if (val === "on" || val === "1" || val === "true" || val === "yes") return "on"
  if (val === "off" || val === "0" || val === "false" || val === "no") return "off"
  return undefined
}

/**
 * Check whether the embedding engine is available.
 * Probes once on first call, then caches the result.
 */
export async function probeEmbeddingAvailability(): Promise<boolean> {
  if (getEnvOverride() === "off") {
    _availability = "disabled"
    return false
  }

  if (_availability === "available") return true
  if (_availability === "unavailable" || _availability === "disabled") return false

  try {
    await import("@huggingface/transformers")
    _availability = "available"
    return true
  } catch {
    _availability = "unavailable"
    return false
  }
}

/** Synchronous check — returns current cached state. */
export function getEmbeddingAvailability(): Availability {
  if (getEnvOverride() === "off") {
    _availability = "disabled"
  }
  return _availability
}

// =============================================================================
// Embedding Engine (lazy-loaded)
// =============================================================================

let pipeline: any = null
let modelReady = false

async function ensureModel(): Promise<any> {
  if (modelReady && pipeline) return pipeline

  if (getEnvOverride() === "off" || _availability === "unavailable" || _availability === "disabled") {
    throw new Error(
      "Embedding is unavailable. " +
      "Install @huggingface/transformers to enable semantic search." +
      (_availability === "disabled" ? " (disabled by STELLARIO_EMBEDDING=off)" : "")
    )
  }

  try {
    const { pipeline: createPipeline } = await import("@huggingface/transformers")
    pipeline = await createPipeline(
      "feature-extraction",
      "Xenova/bge-small-zh-v1.5",
      { quantized: true }
    )
    modelReady = true
    _availability = "available"
    return pipeline
  } catch (err) {
    _availability = "unavailable"
    throw new Error(
      "Embedding is unavailable. " +
      "Install @huggingface/transformers to enable semantic search."
    )
  }
}

/**
 * Embed a single text string into a vector.
 * Returns a normalized vector (unit length) for cosine similarity.
 */
export async function embed(text: string): Promise<number[]> {
  const pipe = await ensureModel()
  const output = await pipe(text, { pooling: "mean", normalize: true })
  return Array.from(output.data as Float32Array)
}

/**
 * Embed multiple texts in batch. More efficient than individual calls.
 */
export async function embedBatch(texts: string[]): Promise<number[][]> {
  const pipe = await ensureModel()
  const output = await pipe(texts, { pooling: "mean", normalize: true })
  const dims = output.dims as number[]
  const dim = dims[dims.length - 1]
  const data = output.data as Float32Array
  const results: number[][] = []
  for (let i = 0; i < texts.length; i++) {
    results.push(Array.from(data.slice(i * dim, (i + 1) * dim)))
  }
  return results
}

// =============================================================================
// Vector Math
// =============================================================================

/**
 * Cosine similarity between two pre-normalized vectors.
 * For normalized vectors, dot product = cosine similarity.
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  let sum = 0
  const len = Math.min(a.length, b.length)
  for (let i = 0; i < len; i++) {
    sum += a[i] * b[i]
  }
  return sum
}

// =============================================================================
// Keyword Index (JSONL)
// =============================================================================

export interface KeywordIndexEntry {
  id: string
  keywords: string[]
  vectors: number[][] // one vector per keyword, same order as keywords
}

const INDEX_FILE = "keywords-index.jsonl"

function indexPath(memDir: string): string {
  return join(memDir, INDEX_FILE)
}

/**
 * Read all entries from the keyword index.
 */
export function readKeywordIndex(memDir: string): KeywordIndexEntry[] {
  const path = indexPath(memDir)
  if (!existsSync(path)) return []
  const content = readFileSync(path, "utf-8")
  if (!content.trim()) return []
  return content
    .split("\n")
    .filter((line) => line.trim())
    .map((line) => JSON.parse(line) as KeywordIndexEntry)
}

/**
 * Write all entries to the keyword index.
 */
function writeKeywordIndex(memDir: string, entries: KeywordIndexEntry[]): void {
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })
  const path = indexPath(memDir)
  writeFileSync(
    path,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf-8"
  )
}

/**
 * Update or add a single entry's keyword vectors in the index.
 * Gracefully skips if embedding is unavailable.
 */
export async function updateKeywordIndex(
  memDir: string,
  id: string,
  keywords: string[]
): Promise<void> {
  if (keywords.length === 0) {
    // Remove entry if no keywords
    removeKeywordIndex(memDir, id)
    return
  }

  // Gracefully skip if embedding unavailable
  const available = await probeEmbeddingAvailability()
  if (!available) return

  const vectors = await embedBatch(keywords)
  const newEntry: KeywordIndexEntry = { id, keywords, vectors }

  const entries = readKeywordIndex(memDir)
  const idx = entries.findIndex((e) => e.id === id)
  if (idx >= 0) {
    entries[idx] = newEntry
  } else {
    entries.push(newEntry)
  }

  writeKeywordIndex(memDir, entries)
}

/**
 * Remove a single entry from the keyword index.
 */
export function removeKeywordIndex(memDir: string, id: string): void {
  const entries = readKeywordIndex(memDir)
  const filtered = entries.filter((e) => e.id !== id)
  if (filtered.length < entries.length) {
    writeKeywordIndex(memDir, filtered)
  }
}

/**
 * Rebuild the entire keyword index from scratch.
 */
export async function rebuildKeywordIndex(
  memDir: string,
  config: StellarioConfig
): Promise<{ indexed: number; keywords: number }> {
  const available = await probeEmbeddingAvailability()
  if (!available) {
    return { indexed: 0, keywords: 0 }
  }

  const { readJsonl } = await import("./store.js")
  const volumes = Object.keys(config.volumes)
  const allItems: Array<{ id: string; keywords: string[] }> = []

  for (const volume of volumes) {
    const entries = readJsonl(memDir, volume)
    for (const entry of entries) {
      if (entry.keywords && entry.keywords.length > 0) {
        allItems.push({ id: entry.id, keywords: entry.keywords })
      }
    }
  }

  const indexEntries: KeywordIndexEntry[] = []
  for (const item of allItems) {
    const vectors = await embedBatch(item.keywords)
    indexEntries.push({ id: item.id, keywords: item.keywords, vectors })
  }

  writeKeywordIndex(memDir, indexEntries)

  const totalKeywords = indexEntries.reduce((sum, e) => sum + e.keywords.length, 0)
  return { indexed: indexEntries.length, keywords: totalKeywords }
}

// =============================================================================
// Semantic Search
// =============================================================================

export interface SemanticResult {
  id: string
  score: number
  matchedKeyword: string
}

/**
 * Semantic search: embed query and find closest keyword vectors.
 * Returns entry IDs ranked by best keyword match score.
 */
export async function semanticSearch(
  memDir: string,
  query: string,
  limit: number = 20
): Promise<SemanticResult[]> {
  const queryVector = await embed(query)
  const index = readKeywordIndex(memDir)

  if (index.length === 0) return []

  const results: SemanticResult[] = []

  for (const entry of index) {
    let bestScore = -1
    let bestKeyword = ""

    for (let i = 0; i < entry.keywords.length; i++) {
      const kwVector = entry.vectors[i]
      const score = cosineSimilarity(queryVector, kwVector)
      if (score > bestScore) {
        bestScore = score
        bestKeyword = entry.keywords[i]
      }
    }

    if (bestScore > 0) {
      results.push({ id: entry.id, score: bestScore, matchedKeyword: bestKeyword })
    }
  }

  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit)
}
