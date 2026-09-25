import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { PNG } from "pngjs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import { fakeExec, fakeTracker, issue } from "../../__tests__/fakes.ts"
import { readUserTestState } from "../state.ts"
import { runUserTest, type UserTestDeps } from "../run.ts"

const HEAD = "e".repeat(40)
// A real PNG, as take_screenshot saves one.
const PNG_FILE = join(mkdtempSync(join(tmpdir(), "ut-png-")), "p.png")
writeFileSync(PNG_FILE, PNG.sync.write(new PNG({ width: 4, height: 4 })))
const PR = "https://github.com/example/repo/pull/7"

function deps(over: Partial<UserTestDeps> = {}, usertest: Record<string, unknown> = {}): UserTestDeps {
  process.env.AGENTD_HOME = mkdtempSync(join(tmpdir(), "agentd-ut-"))
  const config = ConfigSchema.parse({
    mini: "eve",
    repo: { path: "/repo", slug: "example/repo" },
    pluginRoot: "/plugin",
    slack: { allowedUsers: ["U0EXAMPLE"] },
    usertest: {
      enabled: true,
      previewEnvironment: "Preview – example",
      previewHost: "^app-[a-z0-9-]+\\.vercel\\.app$",
      stagingOrigin: "https://staging.example.com",
      previewWaitMinutes: 1,
      personas: [{ id: "customer", email: "customer@example.test", paths: ["components/account/**"] }],
      ...usertest,
    },
  })
  const { exec } = fakeExec([
    [/deployments\?sha=/, { stdout: JSON.stringify([{ id: 1, sha: HEAD, environment: "Preview – example", created_at: "2026-09-25T10:00:00Z" }]) }],
    [/deployments\/1\/statuses/, { stdout: JSON.stringify([{ state: "success", environment_url: "https://app-x1.vercel.app", created_at: "2026-09-25T10:01:00Z", creator: { login: "vercel[bot]" } }]) }],
    [/pr comment/, { stdout: "https://github.com/example/repo/pull/7#issuecomment-1\n" }],
  ])
  const t = fakeTracker([issue({ id: "STEP-7" })])
  return {
    paths: agentPaths(),
    config,
    exec,
    tracker: t.tracker,
    now: () => new Date("2026-09-25T10:05:00Z"),
    log: { info: () => {}, warn: () => {}, error: () => {} },
    fetchImpl: vi.fn().mockResolvedValue({ status: 500, ok: false, headers: { getSetCookie: () => [] } }) as unknown as typeof fetch,
    sleep: async () => {},
    secrets: { testLoginSecret: "s", bypassSecret: null },
    launch: vi.fn().mockResolvedValue({ port: 9333, close: async () => {} }),
    setCookies: vi.fn().mockResolvedValue(undefined),
    browse: vi.fn().mockResolvedValue({
      result: { status: "findings", summary: "It broke.", journeys: [], findings: [{ severity: "major", title: "Save does nothing", where: "/en/account", steps: "s", expected: "e", actual: "a" }], screenshots: [{ file: "main-01.png", caption: "The page" }], notWalked: [] },
      costUsd: 0.5,
      problem: null,
    }),
    publishImages: vi.fn().mockResolvedValue(new Map()),
    uploadImage: vi.fn().mockResolvedValue(null),
    ...over,
  }
}

