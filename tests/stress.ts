/**
 * Stress test for Stellario semantic search.
 * Run: npx tsx tests/stress.ts
 */

import { join } from "path"
import { mkdtempSync, rmSync, statSync } from "fs"
import { tmpdir } from "os"

import {
  probeEmbeddingAvailability,
  embedBatch,
  updateEntryIndex,
  readIndex,
  semanticSearch,
  setModelId,
} from "../src/embedding.ts"
import type { StellarioConfig } from "../src/types.ts"
import { readJsonl, writeEntries } from "../src/store.js"

// ── Helpers ───────────────────────────────────────────────────────────────────

const NS_PER_MS = 1e6
function elapsed(start: bigint): number {
  return Number(process.hrtime.bigint() - start) / NS_PER_MS
}
function avg(arr: number[]): number {
  return arr.reduce((a, b) => a + b, 0) / arr.length
}
function p50(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length / 2)]
}
function rssMB(): number {
  return process.memoryUsage().rss / 1024 / 1024
}

// ── Test data ─────────────────────────────────────────────────────────────────

const TOPICS = [
  ["architecture", "microservices", "event-driven", "distributed-systems", "scalability"],
  ["database", "PostgreSQL", "schema", "normalization", "indexing"],
  ["authentication", "JWT", "OAuth", "security", "session"],
  ["REST", "API", "endpoints", "JSON", "HTTP"],
  ["deployment", "CI/CD", "Docker", "Kubernetes", "container"],
  ["testing", "unit-test", "integration", "coverage", "TDD"],
  ["caching", "Redis", "memoization", "CDN", "performance"],
  ["logging", "monitoring", "observability", "metrics", "alerting"],
  ["encryption", "TLS", "certificate", "hashing", "privacy"],
  ["frontend", "React", "component", "state-management", "responsive"],
  ["messaging", "queue", "Kafka", "async", "pub-sub"],
  ["configuration", "environment", "secrets", "feature-flags", "env"],
  ["networking", "DNS", "load-balancer", "proxy", "firewall"],
  ["storage", "S3", "blob", "file-system", "object-storage"],
  ["search", "Elasticsearch", "indexing", "full-text", "ranking"],
  ["graph", "Neo4j", "relationship", "traversal", "nodes"],
  ["machine-learning", "model", "training", "inference", "embedding"],
  ["streaming", "real-time", "WebSocket", "SSE", "data-pipeline"],
  ["identity", "SSO", "LDAP", "RBAC", "permissions"],
  ["documentation", "API-docs", "markdown", "developer-guide", "SDK"],
]

function makeKeywords(idx: number): string[] {
  return TOPICS[idx % TOPICS.length]
}

const TEST_QUERIES = [
  "how to deploy containers at scale",
  "user login security best practices",
  "database performance tuning",
  "real-time data streaming architecture",
  "machine learning model deployment",
]

// ── Setup ─────────────────────────────────────────────────────────────────────

const TEST_DIR = mkdtempSync(join(tmpdir(), "stellario-stress-"))
console.log(`Stress test dir: ${TEST_DIR}\n`)

const avail = await probeEmbeddingAvailability()
if (!avail) {
  console.log("Embedding not available")
  process.exit(1)
}

// Warm up
console.log("Warming up model...")
await embedBatch(["warmup"])
console.log(`RSS after warmup: ${rssMB().toFixed(0)}MB\n`)

const baselineRSS = rssMB()

// ══════════════════════════════════════════════════════════════════════════════
// Stress Test: Build + Search at increasing scales
// ══════════════════════════════════════════════════════════════════════════════

console.log("═".repeat(70))
console.log("  Entries | Build Time | Index Size | Search Avg | Search P50 | RSS Delta")
console.log("═".repeat(70))

let currentIndex: Map<string, string[]> = new Map()

