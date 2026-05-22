#!/usr/bin/env node
// Stellario CLI — pure JS, no build step needed
// This file is the npm bin entry point

import { existsSync, mkdirSync, writeFileSync, cpSync, readFileSync } from "fs"
import { join, resolve, dirname } from "path"
import { execSync } from "child_process"
import { fileURLToPath } from "url"
import { parse as parseYaml } from "yaml"

const __filename = fileURLToPath(import.meta.url)
const __dirname = dirname(__filename)

const TEMPLATES = ["minimal", "novel", "software"]
const STELLARIO_REPO = "github:FadingRose/stellario"

// ── Glue Templates (must be before main logic) ─────────────────────────────

const MEMORY_GLUE = `import { tool } from "@opencode-ai/plugin"
import { getMemoryToolDefs } from "stellario/defs/memory"

const defs = getMemoryToolDefs()

export const create  = tool(defs.create)
export const show    = tool(defs.show)
export const revise  = tool(defs.revise)
export const forget  = tool(defs.forget)
export const history = tool(defs.history)
`

const TELESCOPE_GLUE = `import { tool } from "@opencode-ai/plugin"
import { getTelescopeToolDefs } from "stellario/defs/telescope"

const defs = getTelescopeToolDefs()

export const search = tool(defs.search)
`

const WORKSPACE_GLUE = `import { tool } from "@opencode-ai/plugin"
import { getWorkspaceToolDefs } from "stellario/defs/workspace"

const defs = getWorkspaceToolDefs()

export const status = tool(defs.status)
`

// ── Main ──────────────────────────────────────────────────────────────────

const args = process.argv.slice(2)
const command = args[0]

if (!command || command === "help" || command === "--help") {
  console.log(`stellario — agent memory infrastructure

Usage:
  stellario init [--template <name>] [--root <path>]

Commands:
  init    Initialize Stellario in a project

Options:
  -t, --template <name>   Config template: ${TEMPLATES.join(", ")} (default: minimal)
      --root <path>       Project root directory (default: current directory)

Examples:
  npx github:FadingRose/stellario init --template software
  npx stellario init --template novel --root /path/to/project
`)
  process.exit(0)
}

if (command !== "init") {
  console.error(`Unknown command: ${command}`)
  process.exit(1)
}

// ── Init ──────────────────────────────────────────────────────────────────

const template = getArg(args, "--template") || getArg(args, "-t") || "minimal"
const projectRoot = resolve(getArg(args, "--root") || ".")

if (!TEMPLATES.includes(template)) {
  console.error(`Unknown template: "${template}". Available: ${TEMPLATES.join(", ")}`)
  process.exit(1)
}

if (!existsSync(projectRoot)) {
  console.error(`Directory not found: ${projectRoot}`)
  process.exit(1)
}

console.log(`Stellario init — template: ${template}`)
console.log(`Project root: ${projectRoot}`)
console.log("")

const opencodeDir = join(projectRoot, ".opencode")
const configPath = join(opencodeDir, "stellario.yaml")

// ── 1. Config ──────────────────────────────────────────────────────────────

