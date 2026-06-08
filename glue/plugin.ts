import type { Plugin } from "@opencode-ai/plugin"
import { buildStatus } from "stellario/defs/workspace"

export default (async ({ directory }) => {
  return {
    "experimental.chat.system.transform": async (_input, output) => {
      try {
        const status = buildStatus(directory, "stellario")
        output.system.push(status)
      } catch {
        // Memory not initialized yet — silently skip
      }
    },
  }
}) satisfies Plugin
