import { describe, expect, it } from "vitest"
import { issue } from "../../__tests__/fakes.ts"
import { ANSWERS_HEADING, appendAnswer } from "../../slack/text.ts"
import { buildBrief, PLAIN_WORDS_RULE, WORKER_LESSONS_FILE, WORKER_RESULT_SCHEMA, workerLessons, workerRules, type BriefInput } from "../brief.ts"

const input: BriefInput = {
  mini: "eve",
  issue: issue({ id: "STEP-7", title: "Fix the date", labels: ["polads", "agent-ready"], description: "## Goal\n\nShow the publication date.\n\n## Acceptance criteria\n\n- [ ] the date is right" }),
  worktree: "/Users/eve/.agentd/worktrees/STEP-7-fix-the-date",
  branch: "STEP-7-fix-the-date",
  base: "staging",
  resumed: false,
  limits: { maxTurns: 250, maxBudgetUsd: 15, wallClockMinutes: 90 },
}

describe("buildBrief", () => {
  it("carries the issue as refined, its link and its labels", () => {
    const brief = buildBrief(input)
    expect(brief).toContain("# STEP-7: Fix the date")
    expect(brief).toContain("https://linear.app/step/issue/STEP-7")
    expect(brief).toContain("- [ ] the date is right")
    expect(brief).toContain("Labels: polads, agent-ready")
  })

  it("keeps the answers people gave in Slack, as the bridge appended them", () => {
    const description = appendAnswer(input.issue.description, { ts: "1727.5", userName: "Nate", text: "the publication date, not the creation date", permalink: null })
    const brief = buildBrief({ ...input, issue: { ...input.issue, description } })
    expect(brief).toContain(ANSWERS_HEADING)
    expect(brief).toContain("**Nate**: the publication date, not the creation date")
  })
})

describe("workerRules", () => {
  it("names the mini from its input, and states the worktree, the push ban, the checks and the limits", () => {
    const rules = workerRules(input)
    expect(rules).toMatch(/^You are eve's worker/)
    expect(rules).toContain(input.worktree)
    expect(rules).toMatch(/Never push, never open or merge a PR/)
    expect(rules).toMatch(/pnpm typecheck, pnpm lint/)
    expect(rules).toMatch(/250 turns, USD 15 .*, 90 minutes/)
    expect(rules).not.toMatch(/--admin/)
  })

  it("lets the worker fan out on any model, only on worker.fanOut, and names the Workflow tool as its owner's opt-in, never a person's request (STEP-3367)", () => {
    const on = workerRules({ ...input, fanOut: true })
    expect(on).toMatch(/subagents \(the Agent tool, in the background or the foreground\), a dynamic workflow \(the Workflow tool, which this mini's owner turned on for you\), and named teammates you message with SendMessage/)
    expect(on).toMatch(/fable, opus, sonnet or haiku/)
    expect(on).toMatch(/under your rules, hooks and sandbox: they never push or open a PR, read no secret, and message only you and each other/)
    expect(on).not.toMatch(/explicit request|the user asked|a person asked/)
    for (const off of [workerRules(input), workerRules({ ...input, fanOut: false })]) expect(off).not.toMatch(/subagent|Workflow|teammate/)
  })

  it("puts ~/.config, every .env file but the template, and the agent configuration off limits", () => {
    const rules = workerRules(input)
    expect(rules).toMatch(/Never read or write \.env files \(the tracked \.env\.example template aside\) or anything in ~\/\.config/)
    expect(rules).toMatch(/Never change \.claude\/hooks, \.claude\/settings\*\.json or \.mcp\.json/)
  })

  it("mentions earlier work only when resuming, and then has the worker install the branch's own dependencies", () => {
    expect(workerRules(input)).not.toMatch(/earlier work/)
    expect(workerRules(input)).not.toMatch(/pnpm install/)
    const rules = workerRules({ ...input, resumed: true })
    expect(rules).toMatch(/cut from origin\/staging, with earlier work on it\./)
    expect(rules).toMatch(/The launcher installed the dependencies of origin\/staging\. If the earlier work changed package\.json or pnpm-lock\.yaml, run pnpm install --frozen-lockfile --prefer-offline before anything else\./)
  })
})

describe("the self-check (STEP-3284)", () => {
  it("has every develop worker sweep one hop and mutation-check its new guard tests before it reports", () => {
    const rules = workerRules(input)
    for (const phrase of [
      /sweep one hop from every change/,
      /sibling call sites with the same pattern/,
      /public outputs and exports/,
      /caches and their version keys: bump a version when cached output changes meaning/,
      /crons, reminders and emails coupled to the changed flow/,
      /API_DOCUMENTATION\.md, \.claude\/reference notes, code comments/,
      /one deliberate mutation of the invariant itself/,
      /revert the mutation with git checkout -- <file> before you commit/,
      /checklist \(siblings, publicOutputs, caches, coupled, docs, translations\)/,
      /The runner refuses a done report without them/,
    ]) {
      expect(rules, String(phrase)).toMatch(phrase)
    }
    expect(buildBrief(input)).toMatch(/run the self-check in your rules/)
  })

  it("asks the report for the checklist and the mutation checks, and requires neither of a blocked report", () => {
    expect(Object.keys(WORKER_RESULT_SCHEMA.properties.checklist.properties)).toEqual(["siblings", "publicOutputs", "caches", "coupled", "docs", "translations"])
    expect(WORKER_RESULT_SCHEMA.properties.mutations.items.required).toEqual(["test", "mutation", "result"])
    expect(WORKER_RESULT_SCHEMA.required).toEqual(["status", "summary"])
  })
})

describe("WORKER_RESULT_SCHEMA", () => {
  it("has the worker write what reaches Slack in plain words, without the machinery's", () => {
    const rules = workerRules(input)
    expect(rules).toContain(PLAIN_WORDS_RULE)
    expect(PLAIN_WORDS_RULE).toMatch(/plain words someone who does not write code follows.*the one thing you need.*self-check, checklist, siblings, report/)
    expect((WORKER_RESULT_SCHEMA.properties.question as { description: string }).description).toMatch(/plain words someone who does not write code follows/)
  })

  it("gives every worker the lessons file the weekly retro keeps, and nothing when it is empty (STEP-3290)", () => {
    expect(workerRules(input, "# Lessons from review\n\n- Test every new branch.")).toContain("\n# Lessons from review\n\n- Test every new branch.\n")
    expect(workerRules(input, "")).not.toContain("Lessons from review")
    // The checkout's own file, as the mini's install has it.
    expect(workerLessons()).toMatch(/^# Lessons from review/)
    expect(workerLessons(WORKER_LESSONS_FILE)).toBe(workerLessons())
    expect(workerLessons("/nonexistent/worker-lessons.md")).toBe("")
  })

  it("requires a status and a summary and allows only the three statuses", () => {
    expect(WORKER_RESULT_SCHEMA.required).toEqual(["status", "summary"])
    expect(WORKER_RESULT_SCHEMA.properties.status.enum).toEqual(["done", "needs_input", "blocked"])
  })
})
