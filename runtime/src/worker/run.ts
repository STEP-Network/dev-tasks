/**
 * One develop job, end to end, as its own process. agentd spawns it detached,
 * so neither a front-door restart nor an agentd restart kills a 90-minute run.
 *   1. read the issue; skip it when it is no longer Ready, is held by someone
 *      else, or already has an open PR; otherwise claim it
 *   2. prepare the worktree (fetch, worktree add, pnpm install)
 *   3. run the SDK session: plugin hooks, the worker's guard, the sandbox, the limits
 *   4. finalize: push, PR, auto-merge, Linear, Slack
 *   5. move the job to done with its result, exactly once
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import { readFileSync } from "node:fs"
import { basename, join } from "node:path"
import { agentPaths, assertProfileMini, loadConfig, readProfileMini, type AgentConfig, type AgentPaths } from "../config.ts"
import { readJson } from "../fsq.ts"
import { jobPath, moveJob, updateJob, type JobRecord, type JobResult } from "../jobs.ts"
import { appendLedger, createLogger, type Logger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { loadClaudeOauthToken } from "../secrets.ts"
import { branchNameFor, createLinearTracker, type Tracker, type TrackerIssue } from "../tracker.ts"
import { buildBrief, WORKER_RESULT_SCHEMA, workerRules, type BriefInput } from "./brief.ts"
import { finalize, FinalizeFailed } from "./finalize.ts"
import { prepareWorktree, realExec, WorktreeRefused, type Exec } from "./git.ts"
import { denyBannedBash, denyWorkerPaths, ENV_TEMPLATE, workerEnv, workerToolDenial } from "./guard.ts"
import { toOutcome, type Outcome, type ResultMessageLike } from "./outcome.ts"

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

export async function runJob(deps: RunDeps, jobId: string): Promise<JobResult> {
  const { paths, config, tracker, exec, log } = deps
  const job = readJson<JobRecord>(jobPath(paths, "running", jobId))
  if (!job) throw new Error(`job ${jobId} is not in jobs/running`)
  const started = deps.now()
  const minutes = () => Math.round((deps.now().getTime() - started.getTime()) / 60_000)
  const finish = (result: JobResult): JobResult => {
    moveJob(paths, jobId, "running", "done", { endedAt: deps.now().toISOString(), result })
    appendLedger(paths, { type: "worker.end", issue: job.issue, ...result }, deps.now())
    return result
  }
  const nothing = { prUrl: null, branch: null, costUsd: null, turns: null, minutes: 0 }

  // 1. read, skip or claim. Linear failing here ends the job the ordinary way,
  // as skipped: a short outage is no fault of the issue or the mini, and a
  // crash here would count as a worker lost early (agentd, heldBackIssues).
  let issue: TrackerIssue
  let branch: string
  try {
    const current = await tracker.readIssue(job.issue)
    const me = await tracker.whoami()
    if (current.state !== "Ready") return finish({ ...nothing, status: "skipped", reason: `the issue is ${current.state}, not Ready` })
    if (current.assigneeId && current.assigneeId !== me.id) return finish({ ...nothing, status: "skipped", reason: "someone else holds the issue" })
    branch = branchNameFor(current.id, current.title)
    const open = await exec("gh", ["pr", "list", "--repo", config.repo.slug, "--head", branch, "--state", "open", "--json", "url", "--jq", ".[0].url // empty"], { cwd: config.repo.path })
    if (open.code === 0 && open.stdout.trim().startsWith("https://")) {
      await tracker.updateIssue(current.id, { state: "In Review" })
      return finish({ ...nothing, status: "skipped", reason: "a PR for this branch is already open", prUrl: open.stdout.trim(), branch })
    }
    issue = await tracker.claimIssue(current.id, config.mini)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    log.warn("Linear failed before the claim", { issue: job.issue, error: message })
    return finish({ ...nothing, status: "skipped", reason: `Linear failed before the claim: ${message}` })
  }
  appendLedger(paths, { type: "claimed", issue: issue.id }, deps.now())
  enqueueSlack(paths, { kind: "post", channel: "agents", text: `claimed ${issue.id} ${issue.title}` }, deps.now())

  const model = modelFor(issue, job, config)
  const limits = { maxTurns: config.worker.maxTurns, maxBudgetUsd: config.worker.maxBudgetUsd, wallClockMinutes: config.worker.wallClockMinutes }
  const autoMerge = readAutoMergePolicy(config.repo.path, config.repo.base) === "auto-after-checks-and-review"
  const finishWith = async (worktree: string | null, outcome: Outcome): Promise<JobResult> => {
    let result: JobResult
    try {
      const fin = await finalize({ exec, tracker, paths, config, issue, branch, worktree, autoMerge, model, minutes: minutes(), now: deps.now }, outcome)
      result = { status: fin.status, reason: fin.reason, prUrl: fin.prUrl, branch, costUsd: outcome.costUsd, turns: outcome.turns, minutes: minutes() }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      enqueueSlack(paths, { kind: "post", channel: "agents", text: `${issue.id}: finishing the job failed (${message}). A person needs to look.` }, deps.now())
      // A PR that opened before the failure is still this job's.
      const prUrl = error instanceof FinalizeFailed ? error.prUrl : null
      result = { status: "blocked", reason: `finishing the job failed: ${message}`, prUrl, branch, costUsd: outcome.costUsd, turns: outcome.turns, minutes: minutes() }
    }
    // Outside the try: the job reaches done once, whatever finalize did (Review Focus 5).
    return finish(result)
  }
  const blockedBefore = (reason: string): Outcome => ({ status: "blocked", reason, report: null, costUsd: null, turns: null, sessionId: null })

  // 2. the worktree
  let worktree: { path: string; resumed: boolean }
  try {
    worktree = await prepareWorktree(exec, { repo: config.repo.path, worktreesDir: paths.worktrees, branch, base: config.repo.base })
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    return finishWith(null, blockedBefore(error instanceof WorktreeRefused ? message : `the worktree could not be prepared: ${message}`))
  }

  // 3. the session
  const brief: BriefInput = { mini: config.mini, issue, worktree: worktree.path, branch, base: config.repo.base, resumed: worktree.resumed, limits }
  const abortController = new AbortController()
  let abortedByClock = false
  const timer = setTimeout(() => {
    abortedByClock = true
    abortController.abort()
  }, config.worker.wallClockMinutes * 60_000)
  let result: ResultMessageLike | null = null
  let thrown: string | null = null
  let initProblem: string | null = null
  // agentd's backstop counts the wall clock from here, not from the spawn: preparing the worktree can take 20 minutes.
  updateJob(paths, "running", jobId, { sessionStartedAt: deps.now().toISOString() })
  log.info("worker session starting", { issue: issue.id, model, worktree: worktree.path, resumed: worktree.resumed })
  try {
    const stream = deps.query({
      prompt: buildBrief(brief),
      options: sdkOptions({
        config,
        cwd: worktree.path,
        model,
        abortController,
        rules: workerRules(brief),
        pnpmStore: deps.pnpmStore,
        env: workerEnv(process.env, { DEV_TASKS_PROFILE: "agent", ...(deps.claudeToken ? { CLAUDE_CODE_OAUTH_TOKEN: deps.claudeToken } : {}) }),
        home: paths.home,
      }),
    })
    let sawInit = false
    for await (const message of stream) {
      if (message.type === "system" && message.subtype === "init") {
        sawInit = true
        initProblem = checkPlugins(message.plugins) ?? checkBilling(message.apiKeySource)
      } else if (!sawInit && ["assistant", "user", "result"].includes(message.type)) {
        // The conversation began, or ended, without the checks (hook events may
        // come first). A session that failed to start says why in its result.
        const said = [...(Array.isArray(message.errors) ? message.errors : []), typeof message.result === "string" ? message.result : ""].filter(Boolean).join(". ")
        initProblem = `the session sent no init message, so the plugin and billing checks could not run${said ? ` (${said})` : ""}`
      }
      if (initProblem) {
        abortController.abort()
        break
      }
      if (message.type === "result") result = message as unknown as ResultMessageLike
    }
  } catch (error) {
    thrown = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
  const outcome = initProblem ? blockedBefore(initProblem) : toOutcome(result, { abortedByClock, thrown, limits })
  log.info("worker session ended", { issue: issue.id, status: outcome.status, reason: outcome.reason, costUsd: outcome.costUsd, turns: outcome.turns })

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
