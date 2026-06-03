/**
 * Unit test for src/embedding.ts
 *
 * Run: npx tsx tests/embedding.test.ts
 *
 * Requires @huggingface/transformers installed (first run downloads model ~22MB).
 */

import { join } from "path"
import { mkdtempSync, rmSync } from "fs"
import { tmpdir } from "os"

import {
  probeEmbeddingAvailability,
  cosineSimilarity,
  embed,
  embedBatch,
  readIndex,
  updateEntryIndex,
  removeEntryIndex,
  rebuildIndex,
  indexExists,
  semanticSearch,
} from "../src/embedding.ts"

// ── Test harness ──────────────────────────────────────────────────────────────

let passed = 0
let failed = 0

function assert(condition: boolean, msg: string) {
  if (condition) {
    console.log(`  ✅ ${msg}`)
    passed++
  } else {
    console.log(`  ❌ ${msg}`)
    failed++
  }
}

function assertApprox(a: number, b: number, tolerance: number, msg: string) {
  assert(Math.abs(a - b) < tolerance, `${msg} (${a.toFixed(4)} ≈ ${b.toFixed(4)})`)
}

// ── Setup ─────────────────────────────────────────────────────────────────────

const TEST_DIR = mkdtempSync(join(tmpdir(), "stellario-embed-test-"))
console.log(`Test dir: ${TEST_DIR}\n`)

// Fake config for rebuildIndex
const fakeConfig = {
  volumes: {
    meta: { profile: "mutable" as const, boundaries: { read: ["all"], write: ["test"] } },
    active: { profile: "mutable" as const, boundaries: { read: ["all"], write: ["test"] } },
  },
  agents: { test: { display: "Test" } },
}

// ── Test 1: Probe ─────────────────────────────────────────────────────────────

console.log("=== Test 1: Probe Embedding Availability ===")

const avail = await probeEmbeddingAvailability()
assert(avail === true, "Embedding should be available")
console.log("")

if (!avail) {
  console.log("⚠️  Embedding not available — skipping remaining tests")
  console.log(`\nResults: ${passed} passed, ${failed} failed`)
  process.exit(failed > 0 ? 1 : 0)
}

// ── Test 2: Embed single text ─────────────────────────────────────────────────

console.log("=== Test 2: Embed Single Text ===")

const vec = await embed("hello world")
assert(Array.isArray(vec), "embed() returns an array")
assert(vec.length === 384, `Vector dimension is 384 (got ${vec.length})`)

// Check normalization (unit vector: ||v|| ≈ 1)
const norm = Math.sqrt(vec.reduce((sum, x) => sum + x * x, 0))
assertApprox(norm, 1.0, 0.01, "Vector is normalized (unit length)")
console.log("")

// ── Test 3: Embed batch ───────────────────────────────────────────────────────

console.log("=== Test 3: Embed Batch ===")

const batch = await embedBatch(["cat", "dog", "car"])
assert(batch.length === 3, "embedBatch returns 3 vectors")
assert(batch[0].length === 384, "Each vector is 384-dim")
console.log("")

// ── Test 4: Cosine Similarity ─────────────────────────────────────────────────

console.log("=== Test 4: Cosine Similarity ===")

const catVec = await embed("cat")
const dogVec = await embed("dog")
const carVec = await embed("car")

const catDog = cosineSimilarity(catVec, dogVec)
const catCar = cosineSimilarity(catVec, carVec)

assert(catDog > catCar, `"cat" ≈ "dog" (${catDog.toFixed(3)}) > "cat" ≈ "car" (${catCar.toFixed(3)})`)
assert(catDog > 0.3, `"cat"-"dog" similarity is significant (> 0.3)`)
console.log("")

// ── Test 5: Index Write & Read ────────────────────────────────────────────────

console.log("=== Test 5: Index Write & Read ===")

await updateEntryIndex(TEST_DIR, "e01", ["architecture", "microservices", "database"])
await updateEntryIndex(TEST_DIR, "e02", ["authentication", "JWT", "security"])
await updateEntryIndex(TEST_DIR, "e03", ["deployment", "Kubernetes", "Docker"])

