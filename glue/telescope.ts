import { tool } from "@opencode-ai/plugin"
import { getTelescopeToolDefs } from "stellario/defs/telescope"

const defs = getTelescopeToolDefs()

export const search = tool(defs.search)
