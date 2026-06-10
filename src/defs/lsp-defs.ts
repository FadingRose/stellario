// =============================================================================
// Stellario — LSP Tool Definitions
// =============================================================================
// 4 tools for code navigation via Language Server Protocol:
//   lsp_references    — Find all references to a symbol
//   lsp_definition    — Go to definition of a symbol
//   lsp_symbols       — Workspace symbol search
//   lsp_call_hierarchy — Call hierarchy (incoming/outgoing calls)

import { z } from "zod"
import type { ToolContext, ToolDef } from "../types.js"
import { resolveContext } from "../context.js"
import { resolveAgent } from "../permissions.js"
import { LspClient, uriToFilePath, readFileContext } from "../lsp/client.js"
import { getOrCreateClient } from "../lsp/manager.js"
import type { LspLocation } from "../lsp/types.js"
import { relative } from "path"

// =============================================================================
// Tool Definitions
// =============================================================================

export function getLspToolDefs(): Record<string, ToolDef> {

  // ── Shared Helpers ──

  function resolveClient(ctx: ReturnType<typeof resolveContext>): { client: LspClient; rootPath: string } | string {
    const lspConfig = ctx.config.lsp
    if (!lspConfig || Object.keys(lspConfig).length === 0) {
      return "\u274c No LSP server configured. Add an `lsp:` section to stellario.yaml."
    }

    // Use the first configured server
    const [name, serverConfig] = Object.entries(lspConfig)[0]
    const client = getOrCreateClient(name, serverConfig)

    if (client.state === "starting") {
      const sec = Math.floor(client.elapsedMs / 1000)
      const elapsed = sec < 60 ? `${sec}s` : `${Math.floor(sec / 60)}m ${sec % 60}s`
      return `\u23F3 LSP indexing... (${elapsed})`
    }

    if (client.state !== "ready") {
      return `\u274c LSP not available (state: ${client.state}${client.stateDetail ? `, ${client.stateDetail}` : ""}). Restart the session to reconnect.`
    }

    return { client, rootPath: ctx.projectRoot }
  }

  function formatLocation(loc: LspLocation, rootPath: string, direction?: string): string {
    const absPath = uriToFilePath(loc.uri)
    const relPath = relative(rootPath, absPath)
    const ln = loc.range.start.line + 1
    const src = readFileContext(absPath, loc.range.start.line)
    const prefix = direction ? `[${direction}] ` : ""
    return `${relPath}:${ln}  ${prefix}${src}`
  }

  function filterByPath(locations: LspLocation[], rootPath: string, fileFilter?: string): LspLocation[] {
    if (!fileFilter) return locations
    return locations.filter(loc => uriToFilePath(loc.uri).includes(fileFilter))
  }

  function deduplicateLocations(locations: LspLocation[]): LspLocation[] {
    const seen = new Set<string>()
    return locations.filter(loc => {
      const key = `${loc.uri}:${loc.range.start.line}`
      if (seen.has(key)) return false
      seen.add(key)
      return true
    })
  }

  // ── lsp_references ──

  const lsp_references: ToolDef = {
    description:
      "Find all references to a symbol via LSP. " +
      "Requires a configured language server in stellario.yaml. " +
      "Returns file:line locations with source context.",
    args: {
      symbol: z.string().describe("Symbol name to search for references."),
      file: z.string().optional().describe("Path filter — only return results whose file path contains this string."),
      limit: z.number().optional().describe("Max results (default 50)."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const resolved = resolveClient(ctx)
      if (typeof resolved === "string") return resolved
      const { client, rootPath } = resolved

      // Find symbol via workspace/symbol
      const candidates = await client.workspaceSymbol(args.symbol)
      const exact = candidates.filter(s =>
        s.name === args.symbol || s.name.endsWith(`::${args.symbol}`)
      )
      const target = (exact.length > 0 ? exact : candidates)[0]
      if (!target) return `Symbol '${args.symbol}' not found.`

      // Get references
      const refs = await client.findReferences(
        target.location.uri,
        target.location.range.start.line,
        target.location.range.start.character,
      )

      let filtered = filterByPath(refs, rootPath, args.file)
      filtered = deduplicateLocations(filtered)

      const limit = args.limit || 50
      filtered = filtered.slice(0, limit)

      if (filtered.length === 0) return `No references found for '${args.symbol}'.`

      const lines: string[] = []
      lines.push(`${filtered.length} reference(s) for '${args.symbol}'`)
      for (const loc of filtered) {
        lines.push(formatLocation(loc, rootPath))
      }
      return lines.join("\n")
    },
  }

  // ── lsp_definition ──

  const lsp_definition: ToolDef = {
    description:
      "Go to definition of a symbol via LSP. " +
      "Returns definition locations. When multiple candidates exist, all are listed.",
    args: {
      symbol: z.string().describe("Symbol name to find definition for."),
      file: z.string().optional().describe("Path filter — only return results whose file path contains this string."),
      limit: z.number().optional().describe("Max results (default 20)."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const resolved = resolveClient(ctx)
      if (typeof resolved === "string") return resolved
      const { client, rootPath } = resolved

      // Find symbol candidates
      const candidates = await client.workspaceSymbol(args.symbol)
      const exact = candidates.filter(s =>
        s.name === args.symbol || s.name.endsWith(`::${args.symbol}`)
      )
      const targets = exact.length > 0 ? exact : candidates.slice(0, 5)

      if (targets.length === 0) return `Symbol '${args.symbol}' not found.`

      // Collect definitions from all candidates
      const allDefs: LspLocation[] = []
      for (const target of targets) {
        const defs = await client.gotoDefinition(
          target.location.uri,
          target.location.range.start.line,
          target.location.range.start.character,
        )
        if (defs.length > 0) {
          allDefs.push(...defs)
        } else {
          // Fall back to the symbol location itself
          allDefs.push(target.location)
        }
      }

      let filtered = filterByPath(allDefs, rootPath, args.file)
      filtered = deduplicateLocations(filtered)

      const limit = args.limit || 20
      filtered = filtered.slice(0, limit)

      const lines: string[] = []

      if (targets.length > 1) {
        lines.push(`${targets.length} candidates for '${args.symbol}':`)
        for (const t of targets) {
          const absPath = uriToFilePath(t.location.uri)
          const relPath = relative(rootPath, absPath)
          lines.push(`  ${t.name} → ${relPath}:${t.location.range.start.line + 1}`)
        }
        lines.push("")
      }

      lines.push(`${filtered.length} definition(s) for '${args.symbol}'`)
      for (const loc of filtered) {
        lines.push(formatLocation(loc, rootPath))
      }
      return lines.join("\n")
    },
  }

  // ── lsp_symbols ──

  const lsp_symbols: ToolDef = {
    description:
      "Workspace symbol search via LSP. " +
      "Fuzzy search for symbols across the entire workspace. " +
      "Returns symbol names, kinds, and locations.",
    args: {
      query: z.string().describe("Search query — fuzzy matched against symbol names."),
      file: z.string().optional().describe("Path filter — only return results whose file path contains this string."),
      limit: z.number().optional().describe("Max results (default 30)."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const resolved = resolveClient(ctx)
      if (typeof resolved === "string") return resolved
      const { client, rootPath } = resolved

      const results = await client.workspaceSymbol(args.query)

      if (!results || results.length === 0) {
        return `No symbols matching '${args.query}'.`
      }

      let filtered = results
      if (args.file) {
        filtered = filtered.filter(s =>
          uriToFilePath(s.location.uri).includes(args.file!)
        )
      }

      const limit = args.limit || 30
      filtered = filtered.slice(0, limit)

      const lines: string[] = []
      lines.push(`${filtered.length} symbol(s) for '${args.query}'`)
      for (const sym of filtered) {
        const absPath = uriToFilePath(sym.location.uri)
        const relPath = relative(rootPath, absPath)
        const ln = sym.location.range.start.line + 1
        const src = readFileContext(absPath, sym.location.range.start.line)
        const container = sym.containerName ? `${sym.containerName}::` : ""
        lines.push(`${relPath}:${ln}  ${container}${sym.name} — ${src}`)
      }
      return lines.join("\n")
    },
  }

  // ── lsp_call_hierarchy ──

  const lsp_call_hierarchy: ToolDef = {
    description:
      "Call hierarchy via LSP — find who calls a function (incoming). " +
      "Only works on functions/methods. Returns 'LSP not supported' if the server " +
      "doesn't support call hierarchy.",
    args: {
      symbol: z.string().describe("Function or method name."),
      depth: z.number().optional().describe("Depth: 1 = incoming calls only, 2 = also outgoing. Default: 1."),
      file: z.string().optional().describe("Path filter — only return results whose file path contains this string."),
      limit: z.number().optional().describe("Max results (default 50)."),
    },
    async execute(args, context: ToolContext) {
      const ctx = resolveContext(context)
      const agent = resolveAgent(context.agent, ctx.config)
      if (!agent) return `\u274c Unknown agent: "${context.agent}"`

      const resolved = resolveClient(ctx)
      if (typeof resolved === "string") return resolved
      const { client, rootPath } = resolved

      // Find symbol
      const candidates = await client.workspaceSymbol(args.symbol)
      const exact = candidates.filter(s =>
        s.name === args.symbol || s.name.endsWith(`::${args.symbol}`)
      )
      const target = (exact.length > 0 ? exact : candidates)[0]
      if (!target) return `Symbol '${args.symbol}' not found.`

      // Prepare call hierarchy
      let items: any[]
      try {
        items = await client.prepareCallHierarchy(
          target.location.uri,
          target.location.range.start.line,
          target.location.range.start.character,
        )
      } catch {
        return `LSP server does not support call hierarchy for '${args.symbol}'.`
      }

      if (items.length === 0) {
        return `No call hierarchy for '${args.symbol}' (not a callable symbol).`
      }

      // Collect calls
      const allLocs: Array<{ loc: LspLocation; direction: string }> = []

      for (const item of items) {
        const incoming = await client.incomingCalls(item)
        for (const call of incoming) {
          if (call.from?.uri) allLocs.push({ loc: call.from, direction: "incoming" })
        }
        if ((args.depth ?? 1) >= 2) {
          const outgoing = await client.outgoingCalls(item)
          for (const call of outgoing) {
            if (call.to?.uri) allLocs.push({ loc: call.to, direction: "outgoing" })
          }
        }
      }

      let filtered = allLocs
      if (args.file) {
        filtered = filtered.filter(({ loc }) =>
          uriToFilePath(loc.uri).includes(args.file!)
        )
      }

      const limit = args.limit || 50
      filtered = filtered.slice(0, limit)

      const lines: string[] = []
      lines.push(`${filtered.length} call hierarchy result(s) for '${args.symbol}'`)
      for (const { loc, direction } of filtered) {
        lines.push(formatLocation(loc, rootPath, direction))
      }
      return lines.join("\n")
    },
  }

  return {
    lsp_references,
    lsp_definition,
    lsp_symbols,
    lsp_call_hierarchy,
  }
}
