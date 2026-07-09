// =============================================================================
// Display ID Symmetry — multi-char idPrefix regression test
// =============================================================================
//
// Regression: parseDisplayId used to reconstruct storedId via config.idPrefix,
// while formatDisplayId strips via slice(1). For volumes whose idPrefix length
// > 1 (e.g. linked "lilac-active" with idPrefix "la" but entries retain source
// prefix "a"), show/display-ID lookup failed because the reconstructed id
// ("la83") didn't match the actual stored id ("a83").

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, writeFileSync, rmSync } from "fs"
import { join } from "path"
import { tmpdir } from "os"
import type { StellarioConfig, MemoryEntry } from "../src/types"
import { findEntry, parseDisplayId, formatDisplayId } from "../src/store"

function makeConfig(): StellarioConfig {
  return {
    memoryDir: ".",
    volumes: {
      active: {
        profile: "mutable",
        boundaries: { read: ["all"], write: ["all"] },
        idPrefix: "a",
      },
      "lilac-active": {
        profile: "frozen",
        boundaries: { read: ["all"], write: [] },
        idPrefix: "la",
      },
      directing: {
        profile: "mutable",
        boundaries: { read: ["all"], write: ["all"] },
        idPrefix: "dr",
      },
      archived: { profile: "frozen", boundaries: { read: ["all"], write: [] }, idPrefix: "z" },
      meta: { profile: "mutable", boundaries: { read: ["all"], write: ["all"] }, idPrefix: "m" },
      handover: { profile: "append", boundaries: { read: ["all"], write: ["all"] }, idPrefix: "h" },
      layer: { profile: "workspace", boundaries: { read: ["all"], write: ["all"] }, idPrefix: "l" },
    },
    agents: { stellario: { display: "Stellario" } },
  }
}

function makeEntry(id: string, volume: string): MemoryEntry {
  return {
    id,
    volume,
    content: `content for ${id}`,
    tags: [],
    created: "2026-04-25",
    updated: "2026-04-25",
    keywords: [],
    author: "maestro",
  }
}

describe("display ID symmetry (multi-char idPrefix)", () => {
  let memDir: string

  beforeEach(() => {
    memDir = mkdtempSync(join(tmpdir(), "stellario-did-"))
    // lilac-active entries use source prefix "a", but volume config says "la"
    const linked = [makeEntry("a83", "lilac-active"), makeEntry("a84", "lilac-active")]
    writeFileSync(
      join(memDir, "lilac-active.jsonl"),
      linked.map((e) => JSON.stringify(e)).join("\n") + "\n",
    )
    // directing entries use "dr" prefix natively (idPrefix matches stored id)
    const directing = [makeEntry("dr01", "directing")]
    writeFileSync(
      join(memDir, "directing.jsonl"),
      directing.map((e) => JSON.stringify(e)).join("\n") + "\n",
    )
  })

  afterEach(() => {
    rmSync(memDir, { recursive: true, force: true })
  })

  it("parseDisplayId returns number portion without prefix", () => {
    const config = makeConfig()
    const parsed = parseDisplayId("lilac-active:83", config)
    expect(parsed).toEqual({ volume: "lilac-active", storedId: "83" })
  })

  it("findEntry resolves linked volume display ID (source prefix ≠ config prefix)", () => {
    const config = makeConfig()
    const found = findEntry(memDir, "lilac-active:83", config)
    expect(found).not.toBeNull()
    expect(found!.entry.id).toBe("a83")
    expect(found!.volume).toBe("lilac-active")
  })

  it("formatDisplayId → parseDisplayId → findEntry roundtrip is symmetric", () => {
    const config = makeConfig()
    const entry = makeEntry("a83", "lilac-active")
    const displayId = formatDisplayId(entry)
    expect(displayId).toBe("lilac-active:83")
    const found = findEntry(memDir, displayId, config)
    expect(found).not.toBeNull()
    expect(found!.entry.id).toBe("a83")
  })

  it("findEntry resolves native multi-char prefix volume (directing)", () => {
    const config = makeConfig()
    // formatDisplayId uses slice(1), so "dr01" → "directing:r01"
    const displayId = formatDisplayId(makeEntry("dr01", "directing"))
    const found = findEntry(memDir, displayId, config)
    expect(found).not.toBeNull()
    expect(found!.entry.id).toBe("dr01")
  })
})
