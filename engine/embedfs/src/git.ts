import { execFileSync } from "child_process"
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs"
import { join } from "path"
import type { StellarioConfig, MemoryEntry } from "./types.js"
import { profileBehavior } from "./types.js"
import { readJsonl, formatEntryMdForTrack, ensureTrackVolumeDir } from "./store.js"

/**
 * Git commit helper. Stages volume JSONL, volume MD, and any per-entry .track files.
 * After commit, attempts to push (tolerates network failures silently).
 * Returns short commit hash on success, null on failure or skipped.
 */
export function gitCommit(
  memDir: string,
  volume: string,
  message: string,
  config: StellarioConfig,
  entryIds?: string[],
): string | null {
  const def = config.volumes[volume]
  if (!def) return null
  if (!profileBehavior(def.profile).isTracked) return null

  try {
    const files = [`${volume}.jsonl`]
    if (entryIds && entryIds.length > 0) {
      for (const id of entryIds) {
        files.push(`.track/${volume}/${id}.md`)
      }
    }
    // -A handles add/modify/delete for per-entry md files (forget removes them)
    execFileSync("git", ["add", "-A", "--", ...files], { cwd: memDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", message], { cwd: memDir, stdio: "pipe" })
    const hash = execFileSync("git", ["rev-parse", "--short", "HEAD"], { cwd: memDir }).toString().trim()

    // Fire-and-forget push — tolerates network partition
    gitPush(memDir)

    return hash
  } catch {
    return null
  }
}

/**
 * Check if a git repo exists in the memory directory.
 */
export function isGitRepo(memDir: string): boolean {
  try {
    execFileSync("git", ["rev-parse", "--git-dir"], { cwd: memDir, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Initialize a git repo in the memory directory if one doesn't exist.
 */
export function initGitRepo(memDir: string): boolean {
  if (isGitRepo(memDir)) return false
  try {
    execFileSync("git", ["init"], { cwd: memDir, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

// =============================================================================
// Per-Entry Markdown Migration
// =============================================================================

const TRACK_MARKER = ".track/.migrated"

/**
 * Run migration once: generate per-entry .track/{volume}/{id}.md files
 * for all existing entries, then commit them. Idempotent (checks marker file).
 */
export function migrateTrackMd(
  memDir: string,
  config: StellarioConfig,
): { entries: number; migrated: boolean } {
  const markerPath = join(memDir, TRACK_MARKER)
  if (existsSync(markerPath)) return { entries: 0, migrated: false }

  const trackRoot = join(memDir, ".track")
  let count = 0

  for (const volume of Object.keys(config.volumes)) {
    const entries = readJsonl(memDir, volume)
    if (entries.length === 0) continue
    ensureTrackVolumeDir(memDir, volume)
    for (const entry of entries) {
      writeFileSync(
        join(trackRoot, volume, `${entry.id}.md`),
        formatEntryMdForTrack(entry),
        "utf-8",
      )
      count++
    }
  }

  // Also handle archived entries
  const archivedEntries = readJsonl(memDir, "archived")
  if (archivedEntries.length > 0) {
    ensureTrackVolumeDir(memDir, "archived")
    for (const entry of archivedEntries) {
      writeFileSync(
        join(trackRoot, "archived", `${entry.id}.md`),
        formatEntryMdForTrack(entry),
        "utf-8",
      )
      count++
    }
  }

  // Write marker
  if (!existsSync(trackRoot)) mkdirSync(trackRoot, { recursive: true })
  writeFileSync(markerPath, "", "utf-8")

  // Initial git commit for migrated files
  if (count > 0 && isGitRepo(memDir)) {
    try {
      execFileSync("git", ["add", "--", ".track/"], { cwd: memDir, stdio: "pipe" })
      execFileSync(
        "git",
        ["commit", "-m", `migrate: initial per-entry md tracking (${count} entries)`],
        { cwd: memDir, stdio: "pipe" },
      )
    } catch {
      // Non-critical — files are written, commit can happen next operation
    }
  }

  return { entries: count, migrated: true }
}

/**
 * Run git log for a specific entry's track file to get its revision history.
 */
export function gitLogEntry(
  memDir: string,
  volume: string,
  id: string,
  limit: number = 10,
): string | null {
  if (!isGitRepo(memDir)) return null

  try {
    const path = `.track/${volume}/${id}.md`
    const log = execFileSync(
      "git",
      ["log", "--oneline", `-${limit}`, "--", path],
      { cwd: memDir, stdio: "pipe" },
    ).toString().trim()
    return log || null
  } catch {
    return null
  }
}

// =============================================================================
// Auto Sync (push on commit, pull on session start)
// =============================================================================
//
// Tolerates network partition — all failures are silent.
// The global library (~/.stellario/) has a single git remote.
// Push: fire-and-forget after every commit.
// Pull: on session start, rebase local commits on top of remote.

/**
 * Push commits to remote. Silently fails on network error.
 * Uses rebase to avoid merge commits.
 */
export function gitPush(memDir: string): void {
  try {
    execFileSync("git", ["push", "origin", "HEAD"], { cwd: memDir, stdio: "pipe", timeout: 10000 })
  } catch {
    // Network partition, no remote, or auth failure — silent
  }
}

/**
 * Pull remote changes. Silently fails on network error.
 * Uses rebase to keep linear history.
 */
export function gitPull(memDir: string): void {
  try {
    execFileSync("git", ["pull", "--rebase", "origin", "HEAD"], { cwd: memDir, stdio: "pipe", timeout: 10000 })
  } catch {
    // Network partition, no remote, or conflict — silent
  }
}
