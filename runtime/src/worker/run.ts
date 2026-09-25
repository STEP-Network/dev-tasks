/**
 * One develop job, end to end, as its own process. agentd spawns it detached,
 * so neither a front-door restart nor an agentd restart kills a 90-minute run.
 *   1. read the issue; skip it when it is no longer Ready, is held by someone
 *      else, or already has an open PR; otherwise claim it
 *   2. prepare the worktree (fetch, worktree add, pnpm install)
 *   3. run the SDK session: plugin hooks, the worker's guard, the sandbox, the limits.
 *      A report whose only fault is its form, with commits ahead, is asked
 *      for once more in the same session, then taken from the commits
 *   4. finalize: push, PR, auto-merge, Linear, Slack
 *   5. move the job to done with its result, exactly once
 * A retry (agentctl retry) takes its issue On hold too, and prepareWorktree
 * carries the branch's commits on. A revise job (STEP-3274, agentd/revise.ts)
 * claims nothing: it continues its open PR's branch from origin, with the
 * review feedback in its brief, and finalizeRevise pushes to that branch and
 * replies on the PR.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { existsSync, readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import { requiredChecks } from "../agentd/health.ts"
import { FINISH_GRACE_MINUTES } from "../agentd/jobrunner.ts"
import { agentPaths, assertProfileMini, loadConfig, readProfileMini, type AgentConfig, type AgentPaths } from "../config.ts"
import { readJson } from "../fsq.ts"
import { jobPath, moveJob, updateJob, type JobRecord, type JobResult } from "../jobs.ts"
import { appendLedger, createLogger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { loadClaudeOauthToken } from "../secrets.ts"
import { branchNameFor, createLinearTracker, type Tracker, type TrackerIssue } from "../tracker.ts"
import { buildBrief, WORKER_RESULT_SCHEMA, workerRules, type BriefInput } from "./brief.ts"
import { finalize, FinalizeFailed, type MergeMode } from "./finalize.ts"
import { changedFiles, commitMessages, commitsAhead, historyRewrite, prepareWorktree, realExec, WorktreeRefused, type Exec } from "./git.ts"
import { denyBannedBash, denyWorkerPaths, ENV_TEMPLATE, workerEnv, workerToolDenial } from "./guard.ts"
import { clause, toOutcome, type Outcome, type ResultMessageLike } from "./outcome.ts"
import { buildReviseBrief, finalizeRevise, gatherFeedback } from "./revise.ts"

export type SdkMessage = { type: string; subtype?: string; [key: string]: unknown }
/** The SDK's query(), narrowed to what the runner uses, so tests can pass a generator. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SdkMessage>

export function modelFor(issue: TrackerIssue, job: JobRecord, config: AgentConfig): string {
  if (job.model) return job.model
  return issue.labels.includes("complexity-high") ? config.worker.complexModel : config.worker.defaultModel
}

export function readAutoMergePolicy(repo: string, base: string): string | null {
  try {
    const parsed = JSON.parse(readFileSync(join(repo, ".claude", "project-config.json"), "utf8")) as {
      git?: { autoMergePolicy?: Record<string, string> }
    }
    return parsed.git?.autoMergePolicy?.[base] ?? null
  } catch {
    return null
  }
}

/** Auto-merge takes both: the project's policy for the base branch, and this mini's worker.autoMerge. */
export function mergeMode(policy: string | null, config: AgentConfig): MergeMode {
  if (policy !== "auto-after-checks-and-review") return "person"
  return config.worker.autoMerge === false ? "mini-off" : "auto"
}

/** The init message's plugin list must hold dev-tasks exactly once, or its hooks cannot be trusted. */
export function checkPlugins(plugins: unknown): string | null {
  const list = Array.isArray(plugins) ? plugins : []
  const count = list.filter((p) => (p as { name?: unknown } | null)?.name === "dev-tasks").length
  return count === 1 ? null : `the dev-tasks plugin loaded ${count} times in the worker (expected once), so its hooks cannot be trusted`
}

/**
 * Spec 1: the subscription, never an API key. The worker's environment holds
 * no key, but a Console login or an apiKeyHelper would still bill one, and
 * the init message says which the session uses.
 */
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"])

export function checkBilling(apiKeySource: unknown): string | null {
  return typeof apiKeySource === "string" && API_KEY_SOURCES.has(apiKeySource)
    ? `the worker would bill an API key (${apiKeySource}), not the subscription`
    : null
}

