import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../config.ts"
import { listNew } from "../fsq.ts"
import { forgetWatchedPr, listJobs, moveJob, readWatchedPrs, recordPr, submitJob, updateJob, updateWatchedPr } from "../jobs.ts"
import { enqueueSlack, type OutboxMessage } from "../outbox.ts"
import { issueForThread, saveThread, threadFor } from "../threads.ts"

const paths = () => agentPaths(mkdtempSync(join(tmpdir(), "agentd-stores-")))

describe("the outbox", () => {
  it("drains in the order messages were queued, even within one millisecond", () => {
    const p = paths()
    const at = new Date("2026-09-24T08:00:00.000Z")
    for (const text of ["first", "second", "third", "fourth"]) enqueueSlack(p, { kind: "post", channel: "agents", text }, at)
    enqueueSlack(p, { kind: "post", channel: "agents", text: "later" }, new Date("2026-09-24T08:00:01.000Z"))
    expect(listNew<OutboxMessage & { text: string }>(p.outbox).map((e) => e.payload.text)).toEqual(["first", "second", "third", "fourth", "later"])
  })

  it("never writes a token-shaped string to the queue", () => {
    // Worker and git error text reach the outbox; the files sit on disk until agentd cleans them.
    const p = paths()
    enqueueSlack(p, { kind: "post", channel: "agents", text: "push failed: https://x-access-token:xoxb-1-2-abc@github.com" })
    const [entry] = listNew<{ text: string }>(p.outbox)
    expect(entry.payload.text).toBe("push failed: https://x-access-token:[redacted]@github.com")
  })
})

describe("threads", () => {
  it("store one thread per issue and find the issue from a thread", () => {
    const p = paths()
    saveThread(p, { issue: "STEP-7", channelId: "C9", ts: "1727.5", permalink: null, createdAt: "2026-09-24T08:00:00.000Z", lastQuestionAt: null })
    expect(threadFor(p, "STEP-7")?.ts).toBe("1727.5")
    expect(issueForThread(p, "C9", "1727.5")).toBe("STEP-7")
    expect(issueForThread(p, "C9", "1727.6")).toBeNull()
    expect(threadFor(p, "STEP-8")).toBeNull()
  })
})

describe("jobs", () => {
  it("refuses a second active job for the same issue", () => {
    const p = paths()
    const job = submitJob(p, "STEP-7", null, new Date("2026-09-24T08:00:00.000Z"))
    expect(job.id).toBe("STEP-7-20260924080000")
    expect(() => submitJob(p, "STEP-7", null, new Date("2026-09-24T08:01:00.000Z"))).toThrow(/already pending/)
  })

  it("move between states, merge patches, and list oldest first", () => {
    const p = paths()
    const a = submitJob(p, "STEP-1", null, new Date("2026-09-24T08:00:00.000Z"))
    submitJob(p, "STEP-2", "opus", new Date("2026-09-24T07:00:00.000Z"))
    expect(listJobs(p, "pending").map((j) => j.issue)).toEqual(["STEP-2", "STEP-1"])
    expect(moveJob(p, a.id, "pending", "running", { startedAt: "2026-09-24T08:05:00.000Z" })).toBe(true)
    expect(moveJob(p, a.id, "pending", "running")).toBe(false)
    updateJob(p, "running", a.id, { pid: 4242 })
    expect(listJobs(p, "running")[0]).toMatchObject({ issue: "STEP-1", pid: 4242, startedAt: "2026-09-24T08:05:00.000Z" })
  })
})

describe("watched PRs", () => {
  const PR1 = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1"
  const PR2 = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/2"

  it("keep one record per PR, oldest first, and a second record of a PR changes nothing", () => {
    const p = paths()
    recordPr(p, { issue: "STEP-8", url: PR2, openedAt: "2026-09-24T09:00:00.000Z" })
    recordPr(p, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T08:00:00.000Z" })
    updateWatchedPr(p, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T08:00:00.000Z", notified: "abc:Lint" })
    // A resumed job reuses the open PR and records it again: what the watcher noted stays.
    recordPr(p, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T10:00:00.000Z" })
    expect(readWatchedPrs(p)).toEqual([
      { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T08:00:00.000Z", notified: "abc:Lint" },
      { issue: "STEP-8", url: PR2, openedAt: "2026-09-24T09:00:00.000Z" },
    ])
  })

  it("forget a PR for good: a late update does not bring it back", () => {
    const p = paths()
    recordPr(p, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T08:00:00.000Z" })
    forgetWatchedPr(p, PR1)
    updateWatchedPr(p, { issue: "STEP-7", url: PR1, openedAt: "2026-09-24T08:00:00.000Z", notified: "abc:Lint" })
    expect(readWatchedPrs(p)).toEqual([])
  })
})
