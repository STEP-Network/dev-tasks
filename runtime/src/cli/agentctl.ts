/**
 * agentctl: the agent mini's local control, for the front door (tick, ack,
 * job submit, ask, slack post and reply), a person on the machine (status,
 * report, pause, resume, doctor) and the rehearsal (probe-hooks). One line of
 * output per call: JSON, or text for status, report and doctor. Usage errors
 * exit 64, anything else 1. Installed as ~/.agentd/bin/agentctl, which runs it
 * with `node --import <tsx's loader>`: tsx's own command opens an IPC socket,
 * and the front door's sandbox refuses that.
 */

import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { join } from "node:path"
import { agentPaths, loadConfig, readProfile, readProfileMini } from "../config.ts"
import { ack, readJson } from "../fsq.ts"
import { heldBackIssues, listJobs, submitJob } from "../jobs.ts"
import { enqueueSlack, type ChannelKey } from "../outbox.ts"
import { loadClaudeOauthToken } from "../secrets.ts"
import { buildDigest, pauseReason } from "../tick.ts"
import { assertNoSecretText, createLinearTracker, readTextFile, type Tracker } from "../tracker.ts"
import { readUsage } from "../usage.ts"
import { frontDoorAlive, lastTickAt, readFrontDoorState } from "../agentd/frontdoor.ts"
import { realExec, type Exec } from "../worker/git.ts"
import { probeHooks } from "../worker/probe.ts"
import { checkBilling, checkPlugins, type QueryFn } from "../worker/run.ts"
import { parseCli, UsageError } from "./args.ts"
import { doctorChecks, formatDoctor } from "./doctor.ts"
import { statusReport, summariseLedger, type StatusInput } from "./report.ts"

export { parseCli, UsageError }

const ISSUE_RE = /^STEP-\d+$/
const CHANNELS: ChannelKey[] = ["agents", "questions", "intake", "releases"]
/** A Slack channel id, as the digest's events carry it: a reply names the channel by id, never by name. */
const CHANNEL_ID_RE = /^[CGD][A-Z0-9]+$/
const THREAD_TS_RE = /^\d+\.\d+$/

export interface AgentctlDeps {
  tracker: () => Tracker
  /** AGENTD_FRONT_DOOR=1 marks the front door's own session (agentd sets it on its tmux session). */
  env: NodeJS.ProcessEnv
  exec: Exec
  now: () => Date
  /** The Agent SDK's query(), loaded only for probe-hooks. */
  query: () => Promise<QueryFn>
}

const DEFAULTS: AgentctlDeps = {
  tracker: () => createLinearTracker(),
  env: process.env,
  exec: realExec,
  now: () => new Date(),
  query: async () => (await import("@anthropic-ai/claude-agent-sdk")).query as unknown as QueryFn,
}

const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

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
    return text.replace(/\n+$/, "")
  }
  const issueFlag = () => {
    const issue = need("issue")
    if (!ISSUE_RE.test(issue)) throw new UsageError(`--issue must look like STEP-123, got ${issue}`)
    return issue
  }

  // Only a person lifts a pause (on the mini, not through Slack), and a probe
  // spends money: the front door's own session may do neither. Its settings
  // deny both as well.
  if (deps.env.AGENTD_FRONT_DOOR === "1" && (command === "resume" || command === "probe-hooks")) {
    throw new Error(`agentctl ${command} is for a person on the mini, not for the front door`)
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
        print(submitJob(paths, issueFlag(), typeof flags.model === "string" ? flags.model : null, now()))
        return 0
      }
      if (rest[0] === "list") {
        print({ pending: listJobs(paths, "pending"), running: listJobs(paths, "running"), done: listJobs(paths, "done").slice(-10) })
        return 0
      }
      throw new UsageError("usage: agentctl job submit --issue STEP-n [--model m] | agentctl job list")
    }
    case "ask": {
      print({ queued: enqueueSlack(paths, { kind: "issue", issue: issueFlag(), text: textFlag(), question: true }, now()) })
      return 0
    }
    case "slack": {
      if (rest[0] === "post") {
        const channel = need("channel")
        if (!CHANNELS.includes(channel as ChannelKey)) throw new UsageError(`--channel must be one of ${CHANNELS.join(", ")}`)
        print({ queued: enqueueSlack(paths, { kind: "post", channel: channel as ChannelKey, text: textFlag() }, now()) })
        return 0
      }
      if (rest[0] === "reply") {
        const channelId = need("channel")
        const threadTs = need("thread")
        const text = textFlag()
        if (!CHANNEL_ID_RE.test(channelId)) throw new UsageError(`--channel must be a Slack channel id (C...), as the event carries it, got ${channelId}`)
        if (!THREAD_TS_RE.test(threadTs)) throw new UsageError(`--thread must be a Slack message ts (1790000000.000100), got ${threadTs}`)
        print({ queued: enqueueSlack(paths, { kind: "reply", channelId, threadTs, text }, now()) })
        return 0
      }
      throw new UsageError("usage: agentctl slack post --channel <key> --text <t> | agentctl slack reply --channel <id> --thread <ts> --text <t> (or --text-file <path> for either)")
    }
    case "pause": {
      mkdirSync(paths.root, { recursive: true })
      writeFileSync(paths.pauseFile, JSON.stringify({ at: now().toISOString(), reason: typeof flags.reason === "string" ? flags.reason : "" }))
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
          agentd: readJson<{ pid: number; at: string; error?: string }>(join(paths.state, "agentd.json")),
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
      print(summariseLedger(events, new Date(now().getTime() - days * 86_400_000)))
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
        fresh: flags.fresh === true,
      })
      const { text, ok } = formatDoctor(checks)
      print(text)
      return ok ? 0 : 1
    }
    case "probe-hooks": {
      // Spends a few cents: a real SDK session in a throwaway repository.
      const verdict = await probeHooks({ query: await deps.query(), config: loadConfig(paths), exec: deps.exec, claudeToken: loadClaudeOauthToken(paths.home) })
      print(verdict)
      // What every job needs: both guards fire, the plugin loaded exactly once, and the subscription pays.
      const once = checkPlugins(verdict.loadedPlugins.map((name) => ({ name }))) === null
      return verdict.pluginHookFired && verdict.workerGuardFired && once && checkBilling(verdict.apiKeySource) === null ? 0 : 1
    }
    default:
      throw new UsageError("usage: agentctl <tick|ack|job|ask|slack|pause|resume|status|report|doctor|probe-hooks> (see runtime/src/cli/agentctl.ts)")
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
