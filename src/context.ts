import { existsSync, readFileSync } from "fs"
import { join } from "path"
import type { StellarioConfig, ToolContext } from "./types.js"
import { loadConfig, getMemoryDir } from "./config.js"
import { initGitRepo, migrateTrackMd } from "./git.js"

// =============================================================================
// Context Resolution
// =============================================================================

/**
 * Resolved runtime context for a tool invocation.
 * Combines config, paths, and agent identity.
 */
export interface ResolvedContext {
  config: StellarioConfig
  projectRoot: string
  memDir: string
  agent: string
}

/**
 * Track initialization state to avoid repeated migration checks.
 */
let _trackInitialized = false

/**
 * Resolve the full runtime context from an opencode ToolContext.
 * Loads config, computes paths, and runs one-time initialization.
 */
export function resolveContext(ctx: ToolContext): ResolvedContext {
  const config = loadConfig(ctx.directory)
  const memDir = getMemoryDir(config, ctx.directory)

  // One-time initialization: git repo + per-entry md migration
  if (!_trackInitialized) {
    initGitRepo(memDir)
    migrateTrackMd(memDir, config)
    _trackInitialized = true
  }

  return {
    config,
    projectRoot: ctx.directory,
    memDir,
    agent: ctx.agent,
  }
}

// =============================================================================
// Project Detection Helpers
// =============================================================================

/**
 * Detect if project is a Rust workspace.
 */
export function isRustProject(projectRoot: string): boolean {
  return existsSync(join(projectRoot, "Cargo.toml"))
}

/**
 * Detect if project has an opencode config.
 */
export function hasOpencodeConfig(projectRoot: string): boolean {
  return existsSync(join(projectRoot, ".opencode"))
}

/**
 * Get workspace member crates (for Rust projects).
 */
export function getRustCrates(projectRoot: string): string[] {
  const cargoPath = join(projectRoot, "Cargo.toml")
  if (!existsSync(cargoPath)) return []

  try {
    const content = readFileSync(cargoPath, "utf-8")
    const members: string[] = []
    const match = content.match(/members\s*=\s*\[([\s\S]*?)\]/)
    if (match) {
      const raw = match[1]
      const entries = raw.match(/"([^"]+)"/g)
      if (entries) {
        members.push(...entries.map((e) => e.replace(/"/g, "")))
      }
    }
    return members
  } catch {
    return []
  }
}
