import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { readUserTestState, saveUserTestState } from "../state.ts"

describe("the browser test's state", () => {
  it("reads back the latest test of a PR by its URL, and nothing for another PR", () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "ut-state-")))
    const state = { issue: "STEP-7", url: "https://github.com/example/repo/pull/7", head: "e".repeat(40), verdict: "findings" as const, findings: ["major: Save does nothing (/en/account)"], at: "2026-09-25T10:05:00.000Z" }
    saveUserTestState(paths, state)
    expect(readUserTestState(paths, state.url)).toEqual(state)
    saveUserTestState(paths, { ...state, verdict: "pass", findings: [] })
    expect(readUserTestState(paths, state.url)).toMatchObject({ verdict: "pass", findings: [] })
    expect(readUserTestState(paths, "https://github.com/example/repo/pull/8")).toBeNull()
  })
})