export interface SdkOptionsInput {
  config: AgentConfig
  cwd: string
  model: string
  abortController: AbortController
  rules: string
  pnpmStore: string | null
  env: Record<string, string>
  /** The machine user's home: its ~/.config, and every .env file under it, stay unread. */
  home: string
}

/** git's files that say where a worktree's repository, config and common directory are. */
const GIT_POINTERS = ["commondir", "gitdir", "config.worktree"]

/** Typed as the SDK's own Options: a misspelt or retired option fails the typecheck. */
export function sdkOptions(o: SdkOptionsInput): Options {
  const repoGit = join(o.config.repo.path, ".git")
  const scope = { worktree: o.cwd, home: o.home }
  return {
    cwd: o.cwd,
    model: o.model,
    maxTurns: o.config.worker.maxTurns,
    maxBudgetUsd: o.config.worker.maxBudgetUsd,
    abortController: o.abortController,
    // Edits are accepted, sandboxed Bash is auto-allowed, and anything that
    // would still prompt is denied: nobody is there to answer (decision 7).
    permissionMode: "acceptEdits",
    canUseTool: async (toolName, input) => ({
      behavior: "deny",
      message:
        workerToolDenial(toolName, input, scope) ??
        `${toolName} needs a permission prompt and an unattended worker has nobody to ask. Work around it, or finish with status blocked.`,
    }),
    // No web (token discipline, and less untrusted text), no subagents (spec
    // 6.6: no fan-out), no skills: the brief is the whole procedure, and /ship
    // would try to push. "Agent" and "Task" are the subagent tool's two names.
    disallowedTools: ["WebFetch", "WebSearch", "Agent", "Task", "Skill"],
    // PolAds's CLAUDE.md and project hooks. Not "user": that is the front door's
    // settings (Remote Control, the status line), not the worker's.
    settingSources: ["project"],
    // The project's settings, hooks and .claude trees come from the main
    // checkout, which agentd keeps at the base, not from the branch in the
    // worktree: a branch's own copy is a worker's, unreviewed, and hooks run
    // outside the sandbox. No MCP server but the ones passed here (none).
    projectConfigRoot: o.config.repo.path,
    strictMcpConfig: true,
    plugins: [{ type: "local", path: o.config.pluginRoot, skipMcpDiscovery: true }],
    // Claude Code's own deny rules, beside the hook below: the secrets, and the
    // agent configuration in the worktree (`//` is an absolute path). A deny
    // rule has no exceptions, so .env files, where .env.example must stay
    // readable, are held by the hook and the sandbox.
    settings: {
      permissions: {
        deny: [
          "Read(~/.config/**)",
          "Edit(~/.config/**)",
          `Edit(/${o.cwd}/.claude/hooks/**)`,
          `Edit(/${o.cwd}/.claude/settings*.json)`,
          `Edit(/${o.cwd}/.mcp.json)`,
        ],
      },
    },
    hooks: {
      PreToolUse: [
        { matcher: "Bash", hooks: [denyBannedBash] },
        // Every tool: canUseTool never hears of a read, nor of an edit acceptEdits allows.
        { hooks: [denyWorkerPaths(scope)] },
      ],
    },
    sandbox: {
      enabled: true,
      failIfUnavailable: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      // strictAllowlist: another host is refused outright, never a prompt (decision 7).
      network: { allowedDomains: ["registry.npmjs.org"], allowLocalBinding: true, strictAllowlist: true },
      filesystem: {
        // The worktree is the cwd and writable by default. Commits also write the
        // repository's shared .git, and `pnpm add` writes the pnpm store. The
        // sandbox itself keeps .git/config and .git/hooks read-only.
        allowWrite: [repoGit, ...(o.pnpmStore ? [o.pnpmStore] : [])],
        denyWrite: [
          // git's pointers between the worktree and the repository. Rewritten, they
          // would point the runner's own git, which runs outside this sandbox, at a
          // config the worker wrote. git reads a commondir in any git directory,
          // the main one included, so that one is refused before it exists. This
          // worktree's own are named outright as well as by wildcard.
          join(o.cwd, ".git"),
          join(repoGit, "commondir"),
          // Files that rewrite history as git reads it, which no option turns
          // off: a graft could hide what a branch changes from the resume check.
          join(repoGit, "info", "grafts"),
          join(repoGit, "shallow"),
          ...GIT_POINTERS.map((file) => join(repoGit, "worktrees", basename(o.cwd), file)),
          ...GIT_POINTERS.map((file) => join(repoGit, "worktrees", "*", file)),
          // The project's agent configuration: Claude Code runs these hooks, and
          // would load these settings and MCP servers, outside this sandbox.
          join(o.cwd, ".claude", "hooks"),
          join(o.cwd, ".claude", "settings.json"),
          join(o.cwd, ".claude", "settings.local.json"),
          join(o.cwd, ".mcp.json"),
        ],
        denyRead: [join(o.home, ".config"), join(o.home, "**", ".env*")],
        // PolAds's tracked template holds no secret, and git stats every tracked file.
        allowRead: [join(o.home, "**", ENV_TEMPLATE)],
      },
      // The worker's own process needs the Claude token. Its commands never do.
      credentials: { envVars: [{ name: "CLAUDE_CODE_OAUTH_TOKEN", mode: "deny" }] },
    },
    env: o.env,
    systemPrompt: { type: "preset", preset: "claude_code", append: o.rules },
    outputFormat: { type: "json_schema", schema: WORKER_RESULT_SCHEMA },
  }
}

