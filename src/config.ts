import { readFileSync, existsSync } from "fs"
import { join } from "path"
import { parse as parseYaml } from "yaml"
import type { StellarioConfig, VolumeDef, Profile } from "./types.js"
import { profileBehavior } from "./types.js"

const CONFIG_FILENAME = "stellario.yaml"

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
      const raw = readFileSync(path, "utf-8")
      const parsed = parseYaml(raw)
      return validateConfig(parsed, path)
    }
  }

  throw new Error(
    `Stellario config not found. Create .opencode/${CONFIG_FILENAME} or ${CONFIG_FILENAME} in your project root.`
  )
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

  const volumes: Record<string, VolumeDef> = {}
  const validProfiles: Profile[] = ["mutable", "append", "scratch", "frozen", "workspace"]

  for (const [name, def] of Object.entries(raw.volumes)) {
    const v = def as Record<string, any>

    if (!v.profile || !validProfiles.includes(v.profile)) {
      throw new Error(
        `Volume "${name}": profile must be one of ${validProfiles.join(", ")}, got "${v.profile}"`
      )
    }

    if (!v.boundaries || typeof v.boundaries !== "object") {
      throw new Error(`Volume "${name}": "boundaries" is required.`)
    }

    volumes[name] = {
      profile: v.profile,
      boundaries: {
        read: normalizeAgentList(v.boundaries.read),
        write: normalizeAgentList(v.boundaries.write),
      },
      authority: v.authority,
      requiredTagPrefix: v.requiredTagPrefix,
      idPrefix: v.idPrefix,
      autoRefs: v.autoRefs,
    }
  }

  // Validate workspace uniqueness
  const workspaceVolumes = Object.entries(volumes).filter(([, v]) => v.profile === "workspace")
  if (workspaceVolumes.length > 1) {
    throw new Error(
      `At most one volume can have profile "workspace". Found: ${workspaceVolumes.map(([n]) => n).join(", ")}`
    )
  }

  // Agents
  if (!raw.agents || typeof raw.agents !== "object") {
    throw new Error(`Invalid config: "agents" is required and must be an object.`)
  }

  const agents: Record<string, { display: string }> = {}
  for (const [name, def] of Object.entries(raw.agents)) {
    const a = def as Record<string, any>
    agents[name] = {
      display: a.display || name,
    }
  }

  // Validate boundaries reference known agents
  const knownAgents = new Set([...Object.keys(agents), "all"])
  for (const [volName, volDef] of Object.entries(volumes)) {
    for (const agent of [...volDef.boundaries.read, ...volDef.boundaries.write]) {
      if (!knownAgents.has(agent)) {
        console.warn(`Warning: Volume "${volName}" references unknown agent "${agent}" in boundaries.`)
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
 * Get the workspace volume name, or null if none configured.
 */
export function getWorkspaceVolume(config: StellarioConfig): string | null {
  for (const [name, def] of Object.entries(config.volumes)) {
    if (def.profile === "workspace") return name
  }
  return null
}

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
