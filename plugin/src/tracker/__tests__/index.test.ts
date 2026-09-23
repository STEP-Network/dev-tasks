/**
 * Tracker selection and the Monday adapter's one pure helper.
 *
 * The default is MONDAY, deliberately: phase 0 ships before the Linear
 * workspace exists (spec section 14), so a plugin that defaulted to Linear
 * would fail on every consumer the day it released. PolAds flips the key on
 * cutover weekend.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { readTrackerProvider, resolveTracker } from "../index.ts"
import { stripDescriptionDocHeader } from "../monday.ts"

let root: string

function writeConfig(body: unknown): void {
  mkdirSync(join(root, ".claude"), { recursive: true })
  writeFileSync(join(root, ".claude", "project-config.json"), JSON.stringify(body))
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tracker-cfg-"))
})

afterEach(() => {
  rmSync(root, { recursive: true, force: true })
})

describe("readTrackerProvider", () => {
  it("defaults to monday when there is no config at all", () => {
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("defaults to monday when the config has no tracker block", () => {
    writeConfig({ version: "1", monday: { productId: "1" } })
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("reads linear when the config says so", () => {
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    expect(readTrackerProvider(root)).toBe("linear")
  })

  it("falls back to monday on an unrecognised value rather than throwing", () => {
    // A typo must not take the three skills down; Monday still works.
    writeConfig({ version: "1", tracker: { provider: "jira" } })
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("survives an unparseable config", () => {
    mkdirSync(join(root, ".claude"), { recursive: true })
    writeFileSync(join(root, ".claude", "project-config.json"), "{ not json")
    expect(readTrackerProvider(root)).toBe("monday")
  })

  it("is overridden by DEV_TASKS_TRACKER, for the rehearsal", () => {
    writeConfig({ version: "1", tracker: { provider: "monday" } })
    process.env.DEV_TASKS_TRACKER = "linear"
    try {
      expect(readTrackerProvider(root)).toBe("linear")
    } finally {
      delete process.env.DEV_TASKS_TRACKER
    }
  })
})

describe("resolveTracker", () => {
  it("returns the implementation the provider names", () => {
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    expect(resolveTracker(root).kind).toBe("linear")

    writeConfig({ version: "1", tracker: { provider: "monday" } })
    expect(resolveTracker(root).kind).toBe("monday")
  })
})

describe("stripDescriptionDocHeader", () => {
  it("removes the header getTaskDescriptionDoc prepends", () => {
    const raw = "# Description Doc — Task #123 (doc 456)\n\nThe real body.\n\n## Acceptance criteria\n\n- [ ] x"
    expect(stripDescriptionDocHeader(raw)).toBe("The real body.\n\n## Acceptance criteria\n\n- [ ] x")
  })

  it("leaves a body that carries no such header alone", () => {
    expect(stripDescriptionDocHeader("Just a body")).toBe("Just a body")
  })

  it("returns empty string for the empty-doc placeholder", () => {
    expect(stripDescriptionDocHeader("# Description Doc — Task #1 (doc 2)\n\n_(empty doc)_")).toBe("")
  })

  it("returns empty string when the tool returned an error string", () => {
    // formatError output must never be mistaken for a description.
    expect(stripDescriptionDocHeader("ERROR: Task #9 has no description doc set.")).toBe("")
  })

  it("returns empty string for the real formatError shape (a heading line, not an ERROR: prefix)", () => {
    // R7: formatError() actually renders "# Error\n\n<msg>" — a heading, not
    // the "ERROR:" prefix the brief's helper alone would catch. Without this
    // case a real "no description doc" error would be returned as the
    // issue's description.
    expect(
      stripDescriptionDocHeader(
        "# Error\n\nTask #9 has no description doc set. Use createTaskDescriptionDoc(taskId, markdown) to create one.",
      ),
    ).toBe("")
  })
})
