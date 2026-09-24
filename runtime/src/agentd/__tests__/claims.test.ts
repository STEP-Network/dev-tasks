import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { listNew } from "../../fsq.ts"
import { moveJob, submitJob } from "../../jobs.ts"
import type { Logger } from "../../log.ts"
import type { ClaimRecord } from "../../tracker.ts"
import { EVE, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { heartbeatAndSweep, sweepDecision } from "../claims.ts"

const NOW = new Date("2026-09-24T12:00:00.000Z")
const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } })
const claim = (id: string, heartbeatAt: string): ClaimRecord => ({
  issue: issue({ id, state: "In Progress", assigneeId: EVE.id }),
  claimant: "eve",
  commentId: `c-${id}`,
  claimedAt: "2026-09-24T01:00:00.000Z",
  heartbeatAt,
})

function setup(claims: ClaimRecord[]) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-claims-")))
  const fake = fakeTracker(claims.map((c) => c.issue))
  fake.tracker.listClaims = async () => claims
  const warnings: string[] = []
  const log: Logger = { info() {}, warn: (msg) => void warnings.push(msg), error() {} }
  return { paths, fake, warnings, deps: { tracker: fake.tracker, paths, config, now: () => NOW, liveness: () => "ours" as const, log } }
}

const runningJob = (paths: ReturnType<typeof agentPaths>, issueId: string) => {
  const job = submitJob(paths, issueId, null, NOW)
  moveJob(paths, job.id, "pending", "running", { pid: 4242 })
  return job
}

describe("sweepDecision", () => {
  it("refreshes a claim a live local job holds and never releases it, however old its heartbeat", () => {
    expect(sweepDecision({ claims: [claim("STEP-1", "2026-09-23T00:00:00.000Z")], runningIssues: new Set(["STEP-1"]), now: NOW, ttlHours: 6 })).toEqual({ refresh: ["STEP-1"], release: [] })
  })

  it("releases a claim with no local job only once its heartbeat is older than the TTL", () => {
    const d = sweepDecision({
      claims: [claim("STEP-2", "2026-09-24T06:01:00.000Z"), claim("STEP-3", "2026-09-24T05:30:00.000Z")],
      runningIssues: new Set(),
      now: NOW,
      ttlHours: 6,
    })
    expect(d).toEqual({ refresh: [], release: [{ issue: "STEP-3", reason: "claim by eve has had no heartbeat for 6 hours" }] })
  })
})

describe("heartbeatAndSweep", () => {
  it("touches the running job's claim, releases the stale one, and says so in #polads-agents", async () => {
    const { paths, fake, deps } = setup([claim("STEP-1", "2026-09-24T11:50:00.000Z"), claim("STEP-3", "2026-09-24T01:00:00.000Z")])
    runningJob(paths, "STEP-1")
    expect(await heartbeatAndSweep(deps)).toEqual({ refreshed: 1, released: 1 })
    expect(fake.called("touchClaim")).toEqual([["STEP-1", "eve"]])
    expect(fake.called("releaseIssue")[0][0]).toBe("STEP-3")
    expect(listNew<{ text: string }>(paths.outbox)[0].payload.text).toBe("released STEP-3: claim by eve has had no heartbeat for 11 hours")
  })

  it("asks about each running job by its pid and id, and a dead one protects nothing", async () => {
    const { paths, fake, deps } = setup([claim("STEP-1", "2026-09-24T01:00:00.000Z")])
    const job = runningJob(paths, "STEP-1")
    const asked: Array<[number, string]> = []
    const result = await heartbeatAndSweep({
      ...deps,
      liveness: (pid, jobId) => {
        asked.push([pid, jobId])
        return "gone"
      },
    })
    expect(asked).toEqual([[4242, job.id]])
    expect(result).toEqual({ refreshed: 0, released: 1 })
    expect(fake.called("touchClaim")).toEqual([])
  })

  it("keeps the claim of a worker ps cannot vouch for: refreshed, never released", async () => {
    const { paths, fake, deps } = setup([claim("STEP-1", "2026-09-24T01:00:00.000Z")])
    runningJob(paths, "STEP-1")
    expect(await heartbeatAndSweep({ ...deps, liveness: () => "unknown" })).toEqual({ refreshed: 1, released: 0 })
    expect(fake.called("releaseIssue")).toEqual([])
  })

  it("counts a heartbeat only when the claim comment was there to refresh, and says when it was not", async () => {
    const { paths, fake, warnings, deps } = setup([claim("STEP-1", "2026-09-24T01:00:00.000Z")])
    runningJob(paths, "STEP-1")
    fake.tracker.touchClaim = async () => false
    expect(await heartbeatAndSweep(deps)).toEqual({ refreshed: 0, released: 0 })
    expect(warnings).toEqual(["no claim comment by this mini to refresh"])
  })

  it("lets a failed Linear call through, releasing nothing it could not read", async () => {
    const { deps } = setup([])
    deps.tracker.listClaims = async () => {
      throw new Error("Linear: 503 (fake)")
    }
    await expect(heartbeatAndSweep(deps)).rejects.toThrow(/503/)
  })
})
