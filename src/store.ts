import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
  unlinkSync,
} from "fs"
import { randomUUID } from "crypto"
import { join } from "path"
import { z } from "zod"
import type { StellarioConfig, MemoryEntry, VolumeIndexEntry, MountRef } from "./types.js"
import { profileBehavior } from "./types.js"
import { getMemoryDir, getVolumeIdPrefix } from "./config.js"

// =============================================================================
// Text Utilities
// =============================================================================

export function today(): string {
  return new Date().toISOString().split("T")[0]
}

export function truncate(s: string, maxChars: number): string {
  if (s.length <= maxChars) return s
  return s.slice(0, maxChars) + "\u2026"
}

export function extractTitle(content: string): string {
  const lines = content.split("\n")
  const first = lines[0]?.trim() ?? ""
  if (first.length >= 5 && !first.startsWith("## ")) {
    return first.length > 60 ? first.slice(0, 57) + "..." : first
  }
  for (const line of lines) {
    const trimmed = line.trim()
    if (trimmed.startsWith("## ")) {
      return trimmed.slice(3).trim()
    }
  }
  return first.length > 60 ? first.slice(0, 57) + "..." : first
}

/**
 * Safely coerce a tool argument to a string array.
 * opencode may pass array params as JSON strings instead of actual arrays.
 */
export function ensureStringArray(value: unknown): string[] {
  if (Array.isArray(value)) return value
  if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) return parsed
    } catch {
      // Not valid JSON — treat as empty
    }
  }
  return []
}

/**
 * Safely coerce a tool argument to an array of any type.
 * opencode may pass array params as JSON strings instead of actual arrays.
 * After parsing, validates each element against an optional Zod schema.
 */
export function ensureArray<T>(value: unknown, elementSchema?: z.ZodType<T>): T[] {
  let arr: unknown[]
  if (Array.isArray(value)) {
    arr = value
  } else if (typeof value === "string") {
    try {
      const parsed = JSON.parse(value)
      if (Array.isArray(parsed)) {
        arr = parsed
      } else {
        return []
      }
    } catch {
      return []
    }
  } else {
    return []
  }

  if (!elementSchema) return arr as T[]

  // Validate each element with Zod, filter out invalid
  const result: T[] = []
  for (const item of arr) {
    const parsed = elementSchema.safeParse(item)
    if (parsed.success) {
      result.push(parsed.data)
    }
  }
  return result
}

export function dedupeTags(tags: string[]): string[] {
  const out: string[] = []
  const seen = new Set<string>()
  for (const raw of tags) {
    const tag = raw.trim().replace(/\s+/g, " ")
    if (!tag) continue
    const key = tag.toLowerCase()
    if (seen.has(key)) continue
    seen.add(key)
    out.push(tag)
  }
  return out
}

// =============================================================================
// Volume Index
// =============================================================================

const VOLUMES_INDEX_FILE = "volumes.jsonl"

export function readVolumeIndex(memDir: string): VolumeIndexEntry[] {
  const indexPath = join(memDir, VOLUMES_INDEX_FILE)
  if (!existsSync(indexPath)) return []

  const content = readFileSync(indexPath, "utf-8")
  if (!content.trim()) return []

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as VolumeIndexEntry)
}

function writeVolumeIndex(memDir: string, index: VolumeIndexEntry[]): void {
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })
  const indexPath = join(memDir, VOLUMES_INDEX_FILE)
  writeFileSync(
    indexPath,
    index.map((e) => JSON.stringify(e)).join("\n") + "\n",
    "utf-8",
  )
}

// =============================================================================
// JSONL Read/Write
// =============================================================================

function parseJsonlContent(content: string, volumeHint: string): MemoryEntry[] {
  if (!content.trim()) return []

  return content
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => {
      const entry = JSON.parse(line) as MemoryEntry
      if (typeof entry.tags === "string") {
        entry.tags = (entry.tags as unknown as string).split(",").map((s: string) => s.trim())
      } else if (!Array.isArray(entry.tags)) {
        entry.tags = []
      }
      if (!Array.isArray(entry.keywords)) {
        entry.keywords = []
      }
      if (!entry.volume) {
        entry.volume = volumeHint
      }
      // Normalize new fields for backward compatibility (CL-1)
      if (Array.isArray(entry.refs)) {
        for (const ref of entry.refs) {
          if (!ref.source) (ref as any).source = "manual"
        }
      }
      if (entry.refs_removed === undefined) {
        entry.refs_removed = []
      }
      if (!Array.isArray(entry.refs_removed)) {
        entry.refs_removed = []
      }
      return entry
    })
}

