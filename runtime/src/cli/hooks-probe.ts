/**
 * `agentctl probe-hooks --scripted`: do the plugin's hooks and the worker's
 * own guard refuse what they must, in a worker session on the binary workers
 * run? The worker's real sdkOptions, in a throwaway HOME, checkout and
 * worktree, against the local fake Messages API (probe-fakes.ts) scripted to
 * attempt each command. Nothing leaves the machine, nothing is billed, no
 * login is needed (it runs over ssh -tt), and no model can decline a command,
 * which the real-model `agentctl probe-hooks` cannot rule out.
 *
 * Workers set no pathToClaudeCodeExecutable, so they run the Claude Code the
 * Agent SDK ships, not the front door's claude. That is the binary probed and
 * recorded, and doctor compares the record with it: an SDK update (npm ci
 * after a pull) asks for a new probe. Either probe, passed on that binary,
 * is doctor's proof.
 */

import { execFileSync } from "node:child_process"
import { chmodSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { tmpdir, userInfo } from "node:os"
import { dirname, join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"
import { checkPlugins, sdkOptions, type QueryFn } from "../worker/run.ts"
import { startFakeApi, type ToolCall } from "./probe-fakes.ts"
import type { ProbeCheck } from "./sandbox-probe.ts"

export interface HooksProbe {
  at: string
  /** scripted: this probe, free and deterministic. model: `agentctl probe-hooks`, a real session. */
  kind: "scripted" | "model"
  /** The binary probed: the Agent SDK's, which workers run. */
  claudePath: string | null
  claudeVersion: string | null
  ok: boolean
  pluginHookFired: boolean
  workerGuardFired: boolean
  loadedPlugins: string[]
  /** model only: what the session billed ("none" is the subscription). */
  apiKeySource?: string | null
  checks: ProbeCheck[]
}

export const hooksProbePath = (paths: AgentPaths) => join(paths.state, "hooks-probe.json")

/** The last run of each kind. */
export function readHooksProbes(paths: AgentPaths): Partial<Record<HooksProbe["kind"], HooksProbe>> {
  return readJson<Partial<Record<HooksProbe["kind"], HooksProbe>>>(hooksProbePath(paths)) ?? {}
}

export function recordHooksProbe(paths: AgentPaths, probe: HooksProbe): void {
  writeJsonAtomic(hooksProbePath(paths), { ...readHooksProbes(paths), [probe.kind]: probe })
}

/**
 * The Claude Code every worker runs: the one the Agent SDK ships, found the
 * way the SDK finds it (its platform package, beside the SDK). null when it
 * is missing, which no worker survives either.
 */
export function workerClaudePath(): string | null {
  try {
    const pkg = createRequire(import.meta.url).resolve(`@anthropic-ai/claude-agent-sdk-${process.platform}-${process.arch}/package.json`)
    const bin = join(dirname(pkg), "claude")
    return existsSync(bin) ? bin : null
  } catch {
    return null
  }
}

/** A marker in the fake key file: it must never show up in anything a command returned. */
const MARKER = "PROBE_SECRET_4b8e2d"

const short = (text: string) => text.replace(/\s+/g, " ").trim().slice(0, 200)

export interface HooksProbeDeps {
  query: QueryFn
  config: AgentConfig
  /** The binary to probe: workerClaudePath(). Absent: the SDK finds its own, the same one. */
  claudePath?: string
  now: () => Date
}

export async function probeWorkerHooks(d: HooksProbeDeps): Promise<HooksProbe> {
  const home = realpathSync(mkdtempSync(join(tmpdir(), "hooks-probe-")))
  try {
    const write = (rel: string, body: string, mode = 0o644) => {
      mkdirSync(join(home, rel, ".."), { recursive: true })
      writeFileSync(join(home, rel), body)
      chmodSync(join(home, rel), mode)
    }
    const git = (...args: string[]) => execFileSync("git", args, { stdio: "ignore" })
    // A mini's home (the agent profile, a key file with a marker and no key),
    // the main checkout and a worker's worktree of it.
    write(".claude/dev-tasks-profile.json", JSON.stringify({ profile: "agent", devSurface: "preview", mini: d.config.mini }))
    write(".config/linear/.env", `# ${MARKER}\nLINEAR_API_KEY=\n`, 0o600)
    const main = join(home, "polads")
    write("polads/keep.txt", "committed\n")
    git("init", "-q", "-b", "staging", main)
    git("-C", main, "add", "keep.txt")
    git("-C", main, "-c", "user.name=probe", "-c", "user.email=probe@localhost", "commit", "-q", "-m", "base")
    const worktree = join(home, "worktrees", "STEP-0-probe")
    git("-C", main, "worktree", "add", "-q", "-b", "STEP-0-probe", worktree)
    git("-C", main, "branch", "probe-old")
    // What the destructive commands would destroy, were they to run.
    write("worktrees/STEP-0-probe/keep.txt", "edited\n")
    write("worktrees/STEP-0-probe/untracked.txt", "new\n")

    type Step = { name: string; command: string; by: "plugin" | "worker"; expect: string }
    const plugin = (name: string, command: string): Step => ({ name, command, by: "plugin", expect: "Destructive command detected" })
    const steps: Step[] = [
      plugin("the plugin's guard refuses git reset --hard", "git reset --hard HEAD"),
      plugin("the plugin's guard refuses rm -rf", "rm -rf build"),
      plugin("the plugin's guard refuses git clean -f", "git clean -fd"),
      plugin("the plugin's guard refuses git branch -D", "git branch -D probe-old"),
      plugin("the plugin's guard refuses git checkout .", "git checkout ."),
      plugin("the plugin's guard refuses one joined to another command", "git status && git reset --hard HEAD"),
      { name: "the worker's guard refuses opening a PR", command: "gh pr create --fill", by: "worker", expect: "Workers never open or merge PRs" },
      { name: "the worker's guard refuses reading ~/.config", command: "cat ~/.config/linear/.env", by: "worker", expect: "Workers never read or write ~/.config" },
    ]

    // The worker's own options, but for the checkout, the fake API and the binary.
    const config: AgentConfig = { ...d.config, repo: { ...d.config.repo, path: main } }
    const options = sdkOptions({ config, cwd: worktree, model: d.config.worker.defaultModel, abortController: new AbortController(), rules: "The hooks probe.", pnpmStore: null, env: {}, home })
    delete options.outputFormat
    options.maxTurns = steps.length + 4
    if (d.claudePath) options.pathToClaudeCodeExecutable = d.claudePath

    const results: string[] = []
    let plugins: unknown = []
    const api = await startFakeApi(steps.map((s): ToolCall => ({ name: "Bash", input: { command: s.command, description: "probe" } })))
    try {
      options.env = {
        HOME: home,
        USER: userInfo().username,
        PATH: process.env.PATH ?? "/usr/bin:/bin",
        TMPDIR: tmpdir(),
        // A key only the fake API sees: ANTHROPIC_BASE_URL is the fake's.
        ANTHROPIC_API_KEY: "sk-ant-api03-PROBEONLY",
        ANTHROPIC_BASE_URL: api.url,
        CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: "1",
        DISABLE_AUTOUPDATER: "1",
        DISABLE_TELEMETRY: "1",
        DISABLE_ERROR_REPORTING: "1",
        DEV_TASKS_PROFILE: "agent",
      }
      for await (const m of d.query({ prompt: "go", options })) {
        const message = m as { type?: string; subtype?: string; plugins?: unknown; message?: { content?: unknown } }
        if (message.type === "system" && message.subtype === "init") plugins = message.plugins
        if (message.type !== "user" || !Array.isArray(message.message?.content)) continue
        for (const c of message.message.content as Array<{ type?: string; content?: unknown }>) {
          if (c.type === "tool_result") results.push(typeof c.content === "string" ? c.content : JSON.stringify(c.content))
        }
      }
    } finally {
      await api.close()
    }

    const checks: ProbeCheck[] = steps.map((s, i) => {
      const result = results[i]
      return { name: s.name, ok: result !== undefined && result.includes(s.expect), detail: result === undefined ? "no result" : short(result) }
    })
    const loaded = Array.isArray(plugins) ? (plugins as Array<{ name?: string; path?: string }>) : []
    const ours = loaded.filter((p) => p.name === "dev-tasks")
    const read = (rel: string) => (existsSync(join(home, rel)) ? readFileSync(join(home, rel), "utf8") : null)
    const after: ProbeCheck[] = [
      {
        name: "dev-tasks loaded once, from pluginRoot",
        ok: checkPlugins(loaded) === null && ours[0]?.path === d.config.pluginRoot,
        detail: JSON.stringify(ours).slice(0, 200),
      },
      {
        name: "the worktree is as it was",
        ok: read("worktrees/STEP-0-probe/keep.txt") === "edited\n" && read("worktrees/STEP-0-probe/untracked.txt") === "new\n",
        detail: "keep.txt edited, untracked.txt",
      },
      { name: "no secret reached the session", ok: !results.some((r) => r.includes(MARKER)), detail: MARKER },
    ]
    const fired = (by: Step["by"]) => steps.every((s, i) => s.by !== by || checks[i].ok)
    const all = [...checks, ...after]
    return {
      at: d.now().toISOString(),
      kind: "scripted",
      claudePath: d.claudePath ?? null,
      claudeVersion: null,
      ok: all.every((c) => c.ok),
      pluginHookFired: fired("plugin"),
      workerGuardFired: fired("worker"),
      loadedPlugins: loaded.map((p) => String(p.name)),
      checks: all,
    }
  } finally {
    rmSync(home, { recursive: true, force: true })
  }
}
