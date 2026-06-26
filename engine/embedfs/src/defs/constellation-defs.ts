import { z } from "zod"
import type { ToolDef, ToolContext } from "../types.js"
import { resolveContext } from "../context.js"
import { join } from "path"
import { execFileSync } from "child_process"
import { existsSync } from "fs"
import { extractTitle } from "../store.js"

// =============================================================================
// Constellation — bid + hints → arc stream
// =============================================================================

interface ArcEntry {
  id: string
  volume: string
  content: string
  tags: string[]
  keywords: string[]
  frame_type: string
  active: boolean
  created_at: string
}

interface MetaEdge {
  from: string
  to: string
  type: string
}

interface ConstellationMeta {
  frames: string[]
  edges: MetaEdge[]
  hints_applied: string[]
  hints_ignored: string[]
  total_candidates: number
}

interface ConstellationResult {
  arcs: ArcEntry[]
  metadata: ConstellationMeta
}

/**
 * Find the stellario binary. Checks:
 * 1. STELLARIO_BIN env var
 * 2. Local engine build
 * 3. PATH
 */
function findBinary(): string | null {
  // 1. Env var
  const envBin = process.env.STELLARIO_BIN
  if (envBin && existsSync(envBin)) return envBin

  // 2. Try to find relative to this package
  // (when running from .opencode/node_modules/stellario/)
  // We can't know the engine path from here, so skip

  // 3. PATH
  try {
    execFileSync("which", ["stellario"], { stdio: "pipe" })
    return "stellario"
  } catch {
    return null
  }
}

function runConstellation(
  stellarioDir: string,
  bid: string,
  hints: string[] | undefined,
  volume: string | undefined,
  tag: string | undefined,
): ConstellationResult | null {
  const bin = findBinary()
  if (!bin) return null

  const args = ["constellation", "--dir", stellarioDir, "--bid", bid]
  if (volume) args.push("--volume", volume)
  if (tag) args.push("--tag", tag)
  if (hints && hints.length > 0) args.push("--hints", hints.join(","))

  try {
    const stdout = execFileSync(bin, args, {
      encoding: "utf-8",
      timeout: 30000,
      maxBuffer: 10 * 1024 * 1024,
    })
    return JSON.parse(stdout) as ConstellationResult
  } catch {
    return null
  }
}

function renderConstellation(result: ConstellationResult): string {
  const { arcs, metadata } = result

  if (!arcs || arcs.length === 0) {
    return "No arcs found."
  }

  // Header
  const frameChain = metadata.frames.join(" → ")
  const lines: string[] = []
  lines.push(`Constellation: ${arcs.length} arcs, sorted by causal order`)
  lines.push(`Frames: ${frameChain}`)
  if (metadata.hints_applied.length > 0) {
    lines.push(`Hints applied: ${metadata.hints_applied.join(", ")}`)
  }
  if (metadata.hints_ignored.length > 0) {
    lines.push(`Hints ignored: ${metadata.hints_ignored.join(", ")}`)
  }
  lines.push("")

  // Build edge lookup for inline display
  const incomingByTarget: Map<string, MetaEdge[]> = new Map()
  for (const edge of metadata.edges || []) {
    const list = incomingByTarget.get(edge.to) || []
    list.push(edge)
    incomingByTarget.set(edge.to, list)
  }

  // Arc entries
  for (const arc of arcs) {
    const title = extractTitle(arc.content)
    const frameLabel = arc.frame_type || "assert"
    lines.push(`[${arc.id}] ${arc.volume} ${frameLabel} — ${title}`)

    // Show incoming edges (dependencies within the stream)
    const edges = incomingByTarget.get(arc.id)
    if (edges) {
      for (const edge of edges) {
        lines.push(`  └─ ${edge.type}: ${edge.from}`)
      }
    }
  }

  return lines.join("\n")
}

export function getConstellationToolDefs(): { constellation: ToolDef } {
  const constellationTool: ToolDef<{
    bid: z.ZodString
    hints: z.ZodOptional<z.ZodArray<z.ZodString>>
    volume: z.ZodOptional<z.ZodString>
    tag: z.ZodOptional<z.ZodString>
  }> = {
    description:
      "Build an arc stream from a bid (what you want to understand) and optional hints (natural language preferences). " +
      "Returns an ordered memory context, sorted by causal dependencies. " +
      "Use this when you need deep context across multiple entries — not for simple lookups (use telescope_search for those).",
    args: {
      bid: z
        .string()
        .describe(
          "What you want to understand. Natural language intent, e.g. 'FluxPool netting safety boundary'.",
        ),
      hints: z
        .array(z.string())
        .optional()
        .describe(
          "Natural language preferences, e.g. ['only client:fluxpool', 'from last checkpoint', 'be concise']. " +
            "Translated by a local small model into structured operations.",
        ),
      volume: z
        .string()
        .optional()
        .describe("Filter to a specific volume."),
      tag: z
        .string()
        .optional()
        .describe("Filter by tag substring."),
    },
    execute: async (
      args: { bid: string; hints?: string[]; volume?: string; tag?: string },
      context: ToolContext,
    ) => {
      const { directory } = resolveContext(context)
      const agent = "stellario"

      const stellarioDir = join(directory, ".opencode", ".stellario")
      if (!existsSync(stellarioDir)) {
        return `❌ No stellario directory found at ${stellarioDir}`
      }

      const result = runConstellation(stellarioDir, args.bid, args.hints, args.volume, args.tag)
      if (!result) {
        return "❌ Constellation engine not available. Ensure the stellario binary is built and in PATH, or set STELLARIO_BIN."
      }

      return renderConstellation(result)
    },
  }

  return { constellation: constellationTool }
}
