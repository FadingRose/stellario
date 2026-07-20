// =============================================================================
// Stellario — Native Volume Mount Tools (discover/link/unlink)
// =============================================================================
//
// In the global library model, all projects are siblings at
// ~/.stellario/projects/{name}/. "Linking" another project's volume is just
// a record in volumes.jsonl — no symlinks, no filesystem artifacts.
//
// readJsonl reads the source_path directly. resolveContext injects mount
// volumes into config.volumes as frozen/readonly, making them transparent
// to all downstream tools (search, status, etc.).

import { z } from "zod"
import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { homedir } from "os"
import { execFileSync } from "child_process"
import { parse as parseYaml } from "yaml"
import type { ToolContext, ToolDef, StellarioConfig, MountRef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead } from "../permissions.js"
import { readMounts, addMount, removeMount } from "../store.js"

// =============================================================================
// Git Helper
// =============================================================================

/**
 * Commit volumes.jsonl (the volume index) after a mount/unmount operation.
 * Uses a simpler git path than the entry-level gitCommit.
 */
function commitVolumeIndex(memDir: string, message: string): void {
  try {
    execFileSync("git", ["add", "--", "volumes.jsonl"], { cwd: memDir, stdio: "pipe" })
    execFileSync("git", ["commit", "-m", message], { cwd: memDir, stdio: "pipe" })
  } catch {
    // best effort — may fail if nothing changed or git not configured
  }
}

// =============================================================================
// Global Library Helpers
// =============================================================================

/** Path to the global library projects directory (~/.stellario/projects/). */
function projectsDir(): string {
  return join(homedir(), ".stellario", "projects")
}

/** Path to a specific project's data directory in the global library. */
function projectDataDir(projectName: string): string {
  return join(projectsDir(), projectName)
}

/** Path to a specific volume's JSONL in a project's data directory. */
function volumeJsonlPath(projectName: string, volume: string): string {
  return join(projectDataDir(projectName), `${volume}.jsonl`)
}

/**
 * List all project names available in the global library.
 * Reads the projects directory directly — these are siblings that can be mounted.
 */
function listAvailableProjects(): string[] {
  const dir = projectsDir()
  if (!existsSync(dir)) return []
  return readdirSync(dir, { withFileTypes: true })
    .filter(e => e.isDirectory() && !e.name.startsWith("."))
    .map(e => e.name)
    .sort()
}

/**
 * Load a project's config from the global library.
 * Returns null if the project doesn't exist or has no valid config.
 */
function loadProjectConfig(projectName: string): StellarioConfig | null {
  const configPath = join(projectDataDir(projectName), "stellario.yaml")
  if (!existsSync(configPath)) return null
  try {
    const raw = readFileSync(configPath, "utf-8")
    const parsed = parseYaml(raw)
    if (parsed?.volumes) return parsed as StellarioConfig
  } catch {
    // invalid config
  }
  return null
}

/**
 * Count entries in a JSONL file by counting non-empty lines.
 */
function countJsonlEntries(filePath: string): number {
  if (!existsSync(filePath)) return 0
  const content = readFileSync(filePath, "utf-8")
  if (!content.trim()) return 0
  return content.split("\n").filter(l => l.trim()).length
}

// =============================================================================
// Tool Definitions
// =============================================================================

