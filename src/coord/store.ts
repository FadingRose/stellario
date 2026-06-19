// =============================================================================
// Stellario — Coordination Store
// =============================================================================
// CRUD operations for Tasks in taskboard.jsonl.
// All writes go through advisory file lock to prevent concurrent corruption.

import {
  existsSync,
  readFileSync,
  writeFileSync,
  mkdirSync,
} from "fs"
import { join } from "path"
import type { Task, TaskFilter, TaskStatus } from "./types.js"
import { VALID_TRANSITIONS } from "./types.js"
import { acquireAdvisoryLock, releaseAdvisoryLock } from "./lock.js"

// =============================================================================
// Storage Constants
// =============================================================================

const TASKBOARD_FILE = "taskboard.jsonl"
const ID_PREFIX = "tb"

// =============================================================================
// Read
// =============================================================================

/**
 * Read all tasks from taskboard.jsonl.
 * Safe for concurrent reads (no lock needed for read-only).
 */
export function readTasks(memDir: string): Task[] {
  const filePath = join(memDir, TASKBOARD_FILE)
  if (!existsSync(filePath)) return []

  try {
    const content = readFileSync(filePath, "utf-8")
    if (!content.trim()) return []
    return content
      .split("\n")
      .filter(line => line.trim())
      .map(line => {
        const task = JSON.parse(line) as Task
        // Normalize array fields (defensive, same as parseJsonlContent)
        if (!Array.isArray(task.paths)) task.paths = []
        if (!Array.isArray(task.depends_on)) task.depends_on = []
        if (!Array.isArray(task.tags)) task.tags = []
        if (!Array.isArray(task.blocked_by)) task.blocked_by = []
        return task
      })
  } catch {
    return []
  }
}

/**
 * Find a task by ID.
 */
export function findTask(memDir: string, id: string): Task | null {
  const tasks = readTasks(memDir)
  return tasks.find(t => t.id === id) || null
}

/**
 * Query tasks with filters.
 */
export function queryTasks(memDir: string, filter?: TaskFilter): Task[] {
  let tasks = readTasks(memDir)

  if (!filter) return tasks

  if (filter.status) {
    const statuses = Array.isArray(filter.status) ? filter.status : [filter.status]
    tasks = tasks.filter(t => statuses.includes(t.status))
  }

  if (filter.owner !== undefined) {
    if (filter.owner === "") {
      // Empty string means "unclaimed"
      tasks = tasks.filter(t => !t.owner)
    } else {
      tasks = tasks.filter(t => t.owner === filter.owner)
    }
  }

  if (filter.author) {
    tasks = tasks.filter(t => t.author === filter.author)
  }

  if (filter.tags && filter.tags.length > 0) {
    tasks = tasks.filter(t =>
      filter.tags!.every(tag => t.tags.includes(tag))
    )
  }

  if (filter.parent !== undefined) {
    if (filter.parent === "") {
      // Empty string means "root-level" (no parent)
      tasks = tasks.filter(t => !t.parent)
    } else {
      tasks = tasks.filter(t => t.parent === filter.parent)
    }
  }

  return tasks
}

// =============================================================================
// Write
// =============================================================================

/**
 * Write all tasks to taskboard.jsonl (advisory-locked).
 */
function writeTasks(memDir: string, tasks: Task[], agent: string): void {
  if (!existsSync(memDir)) mkdirSync(memDir, { recursive: true })

  if (!acquireAdvisoryLock(memDir, "taskboard", agent)) {
    throw new Error("Failed to acquire taskboard advisory lock")
  }

  try {
    const filePath = join(memDir, TASKBOARD_FILE)
    writeFileSync(
      filePath,
      tasks.map(t => JSON.stringify(t)).join("\n") + (tasks.length > 0 ? "\n" : ""),
      "utf-8",
    )
  } finally {
    releaseAdvisoryLock(memDir, "taskboard")
  }
}

/**
 * Generate the next task ID.
 */
function generateNextId(memDir: string): string {
  const tasks = readTasks(memDir)
  let maxNum = 0
  for (const task of tasks) {
    if (task.id.startsWith(ID_PREFIX)) {
      const num = parseInt(task.id.slice(ID_PREFIX.length), 10)
      if (!isNaN(num) && num > maxNum) maxNum = num
    }
  }
  return `${ID_PREFIX}${String(maxNum + 1).padStart(2, "0")}`
}

