/**
 * Source-level invariants over the skill markdown.
 *
 * A skill is prose; what CAN be pinned is that its load-bearing LITERALS are
 * present and its retired ones are gone. Two of these are contradictions that
 * would otherwise ship in silence: a skill that bans `--auto` shipping beside
 * a skill that runs it, and any skill reaching for `--admin`, which spec
 * section 11 keeps banned outright.
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, "..", "..")

function skill(name: string): string {
  return readFileSync(resolve(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf-8")
}

describe("babysit-prs no longer bans auto-merge", () => {
  const source = skill("babysit-prs")

  it("carries no DO NOT use gh pr merge --auto line", () => {
    expect(source).not.toMatch(/DO NOT use\s+`?gh pr merge --auto`?/i)
  })

  it("does not tell the agent to reach for --admin", () => {
    // Spec section 11: no --admin merges, bypass actors stay empty.
    // (Not a blanket /--admin/ ban: the skill's own prose says "Never `--admin`"
    // as an instruction, which itself contains the substring "--admin".)
    expect(source).not.toMatch(/gh pr merge[^\n`]*--admin/)
    expect(source).not.toMatch(/[Uu]se `--admin/)
  })

  it("still explains what the skill is for", () => {
    // A guard that passes because the file was emptied is not a guard.
    expect(source.length).toBeGreaterThan(2000)
    expect(source).toMatch(/gh pr merge/)
  })
})

describe("/dev", () => {
  const source = skill("dev")

  it("declares itself user-invocable with the name dev", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*dev\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("writes NOTHING to the tracker", () => {
    // Spec section 5: "No tracker writes, no subtasks, no hours."
    expect(source).not.toMatch(/trackerctl(\.ts["']?)?\s+(create|claim|comment|attach)/)
  })

  it("reads the issue through trackerctl rather than an MCP tool", () => {
    expect(source).toMatch(/trackerctl\.ts["']?\s+branch/)
    expect(source).not.toMatch(/mcp__plugin_dev-tasks/)
  })

  it("works in the MAIN checkout unless --worktree is passed", () => {
    expect(source).toMatch(/--worktree/)
    expect(source).toMatch(/main checkout/i)
  })

  it("ends with /preview when devSurface is preview", () => {
    expect(source).toMatch(/devSurface/)
    expect(source).toMatch(/\/preview/)
  })
})
