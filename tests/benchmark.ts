/**
 * Benchmark for Stellario semantic search.
 *
 * Run: npx tsx tests/benchmark.ts
 *
 * Tests:
 *   1. Embedding throughput (single + batch)
 *   2. Index write throughput
 *   3. Search latency (fzf vs semantic vs hybrid)
 *   4. Scaling behavior (10 / 50 / 200 / 500 entries)
 */

import { join } from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"

import {
  probeEmbeddingAvailability,
  embed,
  embedBatch,
  updateEntryIndex,
  removeEntryIndex,
  semanticSearch,
  readIndex,
} from "../src/embedding.ts"

import type { StellarioConfig } from "../src/types.ts"

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

function p95(arr: number[]): number {
  const sorted = [...arr].sort((a, b) => a - b)
  return sorted[Math.floor(sorted.length * 0.95)]
}

// Sample keyword pools for generating test data
const TOPICS = [
  ["architecture", "microservices", "event-driven", "distributed-systems"],
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
]

function makeKeywords(entryIdx: number): string[] {
  return TOPICS[entryIdx % TOPICS.length]
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const TEST_DIR = mkdtempSync(join(tmpdir(), "stellario-bench-"))
console.log(`Benchmark dir: ${TEST_DIR}\n`)

const avail = await probeEmbeddingAvailability()
if (!avail) {
  console.log("❌ Embedding not available — cannot run benchmark")
  process.exit(1)
}

// Warm up model (first call downloads + compiles)
console.log("🔥 Warming up model (first call may download ~22MB)...")
const _warmup = await embed("warmup")
console.log("")

// ══════════════════════════════════════════════════════════════════════════════
// Benchmark 1: Embedding Throughput
// ══════════════════════════════════════════════════════════════════════════════

console.log("═══ Benchmark 1: Embedding Throughput ═══")

// Single embed
const singleTimes: number[] = []
for (let i = 0; i < 20; i++) {
  const start = process.hrtime.bigint()
  await embed(`test query number ${i}`)
  singleTimes.push(elapsed(start))
}
console.log(`  Single embed (20x):
    avg: ${avg(singleTimes).toFixed(1)}ms
    p50: ${p50(singleTimes).toFixed(1)}ms
    p95: ${p95(singleTimes).toFixed(1)}ms`)

// Batch embed (size 4)
const batch4Times: number[] = []
for (let i = 0; i < 20; i++) {
  const texts = [`query ${i}a`, `query ${i}b`, `query ${i}c`, `query ${i}d`]
  const start = process.hrtime.bigint()
  await embedBatch(texts)
  batch4Times.push(elapsed(start))
}
console.log(`  Batch embed ×4 (20x):
    avg: ${avg(batch4Times).toFixed(1)}ms
    p50: ${p50(batch4Times).toFixed(1)}ms
    per-item: ${(avg(batch4Times) / 4).toFixed(1)}ms`)

// Batch embed (size 12)
const batch12Times: number[] = []
for (let i = 0; i < 10; i++) {
  const texts = Array.from({ length: 12 }, (_, j) => `batch query ${i}-${j}`)
  const start = process.hrtime.bigint()
  await embedBatch(texts)
  batch12Times.push(elapsed(start))
}
console.log(`  Batch embed ×12 (10x):
    avg: ${avg(batch12Times).toFixed(1)}ms
    per-item: ${(avg(batch12Times) / 12).toFixed(1)}ms`)
console.log("")

// ══════════════════════════════════════════════════════════════════════════════
// Benchmark 2: Index Write
// ══════════════════════════════════════════════════════════════════════════════

console.log("═══ Benchmark 2: Index Write ═══")

const writeTimes: number[] = []
for (let i = 0; i < 50; i++) {
  const keywords = makeKeywords(i)
  const start = process.hrtime.bigint()
  await updateEntryIndex(TEST_DIR, `e${String(i).padStart(3, "0")}`, keywords)
  writeTimes.push(elapsed(start))
}
console.log(`  updateEntryIndex (50 entries, 4-5 keywords each):
    avg: ${avg(writeTimes).toFixed(1)}ms
    p50: ${p50(writeTimes).toFixed(1)}ms
    p95: ${p95(writeTimes).toFixed(1)}ms`)

const indexSize = readIndex(TEST_DIR).length
console.log(`  Index now has ${indexSize} entries`)
console.log("")

// ══════════════════════════════════════════════════════════════════════════════
// Benchmark 3: Semantic Search Latency
// ══════════════════════════════════════════════════════════════════════════════

console.log("═══ Benchmark 3: Semantic Search Latency ═══")

const queries = [
  "how to deploy my application",
  "user authentication and security",
  "database query optimization",
  "frontend state management",
  "system monitoring and alerting",
  "event-driven message processing",
  "caching strategy for APIs",
  "continuous integration setup",
]

const searchTimes: number[] = []
for (const query of queries) {
  const start = process.hrtime.bigint()
  const results = await semanticSearch(TEST_DIR, query, 20)
  searchTimes.push(elapsed(start))
  console.log(`  "${query}" → ${results.length} results (${searchTimes[searchTimes.length - 1].toFixed(1)}ms, top: ${results[0]?.id || "none"})`)
}

console.log(`\n  Search stats (${indexSize} entries):
    avg: ${avg(searchTimes).toFixed(1)}ms
    p50: ${p50(searchTimes).toFixed(1)}ms
    p95: ${p95(searchTimes).toFixed(1)}ms`)
console.log("")

// ══════════════════════════════════════════════════════════════════════════════
// Benchmark 4: Scaling — search with different index sizes
// ══════════════════════════════════════════════════════════════════════════════

console.log("═══ Benchmark 4: Scaling ═══")

// Clean and rebuild with different sizes
for (const targetSize of [10, 50, 100, 200]) {
  // Reset
  rmSync(TEST_DIR, { recursive: true, force: true })
  const { mkdirSync } = await import("fs")
  mkdirSync(TEST_DIR, { recursive: true })

  // Build index
  for (let i = 0; i < targetSize; i++) {
    const keywords = makeKeywords(i)
    await updateEntryIndex(TEST_DIR, `e${String(i).padStart(3, "0")}`, keywords)
  }

  // Search benchmark
  const scaleTimes: number[] = []
  for (const query of queries) {
    const start = process.hrtime.bigint()
    await semanticSearch(TEST_DIR, query, 20)
    scaleTimes.push(elapsed(start))
  }

  console.log(`  ${String(targetSize).padStart(3)} entries: avg=${avg(scaleTimes).toFixed(1)}ms  p50=${p50(scaleTimes).toFixed(1)}ms  p95=${p95(scaleTimes).toFixed(1)}ms`)
}
console.log("")

// ══════════════════════════════════════════════════════════════════════════════
// Benchmark 5: Query embedding vs Index scan breakdown
// ══════════════════════════════════════════════════════════════════════════════

console.log("═══ Benchmark 5: Query Embedding vs Index Scan ═══")

// Rebuild 100-entry index
rmSync(TEST_DIR, { recursive: true, force: true })
const { mkdirSync: mkDir } = await import("fs")
mkDir(TEST_DIR, { recursive: true })
for (let i = 0; i < 100; i++) {
  await updateEntryIndex(TEST_DIR, `e${String(i).padStart(3, "0")}`, makeKeywords(i))
}

// Measure embed alone
const embedOnlyTimes: number[] = []
for (let i = 0; i < 10; i++) {
  const start = process.hrtime.bigint()
  await embed("test benchmark query")
  embedOnlyTimes.push(elapsed(start))
}

// Measure search (embed + scan)
const searchOnlyTimes: number[] = []
for (let i = 0; i < 10; i++) {
  const start = process.hrtime.bigint()
  await semanticSearch(TEST_DIR, "test benchmark query", 20)
  searchOnlyTimes.push(elapsed(start))
}

const embedAvg = avg(embedOnlyTimes)
const searchAvg = avg(searchOnlyTimes)
const scanAvg = searchAvg - embedAvg

console.log(`  Query embedding: ${embedAvg.toFixed(1)}ms`)
console.log(`  Full search:     ${searchAvg.toFixed(1)}ms`)
console.log(`  Index scan:      ${scanAvg.toFixed(1)}ms (calculated)`)
console.log(`  Breakdown:       ${(embedAvg / searchAvg * 100).toFixed(0)}% embed + ${(scanAvg / searchAvg * 100).toFixed(0)}% scan`)
console.log("")

// ── Cleanup ───────────────────────────────────────────────────────────────────

rmSync(TEST_DIR, { recursive: true, force: true })

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("═".repeat(50))
console.log("Benchmark complete")
console.log("═".repeat(50))
