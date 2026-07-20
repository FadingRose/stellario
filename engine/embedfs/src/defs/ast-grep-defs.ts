// =============================================================================
// Stellario — AST Grep Tool Definition
// =============================================================================
// Structural code search via ast-grep (sg) CLI.
// No state, no process management — each call is a fresh CLI invocation.

import { z } from "zod"
import { execFileSync } from "child_process"
import type { ToolContext, ToolDef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent } from "../permissions.js"
import { relative } from "path"

export function getAstGrepToolDefs(): Record<string, ToolDef> {

  const ast_grep_search: ToolDef = {
    description:
      "Structural code search using AST patterns via ast-grep. " +
      "Matches code by syntax structure, not text — resilient to formatting changes. " +
      "Use $NAME as wildcards for identifiers, $$$ for sequences. " +
      "Examples: '$X.transfer($$$)', 'require($$$)', 'function $NAME($$$) { $$$ }'. " +
      "Requires ast-grep (sg) to be installed.",
    args: {
      pattern: z.string().describe(
        "AST pattern to match. " +
        "Use $NAME for single-node wildcards, $$$ for sequence wildcards. " +
        "Examples: '$OBJ.$METHOD($$$)', 'if ($COND) { $$$ }', 'mapping($$$) public $NAME'"
      ),
      language: z.string().optional().describe(
        "Language to search. Auto-detected from project if omitted. " +
        "Common values: solidity, rust, typescript, go, python"
      ),
      path: z.string().optional().describe(
        "Directory or file to search in. Defaults to project root."
      ),
      limit: z.number().optional().describe("Max results (default 50)."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      // Check ast-grep availability
      try {
        execFileSync("which", ["ast-grep"], { stdio: "pipe" })
      } catch {
        return "\u274c ast-grep not found. Install with: npm install -g @ast-grep/cli or cargo install ast-grep"
      }

      if (!args.pattern?.trim()) {
        return "\u274c pattern is required."
      }

      const searchPath = args.path || ctx.projectRoot
      const limit = args.limit || 50

      const cmdArgs = ["run", "-p", args.pattern]

      if (args.language) {
        cmdArgs.push("-l", args.language)
      }

      cmdArgs.push(searchPath)

      try {
        const output = execFileSync("ast-grep", cmdArgs, {
          cwd: ctx.projectRoot,
          stdio: ["pipe", "pipe", "pipe"],
          timeout: 30000,
          maxBuffer: 10 * 1024 * 1024, // 10MB
        }).toString().trim()

        if (!output) {
          return `No matches for pattern '${args.pattern}'.`
        }

        const allLines = output.split("\n")
        const truncated = allLines.slice(0, limit)

        // Make paths relative to project root
        const rootPath = ctx.projectRoot
        const normalized = truncated.map(line => {
          // ast-grep output: /abs/path:line:content
          const match = line.match(/^([^:]+):(\d+):(.*)$/s)
          if (match) {
            const relPath = relative(rootPath, match[1])
            return `${relPath}:${match[2]}  ${match[3].trim()}`
          }
          return line
        })

        const total = allLines.length
        const suffix = total > limit ? `\n... (${total - limit} more results, use limit to see more)` : ""

        return `${total} match(es) for '${args.pattern}'\n${normalized.join("\n")}${suffix}`
      } catch (err: any) {
        const stderr = err.stderr?.toString().trim() || ""
        if (stderr.includes("ERROR node")) {
          return `Pattern '${args.pattern}' could not be parsed. Try simplifying or check the syntax for language '${args.language || "auto"}'.`
        }
        if (err.status === 1 || stderr === "") {
          return `No matches for pattern '${args.pattern}'.`
        }
        return `\u274c ast-grep error: ${stderr || err.message}`
      }
    },
  }

  return { ast_grep_search }
}
