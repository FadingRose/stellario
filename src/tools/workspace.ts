import { tool } from "@opencode-ai/plugin"
import { z } from "zod"
import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { ToolContext } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead } from "../permissions.js"
import { readJsonl, readVolumeIndex, extractTitle, truncate, findEntry, getActiveWorkspace } from "../store.js"
import { getMemoryDir, getWorkspaceVolume, getTrackedVolumes } from "../config.js"

// =============================================================================
// Tool Factory
// =============================================================================

export function createWorkspaceTools() {
  // ── status ─────────────────────────────────────────────────────────────

  const status = tool({
    description:
      "Bootstrap overview: memory directory, volume stats, active workspace, and latest handoff.",
    args: {},
    async execute(_args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)

      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const lines: string[] = []
      lines.push(`Memory dir: ${ctx.memDir}`)
      lines.push(`Agent: ${agent}`)
      lines.push("")

      // Volume stats
      if (existsSync(ctx.memDir)) {
        const volumeIndex = readVolumeIndex(ctx.memDir)
        const indexMap = new Map(volumeIndex.map(e => [e.volume, e]))
        const parts: string[] = []

        for (const [name, def] of Object.entries(ctx.config.volumes)) {
          const idx = indexMap.get(name)
          let count = 0
          if (idx) {
            for (const file of idx.files) {
              const filePath = join(ctx.memDir, file)
              if (existsSync(filePath)) {
                const content = readFileSync(filePath, "utf-8")
                count += content.trim().split("\n").filter(line => line.trim()).length
              }
            }
          } else {
            const filePath = join(ctx.memDir, `${name}.jsonl`)
            if (existsSync(filePath)) {
              const content = readFileSync(filePath, "utf-8")
              count = content.trim().split("\n").filter(line => line.trim()).length
            }
          }
          if (count > 0) parts.push(`${name}: ${count}`)
        }

        // Archived
        const archivedPath = join(ctx.memDir, "archived.jsonl")
        if (existsSync(archivedPath)) {
          const content = readFileSync(archivedPath, "utf-8")
          const count = content.trim().split("\n").filter(line => line.trim()).length
          if (count > 0) parts.push(`archived: ${count}`)
        }

        lines.push(`Volumes: ${parts.length > 0 ? parts.join(", ") : "empty"}`)

        // Active workspace
        const workspaceVol = getWorkspaceVolume(ctx.config)
        if (workspaceVol) {
          const activeId = getActiveWorkspace(ctx.memDir, workspaceVol)
          lines.push("")
          lines.push("\u2500\u2500\u2500")

          if (activeId) {
            const found = findEntry(ctx.memDir, activeId, ctx.config)
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

        // Latest handoff (append volume)
        const appendVolumes = Object.entries(ctx.config.volumes)
          .filter(([, def]) => def.profile === "append")
          .map(([name]) => name)

        for (const appendVol of appendVolumes) {
          const entries = readJsonl(ctx.memDir, appendVol)
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
      } else {
        lines.push("Memory: empty (not initialized)")
      }

      return lines.join("\n")
    },
  })

  return { status }
}
