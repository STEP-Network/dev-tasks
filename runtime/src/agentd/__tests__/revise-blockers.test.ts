/**
 * Past the round cap while the review still has blockers (Nate, 2026-09-26:
 * "can we make it so that ALL blockers get resolved even exceeding the
 * cap?"): another round while the blockers change, and a person asked when
 * they do not, at 10 rounds, or while usage is high. IMPROVEMENT and POLISH
 * alone never go past the cap. Made-up PRs and files.
 */
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { listJobs, readWatchedPrs, recordPr, type WatchedPr } from "../../jobs.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { openDecisions } from "../decisions.ts"
import { usagePath } from "../../usage.ts"
import { roundLabel } from "../../worker/revise.ts"
import { blockerFingerprint, MAX_REVISE_ROUNDS, MAX_TOTAL_REVISE_ROUNDS, planRevision, reviewBlockers, reviseOwnPr, sameBlockers, type OwnPrView } from "../revise.ts"

const URL = "https://github.com/example/repo/pull/9"
const LAST_ROUND = "2026-09-26T03:00:00.000Z"
const pr: WatchedPr = { issue: "STEP-9", url: URL, openedAt: "2026-09-25T10:00:00.000Z" }
const REVIEW_CHECK = { __typename: "CheckRun", name: "Claude review", conclusion: "FAILURE", detailsUrl: "https://github.com/example/repo/actions/runs/111/job/222" }
const ctx = { mini: "eve", required: ["Claude review", "Test"], infra: {} }
const claude = (id: string, createdAt: string, body: string) => ({ id, author: { login: "claude" }, authorAssociation: "NONE", body, createdAt })

/** The two ways the review writes a BLOCKER, as on real PRs, each with an IMPROVEMENT after it that names a file too. */
const BLOCKER_A = "## Claude review\n\n### BLOCKER\n\n**`lib/services/partner.ts:70`** — the country rule is skipped.\n\nMore words.\n\n### IMPROVEMENT\n\n1. **`lib/services/booking.ts:12`** — duplicated logic."
const BLOCKER_A_MOVED = "## Claude review\n\n**BLOCKER**\n\n- `lib/services/partner.ts:69` (`checkPartner`) — the country rule is still skipped.\n\n**IMPROVEMENT**\n\n- `lib/services/booking.ts:12` — duplicated logic."
const BLOCKER_B = "## Claude review — STEP-9\n\n### BLOCKER\n\n**`lib/ai/messages.ts:146-163` — the store id is not pinned.**\n\n```ts\nreturn host.endsWith(x)\n```"
const IMPROVEMENTS_ONLY = "## Claude review\n\n**No BLOCKERs found.**\n\n### IMPROVEMENT\n\n1. **`docs/security.md`, new line** — names a file that does not exist.\n\n### POLISH\n\n- `app/api/chat/route.ts:40` — guard order."

const view = (over: Partial<OwnPrView> = {}): OwnPrView => ({
  url: URL, number: 9, state: "OPEN", headRefName: "STEP-9-x", headRefOid: "h4", author: { login: "eve-polads" }, statusCheckRollup: [REVIEW_CHECK], ...over,
})
/** At the cap: three rounds, the last sent for these blockers, after any earlier rounds' blockers. */
const capped = (blockers: string[] | undefined, rounds = MAX_REVISE_ROUNDS, earlier: string[][] = []): WatchedPr => ({
  ...pr,
  revise: { rounds, handled: [], lastRoundAt: LAST_ROUND, ...(blockers ? { blockerHistory: [...earlier, blockers] } : {}) },
})

afterEach(() => {
  delete process.env.AGENTD_HOME
})

