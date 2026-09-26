/**
 * Claude Code's hook `if` takes one permission rule (code.claude.com, hooks
 * guide: "To match multiple tool names, use separate handlers each with its
 * own if value"). A `|` in it, `Bash(a|b)` or `Edit(x)|Write(y)`, never
 * matches, and the hook then runs only on a command Claude Code cannot parse.
 * bash-guard, protect-sensitive-files and two nudges sat dead that way until
 * agentctl probe-hooks failed on Eve's mini (2026-09-24). runtime's
 * sessions.test.ts proves the split handlers fire in a real session.
 */

import { readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..")

type Handler = { type: string; command: string; if?: string }
type Group = { matcher?: string; hooks: Handler[] }
const hooks = (JSON.parse(readFileSync(resolve(PLUGIN_ROOT, "hooks", "hooks.json"), "utf-8")) as { hooks: Record<string, Group[]> }).hooks

const handlers = Object.entries(hooks).flatMap(([event, groups]) => groups.flatMap((g) => g.hooks.map((h) => ({ event, matcher: g.matcher, ...h }))))
const conditionsFor = (script: string) => handlers.filter((h) => h.command.endsWith(`/hooks/${script}`)).map((h) => h.if)

describe("hooks.json conditions", () => {
  it("gives every `if` exactly one permission rule, and only on tool events", () => {
    const conditioned = handlers.filter((h) => h.if !== undefined)
    expect(conditioned.length).toBeGreaterThan(0)
    for (const h of conditioned) {
      expect(h.if, h.command).toMatch(/^[A-Z][A-Za-z]*\([^|]*\)$/)
      expect(["PreToolUse", "PostToolUse", "PostToolUseFailure", "PermissionRequest", "PermissionDenied"], h.command).toContain(h.event)
    }
  })

  it("runs bash-guard and the secrets scan on every Bash command, once, with no `if` to miss a form (STEP-3354)", () => {
    // A tab, \git, /usr/bin/git, --no-pager, VAR=x git, a second line: no `if` rule matches them all, and the hooks' own parse reads each.
    for (const script of ["bash-guard.sh", "pre-commit-secrets-scan.sh"]) {
      const registered = handlers.filter((h) => h.command.endsWith(`/hooks/${script}`))
      expect(registered, script).toHaveLength(1)
      expect(registered[0], script).toMatchObject({ event: "PreToolUse", matcher: "Bash" })
      expect(registered[0].if, script).toBeUndefined()
    }
  })

  it("guards every sensitive file for both Edit and Write", () => {
    const conditions = conditionsFor("protect-sensitive-files.sh")
    for (const path of ["**/.env*", "**/.mcp.json", "**/secrets/**", "**/credentials/**", "**/pnpm-lock.yaml", "**/package-lock.json"]) {
      expect(conditions).toContain(`Edit(${path})`)
      expect(conditions).toContain(`Write(${path})`)
    }
    expect(conditions).toHaveLength(12)
  })

  it("runs the people-doors guard on every Monday, Slack, Linear and dev-tasks server's tools and every Bash, with no `if` to miss one (STEP-3330)", () => {
    const guard = handlers.filter((h) => h.command.endsWith("/hooks/people-doors-guard.sh"))
    expect(guard).toHaveLength(1)
    expect(guard[0].event).toBe("PreToolUse")
    expect(guard[0].if).toBeUndefined()
    const matcher = new RegExp(`^(?:${guard[0].matcher})$`)
    for (const tool of [
      "mcp__claude_ai_monday_com__create_update",
      "mcp__claude_ai_monday_com__execute_code",
      "mcp__claude_ai_Slack__slack_send_message",
      "mcp__slack__post_message",
      "mcp__linear-server__save_issue",
      "mcp__claude_ai_Linear__save_issue",
      "mcp__plugin_dev-tasks_dev-tasks__createUpdate",
      "mcp__claude_ai_Dev_Tasks__createUpdate",
      "Bash",
    ]) {
      expect(matcher.test(tool), tool).toBe(true)
    }
    for (const tool of ["Read", "Edit", "Write", "BashOutput", "mcp__claude_ai_Gmail__send_message"]) expect(matcher.test(tool), tool).toBe(false)
  })

  it("runs build-failure-advisor once per command: it counts failures, and filters the command itself", () => {
    expect(conditionsFor("build-failure-advisor.sh")).toEqual(["Bash(pnpm *)"])
  })
})
