import type { Plugin } from "@opencode-ai/plugin"

export default (async ({ directory }) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const { buildStatus } = await import("stellario/defs/workspace")
        const status = buildStatus(directory, "stellario")
        output.system.push(status)
      } catch {
        // Stellario not available or not initialized — silently skip
      }
    },
  }
}) satisfies Plugin
