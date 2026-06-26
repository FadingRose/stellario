// =============================================================================
// Stellario — LSP Manager
// =============================================================================
// Singleton manager for LSP client instances.
// - Manages per-server client lifecycle
// - Provides sync-readable status for buildStatus()
// - Fire-and-forget init from plugin (non-blocking)

import { LspClient } from "./client.js"
import type { LspConfig, LspServerConfig, LspClientState } from "./types.js"

// ─── Global State ────────────────────────────────────────────────────────────

const clients = new Map<string, LspClient>()

/**
 * Get or create a client for the given server name.
 */
export function getOrCreateClient(serverName: string, config: LspServerConfig): LspClient {
  let client = clients.get(serverName)
  if (!client) {
    client = new LspClient(config)
    clients.set(serverName, client)
  }
  return client
}

/**
 * Get an existing client (returns undefined if not created yet).
 */
export function getClient(serverName: string): LspClient | undefined {
  return clients.get(serverName)
}

/**
 * Get the default (first) client. Returns undefined if no LSP config exists.
 */
export function getDefaultClient(): LspClient | undefined {
  for (const client of clients.values()) {
    return client
  }
  return undefined
}

/**
 * Get the first server name from LSP config.
 */
export function getDefaultServerName(config: LspConfig): string | undefined {
  const keys = Object.keys(config)
  return keys.length > 0 ? keys[0] : undefined
}

// ── Init (Fire-and-Forget) ───────────────────────────────────────────────────

/**
 * Trigger LSP initialization for all configured servers.
 * Returns immediately — init happens in the background.
 * Safe to call multiple times (idempotent).
 */
export function triggerInit(rootPath: string, config: LspConfig): void {
  for (const [name, serverConfig] of Object.entries(config)) {
    const client = getOrCreateClient(name, serverConfig)
    // Fire-and-forget — do NOT await
    client.start(rootPath).catch(() => {
      // Error state is stored in client.state, no need to handle here
    })
  }
}

// ── Sync Status (for buildStatus) ────────────────────────────────────────────

export interface LspStatusEntry {
  name: string
  state: LspClientState
  detail: string
  elapsedMs: number
}

/**
 * Get sync-readable status for all LSP clients.
 * Used by buildStatus() — no async, no blocking.
 */
export function getLspStatus(): LspStatusEntry[] {
  const entries: LspStatusEntry[] = []
  for (const [name, client] of clients) {
    entries.push({
      name,
      state: client.state,
      detail: client.stateDetail,
      elapsedMs: client.elapsedMs,
    })
  }
  return entries
}

// ── Shutdown All ──────────────────────────────────────────────────────────────

/**
 * Shutdown all LSP clients. Call on session end.
 */
export async function shutdownAll(): Promise<void> {
  for (const client of clients.values()) {
    await client.shutdown()
  }
  clients.clear()
}
