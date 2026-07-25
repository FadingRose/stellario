import { existsSync, readFileSync, readdirSync } from "fs"
import { join } from "path"
import { execFileSync } from "child_process"
import { homedir } from "os"
import type { StellarioConfig, ToolContext, VolumeDef } from "./types.js"
import { loadConfig, loadConfigFromPath, getMemoryDir } from "./config.js"
import { initGitRepo, migrateTrackMd } from "./git.js"
import { readMounts, setAutoMounts } from "./store.js"

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

interface SiblingDevice {
  device_id: string
  star: string
  path: string
}

interface GoResolveResult {
  project: string
  source: string
  mem_dir: string
  config_path: string
  exists: boolean
  star: string
  siblings?: SiblingDevice[]
}

/**
 * Cache for Go resolve results, keyed by project root.
 * Null results expire after 60s so transient failures (wrong binary in PATH,
 * binary not yet installed) auto-retry instead of caching forever.
 */
const _resolveCache = new Map<string, { result: GoResolveResult | null; ts: number }>()
const _NULL_CACHE_TTL_MS = 60_000

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
    const which = execFileSync("which", ["stellario"], { stdio: "pipe", timeout: 1000 }).toString().trim()
    if (which) {
      try {
        execFileSync(which, ["resolve", "--help"], { stdio: "pipe", timeout: 2000 })
        return which  // confirmed Go binary
      } catch {
        // 'stellario' in PATH doesn't support resolve — skip to dev mode
      }
    }
  } catch {
    // not in PATH
  }

  // 3. Dev mode: engine/stellario relative to this module
  const devBin = join(__dirname, "..", "engine", "stellario")
  if (existsSync(devBin)) return devBin

  return null
}

/**
 * Lazy Go binary discovery — computed on first use, cached.
 * NOT a module-level constant so that PATH changes take effect
 * even if the module was loaded before the binary was installed.
 */
let _goBin: string | null | undefined

function getGoBinary(): string | null {
  if (_goBin !== undefined) return _goBin
  _goBin = findGoBinary()
  return _goBin
}

/**
 * Call Go `stellario resolve --root <dir>` to find the global library location.
 * Returns null if Go is unavailable or the project hasn't been migrated yet.
 */
export function tryGoResolve(projectRoot: string): GoResolveResult | null {
  const goBin = getGoBinary()
  if (!goBin) return null

  const cached = _resolveCache.get(projectRoot)
  if (cached !== undefined) {
    if (cached.result !== null) return cached.result
    if (Date.now() - cached.ts < _NULL_CACHE_TTL_MS) return null
    _resolveCache.delete(projectRoot)
  }

  try {
    const output = execFileSync(
      goBin,
      ["resolve", "--root", projectRoot],
      { stdio: "pipe", timeout: 5000, encoding: "utf-8" },
    )
    const result = JSON.parse(output) as GoResolveResult
    if (!result.exists) {
      _resolveCache.set(projectRoot, { result: null, ts: Date.now() })
      return null
    }
    _resolveCache.set(projectRoot, { result, ts: Date.now() })
    return result
  } catch {
    _resolveCache.set(projectRoot, { result: null, ts: Date.now() })
    return null
  }
}

// =============================================================================
// Context Resolution
// =============================================================================

/**
 * Resolve the full runtime context from an opencode ToolContext.
 *
 * Guardian path (identity-driven): if the agent is declared in the global
 *   config (~/.stellario/global/<device>/), it resolves to the global library
 *   regardless of CWD. The guardian can be invoked from any directory.
 *
 * Path A (directory-driven, Go resolve): Data in ~/.stellario/projects/{name}/{device}/.
 *   Config from global library. Requires device-relative layout
 *   (stellario migrate-device).
 *
 * Path A failed + project config present → explicit ERROR. No silent local
 *   fallback — prevents brain split (l341). Usually flat→device-relative
 *   mismatch; run `stellario migrate-device`.
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

/**
 * Inject sibling-device volumes as auto-mounts (frozen/readonly).
 * Each sibling device's volumes become visible as `{star}-{volume}`.
 * This is the cross-device visibility mechanism in the device-relative model:
 * the local device reads its own dir; sibling dirs are mounted readonly.
 *
 * Builds both the ephemeral source-path registry (for readJsonl) and the
 * frozen VolumeDefs (so search/status/etc. see them as known volumes).
 */
