/**
 * Tracker selection and the Monday adapter's one pure helper.
 *
 * The default is MONDAY, deliberately: phase 0 ships before the Linear
 * workspace exists (spec section 14), so a plugin that defaulted to Linear
 * would fail on every consumer the day it released. PolAds flips the key on
 * cutover weekend.
 */

import { describe, it, expect, beforeEach, afterEach, vi, type MockInstance } from "vitest"
import { execFileSync } from "node:child_process"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { readTrackerProvider, resolveTracker } from "../index.ts"
import { stripDescriptionDocHeader } from "../monday.ts"

let root: string
let stderr: MockInstance
const ORIGINAL_TRACKER = process.env.DEV_TASKS_TRACKER
const ORIGINAL_CEILING = process.env.GIT_CEILING_DIRECTORIES

function writeConfig(body: unknown): void {
  mkdirSync(join(root, ".claude"), { recursive: true })
  writeFileSync(join(root, ".claude", "project-config.json"), JSON.stringify(body))
}

function warnings(): string {
  return stderr.mock.calls.map((c) => String(c[0])).join("")
}

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "tracker-cfg-"))
  // git stops its search at root, so a TMPDIR inside some repo cannot lend
  // these tests that repo's config. The resolver's git child inherits it.
  process.env.GIT_CEILING_DIRECTORIES = dirname(root)
  delete process.env.DEV_TASKS_TRACKER
  stderr = vi.spyOn(process.stderr, "write").mockImplementation(() => true)
})

afterEach(() => {
  stderr.mockRestore()
  if (ORIGINAL_TRACKER === undefined) delete process.env.DEV_TASKS_TRACKER
  else process.env.DEV_TASKS_TRACKER = ORIGINAL_TRACKER
  if (ORIGINAL_CEILING === undefined) delete process.env.GIT_CEILING_DIRECTORIES
  else process.env.GIT_CEILING_DIRECTORIES = ORIGINAL_CEILING
  rmSync(root, { recursive: true, force: true })
})

describe("readTrackerProvider", () => {
  it("defaults to monday when there is no config at all, and says so on stderr", () => {
    expect(readTrackerProvider(root)).toBe("monday")
    // Silence here meant a skill run from the wrong directory wrote to
    // Monday while the project had moved to Linear.
    expect(warnings()).toMatch(/project-config\.json/)
    expect(warnings()).toMatch(/monday/)
  })

  it("defaults to monday QUIETLY when the config has no tracker block", () => {
    // The documented pre-cutover default, not a fallback: every Monday
    // project would otherwise warn on every call.
    writeConfig({ version: "1", monday: { productId: "1" } })
    expect(readTrackerProvider(root)).toBe("monday")
    expect(stderr).not.toHaveBeenCalled()
  })

  it("reads linear when the config says so", () => {
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    expect(readTrackerProvider(root)).toBe("linear")
    expect(stderr).not.toHaveBeenCalled()
  })

  it("falls back to monday on an unrecognised value rather than throwing, and warns", () => {
    // A typo must not take the three skills down; Monday still works. But a
    // typo must not pass unnoticed either.
    writeConfig({ version: "1", tracker: { provider: "jira" } })
    expect(readTrackerProvider(root)).toBe("monday")
    expect(warnings()).toMatch(/jira/)
  })

  it("survives an unparseable config, and warns", () => {
    mkdirSync(join(root, ".claude"), { recursive: true })
    writeFileSync(join(root, ".claude", "project-config.json"), "{ not json")
    expect(readTrackerProvider(root)).toBe("monday")
    expect(warnings()).toMatch(/project-config\.json/)
  })

  it("is overridden by DEV_TASKS_TRACKER, for the rehearsal", () => {
    writeConfig({ version: "1", tracker: { provider: "monday" } })
    process.env.DEV_TASKS_TRACKER = "linear"
    expect(readTrackerProvider(root)).toBe("linear")
  })

  it("ignores an unrecognised DEV_TASKS_TRACKER, and warns", () => {
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    process.env.DEV_TASKS_TRACKER = "Linear"
    expect(readTrackerProvider(root)).toBe("linear")
    expect(warnings()).toMatch(/DEV_TASKS_TRACKER/)
  })

  it("reads the config at the git toplevel when run from a subdirectory", () => {
    // stdio ignored: execFileSync otherwise forwards the child's stderr
    // through process.stderr.write, which is the spy under test.
    execFileSync("git", ["init", "-q"], { cwd: root, stdio: "ignore" })
    writeConfig({ version: "1", tracker: { provider: "linear" } })
    const nested = join(root, "packages", "app")
    mkdirSync(nested, { recursive: true })

    expect(readTrackerProvider(nested)).toBe("linear")
    expect(stderr).not.toHaveBeenCalled()
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
