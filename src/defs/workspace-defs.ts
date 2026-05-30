import type { ToolContext, ToolDef, StellarioConfig } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent } from "../permissions.js"
import { readJsonl, readVolumeIndex, extractTitle, findEntry, getActiveWorkspace } from "../store.js"
import { loadConfig, getMemoryDir, getWorkspaceVolume } from "../config.js"
import { queryTasks } from "../coord/store.js"
import { getAllActiveLocks } from "../coord/lock.js"
import { existsSync, readFileSync } from "fs"
import { join } from "path"

// =============================================================================
// Reusable Status Builder (used by both tool and plugin injector)
// =============================================================================

/**
 * Build the full workspace status string for a given project + agent.
 * This is the single source of truth — used by the tool AND the plugin injector.
 */
export function buildStatus(projectRoot: string, agentName: string): string {
  const config = loadConfig(projectRoot)
  const memDir = getMemoryDir(config, projectRoot)

  const lines: string[] = []
  lines.push(`Memory dir: ${memDir}`)
  lines.push(`Agent: ${agentName}`)
  lines.push("")

  if (!existsSync(memDir)) {
    lines.push("Memory: empty (not initialized)")
    return lines.join("\n")
  }

  // ── Volume stats ──
  const volumeIndex = readVolumeIndex(memDir)
  const indexMap = new Map(volumeIndex.map(e => [e.volume, e]))
  const parts: string[] = []

  for (const [name, def] of Object.entries(config.volumes)) {
    const idx = indexMap.get(name)
    let count = 0
    if (idx) {
      for (const file of idx.files) {
        const filePath = join(memDir, file)
        if (existsSync(filePath)) {
          const content = readFileSync(filePath, "utf-8")
          count += content.trim().split("\n").filter(line => line.trim()).length
        }
      }
    } else {
      const filePath = join(memDir, `${name}.jsonl`)
      if (existsSync(filePath)) {
        const content = readFileSync(filePath, "utf-8")
        count = content.trim().split("\n").filter(line => line.trim()).length
      }
    }
    if (count > 0) parts.push(`${name}: ${count}`)
  }

  const archivedPath = join(memDir, "archived.jsonl")
  if (existsSync(archivedPath)) {
    const content = readFileSync(archivedPath, "utf-8")
    const count = content.trim().split("\n").filter(line => line.trim()).length
    if (count > 0) parts.push(`archived: ${count}`)
  }

  lines.push(`Volumes: ${parts.length > 0 ? parts.join(", ") : "empty"}`)

  // ── Active workspace ──
  const workspaceVol = getWorkspaceVolume(config)
  if (workspaceVol) {
    const activeId = getActiveWorkspace(memDir, workspaceVol)
    lines.push("")
    lines.push("\u2500\u2500\u2500")

    if (activeId) {
      const found = findEntry(memDir, activeId, config)
      if (found) {
        const refs = found.entry.refs || []
        lines.push(`Workspace: [${activeId}] ${extractTitle(found.entry.content)}`)
        if (refs.length > 0) {
          lines.push(`  refs: ${refs.map(r => r.target).join(", ")}`)
        }
        lines.push(`Use memory_show(id="${activeId}") to expand`)
      } else {
        lines.push(`Workspace: [${activeId}] (not found)`)
      }
    } else {
      lines.push("Workspace: (none)")
      lines.push(`\uD83D\uDCA1 Create one: memory_create(volume="${workspaceVol}", content="...", tags=["type:workspace"])`)
    }
  }

  // ── Latest handover (append volumes) ──
  const appendVolumes = Object.entries(config.volumes)
    .filter(([, def]) => def.profile === "append")
    .map(([name]) => name)

  for (const appendVol of appendVolumes) {
    const entries = readJsonl(memDir, appendVol)
    const latest = entries[entries.length - 1]
    if (latest) {
      lines.push("")
      lines.push("\u2500\u2500\u2500")
      lines.push(`Latest ${appendVol}: ${latest.id} (${latest.created})`)
      lines.push(`Title: ${extractTitle(latest.content)}`)
      lines.push("")
      lines.push(latest.content)
    }
  }

  // ── Taskboard ──
  const activeTasks = queryTasks(memDir, {
    status: ["open", "claimed", "in_progress", "review"],
  })
  const activeLocks = getAllActiveLocks(memDir)

  if (activeTasks.length > 0 || activeLocks.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("Taskboard:")

    if (activeTasks.length > 0) {
      const statusOrder = ["in_progress", "claimed", "open", "review"] as const
      for (const status of statusOrder) {
        const group = activeTasks.filter(t => t.status === status)
        for (const task of group) {
          const owner = task.owner || "\u2014"
          const paths = (task.paths?.length ?? 0) > 0 ? `  ${task.paths.join(", ")}` : ""
          lines.push(`  [${task.id}] ${status.padEnd(12)} ${owner.padEnd(14)} ${task.title}`)
          if (paths) lines.push(`    ${paths}`)
        }
      }
    }

    if (activeLocks.length > 0) {
      lines.push("")
      for (const lock of activeLocks) {
        const age = formatLockAge(lock.acquired)
        const taskRef = lock.task_id ? ` \u2192 ${lock.task_id}` : ""
        lines.push(`  \U0001f512 ${lock.path} (${lock.agent}, ${age})${taskRef}`)
      }
    }
  }

  // ── Dynamic prompt injection (type:prompt entries in meta) ──
  const metaVol = findMetaVolume(config)
  if (metaVol) {
    const metaEntries = readJsonl(memDir, metaVol)
    const promptEntries = metaEntries.filter(e =>
      e.tags.some(t => t === "type:prompt")
    )

    if (promptEntries.length > 0) {
      lines.push("")
      lines.push("\u2500\u2500\u2500")
      lines.push(`Prompt (${promptEntries.length} entries from ${metaVol}):`)
      lines.push("")
      for (const entry of promptEntries) {
        lines.push(`[${entry.id}]`)
        lines.push(entry.content)
        lines.push("")
      }
    }
  }

  return lines.join("\n")
}

/**
 * Find the meta volume name (first mutable volume named "meta", or null).
 */
function findMetaVolume(config: StellarioConfig): string | null {
  for (const [name, def] of Object.entries(config.volumes)) {
    if (name === "meta" && def.profile === "mutable") return name
  }
  return null
}

// =============================================================================
// Tool Definition
// =============================================================================

export function getWorkspaceToolDefs(): Record<string, ToolDef> {
  const status: ToolDef = {
    description:
      "Memory dashboard: volume stats, active workspace, latest handoff, and dynamic prompt. " +
      "Auto-injected via plugin on session start — only call this manually for debugging or inspection.",
    args: {},
    async execute(_args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      return buildStatus(ctx.projectRoot, agent)
    },
  }

  return { status }
}

// =============================================================================
// Helpers
// =============================================================================

function formatLockAge(isoTimestamp: string): string {
  const acquired = new Date(isoTimestamp).getTime()
  const diffMs = Date.now() - acquired
  const minutes = Math.floor(diffMs / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  const remMin = minutes % 60
  return remMin > 0 ? `${hours}h ${remMin}m ago` : `${hours}h ago`
}
