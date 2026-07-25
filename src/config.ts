import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { parse as parseYaml } from "yaml"
import type { StellarioConfig, VolumeDef, Profile, AgentDef } from "./types.js"
import { profileBehavior } from "./types.js"

const CONFIG_FILENAME = "stellario.yaml"

// =============================================================================
// System Volume Defaults (overridable)
// =============================================================================
//
// These volumes provide sensible defaults so a minimal config works without
// declaring them. They are NOT reserved — a project config can override any
// field (profile, idPrefix, boundaries, etc.) for these volumes. Config is
// the authority; system defaults only fill in fields the config omits.
//
//   archived  (frozen)    — destination for forgotten entries
//   meta      (mutable)   — behavioral calibrations, injected into prompts
//   handover  (append)    — session handoff logs

const SYSTEM_VOLUMES: Record<string, VolumeDef> = {
  archived: {
    profile: "frozen",
    boundaries: { read: ["all"], write: [] },
    idPrefix: "z",
  },
  meta: {
    profile: "mutable",
    boundaries: { read: ["all"], write: ["all"] },
    idPrefix: "m",
  },
  handover: {
    profile: "append",
    boundaries: { read: ["all"], write: ["all"] },
    idPrefix: "h",
  },
}

/** Set of reserved volume names for quick lookup. */
export const SYSTEM_VOLUME_NAMES = new Set(Object.keys(SYSTEM_VOLUMES))

// =============================================================================
// Config Loading
// =============================================================================

/**
 * Find and load stellario.yaml.
 * Search order:
 *   1. .opencode/stellario.yaml
 *   2. stellario.yaml (project root)
 */
export function loadConfig(projectRoot: string): StellarioConfig {
  const candidates = [
    join(projectRoot, ".opencode", CONFIG_FILENAME),
    join(projectRoot, CONFIG_FILENAME),
  ]

  for (const path of candidates) {
    if (existsSync(path)) {
      return loadConfigFromPath(path)
    }
  }

  throw new Error(
    `Stellario config not found. Create .opencode/${CONFIG_FILENAME} or ${CONFIG_FILENAME} in your project root.`
  )
}

/**
 * Load and validate config from an explicit file path.
 * Used when Go resolve provides the config path in the global library.
 */
export function loadConfigFromPath(configPath: string): StellarioConfig {
  if (!existsSync(configPath)) {
    throw new Error(`Stellario config not found at ${configPath}.`)
  }
  const raw = readFileSync(configPath, "utf-8")
  const parsed = parseYaml(raw)
  return validateConfig(parsed, configPath)
}

// =============================================================================
// Validation
// =============================================================================

