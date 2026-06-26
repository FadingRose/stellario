/**
 * Local embedding for keywords semantic search.
 * Uses @huggingface/transformers with all-MiniLM-L6-v2.
 *
 * Model: ~22MB, 384 dimensions, English-optimized.
 * First call triggers model download + WASM compilation (~2-5s).
 * Subsequent calls use cached model (~50ms/query).
 *
 * GRACEFUL DEGRADATION:
 *   If the runtime does not support WASM or the model fails to load,
 *   all embedding functions fail softly — semantic search returns no results,
 *   while keyword indexing is silently skipped.
 *   Other tools (search, filter, show) continue to work normally.
 *
 * ENVIRONMENT VARIABLE:
 *   STELLARIO_EMBEDDING=off   — explicitly disable embedding
 *   STELLARIO_EMBEDDING=on    — force enable
 *   (unset)                   — auto-detect (default)
 */

import { readFileSync, writeFileSync, existsSync, mkdirSync } from "fs"
import { join } from "path"
import type { StellarioConfig } from "./types.js"
import { readJsonl } from "./store.js"

// =============================================================================
// Types
// =============================================================================

export interface KeywordIndexEntry {
  id: string
  keywords: string[]
  vectors: number[][] // one vector per keyword, same order as keywords
}

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
    const { pipeline: createPipeline } = await import("@huggingface/transformers")
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
let modelId = "Xenova/all-MiniLM-L6-v2"

/**
 * Configure the model ID. Called once during initialization from config.
 */
export function setModelId(id: string): void {
  modelId = id
}

async function ensureModel(): Promise<any> {
  if (modelReady && pipeline) return pipeline

  if (getEnvOverride() === "off" || _availability === "unavailable" || _availability === "disabled") {
    throw new Error(
      "Embedding is unavailable in this environment. " +
      "Install @huggingface/transformers to enable semantic search. " +
      "Falling back to text-only search." +
      (_availability === "disabled" ? " (disabled by STELLARIO_EMBEDDING=off)" : "")
    )
  }

  try {
    const { pipeline: createPipeline } = await import("@huggingface/transformers")
    pipeline = await createPipeline("feature-extraction", modelId, { dtype: "fp32" })
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

/**
 * Compute the maximum pairwise keyword similarity between two indexed entries.
 * Returns the best matching keyword pair and its score.
 * Used by auto_refs for semantic linking decisions.
 */
export function entryKeywordSimilarity(
  sourceKeywords: string[],
  sourceVectors: number[][],
  candidateKeywords: string[],
  candidateVectors: number[][],
): { score: number; kwPair: string } {
  let bestScore = 0
  let bestPair = ""
  for (let i = 0; i < sourceKeywords.length; i++) {
    for (let j = 0; j < candidateKeywords.length; j++) {
      const score = cosineSimilarity(sourceVectors[i], candidateVectors[j])
      if (score > bestScore) {
        bestScore = score
        bestPair = `${sourceKeywords[i]}≈${candidateKeywords[j]}`
      }
    }
  }
  return { score: bestScore, kwPair: bestPair }
}

// =============================================================================
// Keyword Index (JSONL)
// =============================================================================

const INDEX_FILE = "keywords-index.jsonl"

function indexPath(memDir: string): string {
  return join(memDir, INDEX_FILE)
}

/**
 * Read all entries from the keyword index.
 */
export function readIndex(memDir: string): KeywordIndexEntry[] {
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
export function writeIndex(memDir: string, entries: KeywordIndexEntry[]): void {
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })
  const path = indexPath(memDir)
  writeFileSync(
    path,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf-8",
  )
}

/**
 * Update or add a single entry's keyword vectors in the index.
 */
export async function updateEntryIndex(
  memDir: string,
  id: string,
  keywords: string[],
): Promise<void> {
  const entries = readIndex(memDir)

  if (keywords.length === 0) {
    const filtered = entries.filter((e) => e.id !== id)
    writeIndex(memDir, filtered)
    return
  }

  const vectors = await embedBatch(keywords)
  const newEntry: KeywordIndexEntry = { id, keywords, vectors }

  const idx = entries.findIndex((e) => e.id === id)
  if (idx >= 0) {
    entries[idx] = newEntry
  } else {
    entries.push(newEntry)
  }

  writeIndex(memDir, entries)
}

/**
 * Remove a single entry from the keyword index.
 */
export function removeEntryIndex(memDir: string, id: string): void {
  const entries = readIndex(memDir)
  const filtered = entries.filter((e) => e.id !== id)
  if (filtered.length < entries.length) {
    writeIndex(memDir, filtered)
  }
}

/**
 * Rebuild the entire index from scratch.
 * Reads all entries from all volumes and re-embeds keywords.
 */
export async function rebuildIndex(memDir: string, config: StellarioConfig): Promise<{ indexed: number; keywords: number }> {
  const allKeywords: Array<{ id: string; keywords: string[] }> = []

  for (const volume of Object.keys(config.volumes)) {
    const entries = readJsonl(memDir, volume)
    for (const entry of entries) {
      if (entry.keywords && entry.keywords.length > 0) {
        allKeywords.push({ id: entry.id, keywords: entry.keywords })
      }
    }
  }

  // Batch embed all keywords
  const indexEntries: KeywordIndexEntry[] = []
  for (const item of allKeywords) {
    const vectors = await embedBatch(item.keywords)
    indexEntries.push({ id: item.id, keywords: item.keywords, vectors })
  }

  writeIndex(memDir, indexEntries)

  const totalKeywords = indexEntries.reduce((sum, e) => sum + e.keywords.length, 0)
  return { indexed: indexEntries.length, keywords: totalKeywords }
}

/**
 * Check if the index exists and has entries.
 */
export function indexExists(memDir: string): boolean {
  const entries = readIndex(memDir)
  return entries.length > 0
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
 * Optionally includes extra index entries (e.g., from linked external volumes).
 */
export async function semanticSearch(
  memDir: string,
  query: string,
  limit: number = 20,
  extraIndex?: KeywordIndexEntry[],
): Promise<SemanticResult[]> {
  const queryVector = await embed(query)
  const localIndex = readIndex(memDir)
  const index = extraIndex && extraIndex.length > 0
    ? [...localIndex, ...extraIndex]
    : localIndex

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
