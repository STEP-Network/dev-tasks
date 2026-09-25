/**
 * One browser test, end to end (WS5): find the site, launch Chrome, sign the
 * persona in from outside the model's reach, run the browser session, make
 * the GIF, publish the report to the PR and the Linear issue, and record the
 * verdict for agentd. It never throws: every failure is an outcome with a
 * plain reason, and a test that cannot run never holds work back.
 *
 * A PR's preview is always tested signed out: it runs code nobody has
 * reviewed yet, which could keep the test-login secret (login.ts). The
 * persona's journeys are walked on staging after the merge.
 */
import { existsSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { writeJsonAtomic } from "../fsq.ts"
import type { Logger } from "../log.ts"
import { plural } from "../plain.ts"
import { linearRequest, type ApprovalClass, type Tracker, type TrackerIssue } from "../tracker.ts"
import { workerEnv } from "../worker/guard.ts"
import type { Exec } from "../worker/git.ts"
import type { QueryFn } from "../worker/session.ts"
import { buildUserTestBrief, readProjectRules } from "./brief.ts"
import { launchChrome, setBrowserCookies, type ChromeHandle } from "./chrome.ts"
import { gifFromPngs, readablePng } from "./gif.ts"
import { bypassCookies, personaCookies, signInOrigins, type BrowserCookie } from "./login.ts"
import { chromeDevtoolsMcp } from "./mcp.ts"
import { waitForPreview } from "./preview.ts"
import { publishImagesToGitHub, uploadToLinear } from "./publish.ts"
import { findingLines, reportMarkdown, verdictOf, type UserTestResult } from "./result.ts"
import { runBrowserSession } from "./session.ts"
import { saveUserTestState, type UserTestVerdict } from "./state.ts"
import { allowedOrigins, allowedUrlPatterns, isBrowserVisible, personaFor } from "./target.ts"

export type UserTestTarget =
  | { kind: "preview"; prUrl: string; prNumber: number; headSha: string }
  | { kind: "staging" | "rc"; prUrl: string | null; prNumber: number | null; headSha: string | null }

export interface UserTestInput {
  issue: TrackerIssue
  target: UserTestTarget
  changedPaths: string[]
  approvalClass: ApprovalClass | null
}

export interface UserTestOutcome {
  verdict: UserTestVerdict
  reason: string
  findings: string[]
  commentUrl: string | null
  costUsd: number | null
  /** Whether the report reached the Linear issue: when not, the caller says the test did not run. */
  reported: boolean
}

export interface UserTestDeps {
  paths: AgentPaths
  config: AgentConfig
  exec: Exec
  tracker: Pick<Tracker, "comment">
  now: () => Date
  log: Logger
  fetchImpl: typeof fetch
  sleep: (ms: number) => Promise<void>
  secrets: { testLoginSecret: string | null; bypassSecret: string | null }
  launch: (profileDir: string) => Promise<ChromeHandle>
  setCookies: (port: number, cookies: BrowserCookie[]) => Promise<void>
  browse: (port: number, s: { brief: string; cwd: string; origins: string[]; patterns: string[]; shotsDir: string }) => Promise<{ result: UserTestResult | null; costUsd: number | null; problem: string | null }>
  publishImages: (o: { prNumber: number; sha: string; files: string[]; workDir: string; suffix?: string }) => Promise<Map<string, string>>
  uploadImage: (file: string) => Promise<string | null>
}

/** The real outward actions. */
export function userTestDeps(base: Omit<UserTestDeps, "launch" | "setCookies" | "browse" | "publishImages" | "uploadImage">, query: QueryFn, claudeToken: string | null): UserTestDeps {
  const u = base.config.usertest
  return {
    ...base,
    launch: (profileDir) => launchChrome({ chromePath: u.chromePath, profileDir, headless: u.headless, sleep: base.sleep }),
    setCookies: (port, cookies) => setBrowserCookies(port, cookies, { fetchImpl: base.fetchImpl }),
    browse: (port, s) =>
      runBrowserSession(
        { config: base.config, query, mcpBin: chromeDevtoolsMcp().bin },
        { ...s, port, env: workerEnv(process.env, claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: claudeToken } : {}) },
      ),
    publishImages: (o) => publishImagesToGitHub({ exec: base.exec, slug: base.config.repo.slug, ...o }),
    uploadImage: (file) => uploadToLinear(file, { request: linearRequest, fetchImpl: base.fetchImpl }),
  }
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const MAX_IMAGES = 16
/** The screenshots the brief asks for, in the order a person reads them: nothing else in the shots folder is published. */
const SHOT_ORDER = ["main", "phone", "finding", "before-desktop", "before-phone"]
const SHOT_RE = /^(main|phone|finding|before-desktop|before-phone)-\d+\.png$/
const shotRank = (file: string) => SHOT_ORDER.indexOf(SHOT_RE.exec(file.split("/").pop() ?? "")?.[1] ?? "")

export async function runUserTest(deps: UserTestDeps, input: UserTestInput): Promise<UserTestOutcome> {
  const { config, log } = deps
  const u = config.usertest
  const done = (verdict: UserTestVerdict, reason: string, extra: Partial<UserTestOutcome> = {}): UserTestOutcome => ({ verdict, reason, findings: [], commentUrl: null, costUsd: null, reported: false, ...extra })
  if (!u.enabled) return done("skipped", "the browser test is off on this mini")
  if (!isBrowserVisible(input.changedPaths, u.skipPaths)) return done("skipped", "nothing in this change shows in a browser")
  try {
    let site: string
    if (input.target.kind === "preview") {
      const found = await waitForPreview({ exec: deps.exec, slug: config.repo.slug, sha: input.target.headSha, environment: u.previewEnvironment!, hostRe: new RegExp(u.previewHost!), minutes: u.previewWaitMinutes, now: deps.now, sleep: deps.sleep })
      if (found.state === "timeout") return done("skipped", `the preview was not ready within ${u.previewWaitMinutes} minutes`)
      if (found.state !== "ready") return done("skipped", found.state === "failed" ? `the preview could not be used: ${found.detail}` : "the preview could not be found")
      site = found.origin
    } else if (input.target.kind === "staging") {
      site = u.stagingOrigin!
    } else {
      if (!u.rcOrigin) return done("skipped", "no release candidate is set up on this mini")
      site = u.rcOrigin
    }
    // A run a kill cut short leaves its browser profile, with the persona's session cookies in it.
    if (existsSync(deps.paths.usertest)) {
      for (const run of readdirSync(deps.paths.usertest)) rmSync(join(deps.paths.usertest, run, "profile"), { recursive: true, force: true })
    }
    const stamp = deps.now().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)
    const dir = join(deps.paths.usertest, `${input.issue.id}-${stamp}`)
    const shotsDir = join(dir, "shots")
    mkdirSync(shotsDir, { recursive: true })
    const origins = allowedOrigins(site, u.stagingOrigin!)
    const patterns = allowedUrlPatterns(origins, u.extraAllowedUrlPatterns)
    const persona = personaFor(input.changedPaths, u.personas)
    const nowSeconds = Math.floor(deps.now().getTime() / 1000)
    let personaNote = "a visitor who is not signed in"
    let signedIn = false
    const cookies: BrowserCookie[] = []
    if (input.target.kind === "preview") {
      if (deps.secrets.bypassSecret) {
        const b = await bypassCookies(site, deps.secrets.bypassSecret, deps.fetchImpl, nowSeconds)
        if (b.ok) cookies.push(...b.cookies)
        else log.warn("no preview bypass cookie", { issue: input.issue.id, why: b.why })
      }
      if (persona) personaNote = `a visitor who is not signed in: the ${persona.id} journeys run on staging after the merge`
    } else if (persona) {
      if (!deps.secrets.testLoginSecret) {
        personaNote = `not signed in: this mini has no test sign-in secret, so the ${persona.id} journeys are not walked`
      } else {
        const r = await personaCookies({ origin: site, signInOrigins: signInOrigins(u), persona, secret: deps.secrets.testLoginSecret, extraCookies: [], fetchImpl: deps.fetchImpl, nowSeconds })
        if (r.ok) {
          cookies.push(...r.cookies)
          signedIn = true
          personaNote = `signed in as the ${persona.id} persona`
        } else {
          personaNote = `not signed in: ${r.why}, so the ${persona.id} journeys are not walked`
        }
      }
    }
    const brief = buildUserTestBrief({
      issue: input.issue,
      site,
      targetKind: input.target.kind,
      stagingOrigin: u.stagingOrigin!,
      origins,
      personaNote,
      changedPaths: input.changedPaths,
      shotsDir,
      projectRules: readProjectRules(config.repo.path),
      approvalClass: input.approvalClass,
    })
    let chrome: ChromeHandle | null = null
    let session: Awaited<ReturnType<UserTestDeps["browse"]>>
    try {
      chrome = await deps.launch(join(dir, "profile"))
      await deps.setCookies(chrome.port, cookies)
      session = await deps.browse(chrome.port, { brief, cwd: dir, origins, patterns, shotsDir })
    } finally {
      await chrome?.close().catch(() => {})
    }
    // Only whole PNGs by the brief's names: the browser tool can save a page snapshot or a response body under a screenshot's name.
    const shots = existsSync(shotsDir)
      ? readdirSync(shotsDir)
          .filter((f) => SHOT_RE.test(f) && readablePng(join(shotsDir, f)))
          .sort((a, b) => shotRank(a) - shotRank(b) || a.localeCompare(b))
          .map((f) => join(shotsDir, f))
      : []
    const verdict: UserTestVerdict = session.result ? verdictOf(session.result, shots.map((f) => f.split("/").pop()!)) : "error"
    const findings = findingLines(session.result)
    const reason =
      session.problem ??
      (verdict === "pass"
        ? "nothing a user would trip on"
        : verdict === "findings"
          ? `${plural(findings.length, "problem", "problems")} a user would meet`
          : session.result?.status === "blocked"
            ? "the browser test could not test the change"
            : "the browser test saved no screenshot, so its report is no evidence")
    const main = shots.filter((f) => /\/main-\d+\.png$/.test(f))
    const gifWanted = input.approvalClass !== "auto"
    const gif = gifWanted ? gifFromPngs(main, join(dir, "main.gif")) : null
    // A signed-in persona whose pages show real people's data keeps its screenshots on the mini.
    const publish = !signedIn || Boolean(persona?.publishScreenshots)
    const toPublish = publish ? [...(gif ? [gif] : []), ...shots.slice(0, MAX_IMAGES)] : []
    const keptLocal = publish ? Math.max(0, shots.length - MAX_IMAGES) : shots.length + (gif ? 1 : 0)
    const keptLocalReason = publish ? `because a report shows at most ${MAX_IMAGES}` : undefined
    const captions = new Map((session.result?.screenshots ?? []).map((s) => [join(shotsDir, s.file.split("/").pop() ?? s.file), s.caption]))
    const images = (urls: Map<string, string>) =>
      toPublish.filter((f) => f !== gif && urls.has(f)).map((f) => ({ file: f.split("/").pop()!, caption: captions.get(f) ?? f.split("/").pop()!, url: urls.get(f)! }))
    const report = (urls: Map<string, string>) =>
      reportMarkdown({
        mini: config.mini,
        result: session.result,
        verdict,
        reason: session.problem ?? (verdict === "error" ? reason : null),
        site,
        personaNote,
        images: images(urls),
        gifUrl: gif ? urls.get(gif) ?? null : null,
        keptLocal,
        keptLocalReason,
      })
    let reported = false
    let commentUrl: string | null = null
    const target = input.target
    if (target.prUrl && target.prNumber && target.headSha) {
      try {
        // Images that cannot be published never cost the report: it goes out without them.
        const suffix = target.kind === "preview" ? undefined : target.kind
        const urls = toPublish.length
          ? await deps.publishImages({ prNumber: target.prNumber, sha: target.headSha, files: toPublish, workDir: dir, suffix }).catch((error: unknown) => {
              log.warn("browser test images not published", { issue: input.issue.id, error: message(error) })
              return new Map<string, string>()
            })
          : new Map<string, string>()
        const bodyFile = join(dir, "pr-comment.md")
        writeFileSync(bodyFile, `${report(urls)}\n`)
        const out = await deps.exec("gh", ["pr", "comment", target.prUrl, "--repo", config.repo.slug, "--body-file", bodyFile], { cwd: config.repo.path, timeoutMs: 120_000 })
        commentUrl = out.code === 0 ? out.stdout.trim().split("\n").find((l) => l.startsWith("https://")) ?? null : null
      } catch (error) {
        log.warn("browser test report not posted on the PR", { issue: input.issue.id, error: message(error) })
      }
    }
    try {
      const linearUrls = new Map<string, string>()
      for (const file of toPublish) {
        const url = await deps.uploadImage(file).catch(() => null)
        if (url) linearUrls.set(file, url)
      }
      await deps.tracker.comment(input.issue.id, report(linearUrls))
      reported = true
    } catch (error) {
      log.warn("browser test report not posted on the issue", { issue: input.issue.id, error: message(error) })
    }
    writeJsonAtomic(join(dir, "result.json"), { site, personaNote, verdict, reason, result: session.result, costUsd: session.costUsd })
    // Only a preview's verdict is the PR's to act on: agentd's PR watcher reads it by the PR's head.
    if (target.kind === "preview") saveUserTestState(deps.paths, { issue: input.issue.id, url: target.prUrl, head: target.headSha, verdict, findings, at: deps.now().toISOString() })
    return done(verdict, reason, { findings, commentUrl, costUsd: session.costUsd, reported })
  } catch (error) {
    return done("error", `the browser test could not run: ${message(error)}`)
  }
}