export function getVolumeLinkDefs(): Record<string, ToolDef> {

  // ── discover ──

  const discover: ToolDef = {
    description:
      "Discover available stellario memory volumes — both local and from external projects. " +
      "Without arguments, shows currently mounted volumes and all local volumes. " +
      "With a path, scans that directory for stellario projects and shows their volumes.",
    args: {
      path: z.string().optional().describe(
        "Directory path to scan for stellario projects. " +
        "Omit to show only current project status."
      ),
      deep: z.boolean().optional().describe(
        "Recursively scan subdirectories (max depth 2). Default: false."
      ),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const lines: string[] = []

      // ── Currently mounted volumes ──
      const mounts = readMounts(ctx.memDir)
      if (mounts.length > 0) {
        lines.push("Mounts:")
        for (const { alias, mount } of mounts) {
          const count = countJsonlEntries(mount.source_path)
          const broken = !existsSync(mount.source_path)
          const status = broken ? "\u26a0\ufe0f BROKEN" : `${count} entries`
          lines.push(`  ${alias} \u2190 ${mount.source_volume} @ ${mount.project} (${status})`)
        }
        lines.push("")
      }

      // ── Local volumes (from current project) ──
      lines.push("Local volumes:")
      for (const [name, def] of Object.entries(ctx.config.volumes)) {
        const canAccess = canRead(agent, name, ctx.config)
        const count = canAccess
          ? countJsonlEntries(join(ctx.memDir, `${name}.jsonl`))
          : -1
        const access = canAccess ? "read" : "no access"
        const profile = def.profile
        lines.push(`  ${name} (${profile}, ${access}${count >= 0 ? `, ${count} entries` : ""})`)
      }
      lines.push("")

      // ── Available projects in global library ──
      const currentProject = ctx.projectName
      const availableProjects = listAvailableProjects().filter(p => p !== currentProject)
      if (availableProjects.length > 0) {
        lines.push("Available projects:")
        for (const projectName of availableProjects) {
          const projConfig = loadProjectConfig(projectName)
          if (!projConfig) {
            lines.push(`  ${projectName} (no config)`)
            continue
          }
          const volNames = Object.keys(projConfig.volumes)
            .filter(v => v !== "archived" && v !== "meta")
          const volSummary = volNames.map(vn => {
            const count = countJsonlEntries(volumeJsonlPath(projectName, vn))
            return `${vn} (${count})`
          }).join(", ")
          lines.push(`  ${projectName}: ${volSummary}`)
        }
      }

      return lines.join("\n")
    },
  }

  // ── link (native mount) ──

  const link: ToolDef = {
    description:
      "Link an external volume into your working context. " +
      "Creates a native mount reference — no symlinks, just a record in volumes.jsonl. " +
      "The mounted volume becomes searchable and visible in your status.",
    args: {
      project: z.string().describe(
        "Name of the external stellario project in the global library."
      ),
      volume: z.string().describe(
        "Volume name in the external project to mount."
      ),
      alias: z.string().optional().describe(
        "Local alias for the mounted volume. " +
        "Must not contain ':'. " +
        "Defaults to '{project}/{volume}'."
      ),
    },
    async execute(args, context: ToolContext) {
      if (!args.project || !args.volume) return "\u274c link requires 'project' and 'volume'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      // Resolve alias (validate no ':')
      const alias = args.alias || `${args.project}/${args.volume}`
      if (alias.includes(":")) {
        return `\u274c Alias must not contain ':' (used as display ID separator).`
      }

      // Verify project exists in global library
      const sourcePath = volumeJsonlPath(args.project, args.volume)
      if (!existsSync(sourcePath)) {
        // Check if the project itself exists
        const projDir = projectDataDir(args.project)
        if (!existsSync(projDir)) {
          return `\u274c Project "${args.project}" not found in global library.\nAvailable: ${listAvailableProjects().join(", ")}`
        }
        // Project exists but volume doesn't
        const projConfig = loadProjectConfig(args.project)
        const available = projConfig
          ? Object.keys(projConfig.volumes).join(", ")
          : "(no config found)"
        return `\u274c Volume "${args.volume}" not found in project "${args.project}".\nAvailable volumes: ${available}`
      }

      // Add mount record
      const mount: MountRef = {
        project: args.project,
        source_volume: args.volume,
        source_path: sourcePath,
        mounted_at: new Date().toISOString(),
      }
      if (!addMount(ctx.memDir, alias, mount)) {
        return `\u274c Alias "${alias}" already exists. Unlink it first or use a different alias.`
      }

      // Git commit volumes.jsonl
      commitVolumeIndex(ctx.memDir, `mount: ${alias} ← ${args.volume} @ ${args.project}`)

      const entryCount = countJsonlEntries(sourcePath)

      return [
        `Mounted "${args.volume}" from ${args.project}`,
        `Alias: ${alias}`,
        `Entries: ${entryCount}`,
        `Source: ${sourcePath}`,
        `Access: readonly`,
      ].join("\n")
    },
  }

  // ── unlink ──

  const unlink: ToolDef = {
    description:
      "Unlink a previously mounted external volume. " +
      "Removes the mount record from volumes.jsonl.",
    args: {
      alias: z.string().describe("Alias of the mounted volume to unlink."),
    },
    async execute(args, context: ToolContext) {
      if (!args.alias) return "\u274c unlink requires 'alias'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const removed = removeMount(ctx.memDir, args.alias)
      if (!removed) {
        // Distinguish between "not found" and "is a native volume"
        return `\u274c "${args.alias}" is not a mounted volume.`
      }

      // Git commit volumes.jsonl
      commitVolumeIndex(ctx.memDir, `unmount: ${args.alias}`)

      return [
        `Unmounted "${args.alias}"`,
        `Was: ${removed.source_volume} @ ${removed.project}`,
        `Mounted at: ${removed.mounted_at}`,
      ].join("\n")
    },
  }

  return { discover, link, unlink }
}
