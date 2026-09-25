import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import type { WatchedPr } from "../../jobs.ts"
import { listJobs, readWatchedPrs, recordPr } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { APPROVAL_CHECK, classRaise, failingRequired, PR_FIELDS, reviseOwnPr, type OwnPrView } from "../revise.ts"

const HEAD = "a".repeat(40)
const view = (labels: string[], conclusion = "FAILURE"): OwnPrView => ({
  url: "https://github.com/example/repo/pull/7",
  number: 7,
  state: "OPEN",
  headRefName: "STEP-7-x",
  headRefOid: HEAD,
  author: { login: "agent-bot" },
  labels: labels.map((name) => ({ name })),
  statusCheckRollup: [{ name: APPROVAL_CHECK, conclusion, detailsUrl: "https://github.com/example/repo/actions/runs/111/job/222" }],
})

afterEach(() => {
  delete process.env.AGENTD_HOME
})

describe("classRaise", () => {
  it("raises to the PR's label when the check is red and the issue is lower", () => {
    expect(classRaise(view(["approval/look"]), ["approval/auto"])).toEqual({ to: "look", runId: "111" })
    expect(classRaise(view(["approval/try"]), [])).toEqual({ to: "try", runId: "111" })
  })

  it("does nothing when the check is green, the PR has no class, or the issue is already as high", () => {
    expect(classRaise(view(["approval/look"], "SUCCESS"), ["approval/auto"])).toBeNull()
    expect(classRaise(view([]), ["approval/auto"])).toBeNull()
    expect(classRaise(view(["approval/look"]), ["approval/try"])).toBeNull()
    // Red for another reason (an agent lowered it): the class is already where the diff puts it.
    expect(classRaise(view(["approval/look"]), ["approval/look"])).toBeNull()
  })

  it("is fed the PR's labels: the watcher asks gh for them", () => {
    expect(PR_FIELDS.split(",")).toContain("labels")
  })
})

describe("failingRequired", () => {
  it("never sends the Approval class check to a worker, even when it is required", () => {
    expect(failingRequired(view(["approval/look"]), [APPROVAL_CHECK])).toEqual([])
  })
})

describe("reviseOwnPr raises the class once per head", () => {
  const setup = (issueLabels = ["polads", "approval/auto"]) => {
    process.env.AGENTD_HOME = mkdtempSync(join(tmpdir(), "agentd-class-"))
    const paths = agentPaths()
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/repo" }, pluginRoot: "/plugin", slack: { allowedUsers: ["U0EXAMPLE"] } })
    const pr: WatchedPr = { issue: "STEP-7", url: "https://github.com/example/repo/pull/7", openedAt: "2026-09-25T10:00:00.000Z" }
    recordPr(paths, pr)
    const t = fakeTracker([issue({ id: "STEP-7", labels: issueLabels })])
    const { exec, lines } = fakeExec()
    const log = { info: () => {}, warn: () => {}, error: () => {} }
    return { paths, config, pr, t, exec, lines, log }
  }

  it("adds the higher label, removes the lower, re-runs the check and records the head", async () => {
    const { paths, config, pr, t, exec, lines, log } = setup()
    await reviseOwnPr({ exec, paths, config, now: () => new Date("2026-09-25T11:00:00Z"), log, tracker: t.tracker }, pr, view(["approval/look"]), [])
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/look"])
    expect(lines()).toContain("gh run rerun 111 --repo STEP-Network/v0-politiske-annoncer")
    expect(readWatchedPrs(paths)[0].classRaised).toBe(HEAD)
    // Said once, in plain words, in #polads-agents, and kept in the ledger.
    expect(listNew<{ kind: string; channel?: string; text?: string }>(paths.outbox).map((e) => e.payload)).toEqual([
      expect.objectContaining({
        kind: "post",
        channel: "agents",
        text: "STEP-7: the change in <https://github.com/example/repo/pull/7|PR #7> reaches further than planned, so it now needs a visual check by a person before release. Nothing needed from you.",
      }),
    ])
    expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"class.raised","issue":"STEP-7","url":"https://github.com/example/repo/pull/7","to":"look"')
  })

  it("does not act again at the same head", async () => {
    const { paths, config, pr, t, exec, log } = setup()
    await reviseOwnPr({ exec, paths, config, now: () => new Date(), log, tracker: t.tracker }, { ...pr, classRaised: HEAD }, view(["approval/look"]), [])
    expect(t.called("updateIssue")).toEqual([])
  })

  it("sends no revise worker for a red Approval class check, even a required one", async () => {
    const { paths, config, pr, t, exec, log } = setup()
    await reviseOwnPr({ exec, paths, config, now: () => new Date(), log, tracker: t.tracker }, pr, view(["approval/look"]), [APPROVAL_CHECK])
    expect(listJobs(paths, "pending")).toEqual([])
  })

  it("tries again at the next watch when Linear refuses, and never lowers the issue", async () => {
    const { paths, config, pr, exec, log } = setup()
    const refusing = fakeTracker([issue({ id: "STEP-7", labels: ["polads", "approval/auto"] })], undefined, ["updateIssue"])
    await reviseOwnPr({ exec, paths, config, now: () => new Date(), log, tracker: refusing.tracker }, pr, view(["approval/look"]), [])
    expect(readWatchedPrs(paths)[0].classRaised).toBeUndefined()
    // An issue already higher than the PR's label is left alone, and the head is marked.
    const higher = setup(["polads", "approval/try"])
    await reviseOwnPr({ exec: higher.exec, paths: higher.paths, config: higher.config, now: () => new Date(), log: higher.log, tracker: higher.t.tracker }, higher.pr, view(["approval/look"]), [])
    expect(higher.t.called("updateIssue")).toEqual([])
    expect(readWatchedPrs(higher.paths)[0].classRaised).toBe(HEAD)
  })
})
