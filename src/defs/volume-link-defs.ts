// =============================================================================
// Stellario — Volume-Level Link/Unlink/Discover Tool Definitions
// =============================================================================
//
// Volume link = bind an external stellario project's volume into the agent's
// working context. The external volume is accessed readonly via symlink.
//
// Volume unlink = remove the binding and symlink.
//
// Discover = scan for available stellario projects and their volumes.

import { z } from "zod"
import { existsSync, readFileSync, symlinkSync, unlinkSync, mkdirSync, readdirSync, statSync, lstatSync, readlinkSync } from "fs"
import { join, resolve, basename } from "path"
import { parse as parseYaml } from "yaml"
import type { ToolContext, ToolDef, StellarioConfig, LinkedVolume } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent, canRead } from "../permissions.js"
import {
  getLinkedVolumes,
  addLinkedVolume,
  removeLinkedVolume,
  getLinkedVolumeSymlinkPath,
  getLinkedVolumesDir,
  readJsonl,
} from "../store.js"
import { loadConfig, getMemoryDir } from "../config.js"

// =============================================================================
// Helpers
// =============================================================================

/**
 * Try to load a stellario config from a project path.
 * Returns null if not a stellario project.
 */
function tryLoadConfig(projectPath: string): StellarioConfig | null {
  const candidates = [
    join(projectPath, ".opencode", "stellario.yaml"),
    join(projectPath, "stellario.yaml"),
  ]
  for (const path of candidates) {
    if (existsSync(path)) {
      try {
        const raw = readFileSync(path, "utf-8")
        const parsed = parseYaml(raw)
        // Minimal validation
        if (parsed?.volumes && parsed?.agents) return parsed as StellarioConfig
      } catch {
        return null
      }
    }
  }
  return null
}

/**
 * Count entries in a volume's JSONL file.
 */
function countEntries(memDir: string, volume: string): number {
  const filePath = join(memDir, `${volume}.jsonl`)
  if (!existsSync(filePath)) return 0
  const content = readFileSync(filePath, "utf-8")
  if (!content.trim()) return 0
  return content.split("\n").filter(l => l.trim()).length
}

/**
 * Read entries from a linked (external) volume via its symlink.
 * Returns entries in a format compatible with readJsonl.
 */
export function readLinkedVolume(memDir: string, alias: string): import("../types.js").MemoryEntry[] {
  const linkPath = getLinkedVolumeSymlinkPath(memDir, alias)
  if (!lstatSync(linkPath).isSymbolicLink() && !existsSync(linkPath)) return []

  try {
    const content = readFileSync(linkPath, "utf-8")
    if (!content.trim()) return []
    return content
      .split("\n")
      .filter(line => line.trim())
      .map(line => JSON.parse(line) as import("../types.js").MemoryEntry)
  } catch {
    return []
  }
}

// =============================================================================
// Tool Definitions
// =============================================================================

