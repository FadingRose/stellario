import { tool } from "@opencode-ai/plugin"
import { getMemoryToolDefs } from "stellario/defs/memory"

const defs = getMemoryToolDefs()

export const create  = tool(defs.create)
export const show    = tool(defs.show)
export const revise  = tool(defs.revise)
export const forget  = tool(defs.forget)
export const history = tool(defs.history)
export const meta    = tool(defs.meta)
export const ref     = tool(defs.ref)
export const unref   = tool(defs.unref)
