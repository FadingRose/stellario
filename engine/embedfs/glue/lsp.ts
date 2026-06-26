import { tool } from "@opencode-ai/plugin"
import { getLspToolDefs } from "stellario/defs/lsp"

const defs = getLspToolDefs()

export const lsp_references    = tool(defs.lsp_references)
export const lsp_definition    = tool(defs.lsp_definition)
export const lsp_symbols       = tool(defs.lsp_symbols)
export const lsp_call_hierarchy = tool(defs.lsp_call_hierarchy)
