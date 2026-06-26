// =============================================================================
// Stellario — LSP Types
// =============================================================================
// Language Server Protocol types for the generic LSP client.
// Only the subset needed for code navigation (references, definition, symbols,
// call hierarchy) is defined here.

// ─── LSP Protocol Types ──────────────────────────────────────────────────────

export interface LspPosition {
  line: number
  character: number
}

export interface LspRange {
  start: LspPosition
  end: LspPosition
}

export interface LspLocation {
  uri: string
  range: LspRange
}

export interface LspSymbolInfo {
  name: string
  kind: number
  location: LspLocation
  containerName?: string
}

// ─── Client State ────────────────────────────────────────────────────────────

export type LspClientState = "idle" | "starting" | "ready" | "error" | "crashed"

// ─── Config Types ────────────────────────────────────────────────────────────

export interface LspIndexingConfig {
  /** Indexing wait strategy. Default: "timeout". */
  strategy: "timeout" | "poll-symbol" | "none"
  /** Max time to wait for indexing (ms). Default: 30000. Used by all strategies as upper bound. */
  timeout: number
  /** Symbol query for poll-symbol strategy. Default: "main". */
  pollQuery?: string
  /** Poll interval in ms for poll-symbol strategy. Default: 2000. */
  pollInterval?: number
}

export interface LspServerConfig {
  /** Command to spawn the language server (e.g., ["rust-analyzer"] or ["solc", "--lsp"]). */
  command: string[]
  /** Indexing configuration. */
  indexing?: LspIndexingConfig
}

/**
 * LSP configuration in stellario.yaml.
 * Key is an arbitrary name (e.g., "solidity", "rust").
 * Only one server is used by tools — the first one defined.
 */
export type LspConfig = Record<string, LspServerConfig>

// ─── Tool Result Types ───────────────────────────────────────────────────────

export interface LspResultItem {
  /** File path relative to project root. */
  filePath: string
  /** 1-indexed line number. */
  line: number
  /** Source code line content (trimmed). */
  context: string
  /** Direction label for call hierarchy (e.g., "incoming", "outgoing"). */
  direction?: string
}
