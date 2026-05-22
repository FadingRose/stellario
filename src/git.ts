import { execSync } from "child_process"
import type { StellarioConfig } from "./types.js"
import { profileBehavior } from "./types.js"
import { getTrackedVolumes } from "./config.js"

/**
 * Git commit helper. Only commits version-controlled volumes.
 * Returns short commit hash on success, null on failure or skipped.
 */
export function gitCommit(
  memDir: string,
  volume: string,
  message: string,
  config: StellarioConfig,
): string | null {
  const def = config.volumes[volume]
  if (!def) return null
  if (!profileBehavior(def.profile).isTracked) return null

  try {
    execSync(`git add ${volume}.jsonl ${volume}.md`, { cwd: memDir, stdio: "pipe" })
    execSync(`git commit -m ${JSON.stringify(message)}`, { cwd: memDir, stdio: "pipe" })
    return execSync("git rev-parse --short HEAD", { cwd: memDir }).toString().trim()
  } catch {
    return null
  }
}

/**
 * Check if a git repo exists in the memory directory.
 */
export function isGitRepo(memDir: string): boolean {
  try {
    execSync("git rev-parse --git-dir", { cwd: memDir, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}

/**
 * Initialize a git repo in the memory directory if one doesn't exist.
 */
export function initGitRepo(memDir: string): boolean {
  if (isGitRepo(memDir)) return false
  try {
    execSync("git init", { cwd: memDir, stdio: "pipe" })
    return true
  } catch {
    return false
  }
}
