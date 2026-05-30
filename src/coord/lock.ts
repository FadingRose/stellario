// =============================================================================
// Stellario — Coordination Lock
// =============================================================================
// Two layers:
//   1. Advisory file lock (mkdir-atomic) for serializing .jsonl / .json writes
//   2. Path lock map (locks.json) for project file path exclusions

import {
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
  rmSync,
  readdirSync,
} from "fs"
import { join } from "path"
import type { FileLock } from "./types.js"
import {
  DEFAULT_LOCK_TTL_MINUTES,
  LOCK_ACQUIRE_TIMEOUT_MS,
  LOCK_RETRY_INTERVAL_MS,
} from "./types.js"

// =============================================================================
// Advisory File Lock (inter-process mutex via mkdir)
// =============================================================================

const COORD_DIR = ".coord"

/**
 * Get the coordination lock directory path.
 */
function coordDir(memDir: string): string {
  return join(memDir, COORD_DIR)
}

/**
 * Ensure the coordination directory exists.
 */
function ensureCoordDir(memDir: string): void {
  const dir = coordDir(memDir)
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true })
  }
}

/**
 * Read the owner and timestamp from a lock directory.
 */
function readLockMeta(lockPath: string): { owner: string; acquired: number } | null {
  try {
    const metaPath = join(lockPath, "owner")
    if (!existsSync(metaPath)) return null
    const content = readFileSync(metaPath, "utf-8").trim()
    const parts = content.split("\n")
    return {
      owner: parts[0] || "unknown",
      acquired: parseInt(parts[1] || "0", 10),
    }
  } catch {
    return null
  }
}

/**
 * Acquire an advisory file lock for serializing writes to a specific file.
 * Uses mkdir atomicity on POSIX systems.
 *
 * @param memDir  Memory directory
 * @param name    Lock name (e.g., "taskboard", "locks")
 * @param owner   Agent name acquiring the lock
 * @param timeoutMs  Max time to wait (default 5000ms)
 * @returns true if acquired, false if timed out
 */
export function acquireAdvisoryLock(
  memDir: string,
  name: string,
  owner: string,
  timeoutMs: number = LOCK_ACQUIRE_TIMEOUT_MS,
): boolean {
  ensureCoordDir(memDir)
  const lockPath = join(coordDir(memDir), `${name}.lock`)
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      mkdirSync(lockPath, { recursive: false })
      // Write metadata for diagnostics
      writeFileSync(join(lockPath, "owner"), `${owner}\n${Date.now()}`)
      return true
    } catch {
      // Lock exists — check if stale (> 2 minutes old is considered stale for advisory locks)
      const meta = readLockMeta(lockPath)
      if (meta && (Date.now() - meta.acquired) > 120_000) {
        // Steal the stale lock
        try {
          rmSync(lockPath, { recursive: true, force: true })
          continue // Retry acquisition
        } catch {
          // Another process might have cleaned it up
        }
      }
      // Wait and retry
      const remaining = deadline - Date.now()
      if (remaining <= 0) break
      const sleepMs = Math.min(LOCK_RETRY_INTERVAL_MS, remaining)
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, sleepMs)
    }
  }
  return false
}

/**
 * Release an advisory file lock.
 */
export function releaseAdvisoryLock(memDir: string, name: string): void {
  const lockPath = join(coordDir(memDir), `${name}.lock`)
  try {
    if (existsSync(lockPath)) {
      rmSync(lockPath, { recursive: true, force: true })
    }
  } catch {
    // Best effort
  }
}

/**
 * Clean up all stale advisory locks (older than 2 minutes).
 */
export function cleanStaleAdvisoryLocks(memDir: string): void {
  const dir = coordDir(memDir)
  if (!existsSync(dir)) return

  try {
    const entries = readdirSync(dir, { withFileTypes: true })
    for (const entry of entries) {
      if (entry.isDirectory() && entry.name.endsWith(".lock")) {
        const meta = readLockMeta(join(dir, entry.name))
        if (meta && (Date.now() - meta.acquired) > 120_000) {
          try {
            rmSync(join(dir, entry.name), { recursive: true, force: true })
          } catch { /* best effort */ }
        }
      }
    }
  } catch { /* best effort */ }
}

// =============================================================================
// Path Lock Map (locks.json)
// =============================================================================

const LOCKS_FILE = "locks.json"

/**
 * Read all active file locks from locks.json.
 */
export function readPathLocks(memDir: string): Map<string, FileLock> {
  const locksPath = join(memDir, LOCKS_FILE)
  if (!existsSync(locksPath)) return new Map()

  try {
    const content = readFileSync(locksPath, "utf-8")
    const obj = JSON.parse(content) as Record<string, FileLock>
    const map = new Map<string, FileLock>()
    for (const [path, lock] of Object.entries(obj)) {
      map.set(path, lock)
    }
    return map
  } catch {
    return new Map()
  }
}

/**
 * Write all active file locks to locks.json.
 */
function writePathLocks(memDir: string, locks: Map<string, FileLock>): void {
  const obj: Record<string, FileLock> = {}
  for (const [path, lock] of locks) {
    obj[path] = lock
  }
  writeFileSync(join(memDir, LOCKS_FILE), JSON.stringify(obj, null, 2), "utf-8")
}