export function getVolumeLinkDefs(): Record<string, ToolDef> {

  // ── discover ──

  const discover: ToolDef = {
    description:
      "Discover available stellario memory volumes — both local and from external projects. " +
      "Without arguments, shows currently linked volumes and all local volumes. " +
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

      // ── Currently linked volumes ──
      const linked = getLinkedVolumes(ctx.memDir, agent)
      if (linked.length > 0) {
        lines.push("Linked volumes:")
        for (const lv of linked) {
          const entryCount = safeCountLinked(ctx.memDir, lv.alias)
          lines.push(`  ${lv.alias} ← ${lv.source_volume} @ ${lv.source_project} (${entryCount} entries)`)
        }
        lines.push("")
      }

      // ── Local volumes (from current project) ──
      lines.push("Local volumes:")
      for (const [name, def] of Object.entries(ctx.config.volumes)) {
        const canAccess = canRead(agent, name, ctx.config)
        const count = canAccess ? countEntries(ctx.memDir, name) : -1
        const access = canAccess ? "read" : "no access"
        const profile = def.profile
        lines.push(`  ${name} (${profile}, ${access}${count >= 0 ? `, ${count} entries` : ""})`)
      }
      lines.push("")

      // ── Scan external path ──
      if (args.path) {
        const scanPath = resolve(args.path)
        if (!existsSync(scanPath)) {
          lines.push(`Path not found: ${scanPath}`)
          return lines.join("\n")
        }

        lines.push(`Scanning: ${scanPath}`)
        const projects = scanForProjects(scanPath, args.deep ? 2 : 1)
        const linkedAliases = new Set(linked.map(l => l.alias))

        if (projects.length === 0) {
          lines.push("  No stellario projects found.")
        } else {
          for (const project of projects) {
            lines.push("")
            lines.push(`  ${project.path}`)
            for (const [volName, volDef] of Object.entries(project.config.volumes)) {
              const alias = `${basename(project.path)}_${volName}`
              const alreadyLinked = linkedAliases.has(alias)
              const marker = alreadyLinked ? " [linked]" : ""
              const profile = volDef.profile
              lines.push(`    ${volName} (${profile}) → link as "${alias}"${marker}`)
            }
          }
        }
      }

      return lines.join("\n")
    },
  }

  // ── link (volume level) ──

  const link: ToolDef = {
    description:
      "Link an external volume into your working context. " +
      "Creates a readonly symlink to the external volume's JSONL data. " +
      "The linked volume becomes searchable and visible in your status.",
    args: {
      project: z.string().describe(
        "Absolute or relative path to the external stellario project."
      ),
      volume: z.string().describe(
        "Volume name in the external project to link."
      ),
      alias: z.string().optional().describe(
        "Local alias for the linked volume. " +
        "Defaults to '{dirname}_{volume_name}'."
      ),
    },
    async execute(args, context: ToolContext) {
      if (!args.project || !args.volume) return "\u274c link requires 'project' and 'volume'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const projectPath = resolve(args.project)
      if (!existsSync(projectPath)) {
        return `\u274c Project path not found: ${projectPath}`
      }

      // Load external config
      const extConfig = tryLoadConfig(projectPath)
      if (!extConfig) {
        return `\u274c No stellario config found at: ${projectPath}`
      }

      const volDef = extConfig.volumes[args.volume]
      if (!volDef) {
        return `\u274c Volume "${args.volume}" not found in external project. Available: ${Object.keys(extConfig.volumes).join(", ")}`
      }

      // Resolve alias
      const alias = args.alias || `${basename(projectPath)}_${args.volume}`

      // Check alias uniqueness
      const linked = getLinkedVolumes(ctx.memDir, agent)
      if (linked.some(l => l.alias === alias)) {
        return `\u274c Alias "${alias}" is already linked. Unlink it first.`
      }

      // Resolve external memDir
      const extMemDir = getMemoryDir(extConfig, projectPath)
      const extJsonlPath = join(extMemDir, `${args.volume}.jsonl`)
      if (!existsSync(extJsonlPath)) {
        return `\u274c External volume data not found: ${extJsonlPath}`
      }

      // Create symlink
      const linkedDir = getLinkedVolumesDir(ctx.memDir)
      if (!existsSync(linkedDir)) mkdirSync(linkedDir, { recursive: true })

      const symlinkPath = getLinkedVolumeSymlinkPath(ctx.memDir, alias)
      if (existsSync(symlinkPath)) {
        return `\u274c Symlink already exists at: ${symlinkPath}. Remove it manually or use a different alias.`
      }

      try {
        symlinkSync(extJsonlPath, symlinkPath)
      } catch (err: any) {
        return `\u274c Failed to create symlink: ${err.message}`
      }

      // Register in index
      const linkEntry: LinkedVolume = {
        alias,
        source_project: projectPath,
        source_volume: args.volume,
        linked_at: new Date().toISOString(),
      }
      addLinkedVolume(ctx.memDir, agent, linkEntry)

      const entryCount = countEntries(extMemDir, args.volume)

      return [
        `Linked volume "${args.volume}" from ${basename(projectPath)}`,
        `Alias: ${alias}`,
        `Entries: ${entryCount}`,
        `Source: ${extJsonlPath}`,
        `Access: readonly`,
      ].join("\n")
    },
  }

  // ── unlink (volume level) ──

  const unlink: ToolDef = {
    description:
      "Unlink a previously linked external volume. " +
      "Removes the symlink and unregisters the volume from your context.",
    args: {
      alias: z.string().describe("Alias of the linked volume to unlink."),
    },
    async execute(args, context: ToolContext) {
      if (!args.alias) return "\u274c unlink requires 'alias'."

      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const removed = removeLinkedVolume(ctx.memDir, agent, args.alias)
      if (!removed) {
        return `\u274c No linked volume with alias "${args.alias}".`
      }

      // Remove symlink
      const symlinkPath = getLinkedVolumeSymlinkPath(ctx.memDir, args.alias)
      try {
        if (lstatSync(symlinkPath).isSymbolicLink() || existsSync(symlinkPath)) {
          unlinkSync(symlinkPath)
        }
      } catch {
        // Best effort — symlink may already be gone
      }

      return [
        `Unlinked "${args.alias}"`,
        `Was: ${removed.source_volume} @ ${basename(removed.source_project)}`,
        `Linked at: ${removed.linked_at}`,
      ].join("\n")
    },
  }

  return { discover, link, unlink }
}

// =============================================================================
// Internal Helpers
// =============================================================================

interface DiscoveredProject {
  path: string
  config: StellarioConfig
}

/**
 * Scan a directory for stellario projects.
 */
function scanForProjects(rootPath: string, maxDepth: number): DiscoveredProject[] {
  const results: DiscoveredProject[] = []

  // Check if root itself is a stellario project
  const rootConfig = tryLoadConfig(rootPath)
  if (rootConfig) {
    results.push({ path: rootPath, config: rootConfig })
  }

  if (maxDepth <= 0) return results

  try {
    const entries = readdirSync(rootPath, { withFileTypes: true })
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || entry.name === "node_modules") continue

      const subPath = join(rootPath, entry.name)
      const subConfig = tryLoadConfig(subPath)
      if (subConfig) {
        results.push({ path: subPath, config: subConfig })
      } else if (maxDepth > 1) {
        // Recurse one more level
        results.push(...scanForProjects(subPath, maxDepth - 1))
      }
    }
  } catch {
    // Permission denied or other FS error — skip
  }

  return results
}

/**
 * Safely count entries in a linked volume (may be broken symlink).
 */
function safeCountLinked(memDir: string, alias: string): number {
  try {
    return readLinkedVolume(memDir, alias).length
  } catch {
    return 0
  }
}