describe("reviewBlockers: the latest Claude review's BLOCKER findings", () => {
  it("reads each BLOCKER by its file and first line, in either form, and never an IMPROVEMENT's or POLISH's", () => {
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", BLOCKER_A)] }), LAST_ROUND)).toEqual(["lib/services/partner.ts:70"])
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", BLOCKER_A_MOVED)] }), LAST_ROUND)).toEqual(["lib/services/partner.ts:69"])
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", BLOCKER_B)] }), LAST_ROUND)).toEqual(["lib/ai/messages.ts:146"])
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", IMPROVEMENTS_ONLY)] }), LAST_ROUND)).toEqual([])
  })

  it("reads past a code block that looks like a heading, and stops at a plain IMPROVEMENT / POLISH line", () => {
    const body = [
      "## Claude review", "", "### BLOCKER", "", "**`lib/a.ts:10`** — first.", "", "```sh", "# not a heading", "- `lib/code.ts:1` in a block", "```", "",
      "- `lib/b.ts:20` — second.", "", "**Suggested fix**: reuse the helper.", "", "IMPROVEMENT / POLISH (advice only, does not block this check):", "- **POLISH** — `lib/c.ts:30` wording.",
    ].join("\n")
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", body)] }), LAST_ROUND)).toEqual(["lib/a.ts:10", "lib/b.ts:20"])
  })

  it("reads a BLOCKER that names no file by its first words", () => {
    const body = "## Claude review\n\n### BLOCKER\n\n- The migration drops a column the release still reads.\n\n### POLISH\n\n- wording"
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", body)] }), LAST_ROUND)).toEqual(["text:the migration drops a column the release still reads."])
    // Beside a finding that names a file, it still counts; a bold label ("**Why**:") inside a finding is not one.
    const both = "## Claude review\n\n### BLOCKER\n\n- `lib/a.ts:10` — first.\n\n**Why**: it breaks the build.\n\n- The migration drops a column the release still reads.\n\n### POLISH\n\n- wording"
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", both)] }), LAST_ROUND)).toEqual(["lib/a.ts:10", "text:the migration drops a column the release still reads."])
  })

  it("reads only the latest review since the last round, and only the reviewer's", () => {
    const comments = [
      claude("c1", "2026-09-26T02:00:00Z", BLOCKER_B),
      claude("c2", "2026-09-26T04:00:00Z", BLOCKER_A),
      // A person quoting a review is not one.
      { id: "c3", author: { login: "ada" }, authorAssociation: "MEMBER", body: BLOCKER_B, createdAt: "2026-09-26T05:00:00Z" },
    ]
    expect(reviewBlockers(view({ comments }), LAST_ROUND)).toEqual(["lib/services/partner.ts:70"])
    // Two since the last round (a re-run), listed out of order: the later one.
    const twice = [claude("c5", "2026-09-26T05:00:00Z", BLOCKER_A), claude("c4", "2026-09-26T04:00:00Z", BLOCKER_B)]
    expect(reviewBlockers(view({ comments: twice }), LAST_ROUND)).toEqual(["lib/services/partner.ts:70"])
    // Before the last round, it is the previous head's verdict: none for this head yet.
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T02:00:00Z", BLOCKER_B)] }), LAST_ROUND)).toBeNull()
    expect(reviewBlockers(view({ comments: [claude("c1", "2026-09-26T02:00:00Z", BLOCKER_B)] }), null)).toEqual(["lib/ai/messages.ts:146"])
  })
})