if (existsSync(configPath)) {
  console.log(`⚠  Config already exists: ${configPath} (skipped)`)
} else {
  const packageRoot = resolve(join(__dirname, "..", ".."))
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

// ── 2. Load config ─────────────────────────────────────────────────────────

const config = parseYaml(readFileSync(configPath, "utf-8"))
const agents = Object.keys(config.agents || {})
const volumes = config.volumes || {}

// ── 3. Memory directory + git init ─────────────────────────────────────────

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

// ── 4. package.json ────────────────────────────────────────────────────────

const pkgPath = join(opencodeDir, "package.json")
let needsInstall = false

if (!existsSync(pkgPath)) {
  const version = getStellarioVersion()
  const stellarioDep = version === "latest" ? STELLARIO_REPO : `${STELLARIO_REPO}#v${version}`
  const pkg = {
    private: true,
    dependencies: {
      "@opencode-ai/plugin": "latest",
      zod: "^3.23.0",
      stellario: stellarioDep,
    },
  }
  writeFileSync(pkgPath, JSON.stringify(pkg, null, 2) + "\n")
  needsInstall = true
  console.log(`✓ package.json: created`)
} else {
  const existingPkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
  const deps = existingPkg.dependencies || {}
  if (!deps.stellario) {
    const version = getStellarioVersion()
    deps.stellario = version === "latest" ? STELLARIO_REPO : `${STELLARIO_REPO}#v${version}`
    existingPkg.dependencies = deps
    writeFileSync(pkgPath, JSON.stringify(existingPkg, null, 2) + "\n")
    needsInstall = true
    console.log(`✓ package.json: added stellario dependency`)
  } else {
    console.log(`  package.json: stellario already listed`)
  }
}

// ── 5. Glue files ──────────────────────────────────────────────────────────

const toolsDir = join(opencodeDir, "tools")
mkdirSync(toolsDir, { recursive: true })

writeGlue(toolsDir, "stellario-memory.ts", MEMORY_GLUE)
writeGlue(toolsDir, "stellario-telescope.ts", TELESCOPE_GLUE)
writeGlue(toolsDir, "stellario-workspace.ts", WORKSPACE_GLUE)

// ── 6. Agent skeletons ─────────────────────────────────────────────────────

const agentsDir = join(opencodeDir, "agents")
mkdirSync(agentsDir, { recursive: true })

const memoryTools = ["stellario-memory_create", "stellario-memory_show", "stellario-memory_revise", "stellario-memory_forget", "stellario-memory_history"]
const searchTools = ["stellario-telescope_search"]
const workspaceTools = ["stellario-workspace_status"]

for (const agent of agents) {
  const agentPath = join(agentsDir, `${agent}.md`)
  if (existsSync(agentPath)) {
    console.log(`  Agent: ${agent}.md (exists, skipped)`)
    continue
  }

  const agentDef = config.agents[agent] || {}
  const isPrimary = agentDef.role === "primary"
  const display = agentDef.display || agent

  const canWriteAny = Object.entries(volumes)
    .some(([, def]) => (def.boundaries?.write || []).includes(agent))

  const accessibleVolumes = Object.entries(volumes)
    .filter(([, def]) => {
      const write = def.boundaries?.write || []
      const read = def.boundaries?.read || []
      return write.includes(agent) || read.includes(agent) || read.includes("all")
    })
    .map(([name]) => name)

  // Build tools list based on role and permissions
  const agentTools = []

  // Primary agent gets task delegation + code editing
  if (isPrimary) {
    agentTools.push("  task: true")
    agentTools.push("  edit: true")
    agentTools.push("  bash: true")
  }

  // Memory tools based on write permissions
  if (canWriteAny) {
    agentTools.push(...memoryTools.map(t => `  ${t}: true`))
  } else {
    agentTools.push("  memory_show: true", "  memory_history: true")
  }
  agentTools.push(...searchTools.map(t => `  ${t}: true`))
  agentTools.push(...workspaceTools.map(t => `  ${t}: true`))

  const toolsYaml = agentTools.join("\n")

  const content = `---
description: ${display}
mode: primary
tools:
${toolsYaml}
---

# ${display}

Volumes: ${accessibleVolumes.join(", ")}

<!-- Write your agent prompt here -->
`
  writeFileSync(agentPath, content)
  console.log(`✓ Agent: ${agent}.md (${isPrimary ? "primary" : "subagent"})`)
}

// ── 7. npm install ─────────────────────────────────────────────────────────

if (needsInstall) {
  console.log("")
  console.log("Installing dependencies in .opencode/...")
  try {
    execSync("npm install", { cwd: opencodeDir, stdio: "pipe" })
    console.log("✓ npm install")
  } catch {
    console.log(`⚠  npm install failed. Run manually: cd .opencode && npm install`)
  }
}

// ── 8. .gitignore ──────────────────────────────────────────────────────────

const gitignorePath = join(projectRoot, ".gitignore")
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
console.log(`  1. Edit .opencode/stellario.yaml to customize`)
console.log(`  2. Edit .opencode/agents/*.md to add prompts`)
console.log(`  3. Start opencode — tools will be auto-discovered`)

// ── Helpers ────────────────────────────────────────────────────────────────

function getArg(args, flag) {
  const idx = args.indexOf(flag)
  if (idx === -1 || idx + 1 >= args.length) return undefined
  return args[idx + 1]
}

function getStellarioVersion() {
  try {
    const pkgPath = resolve(join(__dirname, "..", "..", "package.json"))
    const pkg = JSON.parse(readFileSync(pkgPath, "utf-8"))
    return pkg.version || "latest"
  } catch {
    return "latest"
  }
}

function writeGlue(toolsDir, filename, content) {
  const path = join(toolsDir, filename)
  if (!existsSync(path)) {
    writeFileSync(path, content)
    console.log(`✓ Tools: ${filename}`)
  } else {
    console.log(`  Tools: ${filename} (exists, skipped)`)
  }
}

