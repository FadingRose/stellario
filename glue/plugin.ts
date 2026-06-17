import type { Plugin } from "@opencode-ai/plugin"
import { join } from "path"

export default (async ({ directory }) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const { buildStatus } = await import("stellario/defs/workspace")
        const status = buildStatus(directory, "stellario")
        output.system.push(status)

        // Trigger LSP initialization (fire-and-forget, non-blocking)
        try {
          const { loadConfig } = await import("stellario/config")
          const { triggerInit } = await import("stellario/lsp/manager")
          const config = loadConfig(directory)
          if (config.lsp && Object.keys(config.lsp).length > 0) {
            triggerInit(directory, config.lsp)
          }

          // Recover interrupted index work (fire-and-forget, non-blocking)
          try {
            const { recoverOnLoad } = await import("stellario/index-worker")
            const memDir = join(directory, ".opencode", ".stellario")
            recoverOnLoad(memDir, config)
          } catch {
            // index-worker not available — skip
          }
        } catch {
          // LSP not configured or not available — skip
        }
      } catch {
        // Stellario not available or not initialized — silently skip
      }
    },
  }
}) satisfies Plugin
