import type { ToolContext, ToolDef, StellarioConfig, MemoryEntry, MemoryRef } from "../types.js"
import { resolveContext, tryGoResolve, isGuardianAgent, loadGlobalContext } from "../context.js"
import { resolveAgent, canRead, canWrite, isAuthor } from "../permissions.js"
import { readJsonl, readVolumeIndex, extractTitle, findEntry, writeEntries, generateNextId, dedupeTags, ensureStringArray, ensureArray, today, readMounts, formatDisplayId, toDisplayId } from "../store.js"
import { loadConfig, loadConfigFromPath, getMemoryDir } from "../config.js"
import { queryTasks, buildPlanTree } from "../coord/store.js"
import type { PlanTreeNode } from "../coord/store.js"
import { getAllActiveLocks } from "../coord/lock.js"
import { getLspStatus } from "../lsp/manager.js"
import { gitCommit } from "../git.js"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { z } from "zod"

// =============================================================================
// Reusable Status Builder (used by both tool and plugin injector)
// =============================================================================

/**
 * Build the full workspace status string for a given project + agent.
 * This is the single source of truth — used by the tool AND the plugin injector.
 */
export function buildStatus(projectRoot: string, agentName: string): string {
  let config: StellarioConfig
  let memDir: string

  // ── Guardian resolution (identity-driven) ──
  // The guardian agent resolves to the global library regardless of CWD.
  if (isGuardianAgent(agentName)) {
    const g = loadGlobalContext()!
    config = g.config
    memDir = g.memDir
  } else {
    // ── Path A: directory-driven Go resolve ──
    const goResult = tryGoResolve(projectRoot)
    if (goResult) {
      config = loadConfigFromPath(goResult.config_path)
      memDir = goResult.mem_dir
    } else {
      // ── Path B: Legacy project-scoped fallback ──
      config = loadConfig(projectRoot)
      memDir = getMemoryDir(config, projectRoot)
    }
  }

  const lines: string[] = []
  lines.push(`Memory dir: ${memDir}`)
  lines.push(`Agent: ${agentName}`)
  lines.push("")

  if (!existsSync(memDir)) {
    lines.push("Memory: empty (not initialized)")
    lines.push("")
    lines.push("This appears to be a fresh install. If you are the primary agent, enter wizard mode: greet the user, read stellario.yaml together, and help them configure their memory system.")
    return lines.join("\n")
  }

  // ── Volume stats ──
  const volumeIndex = readVolumeIndex(memDir)
  const indexMap = new Map(volumeIndex.map(e => [e.volume, e]))
  const parts: string[] = []
  let totalEntries = 0

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
    totalEntries += count
    if (count > 0) parts.push(`${name}: ${count}`)
  }

  const archivedPath = join(memDir, "archived.jsonl")
  if (existsSync(archivedPath)) {
    const content = readFileSync(archivedPath, "utf-8")
    const count = content.trim().split("\n").filter(line => line.trim()).length
    totalEntries += count
    if (count > 0) parts.push(`archived: ${count}`)
  }

  if (totalEntries === 0) {
    lines.push("Memory: empty (no entries yet)")
    lines.push("")
    lines.push("This appears to be a fresh install. If you are the primary agent, enter wizard mode: greet the user, read stellario.yaml together, and help them configure their memory system.")
  } else {
    lines.push(`Volumes: ${parts.join(", ")}`)
  }

  // ── Latest handover (by name, filtered by agent) ──
  // The handover volume is identified by name so it works regardless of profile
  // (it may be append or mutable). For mutable handover, entries can be revised,
  // so "latest" = most recently updated, not file-order-last.
  if (config.volumes["handover"]) {
    const entries = readJsonl(memDir, "handover")
    const agentEntries = entries.filter(e => e.author === agentName)
    if (agentEntries.length > 0) {
      const latest = agentEntries.reduce((best, e) => {
        const eTime = e.updated || e.created || ""
        const bTime = best.updated || best.created || ""
        return eTime > bTime ? e : best
      })
      lines.push("")
      lines.push("\u2500\u2500\u2500")
      lines.push(`Latest handover: ${latest.id} (${latest.updated || latest.created})`)
      lines.push(`Title: ${extractTitle(latest.content)}`)
      lines.push("")
      lines.push(latest.content)
    }
  }

  // ── Roadmap (Plan Tree) ──
  const planTree = buildPlanTree(memDir)
  const activeLocks = getAllActiveLocks(memDir)

  // Count total active items (non-done, non-cancelled) across the tree
  let totalActive = 0
  let totalChildren = 0
  let totalDone = 0
  function countTree(nodes: PlanTreeNode[]) {
    for (const node of nodes) {
      if (node.children.length > 0) {
        countTree(node.children)
      } else {
        totalChildren++
        if (node.item.status === "done" || node.item.status === "cancelled") {
          totalDone++
        } else {
          totalActive++
        }
      }
    }
  }
  countTree(planTree)

  if (planTree.length > 0 || activeLocks.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")

    // Summary line
    const rootCount = planTree.length
    const activeRoots = planTree.filter(n =>
      !["done", "cancelled"].includes(n.derived_status)
    ).length
    lines.push(`Roadmap (${rootCount} milestone${rootCount !== 1 ? "s" : ""}, ${activeRoots} active, ${totalDone}/${totalChildren} tasks done):`)

    // Render tree
    for (const node of planTree) {
      renderPlanNode(node, lines, 2)
    }

    // Locks
    if (activeLocks.length > 0) {
      lines.push("")
      for (const lock of activeLocks) {
        const age = formatLockAge(lock.acquired)
        const taskRef = lock.task_id ? ` \u2192 ${lock.task_id}` : ""
        lines.push(`  \U0001f512 ${lock.path} (${lock.agent}, ${age})${taskRef}`)
      }
    }
  }

  // ── Native mounts ──
  const mounts = readMounts(memDir)
  if (mounts.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("Mounts:")
    for (const { alias, mount } of mounts) {
      let count = 0
      let broken = false
      try {
        if (existsSync(mount.source_path)) {
          const content = readFileSync(mount.source_path, "utf-8")
          count = content.trim().split("\n").filter(l => l.trim()).length
        } else {
          broken = true
        }
      } catch { broken = true }
      const status = broken ? "\u26a0\ufe0f BROKEN" : `${count} entries`
      lines.push(`  ${alias} \u2190 ${mount.source_volume} @ ${mount.project} (${status}, readonly)`)
    }
  }

  // ── LSP status ──
  const lspStatus = getLspStatus()
  if (lspStatus.length > 0) {
    lines.push("")
    lines.push("\u2500\u2500\u2500")
    lines.push("LSP:")
    for (const entry of lspStatus) {
      const sec = Math.floor(entry.elapsedMs / 1000)
      const elapsed = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
      switch (entry.state) {
        case "ready":
          lines.push(`  ${entry.name}: ready`)
          break
        case "starting":
          lines.push(`  ${entry.name}: indexing... (${elapsed})`)
          break
        case "error":
        case "crashed":
          lines.push(`  ${entry.name}: ${entry.state}${entry.detail ? ` (${entry.detail})` : ""}`)
          break
        default:
          lines.push(`  ${entry.name}: ${entry.state}`)
      }
    }
  }

  // ── Dynamic prompt injection (meta volume) ──
  // An agent may declare inject.meta tags to receive only matching entries.
  // Without a declaration, all non-disabled entries are injected (default).
  const metaVol = findMetaVolume(config)
  if (metaVol) {
    const metaEntries = readJsonl(memDir, metaVol)
    const agentDef = config.agents[agentName]
    const injectTags = agentDef?.inject?.meta
    const promptEntries = metaEntries.filter(e => {
      // meta:disable always excludes, regardless of inject declaration.
      if (e.tags.some(t => t === "meta:disable")) return false
      // If the agent declared inject tags, only entries matching at least one tag pass.
      if (injectTags && injectTags.length > 0) {
        return e.tags.some(t => injectTags.includes(t))
      }
      return true // no inject declaration → inject all (default)
    })

    if (promptEntries.length > 0) {
      lines.push("")
      lines.push("\u2500\u2500\u2500")
      lines.push(`Prompt (${promptEntries.length} entries from ${metaVol}):`)
      lines.push("")
      for (const entry of promptEntries) {
        lines.push(`[${formatDisplayId(entry)}]`)
        lines.push(entry.content)
        lines.push("")
      }
    }
  }

  // ── Agent-agnostic usage guide (static, shared across all projects) ──
  lines.push("")
  lines.push("───")
  lines.push("## Stellario Memory System")
  lines.push("")
  lines.push("You have a memory system that persists across sessions. What you write now will be available in future sessions.")
  lines.push("")
  lines.push("### Core Tools")
  lines.push("")
  lines.push("| Tool | When to use |")
  lines.push("|---|---|")
  lines.push("| `create` | Write a new memory entry — design decisions, observations, conventions, handoffs |")
  lines.push("| `revise` | Update an existing entry — add detail, correct error, mark as done |")
  lines.push("| `show` | Read a specific entry by ID (with line numbers for precise editing) |")
  lines.push("| `search` | Find relevant entries — text match + semantic search + tag/keyword filters |")
  lines.push("| `workspace_status` | Dashboard: volume stats, latest handoff, dynamic prompt (you just saw this) |")
  lines.push("")
  lines.push("### Search Usage")
  lines.push("")
  lines.push("`search(query, volumes, tags, intent)` — Find entries relevant to your current task.")
  lines.push("")
  lines.push("- `query`: keywords or natural language description")
  lines.push("- `volumes`: filter to specific volumes (default: all readable)")
  lines.push("- `tags`: AND filter — entries must have ALL these tags")
  lines.push("- `intent`: (optional) describe what you're looking for — used for profiling search patterns")
  lines.push("")
  lines.push("Example: `search(query=\"auth module\", tags=[\"type:design\"], intent=\"find authentication architecture decisions\")`")
  lines.push("")
  lines.push("### Writing Entries")
  lines.push("")
  lines.push("Use markdown with `##` headings. First heading becomes the title. Add tags in `namespace:value` format.")
  lines.push("")
  lines.push("```")
  lines.push("create(volume=\"layer\", content=\"## Design: Auth Token Format\", tags=[\"type:design\", \"module:auth\"], keywords=[\"jwt\", \"token\", \"security\"])")
  lines.push("```")
  lines.push("")
  lines.push("### Handoff Discipline")
  lines.push("")
  lines.push("Before ending a session, write a handoff to the `handover` volume (append-only, immutable):")
  lines.push("")
  lines.push("```")
  lines.push("create(volume=\"handover\", content=\"## Handoff: Session Summary\\nWhat was done, what's in progress, what's blocked, what's next.\", tags=[\"type:handoff\"], keywords=[\"handoff\"])")
  lines.push("```")
  lines.push("")
  lines.push("The next session's agent will read the latest handoff to continue seamlessly.")
  lines.push("")
  lines.push("### Meta Volume — Behavioral Calibration")
  lines.push("")
  lines.push("The `meta` volume holds cross-session behavioral calibrations (methodology lessons, tool quirks, reusable mental models). Entries in `meta` are **injected into your system prompt at session startup** — you see them automatically, no need to search.")
  lines.push("")
  lines.push("- Write calibrations with `create(volume=\"meta\", ...)`.")
  lines.push("- All meta entries are injected by default. To exclude an entry from injection (e.g. it's superseded or project-specific), add the `meta:disable` tag via `revise`.")
  lines.push("- Keep meta lean: signal dilutes with volume. Prefer revising an existing entry over creating a new one when the topic overlaps.")

  return lines.join("\n")
}