const preview = { kind: "preview" as const, prUrl: PR, prNumber: 7, headSha: HEAD }
const staging = { kind: "staging" as const, prUrl: PR, prNumber: 7, headSha: HEAD }
const input = (changedPaths = ["components/account/Profile.tsx"], target: typeof preview | typeof staging = preview) => ({
  issue: issue({ id: "STEP-7" }),
  target,
  changedPaths,
  approvalClass: "look" as const,
})
const briefOf = (d: UserTestDeps) => (d.browse as ReturnType<typeof vi.fn>).mock.calls[0][1].brief as string
const loginCalls = (d: UserTestDeps) => (d.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.filter(([url]) => String(url).endsWith("/api/dev/test-login"))

describe("runUserTest", () => {
  it("does nothing when the browser test is off, or when no user sees the change", async () => {
    expect((await runUserTest(deps({}, { enabled: false }), input())).verdict).toBe("skipped")
    expect((await runUserTest(deps(), input(["docs/a.md"]))).verdict).toBe("skipped")
  })

  const signedIn = () => vi.fn().mockResolvedValue({ status: 200, ok: true, headers: { getSetCookie: () => ["stack-access=s; Path=/"] } }) as unknown as typeof fetch

  it("never signs in on a preview, which runs code nobody has reviewed: the persona's journeys wait for staging", async () => {
    const d = deps({ fetchImpl: signedIn() })
    const outcome = await runUserTest(d, input())
    expect(outcome.verdict).toBe("findings")
    expect(loginCalls(d)).toEqual([])
    expect(d.setCookies).toHaveBeenCalledWith(9333, [])
    const brief = briefOf(d)
    expect(brief).toContain("a visitor who is not signed in")
    expect(brief).toContain("the customer journeys run on staging after the merge")
  })

  it("signs the persona in on staging, and says why when staging refuses", async () => {
    const d = deps()
    await runUserTest(d, input(undefined, staging))
    expect(loginCalls(d)).toHaveLength(1)
    expect(String(loginCalls(d)[0][0])).toBe("https://staging.example.com/api/dev/test-login")
    expect(briefOf(d)).toContain("not signed in: the test sign-in failed on the site's side (HTTP 500)")
  })

  it("asks for Vercel's bypass cookie on a preview only", async () => {
    const bypass = () => vi.fn().mockResolvedValue({ status: 307, ok: false, headers: { getSetCookie: () => ["_vercel_jwt=j; Path=/"] } }) as unknown as typeof fetch
    const onPreview = deps({ fetchImpl: bypass(), secrets: { testLoginSecret: null, bypassSecret: "b" } })
    await runUserTest(onPreview, input())
    expect((onPreview.fetchImpl as unknown as ReturnType<typeof vi.fn>).mock.calls.map(([url]) => String(url))).toEqual(["https://app-x1.vercel.app/"])
    expect(onPreview.setCookies).toHaveBeenCalledWith(9333, [expect.objectContaining({ name: "_vercel_jwt", url: "https://app-x1.vercel.app" })])
    const onStaging = deps({ fetchImpl: bypass(), secrets: { testLoginSecret: null, bypassSecret: "b" } })
    await runUserTest(onStaging, input(undefined, staging))
    expect(onStaging.fetchImpl).not.toHaveBeenCalled()
  })

  it("records the findings for agentd, by PR and head", async () => {
    const d = deps()
    await runUserTest(d, input())
    expect(readUserTestState(d.paths, PR)).toMatchObject({ head: HEAD, verdict: "findings", findings: ["major: Save does nothing (/en/account)"] })
  })

  const browseWithShot = () =>
    vi.fn().mockImplementation(async (_port: number, s: { shotsDir: string }) => {
      writeFileSync(join(s.shotsDir, "main-01.png"), "png")
      return { result: { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [{ file: "main-01.png", caption: "The page" }], notWalked: [] }, costUsd: 0.1, problem: null }
    })
  const admin = { personas: [{ id: "admin", email: "admin@example.test", admin: true, publishScreenshots: false, paths: ["components/account/**"] }] }

  it("keeps a signed-in admin persona's screenshots on the mini", async () => {
    const d = deps({ fetchImpl: signedIn(), browse: browseWithShot() }, admin)
    expect((await runUserTest(d, input(undefined, staging))).verdict).toBe("pass")
    expect(d.publishImages).not.toHaveBeenCalled()
    expect(d.uploadImage).not.toHaveBeenCalled()
  })

  it("publishes a preview's screenshots whatever the persona, since nobody is signed in there", async () => {
    const d = deps({ fetchImpl: signedIn(), browse: browseWithShot() }, admin)
    await runUserTest(d, input())
    expect(d.publishImages).toHaveBeenCalledTimes(1)
  })

  it("publishes a signed-in customer's screenshots to the PR and the issue", async () => {
    const d = deps({ fetchImpl: signedIn(), browse: browseWithShot() })
    await runUserTest(d, input(undefined, staging))
    expect(d.publishImages).toHaveBeenCalledTimes(1)
    expect(d.uploadImage).toHaveBeenCalled()
    expect(briefOf(d)).toContain("signed in as the customer persona")
  })

  it("says in plain words why a report is no verdict, and counts problems in plain words", async () => {
    const blocked = deps({ browse: vi.fn().mockResolvedValue({ result: { status: "blocked", summary: "No page loaded.", journeys: [], findings: [], screenshots: [], notWalked: [] }, costUsd: 0.1, problem: null }) })
    expect(await runUserTest(blocked, input())).toMatchObject({ verdict: "error", reason: "the browser test could not test the change" })
    const bare = deps({ browse: vi.fn().mockResolvedValue({ result: { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [], notWalked: [] }, costUsd: 0.1, problem: null }) })
    expect(await runUserTest(bare, input())).toMatchObject({ verdict: "error", reason: "the browser test saved no screenshot, so its report is no evidence" })
    expect((await runUserTest(deps(), input())).reason).toBe("1 problem a user would meet")
  })

  it("keeps the report, and publishes only the screenshots it named, when a file in the shots folder is not what it says", async () => {
    const comment = vi.fn().mockResolvedValue(undefined)
    const browse = vi.fn().mockImplementation(async (_port: number, s: { shotsDir: string }) => {
      writeFileSync(join(s.shotsDir, "main-01.png"), readFileSync(PNG_FILE))
      writeFileSync(join(s.shotsDir, "main-02.png"), "a snapshot saved as .png")
      writeFileSync(join(s.shotsDir, "odd name (1).png"), readFileSync(PNG_FILE))
      return { result: { status: "findings", summary: "It broke.", journeys: [], findings: [{ severity: "major", title: "X", where: "/en", steps: "s", expected: "e", actual: "a" }], screenshots: [{ file: "main-01.png", caption: "c" }], notWalked: [] }, costUsd: 0.2, problem: null }
    })
    const d = deps({ browse, tracker: { comment } })
    expect(await runUserTest(d, input())).toMatchObject({ verdict: "findings", reported: true })
    expect(comment).toHaveBeenCalledTimes(1)
    const files = (d.publishImages as ReturnType<typeof vi.fn>).mock.calls[0][0].files.map((f: string) => f.split("/").pop())
    expect(files).toEqual(["main-01.png", "main-02.png"])
  })

  it("posts the report on the PR without images when they cannot be published", async () => {
    const d = deps({ browse: vi.fn().mockImplementation(async (_port: number, s: { shotsDir: string }) => {
        for (const f of ["main-01.png"]) writeFileSync(join(s.shotsDir, f), readFileSync(PNG_FILE))
        return { result: { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [{ file: "main-01.png", caption: "The page" }], notWalked: [], ...{} }, costUsd: 0.1, problem: null }
      }), publishImages: vi.fn().mockRejectedValue(new Error("422")) })
    const outcome = await runUserTest(d, input())
    expect(outcome.commentUrl).toBe("https://github.com/example/repo/pull/7#issuecomment-1")
  })

  it("puts the main journey, the phone and the problems first, and says why the rest stay on the mini", async () => {
    const files = [...Array.from({ length: 6 }, (_, n) => `before-desktop-0${n + 1}.png`), ...Array.from({ length: 8 }, (_, n) => `main-0${n + 1}.png`), ...Array.from({ length: 6 }, (_, n) => `phone-0${n + 1}.png`), "finding-01.png"]
    const comment = vi.fn().mockResolvedValue(undefined)
    const d = deps({ browse: vi.fn().mockImplementation(async (_port: number, s: { shotsDir: string }) => {
        for (const f of files) writeFileSync(join(s.shotsDir, f), readFileSync(PNG_FILE))
        return { result: { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [{ file: "main-01.png", caption: "The page" }], notWalked: [], ...{} }, costUsd: 0.1, problem: null }
      }), tracker: { comment } }, { personas: [] })
    await runUserTest(d, { ...input(), approvalClass: "auto" })
    const published = (d.publishImages as ReturnType<typeof vi.fn>).mock.calls[0][0].files.map((f: string) => f.split("/").pop())
    expect(published).toHaveLength(16)
    expect(published.slice(0, 8).every((f: string) => f.startsWith("main-"))).toBe(true)
    expect(published).toContain("finding-01.png")
    expect(published.filter((f: string) => f.startsWith("before-"))).toHaveLength(1)
    expect(comment.mock.calls[0][1]).toContain("5 screenshots stay on the mini, because a report shows at most 16.")
  })

  it("keeps a staging test's images apart from the preview's, and records only a preview's verdict for agentd", async () => {
    const d = deps({ fetchImpl: signedIn(), browse: vi.fn().mockImplementation(async (_port: number, s: { shotsDir: string }) => {
        for (const f of ["main-01.png"]) writeFileSync(join(s.shotsDir, f), readFileSync(PNG_FILE))
        return { result: { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [{ file: "main-01.png", caption: "The page" }], notWalked: [], ...{} }, costUsd: 0.1, problem: null }
      }) })
    await runUserTest(d, input(undefined, staging))
    expect((d.publishImages as ReturnType<typeof vi.fn>).mock.calls[0][0].suffix).toBe("staging")
    expect(readUserTestState(d.paths, PR)).toBeNull()
    const p = deps({ browse: vi.fn().mockImplementation(async (_port: number, s: { shotsDir: string }) => {
        for (const f of ["main-01.png"]) writeFileSync(join(s.shotsDir, f), readFileSync(PNG_FILE))
        return { result: { status: "pass", summary: "Fine.", journeys: [], findings: [], screenshots: [{ file: "main-01.png", caption: "The page" }], notWalked: [], ...{} }, costUsd: 0.1, problem: null }
      }) })
    await runUserTest(p, input())
    expect((p.publishImages as ReturnType<typeof vi.fn>).mock.calls[0][0].suffix).toBeUndefined()
    expect(readUserTestState(p.paths, PR)).toMatchObject({ verdict: "pass" })
  })

  it("says whether the report reached the issue", async () => {
    expect((await runUserTest(deps({}, { enabled: false }), input())).reported).toBe(false)
    expect((await runUserTest(deps({ tracker: { comment: vi.fn().mockRejectedValue(new Error("Linear down")) } }), input())).reported).toBe(false)
  })

  it("never throws: a Chrome that will not start is an error outcome", async () => {
    const outcome = await runUserTest(deps({ launch: vi.fn().mockRejectedValue(new Error("no Chrome")) }), input())
    expect(outcome).toMatchObject({ verdict: "error" })
    expect(outcome.reason).toContain("could not run")
  })
})
