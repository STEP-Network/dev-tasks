/**
 * agentctl: the agent mini's local control, for the front door (tick, ack,
 * job submit, usertest, ask, slack post and reply), a person on the machine (status,
 * report, retro, pause, resume, retry, doctor, probe-sandbox, probe-hooks --scripted,
 * probe-browser) and the rehearsal (probe-hooks). One line of output per call: JSON, or text for
 * status, report, doctor and the free probes. Usage errors exit 64, anything
 * else 1.
 * Installed as ~/.agentd/bin/agentctl (runtime/templates/shim.sh), which runs
 * it with a clean environment and `node --import <tsx's loader>`.
 */

import { existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { join, sep } from "node:path"
import { fileURLToPath } from "node:url"
import { agentPaths, loadConfig, readProfile, readProfileMini, type AgentConfig } from "../config.ts"
import { ack, readJson } from "../fsq.ts"
import { heldBackIssues, jobPath, listJobs, submitJob, type JobRecord } from "../jobs.ts"
import { enqueueSlack, type ChannelKey } from "../outbox.ts"
import { channelApproval, MANAGED_SETTINGS } from "../channel/managed.ts"
import { actionsAsked, decisionText, fileInstructionFor, personEntry, recordDecision, type Decision } from "../decide.ts"
import { handoff, RECOMMENDATION_LEAD, withRecommendation } from "../plain.ts"
import type { Action, InstructionEntry } from "../slack/instruction.ts"
import { loadClaudeOauthToken } from "../secrets.ts"
import { buildDigest, inboxEvents, pauseReason } from "../tick.ts"
import { readChannelState } from "../channel/state.ts"
import { assertNoSecretText, createLinearTracker, readTextFile, type Tracker } from "../tracker.ts"
import { createPeopleView, type PeopleView } from "../monday/people.ts"
import { parseVerdict, recordVerdict, verdictReply } from "../verdict.ts"
import { readUsage } from "../usage.ts"
import { frontDoorAlive, lastTickAt, readFrontDoorState } from "../agentd/frontdoor.ts"
import { realExec, type Exec } from "../worker/git.ts"
import { probeHooks } from "../worker/probe.ts"
import { formatBrowserProbe, probeBrowser } from "../usertest/probe.ts"
import { checkBilling, checkPlugins, type QueryFn } from "../worker/run.ts"
import { parseCli, UsageError } from "./args.ts"
import { doctorChecks, formatDoctor } from "./doctor.ts"
import { statusReport, summariseLedger, type StatusInput } from "./report.ts"
import { spawnRetroProcess } from "../agentd/jobrunner.ts"
import { noEvidence } from "../retro/evidence.ts"
import { noFyi } from "../retro/fyi.ts"
import { readLessons } from "../retro/lessons.ts"
import { localParts, readRetroState, runRetro, writeRetroState } from "../retro/retro.ts"
import { probeWorkerHooks, recordHooksProbe, workerClaudePath } from "./hooks-probe.ts"
import { probeFrontDoorSandbox, recordSandboxProbe } from "./sandbox-probe.ts"

export { parseCli, UsageError }

const ISSUE_RE = /^STEP-\d+$/
const CHANNELS: ChannelKey[] = ["agents", "questions", "intake", "releases"]
/** A Slack channel id, as the digest's events carry it: a reply names the channel by id, never by name. */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/
const THREAD_TS_RE = /^\d+\.\d+$/
const PERSON_ONLY = new Set(["resume", "retry", "probe-hooks", "probe-sandbox"])
const RUNTIME_DIR = fileURLToPath(new URL("../..", import.meta.url))

export interface AgentctlDeps {
  tracker: () => Tracker
  /** AGENTD_FRONT_DOOR=1 marks the front door's own session (agentd sets it on its tmux session). */
  env: NodeJS.ProcessEnv
  /** Whether a person's terminal is attached: stdin is a TTY over ssh -t or in Terminal, never in the front door's Bash. */
  isTTY: () => boolean
  exec: Exec
  now: () => Date
  /** The Agent SDK's query(), loaded only for the probes. */
  query: () => Promise<QueryFn>
  /** The Claude Code workers run: the Agent SDK's own (hooks-probe.ts). */
  workerClaude: () => string | null
  /** Claude Code's managed settings on this machine, which approve the Slack channel. */
  managedSettings: string
  /** Linear's people-facing reads: a UAT fix's parent and its adoption (verdict). */
  people: () => Pick<PeopleView, "adoptFix" | "parentOf">
}

const DEFAULTS: AgentctlDeps = {
  tracker: () => createLinearTracker(),
  env: process.env,
  isTTY: () => Boolean(process.stdin.isTTY),
  exec: realExec,
  now: () => new Date(),
  query: async () => (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn,
  workerClaude: workerClaudePath,
  managedSettings: MANAGED_SETTINGS,
  people: () => createPeopleView(),
}

/** Why agentd starts the front door without the Slack channel, or null when it opens it (agentd/frontdoor.ts). */
function channelOff(config: AgentConfig, managedSettings: string): string | null {
  if (!config.frontDoor.channel) return "frontDoor.channel in config.json"
  const approval = channelApproval(managedSettings)
  return approval.ok ? null : approval.why
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))
const quietLog = { info: () => {}, warn: () => {}, error: () => {} }

export async function run(argv: string[], out: (line: string) => void, overrides: Partial<AgentctlDeps> = {}): Promise<number> {
  const deps = { ...DEFAULTS, ...overrides }
  const { command, rest, flags } = parseCli(argv)
  const paths = agentPaths()
  const now = deps.now
  const print = (value: unknown) => out(typeof value === "string" ? value : JSON.stringify(value))
  const need = (name: string): string => {
    const value = flags[name]
    if (typeof value !== "string" || !value.trim()) throw new UsageError(`--${name} is required`)
    return value
  }
  // The message, inline or from a file (--text-file), where no shell expands
  // people's words. agentctl runs outside the front door's sandbox, so a
  // secrets file or a token in the text is refused here, not there.
  const textFlag = (): string => {
    const inline = typeof flags.text === "string" ? flags.text : undefined
    const file = typeof flags["text-file"] === "string" ? flags["text-file"] : undefined
    if (inline !== undefined && file !== undefined) throw new UsageError("--text and --text-file are two ways to give one text: give one")
    if (inline === undefined && file === undefined) throw new UsageError("--text or --text-file is required")
    let text: string
    try {
      text = file !== undefined ? readTextFile(file, "--text-file") : (inline as string)
      assertNoSecretText(text, file !== undefined ? "--text-file" : "--text")
    } catch (error) {
      if (error instanceof UsageError) throw error
      throw new UsageError(message(error).replace(/^usage: /, ""))
    }
    if (!text.trim()) throw new UsageError("the text is empty")
    if (file !== undefined) textFiles.push(file)
    return text.replace(/\n+$/, "")
  }
  // A reply or a question file in ~/.front-door is spent once queued: a write
  // that failed later must not send an old one again. Nothing elsewhere is touched.
  const textFiles: string[] = []
  const spend = () => {
    for (const file of textFiles) {
      try {
        const real = realpathSync(file)
        if (real.startsWith(realpathSync(join(paths.home, ".front-door")) + sep)) rmSync(real, { force: true })
      } catch {
        // Gone already, or no ~/.front-door: nothing to spend.
      }
    }
  }
  const recommendationFlag = (): string => {
    const inline = typeof flags.recommendation === "string" ? flags.recommendation : undefined
    const file = typeof flags["recommendation-file"] === "string" ? flags["recommendation-file"] : undefined
    if (inline === undefined && file === undefined) {
      throw new UsageError("--recommendation or --recommendation-file is required: every question says what you recommend, and a reply of yes agrees to it")
    }
    if (inline !== undefined && file !== undefined) throw new UsageError("--recommendation and --recommendation-file are two ways to give one text: give one")
    let text: string
    try {
      text = file !== undefined ? readTextFile(file, "--recommendation-file") : (inline as string)
      assertNoSecretText(text, file !== undefined ? "--recommendation-file" : "--recommendation")
    } catch (error) {
      if (error instanceof UsageError) throw error
      throw new UsageError(message(error).replace(/^usage: /, ""))
    }
    if (!text.trim()) throw new UsageError("the recommendation is empty")
    if (file !== undefined) textFiles.push(file)
    return text.trim()
  }
  const issueFlag = () => {
    const issue = need("issue")
    if (!ISSUE_RE.test(issue)) throw new UsageError(`--issue must look like STEP-123, got ${issue}`)
    return issue
  }

  // Only a person lifts a pause (on the mini, not through Slack), a hooks
  // probe spends money, and the sandbox probe records what doctor trusts: the
  // front door may do none of them. Its settings deny them, it carries
  // AGENTD_FRONT_DOOR=1, and its Bash has no terminal, which a variable set in
  // front of the command cannot fake.
  if (PERSON_ONLY.has(command) && (deps.env.AGENTD_FRONT_DOOR === "1" || !deps.isTTY())) {
    throw new Error(`agentctl ${command} is for a person at a terminal on the mini (ssh -t, or Screen Sharing), not for the front door`)
  }

  switch (command) {
    case "tick": {
      print(await buildDigest({ paths, config: loadConfig(paths), tracker: deps.tracker(), now }))
      return 0
    }
    case "ack": {
      if (!rest.length) throw new UsageError("ack needs at least one event key")
      print({ acked: rest.filter((key) => ack(paths.inbox, key)).length })
      return 0
    }
    case "job": {
      if (rest[0] === "submit") {
        // Also how a person lifts a held-back issue: the digest no longer offers it, this runs one by hand.
        const issue = issueFlag()
        let model: string | null = null
        if (flags.model !== undefined) {
          // Only the two models the config names: the worker passes this straight to the SDK.
          const { worker } = loadConfig(paths)
          const allowed = [...new Set([worker.defaultModel, worker.complexModel])]
          if (typeof flags.model !== "string" || !allowed.includes(flags.model)) {
            throw new UsageError(`--model must be one of ${allowed.join(", ")} (config.json's worker models)`)
          }
          model = flags.model
        }
        print(submitJob(paths, issue, model, now()))
        return 0
      }
      if (rest[0] === "list") {
        print({ pending: listJobs(paths, "pending"), running: listJobs(paths, "running"), done: listJobs(paths, "done").slice(-10) })
        return 0
      }
      throw new UsageError("usage: agentctl job submit --issue STEP-n [--model m] | agentctl job list")
    }
    case "usertest": {
      // The browser test on staging, for agent UAT (review-uat). Its PR says what changed.
      const issue = issueFlag()
      const prFlag = need("pr")
      if (!/^\d+$/.test(prFlag) || Number(prFlag) <= 0) throw new UsageError("--pr must be the merged PR's number")
      const pr = Number(prFlag)
      const target = flags.target === undefined ? "staging" : flags.target
      if (target !== "staging" && target !== "rc") throw new UsageError("--target is staging or rc")
      print(submitJob(paths, issue, null, now(), { kind: "usertest", usertest: { target, pr } }))
      return 0
    }
    case "probe-browser": {
      // Free and changes nothing: the real Chrome and the pinned browser tool, with no model.
      const probe = formatBrowserProbe(await probeBrowser(loadConfig(paths)))
      print(probe.text)
      return probe.ok ? 0 : 1
    }
    case "retry": {
      // A blocked job again, on its issue's branch: prepareWorktree carries the
      // commits on, and the runner takes the issue On hold. A person decides
      // that the block is lifted, so the front door may not.
      const id = rest[0]
      if (!id || rest.length > 1) throw new UsageError("usage: agentctl retry <jobId> (agentctl job list shows the ids)")
      if (!/^STEP-\d+-\d{14}$/.test(id)) throw new UsageError(`${id} is not a job id, like STEP-7-20260925071840`)
      const old = readJson<JobRecord>(jobPath(paths, "done", id))
      if (!old) throw new Error(`no finished job ${id}: agentctl job list shows the last ten`)
      if (old.result?.status !== "blocked") throw new Error(`${id} ended ${old.result?.status ?? "without a result"}: only a blocked job is retried`)
      if (old.kind === "usertest") throw new Error(`${id} is a browser test, not work on the issue: agentctl usertest --issue ${old.issue} --pr ${old.usertest?.pr ?? "<number>"} queues it again`)
      print(submitJob(paths, old.issue, old.model, now(), { retryOf: old.id }))
      return 0
    }
    case "ask": {
      // Every question a person must answer carries this mini's recommendation (STEP-3293), which a "yes" agrees to.
      // A hand-off asks for their hands, not a choice: it ends "Reply done when it is done", with nothing a yes could agree to.
      const issue = issueFlag()
      const question = textFlag()
      if (flags.handoff === true) {
        if (flags.recommendation !== undefined || flags["recommendation-file"] !== undefined) {
          throw new UsageError("--handoff asks a person to do something, so it carries no recommendation for a yes to agree to: drop --recommendation")
        }
        print({ queued: enqueueSlack(paths, { kind: "issue", issue, text: handoff(question), question: true }, now()) })
      } else {
        print({ queued: enqueueSlack(paths, { kind: "issue", issue, text: withRecommendation(question, recommendationFlag()), question: true }, now()) })
      }
      spend()
      return 0
    }
    case "decide": {
      // A person's reply the front door read as a decision (STEP-3293): recorded on the issue as words that stand on their own.
      const entry = personEntry(paths, need("key"))
      const agree = flags.agree === true
      if (agree && (flags.text !== undefined || flags["text-file"] !== undefined)) throw new UsageError("--agree records the recommendation: give it without --text or --text-file")
      let decision: Decision
      try {
        decision = decisionText(paths, entry, agree ? { agree: true } : { text: textFlag() })
      } catch (error) {
        if (error instanceof UsageError) throw error
        throw new UsageError(message(error))
      }
      try {
        print({ decided: await recordDecision({ paths, tracker: deps.tracker(), now }, entry, decision), decision: decision.recorded })
      } catch (error) {
        if (!(error instanceof Error) || !/human-todo|not in an issue's thread/.test(error.message)) throw error
        throw new UsageError(error.message)
      }
      spend()
      return 0
    }
    case "verdict": {
      // A person's PASS or FAIL (on a Look also "looks good" or "change") in the thread of an issue waiting to be tried.
      // The verdict is read from their own words, never from the front door's (spec 9: fixed verbs only).
      const entry = personEntry(paths, need("key"))
      if (entry.type !== "reply" || !entry.issue) throw new UsageError(`${entry.key} is not a reply in an issue's thread`)
      const tracker = deps.tracker()
      const current = await tracker.readIssue(entry.issue)
      const look = current.labels.includes("approval/look")
      const who = entry.userName || entry.user
      const verdict = parseVerdict(entry.readableText ?? entry.text, look)
      if (!verdict) {
        throw new UsageError(`${who}'s words do not start with PASS or FAIL${look ? ', "looks good" or "change"' : ""}, so they are not a verdict: answer them in the thread`)
      }
      const out = await recordVerdict(
        { paths, tracker, people: deps.people(), product: loadConfig(paths).repo.product, now },
        { issue: entry.issue, who, verdict, where: entry.permalink ?? "Slack", source: "slack", key: `${entry.channel}:${entry.ts}` },
      )
      const threadTs = entry.threadTs ?? entry.ts
      enqueueSlack(paths, { kind: "reply", channelId: entry.channel, threadTs, text: verdictReply(who, out) }, now())
      // Words first, and a tick beside them only when something was recorded.
      if (out.outcome !== "not-waiting") enqueueSlack(paths, { kind: "react", channelId: entry.channel, ts: entry.ts, name: "white_check_mark" }, now())
      ack(paths.inbox, entry.key)
      print({ issue: entry.issue, ...out })
      spend()
      return 0
    }
    case "instruct": {
      // A person's reply the front door read as one of the fixed actions: agentd acts on it and replies (agentd/instructions.ts).
      const entry = personEntry(paths, need("key"))
      const named = need("actions").split(",").map((a) => a.trim()).filter(Boolean)
      const aimed: InstructionEntry["target"] = {}
      const given = typeof flags.target === "string" ? flags.target : undefined
      if (given !== undefined) {
        if (ISSUE_RE.test(given)) aimed.issue = given
        else if (/^#?\d{2,6}$/.test(given)) aimed.pr = Number(given.replace("#", ""))
        else throw new UsageError(`--target must be STEP-<n> or #<number>, got ${given}`)
      }
      try {
        // Only what their words ask for, on what they name, or "default": a plain yes to agentd's decision takes the reply it recommended.
        const { actions, target }: { actions: Action[]; target: InstructionEntry["target"] } = actionsAsked(paths, entry, named, aimed)
        const filed = fileInstructionFor(paths, entry, actions, target, now())
        print(filed ? { filed: filed.key, actions: filed.actions } : { filed: null, doneByBridge: entry.acted ?? [] })
      } catch (error) {
        throw new UsageError(message(error))
      }
      return 0
    }
    case "slack": {
      if (rest[0] === "post") {
        const channel = need("channel")
        if (!CHANNELS.includes(channel as ChannelKey)) throw new UsageError(`--channel must be one of ${CHANNELS.join(", ")}`)
        print({ queued: enqueueSlack(paths, { kind: "post", channel: channel as ChannelKey, text: textFlag() }, now()) })
        spend()
        return 0
      }
      if (rest[0] === "reply") {
        const channelId = need("channel")
        const threadTs = need("thread")
        const text = textFlag()
        if (!CHANNEL_ID_RE.test(channelId)) throw new UsageError(`--channel must be a Slack channel id (C...), as the event carries it, got ${channelId}`)
        if (!THREAD_TS_RE.test(threadTs)) throw new UsageError(`--thread must be a Slack message ts (1790000000.000100), got ${threadTs}`)
        // The thread keeps a question's recommendation for a later yes only when agentctl ask posts it (STEP-3293 review).
        if (text.includes(RECOMMENDATION_LEAD)) {
          throw new UsageError("a reply that recommends something is a question: post it with agentctl ask --issue <id> --text-file <question> --recommendation-file <recommendation>, so a yes agrees to it")
        }
        print({ queued: enqueueSlack(paths, { kind: "reply", channelId, threadTs, text, frontDoor: true }, now()) })
        spend()
        return 0
      }
      throw new UsageError("usage: agentctl slack post --channel <key> --text <t> | agentctl slack reply --channel <id> --thread <ts> --text <t> (or --text-file <path> for either)")
    }
    case "pause": {
      const reason = typeof flags.reason === "string" ? flags.reason : ""
      try {
        // agentctl status and the front door's digest show it to people.
        assertNoSecretText(reason, "--reason")
      } catch (error) {
        throw new UsageError(message(error).replace(/^usage: /, ""))
      }
      mkdirSync(paths.root, { recursive: true })
      writeFileSync(paths.pauseFile, JSON.stringify({ at: now().toISOString(), reason }))
      print({ paused: true })
      return 0
    }
    case "resume": {
      // Lifts any pause: a person's, or agentd's after early losses on two
      // issues (whose losses count towards nothing afterwards), or the runner's.
      const was = pauseReason(paths)
      rmSync(paths.pauseFile, { force: true })
      print(was ? { paused: false, was } : { paused: false })
      return 0
    }
    case "status": {
      const config = loadConfig(paths)
      const fd = readFrontDoorState(paths)
      const runningJob = listJobs(paths, "running")[0]
      const tracker = deps.tracker()
      let linear: StatusInput["linear"]
      let heldBack = [...heldBackIssues(paths)].sort()
      try {
        linear = { ok: true, email: (await tracker.whoami()).email }
        // Held back means held back from the Ready queue: one a person moved on since is not.
        const ready = new Set((await tracker.listReady(250)).map((i) => i.id))
        heldBack = heldBack.filter((id) => ready.has(id))
      } catch (error) {
        linear = { ok: false, error: message(error) }
      }
      print(
        statusReport({
          mini: config.mini,
          paused: pauseReason(paths),
          agentd: readJson<NonNullable<StatusInput["agentd"]>>(join(paths.state, "agentd.json")),
          frontDoor: {
            alive: await frontDoorAlive({ exec: deps.exec, config }),
            lastWakeAt: lastTickAt(paths),
            startsLastHour: fd.starts.filter((t) => Date.parse(t) > now().getTime() - 3_600_000).length,
            waitUntil: fd.waitUntil,
          },
          worker: runningJob
            ? {
                issue: runningJob.issue,
                minutes: Math.round((now().getTime() - Date.parse(runningJob.startedAt ?? runningJob.submittedAt)) / 60_000),
                pid: runningJob.pid ?? null,
              }
            : null,
          pending: listJobs(paths, "pending").map((j) => j.issue),
          heldBack,
          bridge: readJson<NonNullable<StatusInput["bridge"]>>(join(paths.state, "bridge.json")),
          channel: { at: readChannelState(paths)?.at ?? null, waiting: inboxEvents(paths, config).length, off: channelOff(config, deps.managedSettings) },
          usage: readUsage(paths),
          linear,
          now: now(),
        }),
      )
      return 0
    }
    case "report": {
      const days = typeof flags.days === "string" ? Number.parseInt(flags.days, 10) : 7
      if (!Number.isFinite(days) || days <= 0) throw new UsageError("--days must be a positive number")
      const file = join(paths.logs, "ledger.jsonl")
      const lines = existsSync(file) ? readFileSync(file, "utf8").split("\n").filter(Boolean) : []
      const events = lines.flatMap((line) => {
        try {
          return [JSON.parse(line)]
        } catch {
          return []
        }
      })
      print(summariseLedger(events, new Date(now().getTime() - days * 86_400_000), readLessons(paths), now()))
      return 0
    }
    case "retro": {
      // The weekly retro (STEP-3290). Plain: a dry run, which prints the PR
      // body the retro would open and its Slack summary, and runs no session,
      // no git and no Slack. --run starts the real one now, at a person's terminal.
      const config = loadConfig(paths)
      const slot = localParts(now(), config.queue.timeZone).date
      if (flags.run === true) {
        if (deps.env.AGENTD_FRONT_DOOR === "1" || !deps.isTTY()) throw new Error("agentctl retro --run is for a person at a terminal on the mini (ssh -t, or Screen Sharing), not for the front door")
        const state = readRetroState(paths)
        if (state?.slot === slot && !state.endedAt) throw new Error(`the retro for ${slot} is running already (pid ${state.pid ?? "unknown"})`)
        const pid = spawnRetroProcess(paths, RUNTIME_DIR)(slot)
        writeRetroState(paths, { slot, startedAt: now().toISOString(), pid })
        print({ started: slot, pid, log: join(paths.logs, `retro-${slot}.log`) })
        return 0
      }
      const noSession: QueryFn = () => {
        throw new Error("a dry run runs no session")
      }
      const r = await runRetro({ paths, config, exec: deps.exec, query: noSession, now, log: quietLog, fyi: noFyi, evidence: noEvidence, claudeToken: null }, { slot, dryRun: true })
      print([r.body, "", "## Slack, once it has run", "", r.summary].join("\n"))
      return 0
    }
    case "doctor": {
      const checks = await doctorChecks({
        paths,
        exec: deps.exec,
        env: process.env,
        nodeVersion: process.versions.node,
        profile: () => {
          try {
            return readProfile()
          } catch (error) {
            return `unreadable (${message(error)})`
          }
        },
        profileMini: () => readProfileMini(),
        workerClaude: deps.workerClaude,
        fresh: flags.fresh === true,
      })
      const { text, ok } = formatDoctor(checks)
      print(text)
      return ok ? 0 : 1
    }
    case "probe-hooks": {
      if (flags.scripted !== undefined && flags.scripted !== true) throw new UsageError("--scripted takes no value")
      // Both kinds probe, and record, the binary workers run: the Agent SDK's own.
      const config = loadConfig(paths)
      const claudePath = deps.workerClaude()
      if (!claudePath) throw new Error("the Agent SDK's claude is missing, and no worker can start without it: cd ~/dev-tasks/runtime && npm ci")
      const version = await deps.exec(claudePath, ["--version"])
      if (version.code !== 0) throw new Error(`${claudePath} --version failed: ${version.stderr.trim() || `exit ${version.code}`}`)
      const claudeVersion = version.stdout.trim().split("\n")[0]
      if (flags.scripted === true) {
        // Free: the fake Messages API on loopback, and no login.
        const probe = await probeWorkerHooks({ query: await deps.query(), config, claudePath, now })
        probe.claudeVersion = claudeVersion
        recordHooksProbe(paths, probe)
        print(
          [
            ...probe.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`),
            probe.ok ? `the worker's hooks fire on ${claudeVersion}` : `the worker's hooks do NOT all fire on ${claudeVersion}: keep the mini paused`,
          ].join("\n"),
        )
        return probe.ok ? 0 : 1
      }
      // Spends a few cents: a real SDK session in a throwaway repository.
      const verdict = await probeHooks({ query: await deps.query(), config, exec: deps.exec, claudeToken: loadClaudeOauthToken(paths.home) })
      print(verdict)
      // What every job needs: both guards fire, the plugin loaded exactly once, and the subscription pays.
      const once = checkPlugins(verdict.loadedPlugins.map((name) => ({ name }))) === null
      const ok = verdict.pluginHookFired && verdict.workerGuardFired && once && checkBilling(verdict.apiKeySource) === null
      recordHooksProbe(paths, { at: now().toISOString(), kind: "model", claudePath, claudeVersion, ok, ...verdict, checks: [] })
      return ok ? 0 : 1
    }
    case "probe-sandbox": {
      // Free: fakes of the Messages API and Linear on loopback. With the front
      // door's own binary, so the record is about what the front door runs.
      // Only the binary the front door runs: the record is what agentd starts it on.
      if (flags.claude !== undefined) throw new UsageError("probe-sandbox probes the front door's own claude (config.json's frontDoor.claudePath), never another")
      const claudePath = loadConfig(paths).frontDoor.claudePath
      const version = await deps.exec(claudePath, ["--version"])
      if (version.code !== 0) throw new Error(`${claudePath} --version failed: ${version.stderr.trim() || `exit ${version.code}`}`)
      const probe = await probeFrontDoorSandbox({ query: await deps.query(), claudePath, runtime: RUNTIME_DIR, plugin: join(RUNTIME_DIR, "..", "plugin"), now })
      probe.claudeVersion = version.stdout.trim().split("\n")[0]
      recordSandboxProbe(paths, probe)
      print(
        [
          ...probe.checks.map((c) => `${c.ok ? "ok  " : "FAIL"} ${c.name}${c.ok ? "" : `: ${c.detail}`}`),
          probe.ok ? `the front door's sandbox holds on ${probe.claudeVersion}` : `the front door's sandbox does NOT hold on ${probe.claudeVersion}: keep the mini paused`,
        ].join("\n"),
      )
      return probe.ok ? 0 : 1
    }
    default:
      throw new UsageError(
        "usage: agentctl <tick|ack|job|usertest|ask|decide|verdict|instruct|slack|pause|resume|retry|status|report|retro|doctor|probe-hooks|probe-sandbox|probe-browser> (see runtime/src/cli/agentctl.ts)",
      )
  }
}

if (process.argv[1]?.endsWith("agentctl.ts")) {
  run(process.argv.slice(2), (line) => process.stdout.write(line + "\n"))
    .then((code) => process.exit(code))
    .catch((error: unknown) => {
      process.stderr.write(message(error) + "\n")
      process.exit(error instanceof UsageError ? 64 : 1)
    })
}