const index = readIndex(TEST_DIR)
assert(index.length === 3, `Index has 3 entries (got ${index.length})`)
assert(index[0].keywords.length === 3, "First entry has 3 keywords")
assert(index[0].vectors.length === 3, "First entry has 3 vectors")
assert(index[0].vectors[0].length === 384, "Each vector is 384-dim")
assert(indexExists(TEST_DIR) === true, "indexExists returns true")
console.log("")

// ── Test 6: Index Upsert ──────────────────────────────────────────────────────

console.log("=== Test 6: Index Upsert ===")

await updateEntryIndex(TEST_DIR, "e01", ["architecture", "event-driven"]) // changed keywords
const updated = readIndex(TEST_DIR)
const e01 = updated.find(e => e.id === "e01")
assert(e01 !== undefined, "e01 still exists after upsert")
assert(e01!.keywords.length === 2, `e01 now has 2 keywords (got ${e01!.keywords.length})`)
assert(e01!.keywords.includes("event-driven"), "e01 has new keyword 'event-driven'")
assert(!e01!.keywords.includes("microservices"), "e01 no longer has 'microservices'")
console.log("")

// ── Test 7: Semantic Search ───────────────────────────────────────────────────

console.log("=== Test 7: Semantic Search ===")

// "how to deploy containers" should match e03 (deployment/Kubernetes/Docker)
const results1 = await semanticSearch(TEST_DIR, "how to deploy containers", 10)
assert(results1.length > 0, "Semantic search returns results")
const topId1 = results1[0]?.id
assert(topId1 === "e03", `Top result is e03 (got ${topId1}) — "deploy containers" ≈ "deployment/Kubernetes/Docker"`)
console.log(`  Top result: [${topId1}] score=${results1[0].score.toFixed(3)} keyword="${results1[0].matchedKeyword}"`)

// "user login protection" should match e02 (authentication/JWT/security)
const results2 = await semanticSearch(TEST_DIR, "user login protection", 10)
const topId2 = results2[0]?.id
assert(topId2 === "e02", `Top result is e02 (got ${topId2}) — "user login protection" ≈ "authentication/security"`)

// "system design structure" should match e01 (architecture)
const results3 = await semanticSearch(TEST_DIR, "system design structure", 10)
const topId3 = results3[0]?.id
assert(topId3 === "e01", `Top result is e01 (got ${topId3}) — "system design structure" ≈ "architecture"`)
console.log("")

// ── Test 8: Remove from Index ─────────────────────────────────────────────────

console.log("=== Test 8: Remove from Index ===")

removeEntryIndex(TEST_DIR, "e02")
const afterRemove = readIndex(TEST_DIR)
assert(afterRemove.length === 2, `Index has 2 entries after remove (got ${afterRemove.length})`)
assert(!afterRemove.find(e => e.id === "e02"), "e02 is gone from index")

const resultsAfterRemove = await semanticSearch(TEST_DIR, "password authentication", 10)
assert(!resultsAfterRemove.find(r => r.id === "e02"), "e02 no longer appears in search results")
console.log("")

// ── Test 9: Empty keywords removes from index ─────────────────────────────────

console.log("=== Test 9: Empty Keywords Removes Entry ===")

await updateEntryIndex(TEST_DIR, "e03", []) // remove keywords
const afterEmpty = readIndex(TEST_DIR)
assert(afterEmpty.length === 1, `Index has 1 entry after emptying keywords (got ${afterEmpty.length})`)
assert(afterEmpty[0].id === "e01", "Only e01 remains")
console.log("")

// ── Cleanup ───────────────────────────────────────────────────────────────────

rmSync(TEST_DIR, { recursive: true, force: true })

// ── Summary ───────────────────────────────────────────────────────────────────

console.log("═".repeat(50))
console.log(`Results: ${passed} passed, ${failed} failed`)
console.log("═".repeat(50))

// Note: Do not call process.exit() — vitest treats it as a suite failure.
// The test assertions above already cover correctness.
if (failed > 0) {
  throw new Error(`${failed} embedding test(s) failed`)
}