/**
 * Read all entries for a volume.
 * Supports index-aware multi-file volumes, single-file fallback,
 * native mounts (reads from source_path in global library), and
 * auto-mounts (sibling device volumes, set by resolveContext).
 */

// Ephemeral auto-mount registry: alias → source .jsonl path.
// Populated by resolveContext from Go resolve `siblings`. Lets readJsonl
// transparently read sibling-device volumes (readonly/frozen) without
// persisting anything to disk.
const _autoMounts = new Map<string, string>()

/**
 * Set the auto-mount map for the current resolution. Called by resolveContext.
 * Replaces any previous registration.
 */
export function setAutoMounts(mounts: Map<string, string>): void {
  _autoMounts.clear()
  for (const [alias, path] of mounts) _autoMounts.set(alias, path)
}

export function readJsonl(memDir: string, volume: string): MemoryEntry[] {
  // ── Auto-mount (sibling device volume): read directly from source path ──
  const autoSource = _autoMounts.get(volume)
  if (autoSource) {
    if (!existsSync(autoSource)) return []
    const content = readFileSync(autoSource, "utf-8")
    return parseJsonlContent(content, volume)
  }

  const indexEntry = readVolumeIndex(memDir).find((e) => e.volume === volume)

  // ── Native mount: read directly from source path ──
  if (indexEntry?.mount) {
    const sourcePath = indexEntry.mount.source_path
    if (!existsSync(sourcePath)) return []
    const content = readFileSync(sourcePath, "utf-8")
    return parseJsonlContent(content, volume)
  }

  if (indexEntry && indexEntry.files.length > 0) {
    const allEntries: MemoryEntry[] = []
    for (const file of indexEntry.files) {
      const filePath = join(memDir, file)
      if (!existsSync(filePath)) continue
      const content = readFileSync(filePath, "utf-8")
      allEntries.push(...parseJsonlContent(content, volume))
    }
    return allEntries
  }

  // Fallback: single file
  const filePath = join(memDir, `${volume}.jsonl`)
  if (!existsSync(filePath)) return []
  const content = readFileSync(filePath, "utf-8")
  return parseJsonlContent(content, volume)
}

/**
 * Write entries to a volume's primary JSONL file.
 * Optionally regenerates a companion .md for tracked volumes.
 */
export function writeEntries(
  memDir: string,
  volume: string,
  entries: MemoryEntry[],
  config: StellarioConfig,
): void {
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })

  // Defense-in-depth: refuse to write to mount volumes
  const indexEntry = readVolumeIndex(memDir).find((e) => e.volume === volume)
  if (indexEntry?.mount) {
    throw new Error(`Cannot write to mount volume "${volume}" (source: ${indexEntry.mount.source_path})`)
  }

  const primaryFile = primaryFileForVolume(memDir, volume)
  const jsonlPath = join(memDir, primaryFile)
  writeFileSync(
    jsonlPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf-8",
  )

  // .track/ per-entry md is still written for git history
  // volume aggregate .md is no longer generated (redundant with .track/)
}

function primaryFileForVolume(memDir: string, volume: string): string {
  const entry = readVolumeIndex(memDir).find((e) => e.volume === volume)
  if (entry && entry.files.length > 0) {
    return entry.files[entry.files.length - 1]
  }
  return `${volume}.jsonl`
}

// =============================================================================
// ID Generation
// =============================================================================

/**
 * Generate next ID for a volume.
 * - scratch profile: short hash (e.g., "d7f3a")
 * - all others: sequential prefix + nonce (e.g., "a42", "h03")
 *
 * In the device-relative model, IDs carry NO star suffix: each device writes
 * into its own device-id dir with a per-device nonce, so IDs are naturally
 * unique within their dir and need no suffix for cross-device disambiguation.
 * (The `star` param is accepted for API compatibility but ignored.)
 */
export function generateNextId(memDir: string, volume: string, config: StellarioConfig, star?: string): string {
  const def = config.volumes[volume]
  if (!def) throw new Error(`Unknown volume: ${volume}`)

  const behavior = profileBehavior(def.profile)

  if (!behavior.hasStableId) {
    return generateShortHashId(def)
  }

  const prefix = getVolumeIdPrefix(config, volume)

  const nonce = bumpNonce(memDir, volume)
  if (nonce !== null) {
    return `${prefix}${nonce}`
  }

  // Legacy fallback: scan max ID
  let maxNum = 0
  const allEntries = [
    ...readJsonl(memDir, volume),
    ...readJsonl(memDir, "archived"),
  ]

  for (const entry of allEntries) {
    const rawId = stripStarSuffix(entry.id.split(".")[0])
    if (rawId.startsWith(prefix)) {
      const num = parseInt(rawId.slice(prefix.length), 10)
      if (!isNaN(num) && num > maxNum) maxNum = num
    }
  }

  return `${prefix}${String(maxNum + 1).padStart(2, "0")}`
}