function injectAutoMounts(config: StellarioConfig, siblings: SiblingDevice[] | undefined): void {
  const autoMounts = new Map<string, string>()
  if (siblings && siblings.length > 0) {
    for (const sib of siblings) {
      const star = sib.star || sib.device_id
      let entries: string[]
      try {
        entries = readdirSync(sib.path)
      } catch {
        continue
      }
      for (const name of entries) {
        // Only top-level single-file volumes (v1; sharded volumes are skipped)
        if (!name.endsWith(".jsonl")) continue
        if (name === "volumes.jsonl" || name === "keywords-index.jsonl" ||
            name === "intent-log.jsonl" || name.includes(".index-pending")) {
          continue
        }
        const volname = name.slice(0, -".jsonl".length)
        const alias = `${star}-${volname}`
        const sourcePath = join(sib.path, name)
        autoMounts.set(alias, sourcePath)
        if (!config.volumes[alias]) {
          config.volumes[alias] = {
            profile: "frozen",
            boundaries: { read: ["all"], write: [] },
            // idPrefix must match the source volume so parseDisplayId
            // can reconstruct stored IDs correctly (e.g. "a83" not "l83").
            idPrefix: volname.charAt(0),
          }
        }
      }
    }
  }
  setAutoMounts(autoMounts)
}

/**
 * Read the device identity from ~/.stellario/.device-id.
 * Returns the device directory name (id) and star name.
 */
interface DeviceId { id: string; star: string }
function readDeviceId(): DeviceId | null {
  try {
    const p = join(homedir(), ".stellario", ".device-id")
    if (!existsSync(p)) return null
    const data = JSON.parse(readFileSync(p, "utf-8"))
    if (!data.id) return null
    return { id: data.id, star: data.star || "" }
  } catch { /* ignore */ }
  return null
}

/**
 * Load the global context (the guardian's home): config + memDir + star.
 * Cached after first load. Returns null if no global config exists.
 *
 * The guardian agent is whichever agent is declared in the global config.
 * Resolution is identity-driven: regardless of CWD, the guardian always
 * resolves here. This replaces the old directory-based Path C fallback.
 */
let _globalCtxCache: { config: StellarioConfig; memDir: string; star: string } | null | undefined

export function loadGlobalContext(): { config: StellarioConfig; memDir: string; star: string } | null {
  if (_globalCtxCache !== undefined) return _globalCtxCache
  try {
    const dev = readDeviceId()
    if (!dev) { _globalCtxCache = null; return null }
    const memDir = join(homedir(), ".stellario", "global", dev.id)
    const configPath = join(memDir, "stellario.yaml")
    if (!existsSync(configPath)) { _globalCtxCache = null; return null }
    const config = loadConfigFromPath(configPath)
    _globalCtxCache = { config, memDir, star: dev.star }
    return _globalCtxCache
  } catch {
    _globalCtxCache = null
    return null
  }
}

/**
 * Is this agent the guardian? The guardian is any agent declared in the
 * global config. It resolves to the global library regardless of CWD.
 */
export function isGuardianAgent(agentName: string): boolean {
  const g = loadGlobalContext()
  return !!g && (agentName in g.config.agents)
}

export function resolveContext(ctx: ToolContext): ResolvedContext {
  // ── Guardian resolution (identity-driven, not directory-driven) ──
  // The guardian agent is declared in the global config and can be invoked
  // from any directory. It always resolves to the global library, regardless
  // of CWD. This replaces the old directory-based Path C fallback.
  if (isGuardianAgent(ctx.agent)) {
    const g = loadGlobalContext()!
    if (!_trackInitialized) {
      initGitRepo(g.memDir)
      _trackInitialized = true
    }
    injectMounts(g.config, g.memDir)
    injectAutoMounts(g.config, [])
    return {
      config: g.config,
      projectRoot: ctx.directory,
      memDir: g.memDir,
      agent: ctx.agent,
      star: g.star,
      projectName: "_global",
    }
  }

  // ── Path A: directory-driven Go resolve ──
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
    // Inject sibling-device auto-mounts (cross-device visibility)
    injectAutoMounts(config, goResult.siblings)

    return {
      config,
      projectRoot: ctx.directory,
      memDir,
      agent: ctx.agent,
      star: goResult.star || "",
      projectName: goResult.project,
    }
  }

  // ── Path A failed — NO silent local fallback (prevents brain split, see l341). ──
  if (!getGoBinary()) {
    throw new Error(
      "Stellario Go binary not found — memory tools unavailable. Reinstall stellario."
    )
  }
  const hasProjectConfig =
    existsSync(join(ctx.directory, ".opencode", "stellario.yaml")) ||
    existsSync(join(ctx.directory, "stellario.yaml"))
  if (hasProjectConfig) {
    throw new Error(
      `Project at ${ctx.directory} has a stellario config but Go resolve failed ` +
      "(exists=false). Usually flat→device-relative layout mismatch.\n" +
      "Fix: stellario project register (if unregistered) + stellario migrate-device."
    )
  }

  // All paths failed: no project config, and the agent is not the guardian.
  throw new Error(
    `No stellario context for agent "${ctx.agent}" in ${ctx.directory}. ` +
    "The guardian agent resolves to the global library; project agents require a " +
    "project config. Create .opencode/stellario.yaml or run from a registered project."
  )
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