for (const TARGET of [100, 500, 1000, 2000, 5000]) {
  // Reset
  rmSync(TEST_DIR, { recursive: true, force: true })
  const { mkdirSync } = await import("fs")
  mkdirSync(TEST_DIR, { recursive: true })
  currentIndex.clear()

  global.gc?.()
  const beforeBuild = rssMB()

  // ── Build index ──
  const buildStart = process.hrtime.bigint()

  // Batch embed for speed: embed all keywords first, then write index
  const allKeywords: Array<{ id: string; keywords: string[] }> = []
  for (let i = 0; i < TARGET; i++) {
    const id = `e${String(i).padStart(5, "0")}`
    const keywords = makeKeywords(i)
    allKeywords.push({ id, keywords })
  }

  // Embed in batches of 50 keywords at a time
  const BATCH_SIZE = 50
  const embedMap = new Map<string, { keywords: string[]; vectors: number[][] }>()

  for (let batch = 0; batch < allKeywords.length; batch += BATCH_SIZE) {
    const chunk = allKeywords.slice(batch, batch + BATCH_SIZE)
    // Flatten all keywords in this batch for batch embedding
    const flatKeywords: string[] = []
    const mapping: Array<{ id: string; count: number }> = []
    for (const item of chunk) {
      flatKeywords.push(...item.keywords)
      mapping.push({ id: item.id, count: item.keywords.length })
    }

    const vectors = await embedBatch(flatKeywords)

    // Reconstruct per-entry vectors
    let offset = 0
    for (const m of mapping) {
      const entryVectors = vectors.slice(offset, offset + m.count)
      embedMap.set(m.id, {
        keywords: allKeywords.find(a => a.id === m.id)!.keywords,
        vectors: entryVectors,
      })
      offset += m.count
    }
  }

  // Write index file directly
  const { writeFileSync } = await import("fs")
  const indexLines: string[] = []
  for (const [id, data] of embedMap) {
    indexLines.push(JSON.stringify({ id, keywords: data.keywords, vectors: data.vectors }))
  }
  writeFileSync(join(TEST_DIR, "keywords-index.jsonl"), indexLines.join("\n") + "\n")

  const buildTime = elapsed(buildStart)

  // ── Measure index file size ──
  const indexStat = statSync(join(TEST_DIR, "keywords-index.jsonl"))
  const indexSizeKB = indexStat.size / 1024
  const indexSizeMB = indexSizeKB / 1024

  // ── Search benchmark ──
  const searchTimes: number[] = []
  for (const query of TEST_QUERIES) {
    const start = process.hrtime.bigint()
    await semanticSearch(TEST_DIR, query, 20)
    searchTimes.push(elapsed(start))
  }

  const afterRSS = rssMB()

  const sizeStr = indexSizeMB >= 1
    ? `${indexSizeMB.toFixed(1)}MB`
    : `${indexSizeKB.toFixed(0)}KB`

  console.log(
    `  ${String(TARGET).padStart(6)} | ` +
    `${buildTime.toFixed(0).padStart(9)}ms | ` +
    `${sizeStr.padStart(10)} | ` +
    `${avg(searchTimes).toFixed(1).padStart(10)}ms | ` +
    `${p50(searchTimes).toFixed(1).padStart(9)}ms | ` +
    `+${(afterRSS - baselineRSS).toFixed(0).padStart(3)}MB`
  )

  // Also measure raw cosine scan without embed overhead
  if (TARGET === 1000) {
    const queryVec = (await embedBatch(["test query"]))[0]
    const index = readIndex(TEST_DIR)
    const scanStart = process.hrtime.bigint()
    // Replicate what semanticSearch does
    for (const entry of index) {
      for (let i = 0; i < entry.keywords.length; i++) {
        let sum = 0
        for (let j = 0; j < queryVec.length; j++) {
          sum += queryVec[j] * entry.vectors[i][j]
        }
        // result discarded, just measure compute
      }
    }
    const rawScan = elapsed(scanStart)
    console.log(`         └─ raw cosine scan (no I/O): ${rawScan.toFixed(1)}ms for ${index.length} entries`)
  }
}

console.log("═".repeat(70))
console.log("")

// ── Cleanup ───────────────────────────────────────────────────────────────────

rmSync(TEST_DIR, { recursive: true, force: true })

console.log("Stress test complete.")
