import type { StellarioConfig, VolumeDef, ProfileBehavior } from "./types.js"
import { profileBehavior } from "./types.js"

// =============================================================================
// Agent Resolution
// =============================================================================

/**
 * Normalize agent name from context.
 * Handles case differences and partial matches.
 */
export function resolveAgent(agentStr: string, config: StellarioConfig): string | null {
  const normalized = agentStr.toLowerCase().trim()
  const known = Object.keys(config.agents)

  // Exact match
  if (known.includes(normalized)) return normalized

  // Partial match
  for (const agent of known) {
    if (normalized.includes(agent)) return agent
  }

  return null
}

// =============================================================================
// Permission Checks
// =============================================================================

/**
 * Check if an agent can read a volume.
 */
export function canRead(agent: string, volume: string, config: StellarioConfig): boolean {
  const def = config.volumes[volume]
  if (!def) return false
  return def.boundaries.read.includes("all") || def.boundaries.read.includes(agent)
}

/**
 * Check if an agent can write to a volume.
 * Respects profile: frozen volumes reject all writes.
 */
export function canWrite(agent: string, volume: string, config: StellarioConfig): boolean {
  const def = config.volumes[volume]
  if (!def) return false
  const behavior = profileBehavior(def.profile)
  if (!behavior.canRevise && !canCreate(volume, config)) return false
  return def.boundaries.write.includes("all") || def.boundaries.write.includes(agent)
}

/**
 * Check if new entries can be created in a volume.
 */
export function canCreate(volume: string, config: StellarioConfig): boolean {
  const def = config.volumes[volume]
  if (!def) return false
  return def.profile !== "frozen"
}

/**
 * Check if entries in a volume can be revised.
 */
export function canRevise(volume: string, config: StellarioConfig): boolean {
  const def = config.volumes[volume]
  if (!def) return false
  return profileBehavior(def.profile).canRevise
}

/**
 * Check if entries in a volume can be forgotten (archived).
 */
export function canForget(volume: string, config: StellarioConfig): boolean {
  const def = config.volumes[volume]
  if (!def) return false
  return profileBehavior(def.profile).canForget
}

/**
 * Check if an agent is the author of an entry (for revise/forget permission).
 */
export function isAuthor(agent: string, entryAuthor: string): boolean {
  return agent === entryAuthor.toLowerCase()
}

// =============================================================================
// Volume Queries
// =============================================================================

/**
 * Get all volumes an agent can read.
 */
export function readableVolumes(agent: string, config: StellarioConfig): string[] {
  return Object.entries(config.volumes)
    .filter(([, def]) => def.boundaries.read.includes("all") || def.boundaries.read.includes(agent))
    .map(([name]) => name)
}

/**
 * Get all volumes an agent can write to.
 */
export function writableVolumes(agent: string, config: StellarioConfig): string[] {
  return Object.entries(config.volumes)
    .filter(([, def]) => {
      if (def.profile === "frozen") return false
      return def.boundaries.write.includes("all") || def.boundaries.write.includes(agent)
    })
    .map(([name]) => name)
}

/**
 * Check if an agent can search across all stories.
 * Only the first listed agent has this privilege.
 */
export function canCrossStory(agent: string, config: StellarioConfig): boolean {
  const agents = Object.keys(config.agents)
  return agents.length > 0 && agents[0] === agent
}
