import { existsSync, mkdirSync, mkdtempSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew, putOnce } from "../../fsq.ts"
import { moveJob, readWatchedPrs, recordPr, submitJob } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import type { Exec } from "../../worker/git.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import { cleanup, Every, healthStatus, inboxStuck, linearDownNotice, prAttention, refreshCheckout, sentryCheckInUrl, watchPrs } from "../health.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }
const NOW = new Date("2026-09-24T12:00:00.000Z")
const REQUIRED = ["Lint", "TypeScript (no-emit)", "Test", "Vercel – v0-politiske-annoncer", "i18n", "Task trace", "Claude review"]
/** Every git agentd runs: no hook and no fsmonitor, whatever a config under .git says. */
const GIT = "git -c core.hooksPath=/dev/null -c core.fsmonitor=false"
const SHA = "0123456789abcdef0123456789abcdef01234567"

describe("prAttention", () => {
  it("names only the required checks that are red, from check runs and status contexts", () => {
    const view = {
      url: "u", state: "OPEN", headRefOid: "abc1234def",
      statusCheckRollup: [
        { __typename: "CheckRun", name: "Claude review", conclusion: "FAILURE" },
        { __typename: "CheckRun", name: "Lint", conclusion: "SUCCESS" },
        { __typename: "CheckRun", name: "Corridor advisory", conclusion: "FAILURE" },
        { __typename: "StatusContext", context: "Vercel – v0-politiske-annoncer", state: "ERROR" },
        { __typename: "CheckRun", name: "Test", conclusion: null, status: "IN_PROGRESS" },
      ],
    }
    expect(prAttention(view, REQUIRED)).toEqual({ closed: false, failing: ["Claude review", "Vercel – v0-politiske-annoncer"] })
    expect(prAttention({ ...view, state: "MERGED" }, REQUIRED)).toEqual({ closed: true, failing: [] })
  })
})

