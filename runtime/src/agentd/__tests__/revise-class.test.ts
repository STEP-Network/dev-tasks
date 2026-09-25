import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import type { WatchedPr } from "../../jobs.ts"
import { listJobs, readWatchedPrs, recordPr } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { openDecisions } from "../decisions.ts"
import { APPROVAL_CHECK, APPROVAL_LABEL_CHECK, classRaise, failingRequired, PR_FIELDS, reviseOwnPr, type OwnPrView, type PrRollupEntry } from "../revise.ts"

const HEAD = "a".repeat(40)
const RUN = "https://github.com/example/repo/actions/runs/111/job/222"
/** The PR at HEAD: the Approval class check's verdict, and its label job's (this head's label, when it passed). */
const view = (labels: string[], conclusion: string = "FAILURE", labelJob: string | null = "SUCCESS", extra: Partial<PrRollupEntry> = {}): OwnPrView => ({
  url: "https://github.com/example/repo/pull/7",
  number: 7,
  state: "OPEN",
  headRefName: "STEP-7-x",
  headRefOid: HEAD,
  author: { login: "agent-bot" },
  labels: labels.map((name) => ({ name })),
  statusCheckRollup: [
    { name: APPROVAL_CHECK, conclusion, detailsUrl: RUN, ...extra },
    ...(labelJob === null ? [] : [{ name: APPROVAL_LABEL_CHECK, conclusion: labelJob, detailsUrl: "https://github.com/example/repo/actions/runs/111/job/223" }]),
  ],
})
const running = (labels: string[]) => view(labels, "", null, { status: "IN_PROGRESS" })

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

  it("trusts the PR's label only when this head's label job put it there (STEP-3314 review)", () => {
    for (const labelJob of ["SKIPPED", "", null]) expect(classRaise(view(["approval/try"], "FAILURE", labelJob), ["approval/auto"]), String(labelJob)).toBeNull()
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
    const deps = { exec, paths, config, now: () => new Date("2026-09-25T11:00:00Z"), log, tracker: t.tracker }
    const watch = (v: OwnPrView) => reviseOwnPr(deps, readWatchedPrs(paths)[0], v, [])
    const posts = () => listNew<{ kind: string; channel?: string; text?: string }>(paths.outbox).map((e) => e.payload).filter((p) => p.kind === "post")
    return { paths, config, pr, t, exec, lines, log, deps, watch, posts }
  }

  it("adds the higher label, removes the lower, re-runs the check and records the head", async () => {
    const { paths, t, lines, watch, posts } = setup()
    await watch(view(["approval/look"]))
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/look"])
    expect(lines()).toContain("gh run rerun 111 --repo STEP-Network/v0-politiske-annoncer")
    expect(readWatchedPrs(paths)[0].classRaised).toBe(HEAD)
    // Said once, in plain words, in #polads-agents, and kept in the ledger.
    expect(posts()).toEqual([
      expect.objectContaining({
        channel: "agents",
        text: "STEP-7: the change in <https://github.com/example/repo/pull/7|PR #7> needs a visual check by a person before release, so I raised STEP-7's approval level to match. Nothing needed from you.",
      }),
    ])
    expect(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")).toContain('"type":"class.raised","issue":"STEP-7","url":"https://github.com/example/repo/pull/7","to":"look"')
  })

  it("says it set the level when the issue had none (STEP-3314 review)", async () => {
    const { t, watch, posts } = setup(["polads"])
    await watch(view(["approval/try"]))
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/try"])
    expect(posts()[0].text).toBe(
      "STEP-7: the change in <https://github.com/example/repo/pull/7|PR #7> needs a hands-on test by a person before release, so I set STEP-7's approval level to match. Nothing needed from you.",
    )
  })

  it("does not act again at the same head", async () => {
    const { paths, config, pr, t, exec, log } = setup()
    await reviseOwnPr({ exec, paths, config, now: () => new Date(), log, tracker: t.tracker }, { ...pr, classRaised: HEAD }, view(["approval/look"]), [])
    expect(t.called("updateIssue")).toEqual([])
  })

  it("raises at a watch where the check went red after it was still running at the same head (STEP-3314 review)", async () => {
    // The reviewer's probe, turned round: a running check had the head marked done, and the red that followed was never acted on.
    const { paths, t, watch } = setup()
    await watch(running([]))
    expect(readWatchedPrs(paths)[0].classRaised).toBeUndefined()
    await watch(view(["approval/look"]))
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/look"])
  })

  it("waits, reading nothing and marking nothing, until the check is there", async () => {
    const { paths, t, watch } = setup()
    await watch({ ...view(["approval/look"]), statusCheckRollup: [] })
    expect(t.called("readIssue")).toEqual([])
    expect(readWatchedPrs(paths)[0].classRaised).toBeUndefined()
    await watch(view(["approval/look"]))
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/look"])
  })

  it("never trusts a PR label this head's label job did not put there, and raises once it has (STEP-3314 review)", async () => {
    // The reviewer's probe, turned round: a stale approval/try from an older head overrode a person's lowering to auto.
    const { paths, t, watch } = setup()
    await watch(view(["approval/try"], "FAILURE", "SKIPPED"))
    await watch(view(["approval/try"], "FAILURE", ""))
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/auto"])
    expect(t.called("readIssue")).toEqual([])
    expect(readWatchedPrs(paths)[0].classRaised).toBeUndefined()
    await watch(view(["approval/look"], "FAILURE", "SUCCESS"))
    expect(t.issues.get("STEP-7")!.labels).toEqual(["polads", "approval/look"])
  })

  it("sends no revise worker for a red Approval class check, even a required one", async () => {
    const { paths, config, pr, t, exec, log } = setup()
    await reviseOwnPr({ exec, paths, config, now: () => new Date(), log, tracker: t.tracker }, pr, view(["approval/look"]), [APPROVAL_CHECK])
    expect(listJobs(paths, "pending")).toEqual([])
  })

  it("tries again at the next watch when Linear refuses", async () => {
    const { paths, config, pr, exec, log } = setup()
    const refusing = fakeTracker([issue({ id: "STEP-7", labels: ["polads", "approval/auto"] })], undefined, ["updateIssue"])
    await reviseOwnPr({ exec, paths, config, now: () => new Date(), log, tracker: refusing.tracker }, pr, view(["approval/look"]), [])
    expect(readWatchedPrs(paths)[0].classRaised).toBeUndefined()
  })

  it("with nothing to raise, re-runs the check once at the head, then asks a person once (STEP-3314 review)", async () => {
    // The issue is already at the PR's class, or higher: the check may have read Linear before the class changed.
    const { paths, t, lines, watch } = setup(["polads", "approval/try"])
    await watch(view(["approval/look"]))
    expect(t.called("updateIssue")).toEqual([])
    expect(lines().filter((l) => l.startsWith("gh run rerun"))).toEqual(["gh run rerun 111 --repo STEP-Network/v0-politiske-annoncer"])
    expect(readWatchedPrs(paths)[0]).toMatchObject({ classRerun: HEAD })
    expect(readWatchedPrs(paths)[0].classRaised).toBeUndefined()
    expect(openDecisions(paths, "STEP-7")).toEqual([])
    // Still red at the same head: one question, the head done, and no second re-run.
    await watch(view(["approval/look"]))
    expect(openDecisions(paths, "STEP-7")).toEqual([
      expect.objectContaining({ issue: "STEP-7", defaultReply: "leave it", defaultAction: { kind: "leave" }, question: expect.stringContaining("still red after I started it again") }),
    ])
    expect(readWatchedPrs(paths)[0].classRaised).toBe(HEAD)
    await watch(view(["approval/look"]))
    expect(lines().filter((l) => l.startsWith("gh run rerun"))).toHaveLength(1)
    expect(openDecisions(paths, "STEP-7")).toHaveLength(1)
  })
})
