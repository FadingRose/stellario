import { tool } from "@opencode-ai/plugin"
import { getConstellationToolDefs } from "stellario/defs/constellation"

const defs = getConstellationToolDefs()

export const constellation = tool(defs.constellation)
