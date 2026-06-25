import { existsSync, readFileSync } from "fs"
import { join } from "path"
import { execSync } from "child_process"
import type { StellarioConfig, ToolContext, VolumeDef } from "./types.js"
import { loadConfig, loadConfigFromPath, getMemoryDir } from "./config.js"
import { initGitRepo, migrateTrackMd } from "./git.js"
import { readMounts } from "./store.js"

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
  star: string  // device star name for ID suffix (e.g. "Sirius"), empty if unavailable
  projectName: string  // project identity in the global library (e.g. "stellario-dev"), empty if unresolved
}

/**
 * Track initialization state to avoid repeated migration checks.
 */
let _trackInitialized = false

// ─── Go Resolve Bridge ──────────────────────────────────────────────────────

interface GoResolveResult {
  project: string
  source: string
  mem_dir: string
  config_path: string
  exists: boolean
  star: string
}

/**
 * Cache for Go resolve results, keyed by project root.
 * Avoids repeated execSync calls within the same session.
 */
const _resolveCache = new Map<string, GoResolveResult | null>()

/**
 * Find the Go stellario binary.
 * Search order:
 *   1. STELLARIO_BIN env var
 *   2. stellario in PATH
 *   3. engine/stellario relative to the stellario package (dev mode)
 */
function findGoBinary(): string | null {
  // 1. Explicit env var
  const envBin = process.env.STELLARIO_BIN
  if (envBin && existsSync(envBin)) return envBin

  // 2. In PATH — verify it actually handles 'resolve' (not the Node CLI)
  try {
    const which = execSync("which stellario", { stdio: "pipe", timeout: 1000 }).toString().trim()
    if (which) {
      try {
        execSync(`"${which}" resolve --help`, { stdio: "pipe", timeout: 2000 })
        return which  // confirmed Go binary
      } catch {
        // 'stellario' in PATH doesn't support resolve — skip to dev mode
      }
    }
  } catch {
    // not in PATH
  }

  // 3. Dev mode: engine/stellario relative to this module
  //    This file is at stellario/src/context.ts
  //    Binary is at stellario/engine/stellario
  const devBin = join(__dirname, "..", "engine", "stellario")
  if (existsSync(devBin)) return devBin

  return null
}

const _goBin = findGoBinary()

/**
 * Call Go `stellario resolve --root <dir>` to find the global library location.
 * Returns null if Go is unavailable or the project hasn't been migrated yet.
 */
export function tryGoResolve(projectRoot: string): GoResolveResult | null {
  if (!_goBin) return null

  const cached = _resolveCache.get(projectRoot)
  if (cached !== undefined) return cached

  try {
    const output = execSync(
      `"${_goBin}" resolve --root "${projectRoot}"`,
      { stdio: "pipe", timeout: 5000, encoding: "utf-8" },
    )
    const result = JSON.parse(output) as GoResolveResult
    if (!result.exists) {
      _resolveCache.set(projectRoot, null)
      return null
    }
    _resolveCache.set(projectRoot, result)
    return result
  } catch {
    _resolveCache.set(projectRoot, null)
    return null
  }
}

// =============================================================================
// Context Resolution
// =============================================================================

/**
 * Resolve the full runtime context from an opencode ToolContext.
 *
 * Path A (Go resolve hit): Data lives in ~/.stellario/projects/{name}/.
 *   Config is loaded from the global library copy.
 *
 * Path B (fallback): Data lives in {projectRoot}/.opencode/memory/.
 *   Config is loaded from .opencode/stellario.yaml.
 *   This is the legacy/project-scoped path, used when Go is unavailable
 *   or the project hasn't been migrated to the global library yet.
 */
/**
 * Inject native mounts into config.volumes as frozen/readonly.
 * Called after config is loaded, before returning from resolveContext.
 * Mount volumes become transparent to all downstream tools (search, status, etc.)
 * because they appear in config.volumes and readJsonl redirects to source_path.
 */
function injectMounts(config: StellarioConfig, memDir: string): void {
  const mounts = readMounts(memDir)
  for (const { alias, mount } of mounts) {
    if (!config.volumes[alias]) {
      const frozenDef: VolumeDef = {
        profile: "frozen",
        boundaries: { read: ["all"], write: [] },
      }
      config.volumes[alias] = frozenDef
    }
  }
}

export function resolveContext(ctx: ToolContext): ResolvedContext {
  // ── Path A: Try Go resolve ──
  const goResult = tryGoResolve(ctx.directory)
  if (goResult) {
    const config = loadConfigFromPath(goResult.config_path)
    const memDir = goResult.mem_dir

    if (!_trackInitialized) {
      initGitRepo(memDir)
      _trackInitialized = true
    }

    // Inject native mounts into config
    injectMounts(config, memDir)

    return {
      config,
      projectRoot: ctx.directory,
      memDir,
      agent: ctx.agent,
      star: goResult.star || "",
      projectName: goResult.project,
    }
  }

  // ── Path B: Legacy project-scoped fallback ──
  const config = loadConfig(ctx.directory)
  const memDir = getMemoryDir(config, ctx.directory)

  if (!_trackInitialized) {
    initGitRepo(memDir)
    migrateTrackMd(memDir, config)
    _trackInitialized = true
  }

  // Inject native mounts (works in legacy mode too)
  injectMounts(config, memDir)

  return {
    config,
    projectRoot: ctx.directory,
    memDir,
    agent: ctx.agent,
    star: "",
    projectName: "",
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
