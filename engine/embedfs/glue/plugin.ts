import type { Plugin } from "@opencode-ai/plugin"

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

        // LSP init + index-worker recovery (needs config + memDir)
        try {
          const { tryGoResolve } = await import("stellario/context")
          const goResult = tryGoResolve(directory)

          let config: any
          let memDir: string

          if (goResult) {
            const { loadConfigFromPath } = await import("stellario/config")
            config = loadConfigFromPath(goResult.config_path)
            memDir = goResult.mem_dir
          } else {
            const { loadConfig, getMemoryDir } = await import("stellario/config")
            const { join } = await import("path")
            config = loadConfig(directory)
            memDir = getMemoryDir(config, directory)
          }

          if (config.lsp && Object.keys(config.lsp).length > 0) {
            const { triggerInit } = await import("stellario/lsp/manager")
            triggerInit(directory, config.lsp)
          }

          // Recover interrupted index work (fire-and-forget, non-blocking)
          try {
            const { recoverOnLoad } = await import("stellario/index-worker")
            recoverOnLoad(memDir, config)
          } catch {
            // index-worker not available — skip
          }

          // Auto-pull: sync remote changes at session start (tolerates network failure)
          try {
            const { gitPull } = await import("stellario/git")
            gitPull(memDir)
          } catch {
            // git not available or no remote — skip
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