describe("blockerFingerprint and sameBlockers", () => {
  it("is the review's blockers and each other check the code failed; never the review's own check, verdict or not", () => {
    const failing = view({ statusCheckRollup: [REVIEW_CHECK, { __typename: "CheckRun", name: "Test", conclusion: "FAILURE" }], comments: [claude("c1", "2026-09-26T04:00:00Z", BLOCKER_A)] })
    expect(blockerFingerprint(failing, ["Claude review", "Test"], LAST_ROUND)).toEqual(["lib/services/partner.ts:70", "check:Test"])
    // Red with no verdict says nothing about what blocks: planRevision asks about it past the cap.
    expect(blockerFingerprint(view(), ["Claude review"], LAST_ROUND)).toEqual([])
    expect(blockerFingerprint(view({ comments: [claude("c1", "2026-09-26T04:00:00Z", IMPROVEMENTS_ONLY)] }), [], LAST_ROUND)).toEqual([])
    // Shards are one check: which shard failed moves between runs.
    expect(blockerFingerprint(view(), ["Test (1/4)", "Test (3/4)"], LAST_ROUND)).toEqual(["check:Test"])
  })

  it("counts a blocker whose line moved a little as the same one, and another line or file as another", () => {
    expect(sameBlockers(["lib/services/partner.ts:70"], ["lib/services/partner.ts:69"])).toBe(true)
    expect(sameBlockers(["lib/services/partner.ts:70", "check:Test"], ["check:Test", "lib/services/partner.ts:84"])).toBe(true)
    expect(sameBlockers(["lib/services/partner.ts:70"], ["lib/services/partner.ts:120"])).toBe(false)
    expect(sameBlockers(["lib/services/partner.ts:70"], ["lib/services/other.ts:70"])).toBe(false)
    expect(sameBlockers(["lib/services/partner.ts:70"], ["lib/services/partner.ts:70", "check:Test"])).toBe(false)
    expect(sameBlockers(["check:Test"], ["check:Lint"])).toBe(false)
    expect(sameBlockers(["check:Test"], ["check:Test", "lib/a.ts:1"])).toBe(false)
    expect(sameBlockers([], [])).toBe(false)
    // One to one: two blockers near one line are not the same as that one and another.
    expect(sameBlockers(["lib/a.ts:70", "lib/a.ts:72"], ["lib/a.ts:71", "lib/b.ts:1"])).toBe(false)
    // Paired by line within each file, in order: 60↔70 and 80↔90, not 70↔80 then 90↔60.
    expect(sameBlockers(["lib/a.ts:70", "lib/a.ts:90"], ["lib/a.ts:80", "lib/a.ts:60"])).toBe(true)
    expect(sameBlockers(["text:the migration drops a column", "lib/a.ts:70"], ["lib/a.ts:71", "text:the migration drops a column"])).toBe(true)
  })
})

