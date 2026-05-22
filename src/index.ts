// =============================================================================
// Stellario — Agent Memory Infrastructure
// =============================================================================
//
// Stellario provides volume-based knowledge management for opencode agents.
// Install into any project, configure via stellario.yaml, and use.
//
// Usage:
//   // .opencode/tools/memory.ts
//   import { createMemoryTools } from "stellario/tools/memory"
//   export const { create, revise, forget, show, history } = createMemoryTools()
//
//   // .opencode/tools/workspace.ts
//   import { createWorkspaceTools } from "stellario/tools/workspace"
//   export const { status } = createWorkspaceTools()

// ── Types ────────────────────────────────────────────────────────────────────

export type {
  Profile,
  ProfileBehavior,
  Boundaries,
  Authority,
  VolumeDef,
  AgentDef,
  TagConfig,
  StellarioConfig,
  MemoryEntry,
  MemoryRef,
  VolumeIndexEntry,
  ToolContext,
} from "./types.js"

export {
  profileBehavior,
  canCreate,
  createableProfiles,
} from "./types.js"

// ── Config ───────────────────────────────────────────────────────────────────

export {
  loadConfig,
  getWorkspaceVolume,
  getTrackedVolumes,
  getVolumeIdPrefix,
  getMemoryDir,
} from "./config.js"

// ── Store ────────────────────────────────────────────────────────────────────

export {
  readVolumeIndex,
  readJsonl,
  writeEntries,
  generateNextId,
  findEntry,
  getActiveWorkspace,
  setActiveWorkspace,
  today,
  truncate,
  extractTitle,
  dedupeTags,
} from "./store.js"

// ── Permissions ──────────────────────────────────────────────────────────────

export {
  resolveAgent,
  canRead,
  canWrite,
  canRevise,
  canForget,
  isAuthor,
  readableVolumes,
  writableVolumes,
} from "./permissions.js"

// ── Context ──────────────────────────────────────────────────────────────────

export {
  resolveContext,
  type ResolvedContext,
} from "./context.js"

// ── Git ──────────────────────────────────────────────────────────────────────

export {
  gitCommit,
  isGitRepo,
  initGitRepo,
} from "./git.js"

// ── Tool Factories ───────────────────────────────────────────────────────────

export { createMemoryTools } from "./tools/memory.js"
export { createWorkspaceTools } from "./tools/workspace.js"
export { createTelescopeTool } from "./tools/telescope.js"
