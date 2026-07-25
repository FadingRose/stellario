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
 *   open → claimed → review → done
 *              ↓  ↑           ↓
 *           pending       claimed
 *              ↓
 *           cancelled
 *
 * Any non-terminal state can transition to cancelled.
 * pending = blocked mid-work (e.g. waiting on a dependency).
 * claimed absorbs "actively working" — there is no separate in_progress state.
 */
export type TaskStatus =
  | "open"
  | "claimed"
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
  claimed:     ["pending", "review", "done", "open", "cancelled"],
  pending:     ["claimed", "cancelled"],
  review:      ["done", "claimed", "cancelled"],
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
  depends_on: string[]    // task IDs this task depends on (advisory — shown but not hard-gated)
  tags: string[]
  created: string         // YYYY-MM-DD
  updated: string         // YYYY-MM-DD
  completed?: string      // YYYY-MM-DD when status became done/cancelled

  // ── Tree fields (PlanItem) ──
  parent?: string         // parent item ID — builds milestone > epic > task hierarchy
  blocked_by?: string[]   // item IDs blocking this one (collaboration signal, does not block status transitions)
  gap?: string            // declares a missing piece ("needs X but nobody started") — any agent can claim
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
  parent?: string         // filter by parent ID (use "" for root-level items)
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
