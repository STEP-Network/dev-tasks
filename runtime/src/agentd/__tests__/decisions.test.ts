import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import { askDecision, closeDecision, openDecisions, questionText, takeDefaults, type Decision } from "../decisions.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }
const NOW = new Date("2026-09-25T09:00:00.000Z")
const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679"
const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } })
const INFRA: Omit<Decision, "askedAt" | "deadlineAt"> = {
  id: "infra-STEP-7-abc1234def",
  issue: "STEP-7",
  url: PR,
  question: `CI on ${PR} failed on its infrastructure again after a full re-run (Test on abc1234), not on the code.`,
  options: [
    { reply: "re-run", does: "re-run CI in full once more" },
    { reply: "leave it", does: "leave the PR to a person" },
  ],
  defaultReply: "re-run",
  defaultAction: { kind: "rerun", runs: ["111"] },
}

function setup() {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-decisions-")))
  const f = fakeExec([[/^gh pr view .* --jq \.body$/, { stdout: "STEP-7\n\n## What changed\nFixed.\n" }]])
  const comments: Array<[string, string]> = []
  const deps = (at: Date) => ({ exec: f.exec, paths, config, now: () => at, log: quiet, comment: async (issue: string, body: string) => void comments.push([issue, body]) })
  const outbox = () => listNew<{ kind: string; issue?: string; text: string; question?: boolean }>(paths.outbox).map((e) => e.payload)
  return { paths, f, comments, deps, outbox }
}

describe("decisions (STEP-3285)", () => {
  it("asks one question, recommending its default, with the other options and the default's time in the mini's own time zone, and only once (STEP-3293)", () => {
    const { paths, outbox } = setup()
    expect(askDecision(paths, config, INFRA, NOW)).toMatchObject({ deadlineAt: "2026-09-25T10:00:00.000Z" })
    expect(askDecision(paths, config, INFRA, NOW)).toBeNull()
    expect(outbox()).toEqual([
      expect.objectContaining({
        kind: "issue",
        issue: "STEP-7",
        question: true,
        // 10:00 UTC is 12:00 in Copenhagen.
        text: `${INFRA.question}\n\nMy recommendation: re-run CI in full once more. Reply yes to go with it, or tell me what you want instead. You can also reply "leave it" to leave the PR to a person. If nobody answers, I do it at 12:00.`,
      }),
    ])
    expect(questionText({ ...INFRA, defaultReply: "leave it", askedAt: "", deadlineAt: "2026-09-25T10:00:00.000Z" }, "UTC")).toBe(
      `${INFRA.question}\n\nMy recommendation: leave the PR to a person. Reply yes to go with it, or tell me what you want instead. You can also reply "re-run" to re-run CI in full once more. If nobody answers, I do it at 10:00.`,
    )
    // On the Monday board the fixed verbs read the reply, so a bare yes would act on nothing there.
    expect(questionText({ ...INFRA, askedAt: "", deadlineAt: "2026-09-25T10:00:00.000Z" }, "UTC", "monday")).toBe(
      `${INFRA.question} Reply "re-run" to re-run CI in full once more (the default: I do it at 10:00 if nobody answers), or "leave it" to leave the PR to a person.`,
    )
  })

  it("takes a re-run default after its hour, in full, and logs it in the thread, the PR body and the issue", async () => {
    const { paths, f, comments, deps, outbox } = setup()
    askDecision(paths, config, INFRA, NOW)
    await takeDefaults(deps(new Date("2026-09-25T09:59:00.000Z")))
    expect(f.lines().some((l) => l.startsWith("gh run rerun"))).toBe(false)
    await takeDefaults(deps(new Date("2026-09-25T10:01:00.000Z")))
    expect(f.lines().filter((l) => l.startsWith("gh run rerun"))).toEqual(["gh run rerun 111 --repo STEP-Network/v0-politiske-annoncer"])
    const line = `2026-09-25 10:01 UTC: ${INFRA.question} Nobody answered by 10:00 UTC, so I took the default: re-run CI in full once more.`
    const bodyFile = join(paths.state, "pr-body-STEP-7-decisions.md")
    expect(f.lines()).toContain(`gh pr edit ${PR} --body-file ${bodyFile}`)
    expect(readFileSync(bodyFile, "utf8")).toBe(`STEP-7\n\n## What changed\nFixed.\n\n## Decisions taken by default\n\n- ${line}\n`)
    expect(comments).toEqual([["STEP-7", `Decision taken by default. ${line}`]])
    expect(outbox().at(-1)).toMatchObject({ kind: "issue", question: false, text: "No answer, so I took the default: re-run CI in full once more. It is logged in the PR and the issue." })
    expect(openDecisions(paths)).toEqual([])
    // Taken once.
    await takeDefaults(deps(new Date("2026-09-25T11:00:00.000Z")))
    expect(f.lines().filter((l) => l.startsWith("gh run rerun"))).toHaveLength(1)
  })

  it("takes nothing for a question a person answered, and runs nothing for a leave-it default", async () => {
    const answered = setup()
    askDecision(answered.paths, config, INFRA, NOW)
    closeDecision(answered.paths, INFRA.id, "answered by Nate: leave", NOW)
    await takeDefaults(answered.deps(new Date("2026-09-25T12:00:00.000Z")))
    expect(answered.f.lines()).toEqual([])
    expect(answered.comments).toEqual([])
    const leave = setup()
    askDecision(leave.paths, config, { ...INFRA, id: "cap-STEP-7-1679", defaultReply: "leave it", defaultAction: { kind: "leave" } }, NOW)
    await takeDefaults(leave.deps(new Date("2026-09-25T10:01:00.000Z")))
    expect(leave.f.lines().some((l) => l.startsWith("gh run"))).toBe(false)
    expect(leave.comments[0][1]).toMatch(/so I took the default: leave the PR to a person\.$/)
  })
})