describe("watchPrs", () => {
  const PR1 = "https://github.com/x/pull/1"
  const PR2 = "https://github.com/x/pull/2"
  const PR3 = "https://github.com/x/pull/3"

  function setup() {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-prs-")))
    const repo = mkdtempSync(join(tmpdir(), "repo-"))
    mkdirSync(join(repo, ".claude"))
    writeFileSync(join(repo, ".claude", "project-config.json"), JSON.stringify({ ci: { requiredChecks: REQUIRED } }))
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: repo }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } })
    return { paths, config }
  }
  const view = (url: string, over: Record<string, unknown> = {}) =>
    JSON.stringify({ url, state: "OPEN", headRefOid: "abc1234def", statusCheckRollup: [{ name: "Claude review", conclusion: "FAILURE" }], autoMergeRequest: { enabledAt: "t" }, ...over })
  const posts = (paths: ReturnType<typeof agentPaths>) => listNew<{ kind: string; issue: string; text: string; question: boolean }>(paths.outbox).map((e) => e.payload)

  it("posts a red check to the issue's thread once per head commit, and forgets merged PRs", async () => {
    const { paths, config } = setup()
    recordPr(paths, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T10:00:00.000Z" })
    recordPr(paths, { issue: "STEP-8", url: PR2, openedAt: "2026-09-24T10:05:00.000Z" })
    const f = fakeExec([[/pull\/1 /, { stdout: view(PR1) }], [/pull\/2 /, { stdout: view(PR2, { state: "MERGED", statusCheckRollup: [] }) }]])
    const deps = { exec: f.exec, paths, config, now: () => NOW, log: quiet }
    await watchPrs(deps)
    await watchPrs(deps)
    expect(posts(paths)).toHaveLength(1)
    expect(posts(paths)[0]).toMatchObject({
      kind: "issue",
      issue: "STEP-7",
      question: false,
      text: "PR https://github.com/x/pull/1: Claude review failed on abc1234. Auto-merge waits until it is green. A person needs to look.",
    })
    expect(readWatchedPrs(paths).map((p) => p.issue)).toEqual(["STEP-7"])
  })

  it("reports again on a new head commit, and says when auto-merge is not armed", async () => {
    const { paths, config } = setup()
    recordPr(paths, { issue: "STEP-7", url: PR1, openedAt: "t" })
    await watchPrs({ exec: fakeExec([[/pull\/1 /, { stdout: view(PR1) }]]).exec, paths, config, now: () => NOW, log: quiet })
    await watchPrs({ exec: fakeExec([[/pull\/1 /, { stdout: view(PR1, { headRefOid: "fedcba98", autoMergeRequest: null }) }]]).exec, paths, config, now: () => NOW, log: quiet })
    expect(posts(paths).map((p) => p.text)).toEqual([
      "PR https://github.com/x/pull/1: Claude review failed on abc1234. Auto-merge waits until it is green. A person needs to look.",
      "PR https://github.com/x/pull/1: Claude review failed on fedcba9. It cannot merge until it is green. A person needs to look.",
    ])
  })

  it("asks gh with the mini's own login: the URL and fields only, never a token", async () => {
    const { paths, config } = setup()
    recordPr(paths, { issue: "STEP-7", url: PR1, openedAt: "t" })
    const f = fakeExec([[/pull\/1 /, { stdout: view(PR1, { statusCheckRollup: [] }) }]])
    await watchPrs({ exec: f.exec, paths, config, now: () => NOW, log: quiet })
    expect(f.lines()).toEqual([`gh pr view ${PR1} --json url,state,headRefOid,statusCheckRollup,autoMergeRequest`])
  })

  it("keeps watching a PR gh could not read, and one bad answer does not stop the others", async () => {
    const { paths, config } = setup()
    recordPr(paths, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T10:00:00.000Z" })
    recordPr(paths, { issue: "STEP-8", url: PR2, openedAt: "2026-09-24T10:05:00.000Z" })
    recordPr(paths, { issue: "STEP-9", url: PR3, openedAt: "2026-09-24T10:10:00.000Z" })
    const f = fakeExec([
      [/pull\/1 /, { code: 1, stderr: "HTTP 502" }],
      [/pull\/2 /, { stdout: "not json" }],
      [/pull\/3 /, { stdout: view(PR3) }],
    ])
    await watchPrs({ exec: f.exec, paths, config, now: () => NOW, log: quiet })
    expect(readWatchedPrs(paths).map((p) => p.issue)).toEqual(["STEP-7", "STEP-8", "STEP-9"])
    expect(posts(paths).map((p) => p.issue)).toEqual(["STEP-9"])
  })

  it("loses no PR the runner records while it works", async () => {
    // C2's note: the runner's recordPr and this watcher both write the watched PRs.
    const { paths, config } = setup()
    recordPr(paths, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T10:00:00.000Z" })
    recordPr(paths, { issue: "STEP-8", url: PR2, openedAt: "2026-09-24T10:05:00.000Z" })
    const exec: Exec = async (_cmd, args) => {
      // The runner, meanwhile, opens a PR for STEP-9.
      if (args.includes(PR1)) recordPr(paths, { issue: "STEP-9", url: PR3, openedAt: "2026-09-24T10:10:00.000Z" })
      return { code: 0, stdout: args.includes(PR2) ? view(PR2, { state: "MERGED" }) : view(PR1), stderr: "" }
    }
    await watchPrs({ exec, paths, config, now: () => NOW, log: quiet })
    expect(readWatchedPrs(paths).map((p) => [p.issue, p.notified ?? null])).toEqual([
      ["STEP-7", "abc1234def:Claude review"],
      ["STEP-9", null],
    ])
  })
})

describe("linearDownNotice", () => {
  it("says so once after 15 minutes, and once when Linear is back", () => {
    let s = { downSince: null as string | null, notified: false }
    let r = linearDownNotice(s, false, new Date("2026-09-24T12:00:00.000Z"))
    expect(r.message).toBeNull()
    r = linearDownNotice(r.state, false, new Date("2026-09-24T12:16:00.000Z"))
    expect(r.message).toMatch(/^Linear has been unreachable for 15 minutes/)
    r = linearDownNotice(r.state, false, new Date("2026-09-24T12:31:00.000Z"))
    expect(r.message).toBeNull()
    r = linearDownNotice(r.state, true, new Date("2026-09-24T12:46:00.000Z"))
    expect(r.message).toBe("Linear is reachable again.")
    s = r.state
    expect(linearDownNotice(s, true, NOW).message).toBeNull()
  })
})

describe("healthStatus and sentryCheckInUrl", () => {
  const fresh = { at: new Date(NOW.getTime() - 30_000).toISOString(), connected: true, outboxFailed: 0 }
  const stale = { ...fresh, at: new Date(NOW.getTime() - 10 * 60_000).toISOString() }
  const ok = { frontDoorAlive: true, lastWakeAt: new Date(NOW.getTime() - 60_000), bridge: fresh, now: NOW, staleTickMinutes: 45 }

  it("is healthy only when the front door runs and wakes, and the bridge is connected and fresh", () => {
    expect(healthStatus(ok)).toEqual({ ok: true, problems: [] })
    expect(healthStatus({ frontDoorAlive: false, lastWakeAt: null, bridge: { ...fresh, connected: false }, now: NOW, staleTickMinutes: 45 }).problems).toEqual([
      "the front door is not running",
      "the Slack bridge is disconnected",
    ])
    expect(healthStatus({ frontDoorAlive: true, lastWakeAt: new Date(NOW.getTime() - 60 * 60_000), bridge: null, now: NOW, staleTickMinutes: 45 }).problems).toEqual([
      "the front door has not woken up for 60 minutes",
      "the Slack bridge has no recent heartbeat",
    ])
  })

  it("calls a running bridge's error a paused outbox, and a silent bridge's error a stop", () => {
    // bridge.json's error is also the outbox pause, written every 30 seconds while the bridge runs (C1).
    expect(healthStatus({ ...ok, bridge: { ...fresh, error: "Slack refused the app: invalid_auth" } }).problems).toEqual([
      "the Slack bridge's outbox is paused: Slack refused the app: invalid_auth",
    ])
    expect(healthStatus({ ...ok, bridge: { ...stale, error: "slack-bridge: #polads-intake does not exist or is private" } }).problems).toEqual([
      "the Slack bridge stopped: slack-bridge: #polads-intake does not exist or is private",
    ])
    expect(healthStatus({ ...ok, bridge: stale }).problems).toEqual(["the Slack bridge has no recent heartbeat"])
  })

  it("reports messages Slack refused for good since the last check, once", () => {
    const grew = { ...ok, bridge: { ...fresh, outboxFailed: 3 }, outboxFailedBefore: 1 }
    expect(healthStatus(grew).problems).toEqual(["Slack refused 2 more messages for good, kept in ~/.agentd/outbox/failed"])
    expect(healthStatus({ ...grew, outboxFailedBefore: 3 }).ok).toBe(true)
    // No earlier reading: what was already there when agentd started is not news.
    expect(healthStatus({ ...grew, outboxFailedBefore: null }).ok).toBe(true)
  })

  it("reports Slack messages that have waited over an hour for Linear", () => {
    expect(healthStatus({ ...ok, stuckInbox: 1 }).problems).toEqual(["1 Slack message has waited over an hour for Linear"])
    expect(healthStatus({ ...ok, stuckInbox: 2 }).problems).toEqual(["2 Slack messages have waited over an hour for Linear"])
  })

  it("sets the status on the monitor's check-in URL", () => {
    expect(sentryCheckInUrl("https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/key/", false)).toBe("https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/key/?status=error")
    expect(sentryCheckInUrl("https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/key/", true)).toBe("https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/key/?status=ok")
  })
})

describe("inboxStuck", () => {
  it("counts the answers and unfiled intakes the bridge has retried for over an hour, and nothing that waits for the front door", () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-inbox-")))
    const old = "2026-09-24T10:30:00.000Z"
    const recent = "2026-09-24T11:30:00.000Z"
    putOnce(paths.inbox, "a", { type: "answer", issue: "STEP-7", receivedAt: old })
    putOnce(paths.inbox, "b", { type: "intake", issue: null, receivedAt: old })
    putOnce(paths.inbox, "c", { type: "answer", issue: "STEP-7", receivedAt: recent })
    putOnce(paths.inbox, "d", { type: "intake", issue: "STEP-9", receivedAt: old })
    putOnce(paths.inbox, "e", { type: "mention", receivedAt: old })
    expect(inboxStuck(paths, NOW)).toBe(2)
  })
})