/**
 * Today's date as YYYY-MM-DD.
 */
function today(): string {
  return new Date().toISOString().split("T")[0]
}

// =============================================================================
// CRUD Operations
// =============================================================================

/**
 * Create a new task.
 * Returns the created task.
 */
export function createTask(
  memDir: string,
  opts: {
    title: string
    body?: string
    author: string
    owner?: string
    paths?: string[]
    depends_on?: string[]
    tags?: string[]
    parent?: string
    blocked_by?: string[]
    gap?: string
  },
): Task {
  const tasks = readTasks(memDir)
  const id = generateNextId(memDir)

  // Validate depends_on references
  if (opts.depends_on) {
    for (const depId of opts.depends_on) {
      const found = tasks.find(t => t.id === depId)
      if (!found) {
        throw new Error(`Dependency task "${depId}" not found`)
      }
    }
  }

  // Validate parent reference
  if (opts.parent) {
    const found = tasks.find(t => t.id === opts.parent)
    if (!found) {
      throw new Error(`Parent task "${opts.parent}" not found`)
    }
  }

  // Validate blocked_by references
  if (opts.blocked_by) {
    for (const blockerId of opts.blocked_by) {
      const found = tasks.find(t => t.id === blockerId)
      if (!found) {
        throw new Error(`Blocking task "${blockerId}" not found`)
      }
    }
  }

  const task: Task = {
    id,
    title: opts.title,
    body: opts.body,
    status: opts.owner ? "claimed" : "open",
    author: opts.author,
    owner: opts.owner,
    paths: opts.paths || [],
    depends_on: opts.depends_on || [],
    tags: opts.tags || [],
    created: today(),
    updated: today(),
    parent: opts.parent,
    blocked_by: opts.blocked_by || [],
    gap: opts.gap,
  }

  tasks.push(task)
  writeTasks(memDir, tasks, opts.author)
  return task
}

/**
 * Update a task's status.
 * Validates status transitions.
 */
export function updateTaskStatus(
  memDir: string,
  id: string,
  newStatus: TaskStatus,
  agent: string,
  reason?: string,
): Task {
  const tasks = readTasks(memDir)
  const index = tasks.findIndex(t => t.id === id)
  if (index === -1) throw new Error(`Task "${id}" not found`)

  const task = tasks[index]

  // Validate transition
  const allowed = VALID_TRANSITIONS[task.status]
  if (!allowed.includes(newStatus)) {
    throw new Error(
      `Invalid transition: ${task.status} → ${newStatus}. ` +
      `Allowed from "${task.status}": [${allowed.join(", ")}]`
    )
  }

  // Authorize: only the owner can transition claimed/in_progress/pending/review
  if (["claimed", "in_progress", "pending", "review"].includes(task.status)) {
    if (task.owner && task.owner !== agent) {
      throw new Error(
        `Task "${id}" is owned by "${task.owner}". Only the owner can change status from "${task.status}".`
      )
    }
  }

  // Check dependencies: can't start if dependencies aren't done
  if (newStatus === "in_progress" && (task.depends_on?.length ?? 0) > 0) {
    const allDeps = readTasks(memDir)
    for (const depId of task.depends_on!) {
      const dep = allDeps.find(t => t.id === depId)
      if (dep && dep.status !== "done") {
        throw new Error(
          `Cannot start: dependency "${depId}" is ${dep.status} (needs to be done).`
        )
      }
    }
  }

  tasks[index] = {
    ...task,
    status: newStatus,
    status_reason: reason,
    updated: today(),
    completed: (newStatus === "done" || newStatus === "cancelled") ? today() : undefined,
  }

  writeTasks(memDir, tasks, agent)
  return tasks[index]
}

/**
 * Claim an open task.
 */
export function claimTask(memDir: string, id: string, agent: string): Task {
  const tasks = readTasks(memDir)
  const index = tasks.findIndex(t => t.id === id)
  if (index === -1) throw new Error(`Task "${id}" not found`)

  const task = tasks[index]
  if (task.status !== "open") {
    throw new Error(`Task "${id}" is "${task.status}", not "open". Only open tasks can be claimed.`)
  }

  tasks[index] = {
    ...task,
    status: "claimed",
    owner: agent,
    updated: today(),
  }

  writeTasks(memDir, tasks, agent)
  return tasks[index]
}

