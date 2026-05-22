import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "fs"
import { join, resolve } from "path"
import { execSync } from "child_process"
import { parse as parseYaml } from "yaml"

// =============================================================================
// CLI Entry Point
// =============================================================================

const TEMPLATES = ["minimal", "novel", "software"]

function main() {
  const args = process.argv.slice(2)
  const command = args[0]

  if (!command || command === "help" || command === "--help") {
    printHelp()
    return
  }

  if (command === "init") {
    const template = getArg(args, "--template") || getArg(args, "-t") || "minimal"
    const projectRoot = getArg(args, "--root") || resolve(".")
    init(projectRoot, template)
  } else {
    console.error(`Unknown command: ${command}`)
    printHelp()
    process.exit(1)
  }
}

function printHelp() {
  console.log(`stellario — agent memory infrastructure

Usage:
  stellario init [--template <name>] [--root <path>]

Commands:
  init    Initialize Stellario in a project

Options:
  -t, --template <name>   Config template: ${TEMPLATES.join(", ")} (default: minimal)
  --root <path>           Project root directory (default: current directory)

Examples:
  npx stellario init --template novel
  npx stellario init --template software --root /path/to/project
`)
}

function getArg(args: string[], flag: string): string | undefined {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

// =============================================================================
// Init Command
// =============================================================================

function init(projectRoot: string, template: string) {
  if (!TEMPLATES.includes(template)) {
    console.error(`Unknown template: "${template}". Available: ${TEMPLATES.join(", ")}`)
    process.exit(1)
  }

  projectRoot = resolve(projectRoot)
  if (!existsSync(projectRoot)) {
    console.error(`Directory not found: ${projectRoot}`)
    process.exit(1)
  }

  console.log(`Stellario init — template: ${template}`)
  console.log(`Project root: ${projectRoot}`)
  console.log("")

  const opencodeDir = join(projectRoot, ".opencode")
  const configPath = join(opencodeDir, "stellario.yaml")

  // ── 1. Config ──────────────────────────────────────────────────────────
  if (existsSync(configPath)) {
    console.log(`⚠  Config already exists: ${configPath} (skipped)`)
  } else {
    // Templates are in <package-root>/templates/
    const packageRoot = resolve(join(import.meta.dirname || ".", "..", ".."))
    const templatePath = join(packageRoot, "templates", `${template}.yaml`)

    if (!existsSync(templatePath)) {
      console.error(`Template not found: ${templatePath}`)
      console.error(`Available templates: ${TEMPLATES.join(", ")}`)
      process.exit(1)
    }

    mkdirSync(opencodeDir, { recursive: true })
    cpSync(templatePath, configPath)
    console.log(`✓ Config: ${configPath}`)
  }

  // ── 2. Load config to read agents + memoryDir ──────────────────────────
  const config = parseYaml(readFileSync(configPath, "utf-8"))
  const memoryDirName = config.memoryDir || ".stellario"
  const agents = Object.keys(config.agents || {})
  const volumes = config.volumes || {}

  // ── 3. Memory directory + git init ─────────────────────────────────────
  const memDir = join(opencodeDir, "memory")
  if (!existsSync(memDir)) {
    mkdirSync(memDir, { recursive: true })
    console.log(`✓ Memory dir: ${memDir}`)
  }

  if (!existsSync(join(memDir, ".git"))) {
    try {
      execSync("git init", { cwd: memDir, stdio: "pipe" })
      console.log(`✓ Memory git init`)
    } catch {
      console.log(`⚠  git init failed in ${memDir}`)
    }
  } else {
    console.log(`  Memory git: already initialized`)
  }

  // ── 4. .opencode/package.json ──────────────────────────────────────────
  const pkgPath = join(opencodeDir, "package.json")
  let needsInstall = false

  if (!existsSync(pkgPath)) {
    const pkg = {
      private: true,
      dependencies: {
        "@opencode-ai/plugin": "latest",
        zod: "^3.23.0",
        stellario: getStellarioDep(),
      },
    }
    writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
    needsInstall = true
    console.log(`✓ package.json: created`)
  } else {
    // Check if stellario is already a dep
    const existingPkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    const deps = existingPkg.dependencies || {}
    if (!deps.stellario) {
      deps.stellario = getStellarioDep()
      existingPkg.dependencies = deps
      writeFileSync(pkgPath, JSON.stringify(existingPkg, null, 2) + "\n")
      needsInstall = true
      console.log(`✓ package.json: added stellario dependency`)
    } else {
      console.log(`  package.json: stellario already listed`)
    }
  }

  // ── 5. Glue files ─────────────────────────────────────────────────────
  const toolsDir = join(opencodeDir, "tools")
  mkdirSync(toolsDir, { recursive: true })

  // memory glue
  const memoryGluePath = join(toolsDir, "stellario-memory.ts")
  if (!existsSync(memoryGluePath)) {
    writeFileSync(memoryGluePath, MEMORY_GLUE)
    console.log(`✓ Tools: stellario-memory.ts`)
  } else {
    console.log(`  Tools: stellario-memory.ts (exists, skipped)`)
  }

  // telescope glue
  const telescopeGluePath = join(toolsDir, "stellario-telescope.ts")
  if (!existsSync(telescopeGluePath)) {
    writeFileSync(telescopeGluePath, TELESCOPE_GLUE)
    console.log(`✓ Tools: stellario-telescope.ts`)
  } else {
    console.log(`  Tools: stellario-telescope.ts (exists, skipped)`)
  }

  // workspace glue
  const workspaceGluePath = join(toolsDir, "stellario-workspace.ts")
  if (!existsSync(workspaceGluePath)) {
    writeFileSync(workspaceGluePath, WORKSPACE_GLUE)
    console.log(`✓ Tools: stellario-workspace.ts`)
  } else {
    console.log(`  Tools: stellario-workspace.ts (exists, skipped)`)
  }

  // ── 6. Agent skeletons ────────────────────────────────────────────────
  const agentsDir = join(opencodeDir, "agents")
  mkdirSync(agentsDir, { recursive: true })

  const memoryTools = ["memory_create", "memory_show", "memory_revise", "memory_forget", "memory_history"]
  const searchTools = ["telescope_search"]
  const workspaceTools = ["workspace_status"]
  const allTools = [...memoryTools, ...searchTools, ...workspaceTools]

  for (const agent of agents) {
    const agentPath = join(agentsDir, `${agent}.md`)
    if (existsSync(agentPath)) {
      console.log(`  Agent: ${agent}.md (exists, skipped)`)
      continue
    }

    // Determine which tools this agent can use based on write permissions
    const agentVolumes = Object.entries(volumes)
      .filter(([, def]: [string, any]) => {
        const write = def.boundaries?.write || []
        const read = def.boundaries?.read || []
        return write.includes(agent) || read.includes(agent) || read.includes("all")
      })
      .map(([name]) => name)

    const canWriteAny = Object.entries(volumes)
      .some(([, def]: [string, any]) => (def.boundaries?.write || []).includes(agent))

    const agentTools: string[] = []
    if (canWriteAny) {
      agentTools.push(...memoryTools)
    } else {
      agentTools.push("memory_show", "memory_history")
    }
    agentTools.push(...searchTools)
    agentTools.push(...workspaceTools)

    const display = config.agents[agent]?.display || agent
    const agentContent = generateAgentSkeleton(display, agent, agentTools, agentVolumes)
    writeFileSync(agentPath, agentContent)
    console.log(`✓ Agent: ${agent}.md`)
  }

  // ── 7. npm install ────────────────────────────────────────────────────
  if (needsInstall) {
    console.log("")
    console.log("Installing dependencies in .opencode/...")
    try {
      execSync("npm install", { cwd: opencodeDir, stdio: "pipe" })
      console.log("✓ npm install")
    } catch (e: any) {
      console.log(`⚠  npm install failed. Run manually: cd .opencode && npm install`)
    }
  }

  // ── 8. .gitignore ─────────────────────────────────────────────────────
  const gitignorePath = join(projectRoot, ".gitignore")
  const memDirRelative = `.opencode/${memoryDirName}`

  if (existsSync(gitignorePath)) {
    const gitignore = readFileSync(gitignorePath, "utf-8")
    if (!gitignore.includes(".opencode/")) {
      writeFileSync(gitignorePath, gitignore.trimEnd() + "\n.opencode/\n")
      console.log(`✓ .gitignore: added .opencode/`)
    }
  } else {
    writeFileSync(gitignorePath, ".opencode/\n")
    console.log(`✓ .gitignore: created`)
  }

  console.log("")
  console.log("Done! Next steps:")
  console.log(`  1. Edit .opencode/stellario.yaml to customize volumes and agents`)
  console.log(`  2. Edit .opencode/agents/*.md to add agent prompts`)
  console.log(`  3. Start opencode — tools and agents will be auto-discovered`)
}

// =============================================================================
// Glue File Templates
// =============================================================================

const MEMORY_GLUE = `import { tool } from "@opencode-ai/plugin"
import { getMemoryToolDefs } from "stellario/defs/memory"

const defs = getMemoryToolDefs()

export const memory_create  = tool(defs.create)
export const memory_show    = tool(defs.show)
export const memory_revise  = tool(defs.revise)
export const memory_forget  = tool(defs.forget)
export const memory_history = tool(defs.history)
`

const TELESCOPE_GLUE = `import { tool } from "@opencode-ai/plugin"
import { getTelescopeToolDefs } from "stellario/defs/telescope"

const defs = getTelescopeToolDefs()

export const telescope_search = tool(defs.search)
`

const WORKSPACE_GLUE = `import { tool } from "@opencode-ai/plugin"
import { getWorkspaceToolDefs } from "stellario/defs/workspace"

const defs = getWorkspaceToolDefs()

export const workspace_status = tool(defs.status)
`

// =============================================================================
// Agent Skeleton Generator
// =============================================================================

function generateAgentSkeleton(display: string, name: string, tools: string[], volumes: string[]): string {
  const toolsYaml = tools.map(t => `  ${t}: true`).join("\n")

  return `---
description: ${display}
mode: primary
tools:
${toolsYaml}
---

# ${display}

Volumes: ${volumes.join(", ")}

<!-- Write your agent prompt here -->
`
}

// =============================================================================
// Helpers
// =============================================================================

const STELLARIO_REPO = "github:FadingRose/stellario"

/**
 * Get the stellario version from our own package.json.
 * Used to pin the dependency to the same version.
 */
function getStellarioVersion(): string {
  try {
    const pkgPath = resolve(join(import.meta.dirname || ".", "..", "..", "package.json"))
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    return pkg.version || "latest"
  } catch {
    return "latest"
  }
}

function getStellarioDep(): string {
  const version = getStellarioVersion()
  if (version === "latest") return STELLARIO_REPO
  return `${STELLARIO_REPO}#v${version}`
}

// ── Run ──────────────────────────────────────────────────────────────────

main()
