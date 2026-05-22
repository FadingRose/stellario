import {
  readFileSync,
  writeFileSync,
  existsSync,
  mkdirSync,
} from "fs"
import { randomUUID } from "crypto"
import { join } from "path"
import type { StellarioConfig, MemoryEntry, VolumeIndexEntry } from "./types.js"
import { profileBehavior } from "./types.js"
import { getMemoryDir, getVolumeIdPrefix, getTrackedVolumes } from "./config.js"

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
// Workspace Tracking
// =============================================================================

/**
 * Get the active workspace entry ID, or null.
 */
export function getActiveWorkspace(memDir: string, workspaceVolume: string): string | null {
  const index = readVolumeIndex(memDir)
  const entry = index.find((e) => e.volume === workspaceVolume)
  return entry?.active_workspace || null
}

/**
 * Set the active workspace entry ID.
 */
export function setActiveWorkspace(memDir: string, workspaceVolume: string, id: string): void {
  let index = readVolumeIndex(memDir)
  let entry = index.find((e) => e.volume === workspaceVolume)

  if (!entry) {
    entry = { volume: workspaceVolume, files: [`${workspaceVolume}.jsonl`], next_nonce: 1, active_workspace: id }
    index.push(entry)
  } else {
    entry.active_workspace = id
  }

  writeVolumeIndex(memDir, index)
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
      return entry
    })
}

/**
 * Read all entries for a volume.
 * Supports index-aware multi-file volumes and single-file fallback.
 */
export function readJsonl(memDir: string, volume: string): MemoryEntry[] {
  const indexEntry = readVolumeIndex(memDir).find((e) => e.volume === volume)

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

  const primaryFile = primaryFileForVolume(memDir, volume)
  const jsonlPath = join(memDir, primaryFile)
  writeFileSync(
    jsonlPath,
    entries.map((e) => JSON.stringify(e)).join("\n") + (entries.length > 0 ? "\n" : ""),
    "utf-8",
  )

  // Regenerate .md for tracked volumes
  const tracked = getTrackedVolumes(config)
  if (tracked.includes(volume)) {
    regenerateMd(memDir, volume, entries)
  }
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
 */
export function generateNextId(memDir: string, volume: string, config: StellarioConfig): string {
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
    if (entry.id.startsWith(prefix)) {
      const num = parseInt(entry.id.slice(prefix.length), 10)
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
// Lookup
// =============================================================================

/**
 * Find an entry by ID across all volumes.
 * Uses ID prefix for faster lookup when possible.
 */
export function findEntry(
  memDir: string,
  id: string,
  config: StellarioConfig,
): { entry: MemoryEntry; volume: string } | null {
  const volumes = Object.keys(config.volumes)
  // Try to guess volume from ID prefix
  const candidateVolume = volumeFromId(id, config)
  const searchOrder = candidateVolume
    ? [candidateVolume, ...volumes.filter((v) => v !== candidateVolume)]
    : volumes

  // Also check archived
  searchOrder.push("archived")

  for (const vol of searchOrder) {
    const entries = readJsonl(memDir, vol)
    const found = entries.find((e) => e.id === id)
    if (found) {
      return { entry: found, volume: found.volume || vol }
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
// Markdown Generation
// =============================================================================

function regenerateMd(memDir: string, volume: string, entries: MemoryEntry[]): void {
  const lines: string[] = [`# ${volume}`, ""]

  for (const entry of entries) {
    lines.push(`## ${entry.id}`)
    lines.push("")
    lines.push(entry.content)
    lines.push("")
    lines.push(`tags: \`${entry.tags.join(" \u00b7 ")}\``)
    if (entry.keywords && entry.keywords.length > 0) {
      lines.push(`keywords: \`${entry.keywords.join(" \u00b7 ")}\``)
    }
    if (entry.author) {
      lines.push(`author: ${entry.author}`)
    }
    lines.push("")
    lines.push("---")
    lines.push("")
  }

  writeFileSync(join(memDir, `${volume}.md`), lines.join("\n"), "utf-8")
}