describe("planRevision past the round cap (Nate, 2026-09-26)", () => {
  const withReview = (body: string) => view({ comments: [claude("c9", "2026-09-26T04:00:00Z", body)] })

  it("sends another round while the review still has blockers and the last round changed them", () => {
    expect(planRevision(withReview(BLOCKER_A), capped(["lib/ai/messages.ts:146"]), ctx)).toEqual({
      kind: "revise", handled: ["check:h4:Claude review"], reasons: ["Claude review failed"], blockers: ["lib/services/partner.ts:70"],
    })
    // An older record, from before blockers were kept: the first round past the cap goes.
    expect(planRevision(withReview(BLOCKER_A), capped(undefined as unknown as string[]), ctx)).toMatchObject({ kind: "revise" })
  })

  it("asks when the same blockers came back: the last round made no progress", () => {
    expect(planRevision(withReview(BLOCKER_A_MOVED), capped(["lib/services/partner.ts:70"]), ctx)).toEqual({
      kind: "ask", handled: ["check:h4:Claude review"], reasons: ["Claude review failed"], why: "no-progress",
    })
  })

  it("asks when blockers an earlier round had come back, so A, B, A never runs on to the 10-round guard", () => {
    // Round 2 was sent for partner.ts:70, round 3 for messages.ts:146, and partner.ts:69 is back.
    expect(planRevision(withReview(BLOCKER_A_MOVED), capped(["lib/ai/messages.ts:146"], 3, [["lib/services/partner.ts:70"]]), ctx)).toMatchObject({ kind: "ask", why: "no-progress" })
  })

  it("asks when the review check is red with no verdict (missing, not posted yet, or the no-verdict failure): only real findings and other checks go past the cap", () => {
    const noVerdict = view({ comments: [] })
    expect(planRevision(noVerdict, capped(["lib/services/partner.ts:70"]), ctx)).toEqual({
      kind: "ask", handled: ["check:h4:Claude review"], reasons: ["Claude review failed"], why: "no-verdict",
    })
    // Another check the code failed still counts, as it changed: Test is red now, and the review has no verdict yet.
    const testToo = view({ comments: [], statusCheckRollup: [REVIEW_CHECK, { __typename: "CheckRun", name: "Test", conclusion: "FAILURE" }] })
    expect(planRevision(testToo, capped(["lib/services/partner.ts:70"]), ctx)).toMatchObject({ kind: "revise", blockers: ["check:Test"] })
  })

  it("never goes past the cap for IMPROVEMENT and POLISH findings alone", () => {
    const passing = view({ statusCheckRollup: [], comments: [claude("c9", "2026-09-26T04:00:00Z", IMPROVEMENTS_ONLY), { id: "c10", author: { login: "ada" }, authorAssociation: "MEMBER", body: "@eve please take the improvements too", createdAt: "2026-09-26T04:05:00Z" }] })
    expect(planRevision(passing, capped(["lib/ai/messages.ts:146"]), ctx)).toMatchObject({ kind: "ask", why: "cap" })
    // A person's comment with no review at all, and its check not red: the cap, not "no verdict".
    const commentOnly = view({ statusCheckRollup: [], comments: [{ id: "c11", author: { login: "ada" }, authorAssociation: "MEMBER", body: "@eve one more thing", createdAt: "2026-09-26T04:05:00Z" }] })
    expect(planRevision(commentOnly, capped(["lib/ai/messages.ts:146"]), ctx)).toMatchObject({ kind: "ask", why: "cap" })
  })

  it("stops at 10 rounds whatever the blockers do, and while usage is high", () => {
    expect(MAX_TOTAL_REVISE_ROUNDS).toBe(10)
    expect(planRevision(withReview(BLOCKER_A), capped(["lib/ai/messages.ts:146"], 9), ctx)).toMatchObject({ kind: "revise" })
    expect(planRevision(withReview(BLOCKER_A), capped(["lib/ai/messages.ts:146"], 10), ctx)).toMatchObject({ kind: "ask", why: "runaway" })
    expect(planRevision(withReview(BLOCKER_A), capped(["lib/ai/messages.ts:146"]), { ...ctx, usageBlocked: "weekly usage at 85 percent (light mode)" })).toMatchObject({ kind: "ask", why: "usage" })
  })

  it("never takes the last head's verdict for this one's: this head's red review check with no verdict since asks", () => {
    // The review the last round was sent for, from before it; this head's check failed with no verdict posted.
    const stale = view({ comments: [claude("c8", "2026-09-26T02:00:00Z", BLOCKER_A)] })
    expect(planRevision(stale, capped(["lib/services/partner.ts:70"]), ctx)).toMatchObject({ kind: "ask", why: "no-verdict" })
  })

  it("keeps each round's blockers under the cap too, so the round past it can compare", () => {
    expect(planRevision(withReview(BLOCKER_B), { ...pr, revise: { rounds: 1, handled: [], lastRoundAt: LAST_ROUND } }, ctx)).toEqual({
      kind: "revise", handled: ["check:h4:Claude review"], reasons: ["Claude review failed"], blockers: ["lib/ai/messages.ts:146"],
    })
  })

  it("asks once per head, as before", () => {
    const asked = { ...capped(["lib/services/partner.ts:70"]), revise: { ...capped(["lib/services/partner.ts:70"]).revise!, asked: true, askedHead: "h4" } }
    expect(planRevision(withReview(BLOCKER_A_MOVED), asked, ctx)).toEqual({ kind: "none" })
  })
})