/**
 * Find the meta volume name. Identified by name, not profile — config may
 * override the default "mutable" profile, and meta must still be found for
 * injection regardless.
 */
function findMetaVolume(config: StellarioConfig): string | null {
  return config.volumes["meta"] ? "meta" : null
}

// =============================================================================
// Tool Definition
// =============================================================================

export function getWorkspaceToolDefs(): Record<string, ToolDef> {
  const status: ToolDef = {
    description:
      "Memory dashboard: volume stats, latest handoff, and dynamic prompt. " +
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

/**
 * Render a plan tree node and its children.
 * Indent indicates hierarchy depth.
 * Icons show status and special markers (gap, blocked_by).
 */
function renderPlanNode(node: PlanTreeNode, lines: string[], indent: number): void {
  // Prune completed/cancelled subtrees — they are history, not active context.
  // The summary line above already counts them; the rendered tree shows only
  // work that is open, claimed, in_progress, pending, or review.
  if (node.derived_status === "done" || node.derived_status === "cancelled") return

  const { item, children, derived_status } = node

  // Status icon (derived status for display)
  const statusIcon: Record<string, string> = {
    in_progress: "\u25b6",   // ▶
    pending: "\u23f8",       // ⏸
    claimed: "\u2611",       // ☑
    open: "\u25cb",          // ○
    review: "\u23f3",        // ⏳
    done: "\u2714",          // ✔
    cancelled: "\u2716",     // ✖
  }

  const icon = statusIcon[derived_status] || "\u2022"
  const ownerStr = item.owner ? ` (${item.owner})` : ""
  const statusStr = children.length > 0
    ? derived_status  // parent: show derived status
    : item.status     // leaf: show stored status

  // Base line
  const indentStr = " ".repeat(indent)
  let line = `${indentStr}${icon} [${item.id}] ${item.title}${ownerStr}`
  
  // Special markers
  if (item.gap) {
    line += ` \u26a0 Missing: ${item.gap}`  // ⚠
  }
  if (item.blocked_by && item.blocked_by.length > 0) {
    line += ` \u23f8 blocked: ${item.blocked_by.join(", ")}`  // ⏸
  }

  lines.push(line)

  // Render children
  for (const child of children) {
    renderPlanNode(child, lines, indent + 2)
  }
}