export interface RunDeps {
  paths: AgentPaths
  config: AgentConfig
  tracker: Tracker
  exec: Exec
  query: QueryFn
  now: () => Date
  log: Logger
  pnpmStore: string | null
  /** From ~/.config/agentd/claude.env when the Keychain login does not reach the SDK. */
  claudeToken: string | null
}

/** What one SDK session ended with. */
interface SessionEnd {
  result: ResultMessageLike | null
  thrown: string | null
  initProblem: string | null
  abortedByClock: boolean
}

/**
 * One SDK session, read to its end. The plugin and billing checks come from
 * its init message, and a session that breaks them is stopped at once.
 */
async function runSession(query: QueryFn, prompt: string, options: Options, minutes: number): Promise<SessionEnd> {
  const abortController = options.abortController ?? new AbortController()
  options.abortController = abortController
  const end: SessionEnd = { result: null, thrown: null, initProblem: null, abortedByClock: false }
  const timer = setTimeout(() => {
    end.abortedByClock = true
    abortController.abort()
  }, minutes * 60_000)
  try {
    let sawInit = false
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        sawInit = true
        end.initProblem = checkPlugins(message.plugins) ?? checkBilling(message.apiKeySource)
      } else if (!sawInit && ["assistant", "user", "result"].includes(message.type)) {
        // The conversation began, or ended, without the checks (hook events may
        // come first). A session that failed to start says why in its result.
        const said = [...(Array.isArray(message.errors) ? message.errors : []), typeof message.result === "string" ? message.result : ""].filter(Boolean).join(". ")
        end.initProblem = `the session sent no init message, so the plugin and billing checks could not run${said ? ` (${said})` : ""}`
      }
      if (end.initProblem) {
        abortController.abort()
        break
      }
      if (message.type === "result") end.result = message as unknown as ResultMessageLike
    }
  } catch (error) {
    end.thrown = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
  return end
}

/**
 * The correction the same session gets once, when its report's form was the
 * only fault. `detail` is the outcome's reason: which checklist answers or
 * which tests it concerns.
 */
export function correctionPrompt(problem: NonNullable<Outcome["reportProblem"]>, detail = ""): string {
  const report =
    "Then reply with the final report only, in the report's schema: status, summary, verification, notes, checklist, mutations, and for status done a prTitle, a conventional commit title such as `fix: the notice date`."
  const sentence = (text: string, fallback: string) => {
    const said = clause(text) || fallback
    return `${said[0].toUpperCase()}${said.slice(1)}.`
  }
  if (problem === "checklist") {
    return [
      sentence(detail, "your report's self-check is incomplete"),
      "Do the one-hop sweep in your rules for what is missing: search for it (grep or rg), fix and commit what it finds, and answer every checklist key, siblings and docs with the command you ran.",
      report,
    ].join(" ")
  }
  if (problem === "mutations") {
    return [
      sentence(detail, "your branch changes tests, but your report lists no mutation check"),
      "For each new guard or invariant test: apply one deliberate mutation of the invariant in the implementation, run that test and see it fail, then revert the mutation with git checkout -- <file>. Commit no mutation. If a test passes against its mutation, fix the test and commit that.",
      report,
    ].join(" ")
  }
  const what = problem === "prTitle" ? "Your final report has no prTitle." : "Your session ended without a valid final report."
  return [`${what} Your commits are in place, so change nothing and run no tool.`, report.replace(/^Then reply/, "Reply")].join(" ")
}