/**
 * Update a task's metadata (body, paths, tags, parent, blocked_by, gap).
 * Only the author or owner can update.
 */
export function updateTaskMeta(
  memDir: string,
  id: string,
  agent: string,
  updates: {
    title?: string
    body?: string
    paths?: string[]
    tags?: string[]
    depends_on?: string[]
    parent?: string
    blocked_by?: string[]
    gap?: string
  },
): Task {
  const tasks = readTasks(memDir)
  const index = tasks.findIndex(t => t.id === id)
  if (index === -1) throw new Error(`Task "${id}" not found`)

  const task = tasks[index]
  if (task.author !== agent && task.owner !== agent) {
    throw new Error(
      `Only the author ("${task.author}") or owner ("${task.owner || "none"}") can update task "${id}".`
    )
  }

  // Validate parent reference if changing
  if (updates.parent !== undefined && updates.parent !== "") {
    const found = tasks.find(t => t.id === updates.parent)
    if (!found) {
      throw new Error(`Parent task "${updates.parent}" not found`)
    }
  }

  // Validate blocked_by references if changing
  if (updates.blocked_by) {
    for (const blockerId of updates.blocked_by) {
      const found = tasks.find(t => t.id === blockerId)
      if (!found) {
        throw new Error(`Blocking task "${blockerId}" not found`)
      }
    }
  }

  tasks[index] = {
    ...task,
    title: updates.title ?? task.title,
    body: updates.body ?? task.body,
    paths: updates.paths ?? task.paths,
    tags: updates.tags ?? task.tags,
    depends_on: updates.depends_on ?? task.depends_on,
    parent: updates.parent ?? task.parent,
    blocked_by: updates.blocked_by ?? task.blocked_by,
    gap: updates.gap ?? task.gap,
    updated: today(),
  }

  writeTasks(memDir, tasks, agent)
  return tasks[index]
}

// =============================================================================
// Tree Building (PlanItem hierarchy)
// =============================================================================

/**
 * A node in the plan tree, with children and derived status.
 * The derived status is computed from children, used for display.
 */
export interface PlanTreeNode {
  item: Task
  children: PlanTreeNode[]
  derived_status: TaskStatus  // computed from children (or item.status if leaf)
}

/**
 * Derive parent status from children's status.
 * Rules (a04):
 *   - all children done/cancelled → done
 *   - at least one in_progress/review → in_progress
 *   - at least one pending → pending (blocked)
 *   - all open/claimed → open
 */
export function deriveParentStatus(children: PlanTreeNode[]): TaskStatus {
  if (children.length === 0) {
    return "open"
  }

  const statuses = children.map(c => c.derived_status)

  // Any pending → pending (blocked propagation)
  if (statuses.some(s => s === "pending")) return "pending"

  // All terminal → done
  if (statuses.every(s => s === "done" || s === "cancelled")) return "done"

  // At least one active work → in_progress
  if (statuses.some(s => s === "in_progress" || s === "review")) return "in_progress"

  // All open/claimed → open
  return "open"
}

/**
 * Build the plan tree from flat tasks.
 * Tasks with no parent are root-level.
 * Tasks with parent field are nested under their parent.
 * Parent status is derived from children (does not modify stored status).
 */
export function buildPlanTree(memDir: string): PlanTreeNode[] {
  const tasks = readTasks(memDir)

  // Build children map (parent → children)
  const childrenMap = new Map<string, Task[]>()
  const roots: Task[] = []

  for (const t of tasks) {
    if (t.parent) {
      const parentChildren = childrenMap.get(t.parent) || []
      parentChildren.push(t)
      childrenMap.set(t.parent, parentChildren)
    } else {
      roots.push(t)
    }
  }

  // Recursive build
  function buildNode(item: Task): PlanTreeNode {
    const childItems = childrenMap.get(item.id) || []
    const children = childItems.map(buildNode)

    // Leaf nodes: derived_status = stored status
    // Parent nodes: derived_status = computed
    const derived_status = children.length > 0
      ? deriveParentStatus(children)
      : item.status

    return { item, children, derived_status }
  }

  return roots.map(buildNode)
}