describe("reviseOwnPr past the round cap", () => {
  function setup(record: WatchedPr) {
    process.env.AGENTD_HOME = mkdtempSync(join(tmpdir(), "agentd-past-cap-"))
    const paths = agentPaths()
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/repo", slug: "example/repo" }, pluginRoot: "/plugin", slack: { allowedUsers: ["U0EXAMPLE"] } })
    recordPr(paths, record)
    // The failed review check's log reads as the code's, not the infrastructure's.
    const exec = fakeExec([[/^gh run view/, { stdout: "BLOCKER found" }]]).exec
    const deps = { exec, paths, config, now: () => new Date("2026-09-26T05:00:00Z"), log: { info: () => {}, warn: () => {}, error: () => {} }, tracker: fakeTracker([issue({ id: "STEP-9" })]).tracker }
    return { paths, deps }
  }

  it("sends round 4 with its blockers on the record, says why in the ledger and in Slack", async () => {
    const { paths, deps } = setup(capped(["lib/ai/messages.ts:146"]))
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], view({ comments: [claude("c9", "2026-09-26T04:00:00Z", BLOCKER_A)] }), ["Claude review"])
    expect(listJobs(paths, "pending")[0]).toMatchObject({ kind: "revise", revise: { round: 4 } })
    expect(readWatchedPrs(paths)[0].revise).toMatchObject({ rounds: 4, blockerHistory: [["lib/ai/messages.ts:146"], ["lib/services/partner.ts:70"]] })
    const ledger = readFileSync(join(paths.logs, "ledger.jsonl"), "utf8")
    expect(ledger).toContain('"pastCap":"blockers changed: 1 left"')
    expect(listNew<{ text: string }>(paths.outbox).map((e) => e.payload.text)).toEqual([
      `STEP-9: I am fixing the review comments on <${URL}|PR #9> (Claude review failed), try 4, past my usual 3: 1 blocker is still open, and the last round changed them. Nothing needed from you.`,
    ])
  })

  it("asks a person when the last round did not change the blockers", async () => {
    const { paths, deps } = setup(capped(["lib/services/partner.ts:70"]))
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], view({ comments: [claude("c9", "2026-09-26T04:00:00Z", BLOCKER_A_MOVED)] }), ["Claude review"])
    expect(listJobs(paths, "pending")).toEqual([])
    expect(JSON.stringify(openDecisions(paths))).toContain("has the same blockers as after an earlier round, and I have worked on it 3 times: my rounds are not making progress")
    expect(readWatchedPrs(paths)[0].revise).toMatchObject({ asked: true, askedHead: "h4" })
  })

  it("names the 10-round limit when it stops there", async () => {
    const { paths, deps } = setup(capped(["lib/ai/messages.ts:146"], 10))
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], view({ comments: [claude("c9", "2026-09-26T04:00:00Z", BLOCKER_A)] }), ["Claude review"])
    expect(JSON.stringify(openDecisions(paths))).toContain("has had 10 rounds and still has blockers: I stop at 10 rounds by myself")
  })

  it("asks when the review check is red with no verdict, and says so", async () => {
    const { paths, deps } = setup(capped(["lib/services/partner.ts:70"]))
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], view({ comments: [] }), ["Claude review"])
    expect(listJobs(paths, "pending")).toEqual([])
    expect(JSON.stringify(openDecisions(paths))).toContain("the review posted no verdict, so I cannot tell what still blocks it")
  })

  it("asks instead of going on while usage is high, and names it", async () => {
    const { paths, deps } = setup(capped(["lib/ai/messages.ts:146"]))
    const resets = Date.parse("2026-09-28T00:00:00Z") / 1000
    mkdirSync(paths.state, { recursive: true })
    writeFileSync(usagePath(paths), JSON.stringify({ at: "2026-09-26T04:59:00Z", fiveHourPct: 10, fiveHourResetsAt: resets, sevenDayPct: 85, sevenDayResetsAt: resets }))
    await reviseOwnPr(deps, readWatchedPrs(paths)[0], view({ comments: [claude("c9", "2026-09-26T04:00:00Z", BLOCKER_A)] }), ["Claude review"])
    expect(listJobs(paths, "pending")).toEqual([])
    expect(JSON.stringify(openDecisions(paths))).toContain("usage is too high for me to go on by myself: weekly usage at 85 percent (light mode)")
  })
})

describe("the worker's round label", () => {
  it("says a round past the cap is past it", () => {
    expect(roundLabel({ url: URL, number: 9, branch: "b", round: 2, since: "t", reasons: ["Test failed"] })).toBe("round 2 of 3")
    expect(roundLabel({ url: URL, number: 9, branch: "b", round: 4, since: "t", reasons: ["Test failed"] })).toBe("round 4, past the usual 3 while blockers remain")
    expect(roundLabel({ url: URL, number: 9, branch: "b", round: 4, since: "t", reasons: ["asked by ada"], instruction: "fix it" })).toBe("round 4, past the usual 3, as a person asked")
  })
})
