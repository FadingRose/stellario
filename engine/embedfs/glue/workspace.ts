import { tool } from "@opencode-ai/plugin"
import { getWorkspaceToolDefs } from "stellario/defs/workspace"

const defs = getWorkspaceToolDefs()

export const status   = tool(defs.status)
export const assemble = tool(defs.assemble)
export const open     = tool(defs.open)
export const edit     = tool(defs.edit)
export const add      = tool(defs.add)
export const remove   = tool(defs.remove)
