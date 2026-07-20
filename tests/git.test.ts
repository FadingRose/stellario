import { afterEach, describe, expect, it } from "vitest"
import { execFileSync } from "child_process"
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { gitCommit } from "../src/git"
import type { StellarioConfig } from "../src/types"

const tempDirs: string[] = []

function createRepo(): string {
  const dir = mkdtempSync(join(tmpdir(), "stellario-git-test-"))
  tempDirs.push(dir)
  execFileSync("git", ["init"], { cwd: dir, stdio: "pipe" })
  execFileSync("git", ["config", "user.email", "test@stellario.invalid"], { cwd: dir })
  execFileSync("git", ["config", "user.name", "Stellario Test"], { cwd: dir })
  return dir
}

function configFor(volume: string): StellarioConfig {
  return {
    volumes: {
      [volume]: {
        profile: "mutable",
        boundaries: { read: ["all"], write: ["all"] },
      },
    },
    agents: {},
  }
}

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true })
  }
})

describe("git process boundary", () => {
  it("passes commit messages without shell expansion", () => {
    const dir = createRepo()
    const sideEffect = join(dir, "MESSAGE_INJECTION_PROOF")
    const message = `review $(touch ${sideEffect}) \`touch ${sideEffect}\` "quoted"\nsecond line`
    writeFileSync(join(dir, "active.jsonl"), "{}\n")

    const hash = gitCommit(dir, "active", message, configFor("active"))

    expect(hash).not.toBeNull()
    expect(existsSync(sideEffect)).toBe(false)
    const committedMessage = execFileSync("git", ["log", "-1", "--format=%B"], {
      cwd: dir,
      encoding: "utf-8",
    }).trimEnd()
    expect(committedMessage).toBe(message)
  })

  it("treats shell metacharacters in volume paths as literal characters", () => {
    const dir = createRepo()
    const volume = "active;touch PATH_INJECTION_PROOF"
    writeFileSync(join(dir, `${volume}.jsonl`), "{}\n")

    const hash = gitCommit(dir, volume, "safe path commit", configFor(volume))

    expect(hash).not.toBeNull()
    expect(existsSync(join(dir, "PATH_INJECTION_PROOF.jsonl"))).toBe(false)
    const committedFiles = execFileSync("git", ["show", "--name-only", "--format="], {
      cwd: dir,
      encoding: "utf-8",
    })
    expect(committedFiles).toContain(`${volume}.jsonl`)
  })
})
