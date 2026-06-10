import { tool } from "@opencode-ai/plugin"
import { getAstGrepToolDefs } from "stellario/defs/ast-grep"

const defs = getAstGrepToolDefs()

export const ast_grep_search = tool(defs.ast_grep_search)
