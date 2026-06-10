// =============================================================================
// Stellario — Coordination Types
// =============================================================================
// Task = intent declaration + status tracking across agents
// FileLock = mutual exclusion on project file paths
// These are orthogonal: Task is communication, Lock is exclusion.

// ─── Task ────────────────────────────────────────────────────────────────────

/**
 * Task status lifecycle:
 *
 *   open → claimed → in_progress → review → done
 *                       ↓  ↑            ↓
 *                    pending        in_progress
 *                       ↓
 *                    cancelled
 *
 * Any non-terminal state can transition to cancelled.
 * pending = blocked mid-work (e.g. waiting on a dependency).
 */
export type TaskStatus =
  | "open"
  | "claimed"
  | "in_progress"
  | "pending"
  | "review"
  | "done"
  | "cancelled"

/**
 * Valid status transitions.
 * Enforced by the store to prevent illegal state changes.
 */
export const VALID_TRANSITIONS: Record<TaskStatus, TaskStatus[]> = {
  open:        ["claimed", "cancelled"],
  claimed:     ["in_progress", "open", "cancelled"],
  in_progress: ["pending", "review", "done", "cancelled"],
  pending:     ["in_progress", "cancelled"],
  review:      ["done", "in_progress", "cancelled"],
  done:        [],
  cancelled:   [],
}

export interface Task {
  id: string
  title: string
  body?: string
  status: TaskStatus
  status_reason?: string   // why the last status change happened
  author: string          // agent who created the task
  owner?: string          // agent who claimed it
  paths: string[]         // project-relative file paths this task involves
  depends_on: string[]    // task IDs this task depends on
  tags: string[]
  created: string         // YYYY-MM-DD
  updated: string         // YYYY-MM-DD
  completed?: string      // YYYY-MM-DD when status became done/cancelled
}

// ─── File Lock ───────────────────────────────────────────────────────────────

/**
 * An advisory lock on a project file path.
 * Stored as a simple JSON map in locks.json within the memory directory.
 *
 * Locks have a TTL; stale locks (>ttl_minutes) are auto-released.
 * An agent can only hold one lock per path at a time.
 */
export interface FileLock {
  path: string            // project-relative file path
  agent: string           // lock holder
  task_id?: string        // optional associated task
  acquired: string        // ISO 8601 timestamp
  ttl_minutes: number     // default 60
}

// ─── Coordination Storage ────────────────────────────────────────────────────

/**
 * On-disk layout:
 *
 *   <memDir>/taskboard.jsonl   — Task entries (one JSON per line)
 *   <memDir>/locks.json        — Active FileLock map (path → FileLock)
 *   <memDir>.coord/            — Advisory lock directory (mkdir-atomic)
 *     taskboard.lock           — Serialize taskboard.jsonl writes
 *     locks.lock               — Serialize locks.json writes
 */

// ─── Queries ─────────────────────────────────────────────────────────────────

export interface TaskFilter {
  status?: TaskStatus | TaskStatus[]
  owner?: string
  author?: string
  tags?: string[]
}

// ─── Tool Context Extension ──────────────────────────────────────────────────

/**
 * Default TTL in minutes for file locks.
 */
export const DEFAULT_LOCK_TTL_MINUTES = 60

/**
 * Maximum time (ms) to wait for coordination file lock acquisition.
 */
export const LOCK_ACQUIRE_TIMEOUT_MS = 5000

/**
 * Interval (ms) between lock acquisition retry attempts.
 */
export const LOCK_RETRY_INTERVAL_MS = 200