/** How long, and how many turns, the correction may take. A report alone takes a few, a sweep or a mutation check more. */
const CORRECTION_MINUTES = 10
const CORRECTION_TURNS: Record<NonNullable<Outcome["reportProblem"]>, number> = { prTitle: 4, report: 4, checklist: 30, mutations: 30 }

/** Test files, whose new guards need a mutation check (STEP-3284). */
const TEST_FILE_RE = /(^|\/)__tests__\/|\.(test|spec)\.[cm]?[jt]sx?$/

/**
 * A done report on a branch that changes tests must list its mutation checks:
 * otherwise a guard test may prove only its fixture. Returns the outcome as
 * is, or blocked with reportProblem "mutations".
 */
export function requireMutations(outcome: Outcome, changed: readonly string[]): Outcome {
  if (outcome.status !== "done" || !outcome.report || outcome.report.mutations?.length) return outcome
  const tests = changed.filter((f) => TEST_FILE_RE.test(f))
  if (!tests.length) return outcome
  const shown = tests.slice(0, 5).join(", ") + (tests.length > 5 ? `, and ${tests.length - 5} more` : "")
  return { ...outcome, status: "blocked", reason: `the branch changes tests (${shown}) but the report lists no mutation check`, reportProblem: "mutations" }
}

/**
 * A done report whose only fault stayed its self-check: the work goes out, and
 * the PR says what the worker did not check, for the reviewer.
 */
export function acceptWithGaps(outcome: Outcome): Outcome {
  const note = `The worker's self-check was incomplete (${clause(outcome.reason)}): a reviewer should sweep one hop from the change, and mutation-check its new tests.`
  return {
    ...outcome,
    status: "done",
    reason: `done, with an incomplete self-check: ${clause(outcome.reason)}`,
    report: { ...outcome.report!, status: "done", notes: [note, outcome.report?.notes].filter(Boolean).join("\n") },
    reportProblem: undefined,
  }
}
/** What the correction leaves of agentd's grace after the wall clock, for the push, the PR and Linear. */
const FINISH_MINUTES = 5

/** The correction's minutes: at most CORRECTION_MINUTES, and never into the finish agentd's backstop allows. */
export function correctionMinutes(wallClockMinutes: number, elapsedMinutes: number): number {
  return Math.min(CORRECTION_MINUTES, wallClockMinutes + FINISH_GRACE_MINUTES - FINISH_MINUTES - elapsedMinutes)
}

/** Two sessions' spend or turns, to the micro-dollar, so a sum never reads 2.4499999999999997. */
const add = (a: number | null, b: number | null) => (a === null && b === null ? null : Math.round(((a ?? 0) + (b ?? 0)) * 1e6) / 1e6)

/**
 * A done report built from the branch's commits, when the worker's own report
 * stayed malformed: the newest subject titles the PR (its issue id dropped,
 * since the PR title carries it already), and the messages describe it.
 */
export async function outcomeFromCommits(exec: Exec, worktree: string, base: string, issueId: string, outcome: Outcome): Promise<Outcome | null> {
  const commits = await commitMessages(exec, worktree, base)
  if (!commits.length) return null
  const id = issueId.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const title = commits[0].subject
    .replace(new RegExp(`^${id}:\\s*`), "")
    .replace(new RegExp(`\\s*\\(${id}\\)$`), "")
    .trim()
  const summary = commits.map((c) => (c.body ? `${c.subject}\n\n${c.body}` : c.subject)).join("\n\n")
  const note = `The worker's final report was malformed (${clause(outcome.reason)}), so the runner took this PR's title and description from its commits.`
  return {
    status: "done",
    reason: `done, titled from the commits: ${clause(outcome.reason)}`,
    report: {
      status: "done",
      summary,
      prTitle: title || commits[0].subject,
      verification: outcome.report?.verification ?? [],
      notes: [note, outcome.report?.notes].filter(Boolean).join("\n"),
    },
    costUsd: outcome.costUsd,
    turns: outcome.turns,
    sessionId: outcome.sessionId,
  }
}


