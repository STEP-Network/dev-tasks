import { describe, expect, it } from "vitest"
import { fakeExec } from "../../__tests__/fakes.ts"
import { selectPreview, waitForPreview, type DeploymentWithStatuses } from "../preview.ts"

const SHA = "b".repeat(40)
const ENV = "Preview – example"
const HOST = /^app-[a-z0-9-]+\.vercel\.app$/
const dep = (id: number, state: string, url: string, creator = "vercel[bot]", at = "2026-09-25T10:00:00Z"): DeploymentWithStatuses => ({
  id,
  sha: SHA,
  environment: ENV,
  created_at: at,
  statuses: [{ state, environment_url: url, created_at: at, creator: { login: creator } }],
})

describe("selectPreview", () => {
  it("takes Vercel's success on this project's preview host", () => {
    expect(selectPreview([dep(1, "success", "https://app-x1.vercel.app")], SHA, ENV, HOST)).toEqual({ state: "ready", origin: "https://app-x1.vercel.app" })
  })

  it("ignores a success posted by anyone but vercel[bot], and refuses a foreign host", () => {
    expect(selectPreview([dep(1, "success", "https://app-x1.vercel.app", "someone")], SHA, ENV, HOST)).toEqual({ state: "pending" })
    expect(selectPreview([dep(1, "success", "https://evil.example")], SHA, ENV, HOST)).toMatchObject({ state: "failed" })
  })

  it("reports a failed newest deployment", () => {
    expect(selectPreview([dep(1, "failure", "")], SHA, ENV, HOST)).toMatchObject({ state: "failed" })
  })
})

describe("waitForPreview", () => {
  it("gives up after its minutes on a clock that moves with each wait", async () => {
    let t = Date.parse("2026-09-25T10:00:00Z")
    const { exec } = fakeExec([[/deployments\?sha=/, { stdout: "[]" }]])
    const found = await waitForPreview({ exec, slug: "example/repo", sha: SHA, environment: ENV, hostRe: HOST, minutes: 2, now: () => new Date(t), sleep: async (ms) => void (t += ms), pollMs: 30_000 })
    expect(found).toEqual({ state: "timeout" })
  })

  it("refuses a sha that is not 40 hex characters", async () => {
    const { exec, lines } = fakeExec()
    const found = await waitForPreview({ exec, slug: "example/repo", sha: "HEAD;rm", environment: ENV, hostRe: HOST, minutes: 1, now: () => new Date(), sleep: async () => {} })
    expect(found).toMatchObject({ state: "failed" })
    expect(lines()).toEqual([])
  })
})
