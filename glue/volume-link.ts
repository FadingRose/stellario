import { tool } from "@opencode-ai/plugin"
import { getVolumeLinkDefs } from "stellario/defs/volume-link"

const defs = getVolumeLinkDefs()

export const discover  = tool(defs.discover)
export const link      = tool(defs.link)
export const unlink    = tool(defs.unlink)
