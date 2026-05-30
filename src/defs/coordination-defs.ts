// =============================================================================
// Stellario — Coordination Tool Definitions
// =============================================================================
// 7 tools for multi-agent task coordination and file locking:
//   taskboard_plan     — Create a task (declare intent + associate files)
//   taskboard_claim    — Claim an open task
//   taskboard_update   — Update task status or metadata
//   taskboard_complete — Mark task done + release associated locks
//   taskboard_board    — View tasks (filterable by status/owner/tags)
//   taskboard_lock     — Lock file paths
//   taskboard_unlock   — Release file locks

import { z } from "zod"
import type { ToolContext, ToolDef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent } from "../permissions.js"
import { createTask, findTask, queryTasks, claimTask, updateTaskStatus, updateTaskMeta } from "../coord/store.js"
import {
  lockPath,
  unlockPath,
  unlockAllByAgent,
  checkPathLock,
  getAllActiveLocks,
} from "../coord/lock.js"
import type { TaskStatus } from "../coord/types.js"
import { DEFAULT_LOCK_TTL_MINUTES } from "../coord/types.js"

// =============================================================================
// Tool Definitions
// =============================================================================

export function getCoordinationToolDefs(): Record<string, ToolDef> {

  // ── taskboard_plan ──

  const taskboard_plan: ToolDef = {
    description:
      "Create a coordination task. Declare intent to modify files, " +
      "so other agents can see your plan and avoid conflicts. " +
      "Optionally specify file paths to lock, dependencies on other tasks, and tags.",
    args: {
      title: z.string().describe("Short task description."),
      body: z.string().optional().describe("Detailed description or context."),
      owner: z.string().optional().describe("Agent to assign (skips 'open', goes straight to 'claimed')."),
      paths: z.array(z.string()).optional().describe("Project-relative file paths this task will modify."),
      lock_paths: z.boolean().optional().describe("Also lock the paths immediately. Default: false."),
      depends_on: z.array(z.string()).optional().describe("Task IDs this task depends on (must be done first)."),
      tags: z.array(z.string()).optional().describe("Tags for categorization."),
    },
    async execute(args, context: ToolContext) {
      if (!args.title?.trim()) return "\u274c title is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      try {
        const task = createTask(ctx.memDir, {
          title: args.title.trim(),
          body: args.body,
          author: agent,
          owner: args.owner,
          paths: args.paths || [],
          depends_on: args.depends_on,
          tags: args.tags,
        })

        // Optionally lock paths
        let lockResults = ""
        if (args.lock_paths && task.paths.length > 0) {
          const results: string[] = []
          for (const path of task.paths) {
            const conflict = lockPath(ctx.memDir, path, agent, task.id)
            if (conflict) {
              results.push(`  \u274c ${path} — locked by ${conflict.agent}`)
            } else {
              results.push(`  \u2705 ${path}`)
            }
          }
          lockResults = `\nLocks:\n${results.join("\n")}`
        }

        return [
          `Created [${task.id}] "${task.title}"`,
          `Status: ${task.status}${task.owner ? ` (owner: ${task.owner})` : ""}`,
          `Author: ${task.author}`,
          task.paths.length > 0 ? `Paths: ${task.paths.join(", ")}` : null,
          task.depends_on.length > 0 ? `Depends: ${task.depends_on.join(", ")}` : null,
          task.tags.length > 0 ? `Tags: ${task.tags.join(", ")}` : null,
          lockResults || null,
        ].filter(Boolean).join("\n")
      } catch (err: any) {
        return `\u274c ${err.message}`
      }
    },
  }

  // ── taskboard_claim ──

  const taskboard_claim: ToolDef = {
    description:
      "Claim an open task. Sets you as the owner and transitions to 'claimed'. " +
      "Optionally lock the task's associated file paths.",
    args: {
      id: z.string().describe("Task ID to claim."),
      lock_paths: z.boolean().optional().describe("Also lock the task's paths. Default: true."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c id is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      try {
        const task = claimTask(ctx.memDir, args.id, agent)

        const shouldLock = args.lock_paths !== false
        let lockResults = ""
        if (shouldLock && task.paths.length > 0) {
          const results: string[] = []
          for (const path of task.paths) {
            const conflict = lockPath(ctx.memDir, path, agent, task.id)
            if (conflict) {
              results.push(`  \u274c ${path} — locked by ${conflict.agent}`)
            } else {
              results.push(`  \u2705 ${path}`)
            }
          }
          lockResults = `\nLocks:\n${results.join("\n")}`
        }

        return [
          `Claimed [${task.id}] "${task.title}"`,
          `Owner: ${agent}`,
          lockResults || null,
        ].filter(Boolean).join("\n")
      } catch (err: any) {
        return `\u274c ${err.message}`
      }
    },
  }

  // ── taskboard_update ──

  const taskboard_update: ToolDef = {
    description:
      "Update a task. Can change status (with transition validation), " +
      "or update metadata (title, body, paths, tags). " +
      "Status transitions: open→claimed, claimed→in_progress, in_progress→review, review→done.",
    args: {
      id: z.string().describe("Task ID."),
      status: z.string().optional().describe("New status. Must be a valid transition from current."),
      title: z.string().optional().describe("Updated title."),
      body: z.string().optional().describe("Updated description."),
      paths: z.array(z.string()).optional().describe("Updated file paths."),
      tags: z.array(z.string()).optional().describe("Updated tags."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c id is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      try {
        // Status update
        if (args.status) {
          const task = updateTaskStatus(ctx.memDir, args.id, args.status as TaskStatus, agent)
          return `Updated [${task.id}] → ${task.status}`
        }

        // Metadata update
        const hasMeta = args.title || args.body || args.paths || args.tags
        if (hasMeta) {
          const task = updateTaskMeta(ctx.memDir, args.id, agent, {
            title: args.title,
            body: args.body,
            paths: args.paths,
            tags: args.tags,
          })
          return `Updated [${task.id}] metadata`
        }

        return "\u274c Provide at least one of: status, title, body, paths, tags."
      } catch (err: any) {
        return `\u274c ${err.message}`
      }
    },
  }

  // ── taskboard_complete ──

  const taskboard_complete: ToolDef = {
    description:
      "Mark a task as done and release all file locks held by you for this task. " +
      "Use this when your work is finished.",
    args: {
      id: z.string().describe("Task ID to complete."),
      release_locks: z.boolean().optional().describe("Release all your file locks. Default: true."),
    },
    async execute(args, context: ToolContext) {
      if (!args.id) return "\u274c id is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      try {
        const task = updateTaskStatus(ctx.memDir, args.id, "done", agent)

        // Release locks
        const shouldRelease = args.release_locks !== false
        let lockMsg = ""
        if (shouldRelease) {
          const unlocked = unlockAllByAgent(ctx.memDir, agent)
          if (unlocked.length > 0) {
            lockMsg = `\nReleased locks: ${unlocked.join(", ")}`
          }
        }

        return [
          `Completed [${task.id}] "${task.title}"`,
          lockMsg || null,
        ].filter(Boolean).join("\n")
      } catch (err: any) {
        return `\u274c ${err.message}`
      }
    },
  }

  // ── taskboard_board ──

  const taskboard_board: ToolDef = {
    description:
      "View the task board. Shows all tasks, filterable by status, owner, or tags. " +
      "Also shows active file locks. Use this to discover work and check conflicts.",
    args: {
      status: z.union([
        z.string(),
        z.array(z.string()),
      ]).optional().describe("Filter by status (e.g., 'open', 'in_progress', or ['open', 'claimed'])."),
      owner: z.string().optional().describe("Filter by owner. Use '' for unclaimed tasks."),
      author: z.string().optional().describe("Filter by author."),
      tags: z.array(z.string()).optional().describe("Filter by tags (AND)."),
      show_locks: z.boolean().optional().describe("Show active file locks. Default: true."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      // Parse status filter
      let statusFilter: TaskStatus | TaskStatus[] | undefined
      if (args.status) {
        if (Array.isArray(args.status)) {
          statusFilter = args.status as TaskStatus[]
        } else {
          statusFilter = args.status as TaskStatus
        }
      }

      const tasks = queryTasks(ctx.memDir, {
        status: statusFilter,
        owner: args.owner,
        author: args.author,
        tags: args.tags,
      })

      const lines: string[] = []

      if (tasks.length === 0) {
        lines.push("No tasks found.")
      } else {
        lines.push(`Tasks (${tasks.length}):`)
        lines.push("")

        // Group by status for readability
        const statusOrder: TaskStatus[] = ["in_progress", "claimed", "open", "review", "done", "cancelled"]
        const grouped = new Map<TaskStatus, typeof tasks>()
        for (const task of tasks) {
          const group = grouped.get(task.status) || []
          group.push(task)
          grouped.set(task.status, group)
        }

        for (const status of statusOrder) {
          const group = grouped.get(status)
          if (!group || group.length === 0) continue

          const statusIcon: Record<string, string> = {
            in_progress: "\u25b6",
            claimed: "\u2611",
            open: "\u25cb",
            review: "\u23f3",
            done: "\u2714",
            cancelled: "\u2716",
          }

          for (const task of group) {
            const icon = statusIcon[task.status] || "\u2022"
            const owner = task.owner || "\u2014"
            const paths = task.paths.length > 0
              ? `  [${task.paths.join(", ")}]`
              : ""
            lines.push(`  ${icon} [${task.id}] ${task.status.padEnd(12)} ${owner.padEnd(14)} ${task.title}`)
            if (paths) lines.push(`    ${paths}`)
            if (task.depends_on.length > 0) {
              lines.push(`    depends: ${task.depends_on.join(", ")}`)
            }
          }
        }
      }

      // Show locks
      if (args.show_locks !== false) {
        const locks = getAllActiveLocks(ctx.memDir)
        lines.push("")
        if (locks.length > 0) {
          lines.push(`Locks (${locks.length}):`)
          for (const lock of locks) {
            const age = formatAge(lock.acquired)
            const taskRef = lock.task_id ? ` → ${lock.task_id}` : ""
            lines.push(`  \U0001f512 ${lock.path} (${lock.agent}, ${age})${taskRef}`)
          }
        } else {
          lines.push("Locks: none")
        }
      }

      return lines.join("\n")
    },
  }

  // ── taskboard_lock ──

  const taskboard_lock: ToolDef = {
    description:
      "Lock file path(s) to prevent concurrent modification by other agents. " +
      "Locks have a TTL (default 60 min) and auto-expire. " +
      "Always lock before modifying files.",
    args: {
      paths: z.array(z.string()).describe("Project-relative file paths to lock."),
      task_id: z.string().optional().describe("Associate locks with a task."),
      ttl_minutes: z.number().optional().describe("Lock TTL in minutes. Default: 60."),
    },
    async execute(args, context: ToolContext) {
      if (!args.paths || args.paths.length === 0) return "\u274c paths is required."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const results: string[] = []
      let allOk = true

      for (const path of args.paths) {
        const conflict = lockPath(ctx.memDir, path, agent, args.task_id, args.ttl_minutes)
        if (conflict) {
          results.push(`\u274c ${path} — locked by ${conflict.agent} (since ${formatAge(conflict.acquired)})`)
          allOk = false
        } else {
          results.push(`\u2705 ${path}`)
        }
      }

      const header = allOk
        ? `Locked ${args.paths.length} path(s) for ${agent}`
        : `Locked with conflicts:`
      return `${header}\n${results.join("\n")}`
    },
  }

  // ── taskboard_unlock ──

  const taskboard_unlock: ToolDef = {
    description:
      "Release file lock(s). Only the lock holder can unlock. " +
      "Stale locks (>TTL) can be force-unlocked by anyone.",
    args: {
      paths: z.array(z.string()).optional().describe("Specific paths to unlock. Omit to unlock ALL your locks."),
      release_all: z.boolean().optional().describe("Release all locks held by you. Default: false."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      if (args.release_all || (!args.paths || args.paths.length === 0)) {
        // Release all locks
        const unlocked = unlockAllByAgent(ctx.memDir, agent)
        if (unlocked.length === 0) return "No locks held by you."
        return `Released ${unlocked.length} lock(s): ${unlocked.join(", ")}`
      }

      // Release specific paths
      const results: string[] = []
      for (const path of args.paths!) {
        const ok = unlockPath(ctx.memDir, path, agent)
        results.push(ok ? `\u2705 ${path}` : `\u274c ${path} — not held by you or not locked`)
      }

      return `Unlock results:\n${results.join("\n")}`
    },
  }

  return {
    taskboard_plan,
    taskboard_claim,
    taskboard_update,
    taskboard_complete,
    taskboard_board,
    taskboard_lock,
    taskboard_unlock,
  }
}

// =============================================================================
// Helpers
// =============================================================================

function formatAge(isoTimestamp: string): string {
  const acquired = new Date(isoTimestamp).getTime()
  const diffMs = Date.now() - acquired
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`
}