/**
 * Evict expired locks from the map.
 */
function evictExpired(locks: Map<string, FileLock>): number {
  const now = Date.now()
  let evicted = 0
  for (const [path, lock] of locks) {
    const acquired = new Date(lock.acquired).getTime()
    const ttlMs = lock.ttl_minutes * 60_000
    if (now - acquired > ttlMs) {
      locks.delete(path)
      evicted++
    }
  }
  return evicted
}

/**
 * Lock a project file path.
 * Acquires advisory lock on locks.json first, then updates the map.
 *
 * @returns The existing lock holder if already locked, or null on success.
 */
export function lockPath(
  memDir: string,
  path: string,
  agent: string,
  taskId?: string,
  ttlMinutes?: number,
): FileLock | null {
  // Acquire advisory lock on locks.json
  if (!acquireAdvisoryLock(memDir, "locks", agent)) {
    // Couldn't even acquire advisory lock — return a synthetic conflict
    return { path, agent: "unknown", acquired: new Date().toISOString(), ttl_minutes: 0 }
  }

  try {
    const locks = readPathLocks(memDir)
    evictExpired(locks)

    const normalizedPath = normalizePath(path)

    // Check existing lock
    const existing = locks.get(normalizedPath)
    if (existing) {
      const acquired = new Date(existing.acquired).getTime()
      const ttlMs = existing.ttl_minutes * 60_000
      if (Date.now() - acquired <= ttlMs) {
        // Still locked by someone else (or same agent)
        if (existing.agent === agent) {
          // Re-lock (refresh TTL + update task_id)
          existing.acquired = new Date().toISOString()
          existing.ttl_minutes = ttlMinutes ?? existing.ttl_minutes
          if (taskId !== undefined) existing.task_id = taskId
          writePathLocks(memDir, locks)
          return null // success
        }
        return existing // conflict
      }
      // Expired — remove
      locks.delete(normalizedPath)
    }

    // Create new lock
    const lock: FileLock = {
      path: normalizedPath,
      agent,
      task_id: taskId,
      acquired: new Date().toISOString(),
      ttl_minutes: ttlMinutes ?? DEFAULT_LOCK_TTL_MINUTES,
    }
    locks.set(normalizedPath, lock)
    writePathLocks(memDir, locks)
    return null // success
  } finally {
    releaseAdvisoryLock(memDir, "locks")
  }
}

/**
 * Unlock a project file path.
 * Only the lock holder (or expired lock) can unlock.
 *
 * @returns true if unlocked, false if not the holder
 */
export function unlockPath(memDir: string, path: string, agent: string): boolean {
  if (!acquireAdvisoryLock(memDir, "locks", agent)) {
    return false
  }

  try {
    const locks = readPathLocks(memDir)
    evictExpired(locks)

    const normalizedPath = normalizePath(path)
    const existing = locks.get(normalizedPath)

    if (!existing) return true // already unlocked

    if (existing.agent !== agent) {
      // Not the holder — check if expired (allow force-unlock of stale locks)
      const acquired = new Date(existing.acquired).getTime()
      const ttlMs = existing.ttl_minutes * 60_000
      if (Date.now() - acquired <= ttlMs) {
        return false // still held by someone else
      }
    }

    locks.delete(normalizedPath)
    writePathLocks(memDir, locks)
    return true
  } finally {
    releaseAdvisoryLock(memDir, "locks")
  }
}

/**
 * Unlock all paths held by an agent.
 * Typically called when a task is completed.
 */
export function unlockAllByAgent(memDir: string, agent: string): string[] {
  if (!acquireAdvisoryLock(memDir, "locks", agent)) {
    return []
  }

  try {
    const locks = readPathLocks(memDir)
    evictExpired(locks)

    const unlocked: string[] = []
    for (const [path, lock] of locks) {
      if (lock.agent === agent) {
        unlocked.push(path)
        locks.delete(path)
      }
    }

    if (unlocked.length > 0) {
      writePathLocks(memDir, locks)
    }
    return unlocked
  } finally {
    releaseAdvisoryLock(memDir, "locks")
  }
}

/**
 * Check if a path is locked (and by whom).
 * Returns null if unlocked, the lock if locked.
 */
export function checkPathLock(memDir: string, path: string): FileLock | null {
  const locks = readPathLocks(memDir)
  evictExpired(locks)

  const normalizedPath = normalizePath(path)
  const existing = locks.get(normalizedPath)
  if (!existing) return null

  const acquired = new Date(existing.acquired).getTime()
  const ttlMs = existing.ttl_minutes * 60_000
  if (Date.now() - acquired > ttlMs) {
    return null // expired
  }

  return existing
}

/**
 * Get all active (non-expired) locks.
 */
export function getAllActiveLocks(memDir: string): FileLock[] {
  const locks = readPathLocks(memDir)
  evictExpired(locks)
  return [...locks.values()]
}

// =============================================================================
// Helpers
// =============================================================================

function normalizePath(p: string): string {
  // Normalize separators and strip leading ./
  return p.replace(/\\/g, "/").replace(/^\.\//, "")
}
