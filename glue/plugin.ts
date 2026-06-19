import type { Plugin } from "@opencode-ai/plugin"
import { join } from "path"

export default (async ({ directory, client }) => {
  return {
    "experimental.chat.system.transform": async (input, output) => {
      try {
        // Resolve the current agent name from session messages
        let agent = "stellario"
        if (input.sessionID) {
          try {
            const res = await client.session.messages({ path: { id: input.sessionID } })
            if (res.data) {
              for (let i = res.data.length - 1; i >= 0; i--) {
                const msg = res.data[i].info
                if (msg.role === "user" && msg.agent) {
                  agent = msg.agent
                  break
                }
              }
            }
          } catch {
            // session lookup failed — fall back to default
          }
        }

        const { buildStatus } = await import("stellario/defs/workspace")
        const status = buildStatus(directory, agent)
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