function generateShortHashId(def: { idPrefix?: string }): string {
  const uuid = randomUUID().replace(/-/g, "")
  const prefix = def.idPrefix || "d"
  return `${prefix}${uuid.slice(0, 4)}`
}

function bumpNonce(memDir: string, volume: string): number | null {
  const index = readVolumeIndex(memDir)
  const entry = index.find((e) => e.volume === volume)
  if (!entry) return null

  const nonce = entry.next_nonce
  entry.next_nonce = nonce + 1
  writeVolumeIndex(memDir, index)
  return nonce
}

// =============================================================================
// Display ID (namespace format: "volume:number")
// =============================================================================
//
// Storage IDs are short: "a01", "m02", "l04" (prefix + number).
// Display IDs include the volume name: "active:01", "meta:02", "layer:04".
//
// Agent-facing tools accept display IDs. Internal ref targets may store
// either format (old refs use short IDs, new refs use display IDs).
// findEntry handles both transparently.

/**
 * Strip star suffix from a stored ID.
 * "a06.Sirius" → "a06", "a06" → "a06", "d7f3a" → "d7f3a"
 * Only strips if the suffix starts with an uppercase letter (star names are capitalized).
 */
function stripStarSuffix(id: string): string {
  const dot = id.indexOf(".")
  if (dot > 0 && dot < id.length - 1 && id[dot + 1] === id[dot + 1].toUpperCase()) {
    return id.slice(0, dot)
  }
  return id
}

/**
 * Check if two IDs match, ignoring star suffixes.
 * Matches "a06" against "a06.Sirius" and vice versa.
 */
function idMatch(entryId: string, queryId: string): boolean {
  if (entryId === queryId) return true
  return stripStarSuffix(entryId) === stripStarSuffix(queryId)
}

/**
 * Convert a stored entry to its display ID: "volume:number".
 * Uses entry.volume field + id tail (strip first char = prefix).
 * Star suffix is stripped: "a06.Sirius" → "active:06".
 */
export function formatDisplayId(entry: MemoryEntry): string {
  return `${entry.volume}:${stripStarSuffix(entry.id).slice(1)}`
}

/**
 * Convert a stored id + volume name to display ID.
 * Star suffix is stripped: storedId "a06.Sirius" → "active:06".
 */
export function toDisplayId(storedId: string, volume: string): string {
  return `${volume}:${stripStarSuffix(storedId).slice(1)}`
}

/**
 * Check if an ID string is in display format (contains ":").
 */
export function isDisplayId(id: string): boolean {
  return id.includes(":")
}

/**
 * Parse a display ID ("active:01") into { volume, storedId }.
 * Uses config to resolve the volume's idPrefix for generating storedId.
 * Returns null if the display ID is malformed or volume unknown.
 */
export function parseDisplayId(
  displayId: string,
  config: StellarioConfig,
): { volume: string; storedId: string } | null {
  const colonIdx = displayId.indexOf(":")
  if (colonIdx === -1) return null

  const volume = displayId.slice(0, colonIdx)
  const num = displayId.slice(colonIdx + 1)
  const def = config.volumes[volume]
  if (!def) return null

  const prefix = def.idPrefix || volume.charAt(0)
  return { volume, storedId: `${prefix}${num}` }
}

// =============================================================================
// Lookup
// =============================================================================

/**
 * Find an entry by ID across all volumes.
 *
 * Accepts two formats:
 *   - Display format: "active:01" (preferred — direct volume lookup)
 *   - Short format: "a01" (legacy — uses prefix derivation for backward compat
 *     with old ref targets; may be ambiguous if prefixes collide)
 */
export function findEntry(
  memDir: string,
  id: string,
  config: StellarioConfig,
): { entry: MemoryEntry; volume: string } | null {
  // Display format: "volume:number" → direct lookup
  if (isDisplayId(id)) {
    const parsed = parseDisplayId(id, config)
    if (!parsed) return null
    const { volume, storedId } = parsed
    const entries = readJsonl(memDir, volume)
    const found = entries.find((e) => idMatch(e.id, storedId))
    if (found) return { entry: found, volume }
    // Also check archived (entry may have been forgotten)
    const archived = readJsonl(memDir, "archived")
    const archivedFound = archived.find((e) => idMatch(e.id, storedId))
    if (archivedFound) return { entry: archivedFound, volume: "archived" }
    return null
  }

  // Short format: "a01" → prefix derivation (legacy backward compat)
  const volumes = Object.keys(config.volumes)
  const candidateVolume = volumeFromId(id, config)
  const searchOrder = candidateVolume
    ? [candidateVolume, ...volumes.filter((v) => v !== candidateVolume)]
    : volumes

  searchOrder.push("archived")

  for (const vol of searchOrder) {
    const entries = readJsonl(memDir, vol)
    const found = entries.find((e) => idMatch(e.id, id))
    if (found) {
      return { entry: found, volume: vol }
    }
  }
  return null
}