function validateConfig(raw: any, sourcePath: string): StellarioConfig {
  if (!raw || typeof raw !== "object") {
    throw new Error(`Invalid config in ${sourcePath}: expected an object.`)
  }

  // Volumes
  if (!raw.volumes || typeof raw.volumes !== "object") {
    throw new Error(`Invalid config: "volumes" is required and must be an object.`)
  }

  const validProfiles: Profile[] = ["mutable", "append", "scratch", "frozen"]
  // Intermediate storage: system volumes may not have boundaries in user config
  const userVolumes: Record<string, Partial<VolumeDef> & { profile: Profile }> = {}

  for (const [name, def] of Object.entries(raw.volumes)) {
    const v = def as Record<string, any>
    const isSystem = SYSTEM_VOLUME_NAMES.has(name)

    // System volumes: profile defaults from system, but user may override.
    // Non-system volumes: user must specify profile.
    const profile = isSystem
      ? (v.profile || SYSTEM_VOLUMES[name].profile)  // user override, else default
      : v.profile

    if (!profile || !validProfiles.includes(profile)) {
      throw new Error(
        `Volume "${name}": profile must be one of ${validProfiles.join(", ")}, got "${profile}"`
      )
    }

    // System volumes don't require boundaries in user config (system provides defaults)
    if (!isSystem && (!v.boundaries || typeof v.boundaries !== "object")) {
      throw new Error(`Volume "${name}": "boundaries" is required.`)
    }

    userVolumes[name] = {
      profile,
      boundaries: v.boundaries ? {
        read: normalizeAgentList(v.boundaries.read),
        write: normalizeAgentList(v.boundaries.write),
      } : undefined,
      authority: v.authority,
      requiredTagPrefix: v.requiredTagPrefix,
      idPrefix: v.idPrefix,
      autoRefs: v.autoRefs,
    }
  }

  const volumes: Record<string, VolumeDef> = {}

  // Non-system volumes from user (must have boundaries)
  for (const [name, def] of Object.entries(userVolumes)) {
    if (!SYSTEM_VOLUME_NAMES.has(name)) {
      volumes[name] = def as VolumeDef
    }
  }

  // Merge system volume defaults: config is authoritative — user fields win,
  // system defaults only fill in fields the config omits.
  for (const [name, sysDef] of Object.entries(SYSTEM_VOLUMES)) {
    const userDef = userVolumes[name]
    if (userDef) {
      volumes[name] = {
        profile: userDef.profile,        // user override (default applied at parse)
        boundaries: userDef.boundaries || sysDef.boundaries,
        authority: userDef.authority || sysDef.authority,
        requiredTagPrefix: userDef.requiredTagPrefix || sysDef.requiredTagPrefix,
        idPrefix: userDef.idPrefix || sysDef.idPrefix,
        autoRefs: userDef.autoRefs || sysDef.autoRefs,
      }
    } else {
      volumes[name] = { ...sysDef }
    }
  }

  // Validate idPrefix uniqueness across all volumes (system + user)
  const prefixToVolumes = new Map<string, string[]>()
  for (const [name, def] of Object.entries(volumes)) {
    const prefix = def.idPrefix || name.charAt(0)
    const existing = prefixToVolumes.get(prefix) || []
    existing.push(name)
    prefixToVolumes.set(prefix, existing)
  }
  for (const [prefix, volNames] of prefixToVolumes) {
    if (volNames.length > 1) {
      throw new Error(
        `idPrefix conflict: prefix "${prefix}" is used by volumes: ${volNames.join(", ")}. ` +
        `Each volume must have a unique idPrefix (set explicitly via idPrefix: in config).`
      )
    }
  }

  // Agents
  if (!raw.agents || typeof raw.agents !== "object") {
    throw new Error(`Invalid config: "agents" is required and must be an object.`)
  }

  const agents: Record<string, AgentDef> = {}
  for (const [name, def] of Object.entries(raw.agents)) {
    const a = def as Record<string, any>
    const agent: AgentDef = { display: a.display || name }
    if (a.role === "primary" || a.role === "subagent") agent.role = a.role
    if (a.inject && typeof a.inject === "object") {
      const meta = Array.isArray(a.inject.meta)
        ? a.inject.meta.filter((t: any) => typeof t === "string")
        : undefined
      if (meta && meta.length > 0) agent.inject = { meta }
    }
    agents[name] = agent
  }

  // Validate boundaries reference known agents
  const knownAgents = new Set([...Object.keys(agents), "all"])
  for (const [volName, volDef] of Object.entries(volumes)) {
    for (const agent of [...volDef.boundaries.read, ...volDef.boundaries.write]) {
      if (!knownAgents.has(agent)) {
        // Silently skip — unknown agent in boundaries is non-fatal
      }
    }
  }

  // Embedding (optional)
  let embedding: StellarioConfig["embedding"]
  if (raw.embedding && typeof raw.embedding === "object") {
    embedding = {
      enabled: raw.embedding.enabled,
      model: raw.embedding.model,
    }
  }

  return {
    memoryDir: raw.memoryDir || ".opencode/.stellario",
    volumes,
    agents,
    tags: raw.tags,
    embedding,
    lsp: raw.lsp && typeof raw.lsp === "object" ? raw.lsp : undefined,
  }
}

/**
 * Normalize agent list: accept string "all" or string[].
 */
function normalizeAgentList(value: string[] | string | undefined): string[] {
  if (!value) return []
  if (typeof value === "string") return [value]
  return Array.isArray(value) ? value : []
}

// =============================================================================
// Config Utilities
// =============================================================================

/**
 * Get all volume names that are git-tracked.
 */
export function getTrackedVolumes(config: StellarioConfig): string[] {
  return Object.entries(config.volumes)
    .filter(([, def]) => profileBehavior(def.profile).isTracked)
    .map(([name]) => name)
}

/**
 * Get the ID prefix for a volume.
 * Defaults to the first character of the volume name.
 */
export function getVolumeIdPrefix(config: StellarioConfig, volume: string): string {
  const def = config.volumes[volume]
  if (!def) return "z"
  if (def.idPrefix) return def.idPrefix
  return volume.charAt(0)
}

/**
 * Resolve memory directory path (absolute).
 */
export function getMemoryDir(config: StellarioConfig, projectRoot: string): string {
  return join(projectRoot, config.memoryDir || ".opencode/.stellario")
}
