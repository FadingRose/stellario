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

/** Auto-refs configuration for a volume. */
export interface AutoRefsConfig {
  /** Enable automatic bidirectional linking based on tag+keyword overlap. */
  enabled: boolean
  /** Keyword similarity threshold (cosine similarity). Default: 0.65. */
  threshold?: number
}

export interface VolumeDef {
  profile: Profile
  boundaries: Boundaries
  authority?: Authority
  /** Optional: enforce a tag prefix on all entries (e.g., "lore:"). */
  requiredTagPrefix?: string
  /** Optional: custom ID prefix character (defaults to first char of volume name). */
  idPrefix?: string
  /** Optional: auto-refs configuration. When enabled, create/revise trigger automatic linking. */
  autoRefs?: AutoRefsConfig
}

// ─── Agent Definition ───────────────────────────────────────────────────────

export interface AgentDef {
  /** Human-readable name shown in tool output. */
  display: string
  /** Agent role: "primary" (user-facing) or "subagent" (dispatched via task). Default: "subagent". */
  role?: "primary" | "subagent"
}

// ─── Configuration ──────────────────────────────────────────────────────────

export interface TagConfig {
  /** Allowed tag namespaces (e.g., ["work", "module", "role", "type"]). */
  namespaces?: string[]
  /** Closed vocabulary for type:* tags. */
  typeValues?: string[]
}

export interface EmbeddingConfig {
  /** Whether semantic search is enabled. Default: "auto" (probe at runtime). */
  enabled?: boolean | "auto"
  /** HuggingFace model ID for embeddings. Default: "Xenova/all-MiniLM-L6-v2". */
  model?: string
}

export interface StellarioConfig {
  /** Directory for JSONL data, relative to project root. Default: ".opencode/.stellario" */
  memoryDir?: string
  /** Volume definitions. Key = volume name. */
  volumes: Record<string, VolumeDef>
  /** Agent definitions. Key = agent name (used for permission checks). */
  agents: Record<string, AgentDef>
  /** Tag vocabulary configuration. */
  tags?: TagConfig
  /** Semantic search / embedding configuration. */
  embedding?: EmbeddingConfig
}

// ─── Storage Types ──────────────────────────────────────────────────────────

export interface MemoryRef {
  target: string            // referenced entry ID
  reason: string            // why this entry references the target
  /** How this ref was created. "manual" = agent via memory_link. "auto" = auto_refs engine. */
  source: "manual" | "auto"
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
  /** Targets the agent has explicitly unlinked via memory_unlink.
   *  auto_refs engine will never re-link these. Cleared when agent manually links. */
  refs_removed?: string[]
  archived_at?: string
  archived_reason?: string
}

// ─── Volume Index ───────────────────────────────────────────────────────────

export interface VolumeIndexEntry {
  volume: string
  files: string[]        // ordered list of JSONL files
  next_nonce: number     // next available nonce for ID generation
  active_workspace?: string              // legacy: single global active entry (migrated to map on read)
  active_workspaces?: Record<string, string>  // per-agent: { agentName: entryId }
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

// ─── Tool Definition ─────────────────────────────────────────────────────────

/**
 * A pure tool definition — no runtime coupling.
 * Glue files call tool() from @opencode-ai/plugin with these objects.
 */
export interface ToolDef<A = any> {
  description: string
  args: A
  execute: (args: any, context: ToolContext) => Promise<string>
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