describe("refreshCheckout", () => {
  it("leaves a checkout with local changes alone", async () => {
    const dirty = fakeExec([[/status --porcelain/, { stdout: " M lib/x.ts\n" }]])
    expect(await refreshCheckout(dirty.exec, "/r", "staging")).toBe("left alone: the checkout has local changes")
    expect(dirty.lines()).toEqual([`${GIT} -C /r status --porcelain --ignore-submodules=all`])
  })

  it("checks out the commit origin itself names for the base, never a ref under .git a worker could have moved", async () => {
    const clean = fakeExec([[/ls-remote/, { stdout: `${SHA}\trefs/heads/staging\n` }]])
    expect(await refreshCheckout(clean.exec, "/r", "staging")).toBe("up to date at 0123456")
    expect(clean.lines()).toEqual([
      `${GIT} -C /r status --porcelain --ignore-submodules=all`,
      `${GIT} -C /r ls-remote --exit-code origin refs/heads/staging`,
      `${GIT} -C /r fetch origin staging --prune`,
      `${GIT} -C /r checkout --detach ${SHA}`,
    ])
  })

  it("moves nothing when origin cannot be asked, or names no commit", async () => {
    const down = fakeExec([[/ls-remote/, { code: 128, stderr: "fatal: unable to access\n" }]])
    expect(await refreshCheckout(down.exec, "/r", "staging")).toBe("ls-remote failed: fatal: unable to access")
    const odd = fakeExec([[/ls-remote/, { stdout: "nonsense\n" }]])
    expect(await refreshCheckout(odd.exec, "/r", "staging")).toBe("origin named no commit for staging")
    expect([...down.lines(), ...odd.lines()].some((l) => l.includes("checkout --detach"))).toBe(false)
  })
})

