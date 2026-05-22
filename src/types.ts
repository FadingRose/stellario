// =============================================================================
// Stellario — Core Types
// =============================================================================

// ─── Profile ────────────────────────────────────────────────────────────────

/**
 * Volume behavioral profiles.
 *
 * Each profile defines how entries in the volume behave over time:
 * - mutable:    can create, revise, forget. permanent, stable IDs.
 * - append:     can create only. cannot revise or forget. permanent, stable IDs.
 * - scratch:    can create, revise, forget. transient (not git-tracked), ephemeral IDs.
 * - frozen:     cannot create, revise, or forget. read-only.
 * - workspace:  like mutable + tracks active entry (per-project, unique).
 */
export type Profile = "mutable" | "append" | "scratch" | "frozen" | "workspace"

/**
 * Derived behavioral flags from a profile.
 * These drive the actual system behavior.
 */
export interface ProfileBehavior {
  /** Can entries be revised after creation? */
  canRevise: boolean
  /** Can entries be deleted (forgotten/archived)? */
  canForget: boolean
  /** Is the volume version-controlled (git tracked)? */
  isTracked: boolean
  /** Do entries use stable sequential IDs (vs ephemeral short hash)? */
  hasStableId: boolean
  /** Does this volume track an active entry? (workspace only) */
  tracksActive: boolean
}

// ─── Boundaries ─────────────────────────────────────────────────────────────

export interface Boundaries {
  /** Agent names (or ["all"]) that can read entries in this volume. */
  read: string[]
  /** Agent names (or ["all"]) that can write to this volume. */
  write: string[]
}

// ─── Authority ──────────────────────────────────────────────────────────────

/**
 * Epistemological layer of the content.
 * Source = raw material. Curated = human judgment. Synthesized = agent-derived, rebuildable.
 * This is a semantic label — it does not drive system behavior.
 */
export type Authority = "source" | "curated" | "synthesized"

// ─── Volume Definition ──────────────────────────────────────────────────────

export interface VolumeDef {
  profile: Profile
  boundaries: Boundaries
  authority?: Authority
  /** Optional: enforce a tag prefix on all entries (e.g., "lore:"). */
  requiredTagPrefix?: string
  /** Optional: custom ID prefix character (defaults to first char of volume name). */
  idPrefix?: string
}

// ─── Agent Definition ───────────────────────────────────────────────────────

export interface AgentDef {
  /** Human-readable name shown in tool output. */
  display: string
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface TagConfig {
  /** Allowed tag namespaces (e.g., ["work", "module", "role", "type"]). */
  namespaces?: string[]
  /** Closed vocabulary for type:* tags. */
  typeValues?: string[]
}

export interface StellarioConfig {
  /** Directory for JSONL data, relative to project root. Default: ".stellario" */
  memoryDir?: string
  /** Volume definitions. Key = volume name. */
  volumes: Record<string, VolumeDef>
  /** Agent definitions. Key = agent name (used for permission checks). */
  agents: Record<string, AgentDef>
  /** Tag vocabulary configuration. */
  tags?: TagConfig
}

// ─── Storage Types ──────────────────────────────────────────────────────────

export interface MemoryRef {
  target: string   // referenced entry ID
  reason: string   // why this entry references the target
}

export interface MemoryEntry {
  id: string
  volume: string     // which volume this entry belongs to
  content: string
  tags: string[]
  keywords: string[]
  author: string     // which agent created this entry
  created: string    // YYYY-MM-DD
  updated: string    // YYYY-MM-DD
  refs?: MemoryRef[]
  archived_at?: string
  archived_reason?: string
}

// ─── Volume Index ───────────────────────────────────────────────────────────

export interface VolumeIndexEntry {
  volume: string
  files: string[]        // ordered list of JSONL files
  next_nonce: number     // next available nonce for ID generation
  active_workspace?: string  // only for workspace profile: currently active entry ID
}

// ─── Tool Context ───────────────────────────────────────────────────────────

/**
 * Context passed to tool factories. Must be provided by the host project's
 * tool wrapper to connect Stellario to opencode's runtime.
 */
export interface ToolContext {
  /** Absolute path to the project root directory. */
  directory: string
  /** Agent identity string (e.g., "stellario", "analyst"). */
  agent: string
}

// ─── Helpers ────────────────────────────────────────────────────────────────

/**
 * Resolve the behavioral flags for a given profile.
 */
export function profileBehavior(profile: Profile): ProfileBehavior {
  switch (profile) {
    case "mutable":
      return { canRevise: true, canForget: true, isTracked: true, hasStableId: true, tracksActive: false }
    case "append":
      return { canRevise: false, canForget: false, isTracked: true, hasStableId: true, tracksActive: false }
    case "scratch":
      return { canRevise: true, canForget: true, isTracked: false, hasStableId: false, tracksActive: false }
    case "frozen":
      return { canRevise: false, canForget: false, isTracked: true, hasStableId: true, tracksActive: false }
    case "workspace":
      return { canRevise: true, canForget: true, isTracked: true, hasStableId: true, tracksActive: true }
  }
}

/**
 * Get all profile names that allow creating new entries.
 */
export function createableProfiles(): Profile[] {
  return ["mutable", "append", "scratch", "workspace"]
}

/**
 * Check if a profile allows entry creation.
 */
export function canCreate(profile: Profile): boolean {
  return profile !== "frozen"
}