/**
 * Guess volume name from entry ID prefix.
 */
function volumeFromId(id: string, config: StellarioConfig): string | null {
  const prefix = id.charAt(0)
  for (const [name, def] of Object.entries(config.volumes)) {
    const volPrefix = def.idPrefix || name.charAt(0)
    if (volPrefix === prefix) return name
  }
  return null
}

// =============================================================================
// Per-Entry Markdown Tracking (.track/{volume}/{id}.md)
// =============================================================================

/**
 * Format a single entry as a markdown file for git tracking.
 * These files exist purely for git history — they are never read by tools.
 */
export function formatEntryMdForTrack(entry: MemoryEntry): string {
  const lines: string[] = [
    `# ${entry.id}`,
    "",
    entry.content,
    "",
    `tags: ${entry.tags.join(" · ")}`,
    `keywords: ${entry.keywords.join(" · ")}`,
    `author: ${entry.author}`,
    `created: ${entry.created}`,
    `updated: ${entry.updated}`,
    "",
  ]
  return lines.join("\n")
}

/**
 * Return the .track/{volume} directory path, creating it if needed.
 */
export function ensureTrackVolumeDir(memDir: string, volume: string): string {
  const dir = join(memDir, ".track", volume)
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true })
  return dir
}

/**
 * Write a per-entry markdown file for git tracking.
 */
export function writeEntryMd(memDir: string, volume: string, entry: MemoryEntry): void {
  const dir = ensureTrackVolumeDir(memDir, volume)
  writeFileSync(join(dir, `${entry.id}.md`), formatEntryMdForTrack(entry), "utf-8")
}

/**
 * Remove a per-entry markdown file (called on forget).
 */
export function removeEntryMd(memDir: string, volume: string, id: string): void {
  const path = join(memDir, ".track", volume, `${id}.md`)
  if (existsSync(path)) unlinkSync(path)
}

/**
 * Get the path to a per-entry md file (for git operations).
 */
export function getEntryMdPath(volume: string, id: string): string {
  return `.track/${volume}/${id}.md`
}

// =============================================================================
// Native Mounts (global library cross-project references)
// =============================================================================
//
// Mounts are records in volumes.jsonl that point to another project's volume
// in the global library. No symlinks — readJsonl reads source_path directly.
// Mount entries are injected into config.volumes as frozen/readonly by
// resolveContext, making them transparent to all downstream tools.

/**
 * Read all mount references from the volume index.
 */
export function readMounts(memDir: string): Array<{ alias: string; mount: MountRef }> {
  const index = readVolumeIndex(memDir)
  const result: Array<{ alias: string; mount: MountRef }> = []
  for (const entry of index) {
    if (entry.mount) {
      result.push({ alias: entry.volume, mount: entry.mount })
    }
  }
  return result
}

/**
 * Add a native mount to the volume index.
 * Returns false if the alias already exists.
 */
export function addMount(
  memDir: string,
  alias: string,
  mount: MountRef,
): boolean {
  const index = readVolumeIndex(memDir)
  if (index.some(e => e.volume === alias)) return false

  index.push({
    volume: alias,
    files: [],
    next_nonce: 0,
    mount,
  })
  writeVolumeIndex(memDir, index)
  return true
}

/**
 * Remove a native mount from the volume index.
 * Returns the removed mount, or null if not found.
 * Refuses to remove non-mount entries (native volumes).
 */
export function removeMount(
  memDir: string,
  alias: string,
): MountRef | null {
  const index = readVolumeIndex(memDir)
  const idx = index.findIndex(e => e.volume === alias)
  if (idx === -1) return null
  if (!index[idx].mount) return null  // not a mount

  const removed = index.splice(idx, 1)[0]
  writeVolumeIndex(memDir, index)
  return removed.mount!
}

/**
 * Check if a volume name is a mount (vs native volume).
 */
export function isMountVolume(memDir: string, volume: string): boolean {
  const index = readVolumeIndex(memDir)
  return index.some(e => e.volume === volume && !!e.mount)
}