describe("cleanup", () => {
  it("deletes handled queue entries after 14 days and old worker logs, and leaves a running job's worktree", async () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-clean-")))
    const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } })
    const old = new Date(NOW.getTime() - 20 * 86_400_000)
    const older = new Date(NOW.getTime() - 40 * 86_400_000)
    mkdirSync(join(paths.inbox, "done"), { recursive: true })
    writeFileSync(join(paths.inbox, "done", "old.json"), "{}")
    utimesSync(join(paths.inbox, "done", "old.json"), old, old)
    writeFileSync(join(paths.inbox, "done", "new.json"), "{}")
    mkdirSync(paths.logs, { recursive: true })
    writeFileSync(join(paths.logs, "worker-STEP-1-20260801000000.log"), "x")
    utimesSync(join(paths.logs, "worker-STEP-1-20260801000000.log"), older, older)
    writeFileSync(join(paths.logs, "agentd.log"), "x")
    utimesSync(join(paths.logs, "agentd.log"), older, older)
    mkdirSync(join(paths.worktrees, "STEP-1-x"), { recursive: true })
    utimesSync(join(paths.worktrees, "STEP-1-x"), old, old)
    const job = submitJob(paths, "STEP-2", null, NOW)
    moveJob(paths, job.id, "pending", "running", { pid: 4242 })
    mkdirSync(join(paths.worktrees, "STEP-2-y"), { recursive: true })
    utimesSync(join(paths.worktrees, "STEP-2-y"), old, old)
    const f = fakeExec()
    await cleanup({ paths, config, exec: f.exec, now: () => NOW })
    expect(existsSync(join(paths.inbox, "done", "old.json"))).toBe(false)
    expect(existsSync(join(paths.inbox, "done", "new.json"))).toBe(true)
    expect(existsSync(join(paths.logs, "worker-STEP-1-20260801000000.log"))).toBe(false)
    // A process's own log is rotated by size, never deleted.
    expect(existsSync(join(paths.logs, "agentd.log"))).toBe(true)
    expect(f.lines()).toEqual([`${GIT} -C /r worktree remove --force ${join(paths.worktrees, "STEP-1-x")}`, `${GIT} -C /r worktree prune`])
  })
})

describe("Every", () => {
  it("is due the first time and again only after the interval", () => {
    let t = 0
    const every = new Every(() => t)
    expect(every.due("x", 1000)).toBe(true)
    t = 999
    expect(every.due("x", 1000)).toBe(false)
    t = 1000
    expect(every.due("x", 1000)).toBe(true)
  })
})