export async function runJob(deps: RunDeps, jobId: string): Promise<JobResult> {
  const { paths, config, tracker, exec, log } = deps
  const job = readJson<JobRecord>(jobPath(paths, "running", jobId))
  if (!job) throw new Error(`job ${jobId} is not in jobs/running`)
  const started = deps.now()
  const minutes = () => Math.round((deps.now().getTime() - started.getTime()) / 60_000)
  const finish = (result: JobResult, extra: Partial<JobRecord> = {}): JobResult => {
    moveJob(paths, jobId, "running", "done", { endedAt: deps.now().toISOString(), result, ...extra })
    appendLedger(paths, { type: "worker.end", issue: job.issue, ...result }, deps.now())
    return result
  }
  const nothing = { prUrl: null, branch: null, costUsd: null, turns: null, minutes: 0 }

  // 0. A graft or a shallow list in the repository can hide what a branch
  // changes (prepareWorktree refuses it too). It is the mini's to fix, not the
  // issue's: pause before anything is claimed, rather than park issue after issue.
  const rewrite = historyRewrite(config.repo.path)
  if (rewrite) {
    const why = `the main checkout has .git/${rewrite}, which can hide what a branch changes`
    if (!existsSync(paths.pauseFile)) {
      writeFileSync(paths.pauseFile, JSON.stringify({ at: deps.now().toISOString(), reason: why }))
      appendLedger(paths, { type: "paused", reason: why }, deps.now())
    }
    enqueueSlack(paths, { kind: "post", channel: "agents", text: `Paused: ${why}. ${job.issue} was not started. A person must look at the file, remove it if nothing needs it, and run agentctl resume.` }, deps.now())
    return finish({ ...nothing, status: "skipped", reason: why })
  }

  // 1. read, skip or claim. Linear failing here ends the job the ordinary way,
  // as skipped and marked linearFailed (the digest waits before offering the
  // issue again): an outage is no fault of the issue or the mini, and a crash
  // here would count as a worker lost early (agentd, heldBackIssues).
  const linearFailed = (what: string, error: unknown): JobResult => {
    const message = error instanceof Error ? error.message : String(error)
    log.warn(what, { issue: job.issue, error: message })
    return finish({ ...nothing, status: "skipped", reason: `${what}: ${message}` }, { linearFailed: true })
  }
  const revise = job.kind === "revise" ? job.revise : undefined
  if (job.kind === "revise" && !revise) return finish({ ...nothing, status: "skipped", reason: "a revise job without its PR" })
  let current: TrackerIssue
  let branch: string
  if (revise) {
    try {
      current = await tracker.readIssue(job.issue)
    } catch (error) {
      return linearFailed("Linear failed before the revision", error)
    }
    const pr = await exec("gh", ["pr", "view", revise.url, "--json", "state"], { cwd: config.repo.path })
    let state = ""
    try {
      state = pr.code === 0 ? String((JSON.parse(pr.stdout) as { state?: unknown }).state ?? "") : ""
    } catch {
      state = ""
    }
    if (state !== "OPEN") {
      return finish({ ...nothing, status: "skipped", reason: state ? `the PR is ${state.toLowerCase()}, so there is nothing to revise` : "gh could not read the PR", prUrl: revise.url })
    }
    branch = revise.branch
  } else {
    try {
      current = await tracker.readIssue(job.issue)
      const me = await tracker.whoami()
      // A retry picks up a blocked job, whose issue the runner put On hold.
      const takes = job.retryOf ? ["Ready", "On hold", "In Progress"] : ["Ready"]
      if (!takes.includes(current.state)) {
        return finish({ ...nothing, status: "skipped", reason: `the issue is ${current.state}, not ${job.retryOf ? "Ready or On hold" : "Ready"}` })
      }
      if (current.assigneeId && current.assigneeId !== me.id) return finish({ ...nothing, status: "skipped", reason: "someone else holds the issue" })
      branch = branchNameFor(current.id, current.title)
      const open = await exec("gh", ["pr", "list", "--repo", config.repo.slug, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"], { cwd: config.repo.path })
      if (open.code === 0 && open.stdout.trim().startsWith("https://")) {
        await tracker.updateIssue(current.id, { state: "In Review" })
        return finish({ ...nothing, status: "skipped", reason: "a PR for this branch is already open", prUrl: open.stdout.trim(), branch })
      }
    } catch (error) {
      return linearFailed("Linear failed before the claim", error)
    }
  }
  let issue: TrackerIssue
  if (revise) {
    issue = current
  } else {
    try {
      issue = await tracker.claimIssue(current.id, config.mini)
    } catch (error) {
      // The claim comment and the assignment come before the read-back, so the claim may have gone through.
      enqueueSlack(
        paths,
        { kind: "post", channel: "agents", text: `${job.issue}: Linear failed while claiming it. If the claim went through, it is released after ${config.claims.ttlHours} hours unless someone takes the issue first.` },
        deps.now(),
      )
      return linearFailed("Linear failed while claiming", error)
    }
  }
  if (!revise) {
    appendLedger(paths, { type: "claimed", issue: issue.id }, deps.now())
    enqueueSlack(paths, { kind: "post", channel: "agents", text: `claimed ${issue.id} ${issue.title}` }, deps.now())
  }

  const model = modelFor(issue, job, config)
  const limits = { maxTurns: config.worker.maxTurns, maxBudgetUsd: config.worker.maxBudgetUsd, wallClockMinutes: config.worker.wallClockMinutes }
  const merge = mergeMode(readAutoMergePolicy(config.repo.path, config.repo.base), config)
  const finishWith = async (worktree: string | null, outcome: Outcome): Promise<JobResult> => {
    let result: JobResult
    try {
      const fin = revise
        ? await finalizeRevise({ exec, paths, config, issue, revise, worktree, now: deps.now }, outcome)
        : await finalize({ exec, tracker, paths, config, issue, branch, worktree, merge, model, minutes: minutes(), now: deps.now }, outcome)
      result = { status: fin.status, reason: fin.reason, prUrl: fin.prUrl, branch, costUsd: outcome.costUsd, turns: outcome.turns, minutes: minutes() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      enqueueSlack(paths, { kind: "post", channel: "agents", text: `${issue.id}: finishing the job failed (${message}). A person needs to look.` }, deps.now())
      // A PR that opened before the failure is still this job's.
      const prUrl = error instanceof FinalizeFailed ? error.prUrl : (revise?.url ?? null)
      result = { status: "blocked", reason: `finishing the job failed: ${message}`, prUrl, branch, costUsd: outcome.costUsd, turns: outcome.turns, minutes: minutes() }
    }
    // Outside the try: the job reaches done once, whatever finalize did (Review Focus 5).
    return finish(result)
  }
  const blockedBefore = (reason: string): Outcome => ({ status: "blocked", reason, report: null, costUsd: null, turns: null, sessionId: null })

  // 2. the worktree
  let worktree: { path: string; resumed: boolean }
  try {
    worktree = await prepareWorktree(exec, { repo: config.repo.path, worktreesDir: paths.worktrees, branch, base: config.repo.base, fromOrigin: Boolean(revise) })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return finishWith(null, blockedBefore(error instanceof WorktreeRefused ? message : `the worktree could not be prepared: ${message}`))
  }

  // 3. the session
  const earlier = job.retryOf ? readJson<JobRecord>(jobPath(paths, "done", job.retryOf))?.result?.reason : undefined
  const brief: BriefInput = { mini: config.mini, issue, worktree: worktree.path, branch, base: config.repo.base, resumed: worktree.resumed, limits, ...(earlier ? { earlier } : {}) }
  const options = () =>
    sdkOptions({
      config,
      cwd: worktree.path,
      model,
      abortController: new AbortController(),
      rules: workerRules(brief),
      pnpmStore: deps.pnpmStore,
      env: workerEnv(process.env, { DEV_TASKS_PROFILE: "agent", ...(deps.claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: deps.claudeToken } : {}) }),
      home: paths.home,
    })
  // agentd's backstop counts the wall clock from here, not from the spawn: preparing the worktree can take 20 minutes.
  const sessionStart = deps.now()
  updateJob(paths, "running", jobId, { sessionStartedAt: sessionStart.toISOString() })
  log.info("worker session starting", { issue: issue.id, model, worktree: worktree.path, resumed: worktree.resumed, retryOf: job.retryOf ?? null, revise: revise?.url ?? null })
  const prompt = revise ? buildReviseBrief(brief, revise, await gatherFeedback(exec, config.repo.slug, revise, requiredChecks(config.repo.path))) : buildBrief(brief)
  // A revise job's PR has its title: its report needs none.
  const requireTitle = !revise
  const first = await runSession(deps.query, prompt, options(), config.worker.wallClockMinutes)
  // A revise job's own commits are those past the PR's head on origin.
  const since = revise ? revise.branch : config.repo.base
  const changed = await changedFiles(exec, worktree.path, since).catch(() => [] as string[])
  const judge = (end: typeof first) =>
    requireMutations(toOutcome(end.result, { abortedByClock: end.abortedByClock, thrown: end.thrown, limits, requireTitle }), changed)
  let outcome = first.initProblem ? blockedBefore(first.initProblem) : judge(first)
  log.info("worker session ended", { issue: issue.id, status: outcome.status, reason: outcome.reason, costUsd: outcome.costUsd, turns: outcome.turns })

  // A malformed report is a formatting miss, not a reason to strand finished
  // work. With commits ahead, the same session is asked for the report once
  // (a sweep or a mutation check included, when those were missing). Then a
  // report still short of its self-check goes out with its gaps named, and
  // one without a title or at all is titled from the commits. With no
  // commits, it stays blocked.
  const selfCheck = (o: Outcome | null) => Boolean(o?.report) && (o!.reportProblem === "checklist" || o!.reportProblem === "mutations")
  if (outcome.reportProblem && (await commitsAhead(exec, worktree.path, since).catch(() => 0)) > 0) {
    const problem = outcome.reportProblem
    let repaired: Outcome | null = null
    let closest: Outcome | null = selfCheck(outcome) ? outcome : null
    const budget = correctionMinutes(config.worker.wallClockMinutes, (deps.now().getTime() - sessionStart.getTime()) / 60_000)
    if (outcome.sessionId && budget >= 1) {
      const again = options()
      again.resume = outcome.sessionId
      again.maxTurns = CORRECTION_TURNS[problem]
      const second = await runSession(deps.query, correctionPrompt(problem, outcome.reason), again, budget)
      const corrected = second.initProblem ? null : judge(second)
      const spent = corrected ? { costUsd: add(outcome.costUsd, corrected.costUsd), turns: add(outcome.turns, corrected.turns) } : {}
      if (corrected?.report && !corrected.reportProblem) {
        repaired = { ...corrected, ...spent }
        appendLedger(paths, { type: "report.corrected", issue: issue.id, problem }, deps.now())
      } else if (corrected) {
        outcome = { ...outcome, ...spent }
        if (selfCheck(corrected)) closest = { ...corrected, ...spent }
        else if (closest) closest = { ...closest, ...spent }
      }
    }
    if (!repaired && closest) {
      repaired = acceptWithGaps(closest)
      appendLedger(paths, { type: "report.selfCheckGaps", issue: issue.id, problem: closest.reportProblem }, deps.now())
    }
    if (!repaired) {
      repaired = await outcomeFromCommits(exec, worktree.path, since, issue.id, outcome).catch((error: unknown) => {
        log.warn("the commits could not be read", { issue: issue.id, error: String(error) })
        return null
      })
      if (repaired) appendLedger(paths, { type: "report.fromCommits", issue: issue.id, problem }, deps.now())
    }
    if (repaired) outcome = repaired
    log.info("worker report repaired", { issue: issue.id, problem, status: outcome.status, reason: outcome.reason })
  }

  // 4 and 5
  return finishWith(worktree.path, outcome)
}

if (process.argv[1]?.endsWith("run.ts")) {
  const jobId = process.argv[2]
  const paths = agentPaths()
  const log = createLogger(paths, "worker")
  const main = async () => {
    const config = loadConfig(paths)
    // One mini, one name (decision 2): the claim this job writes and the heartbeat trackerctl sends must agree.
    assertProfileMini(config, readProfileMini(), paths.config)
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    const store = await realExec("pnpm", ["store", "path"], { cwd: config.repo.path })
    return runJob(
      {
        paths,
        config,
        tracker: createLinearTracker(),
        exec: realExec,
        query: query as unknown as QueryFn,
        now: () => new Date(),
        log,
        pnpmStore: store.code === 0 ? store.stdout.trim() : null,
        claudeToken: loadClaudeOauthToken(paths.home),
      },
      jobId,
    )
  }
  main()
    .then((result) => {
      log.info("job finished", { jobId, ...result })
      process.exit(0)
    })
    .catch((error) => {
      // The job stays in jobs/running. agentd sees the dead pid and records it (Task 13).
      log.error("job crashed", { jobId, error: String(error) })
      process.exit(1)
    })
}
