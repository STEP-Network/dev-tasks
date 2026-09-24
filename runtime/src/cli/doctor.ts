/**
 * `agentctl doctor`: is this machine ready to run the agent runtime? One line
 * per check, "ok", "WARN" or "FAIL". install.sh runs it first and installs
 * nothing while a check fails; a person runs it any time after. Each check is
 * something setting up Eve's mini got wrong once (2026-09-24). It reads no
 * secret value: the secrets files are checked by their mode and their line,
 * never printed.
 */

import { existsSync, readFileSync, statSync } from "node:fs"
import { dirname, join } from "node:path"
import { assertProfileMini, loadConfig, type AgentConfig, type AgentPaths } from "../config.ts"
import { frontDoorSettingsPath } from "../agentd/frontdoor.ts"
import { readSandboxProbe } from "./sandbox-probe.ts"
import { agentdSecretsPath, assertLinearKeyFile, claudeTokenPath, linearKeyPath, slackSecretsPath } from "../secrets.ts"
import type { Exec } from "../worker/git.ts"

export interface Check {
  level: "ok" | "warn" | "fail"
  name: string
  detail: string
}

export interface DoctorDeps {
  paths: AgentPaths
  /** realExec: its environment has no GH_TOKEN, so gh answers for the mini's own login (decision 5). */
  exec: Exec
  env: NodeJS.ProcessEnv
  /** process.versions.node */
  nodeVersion: string
  /** hooks/lib/profile.sh get profile */
  profile: () => string
  /** hooks/lib/profile.sh get mini */
  profileMini: () => string | null
  /**
   * Check claude and tmux as PATH finds them, not the paths config.json
   * recorded: install.sh asks for this, so a binary that moved since the last
   * install is found again and recorded, not refused.
   */
  fresh?: boolean
}

/** runtime/package.json's engines floor. */
const NODE_FLOOR = [20, 18, 1]
/** `--permission-prompts none`, which the front door's command line uses. */
const CLAUDE_FLOOR = [2, 1, 259]

const semver = (text: string): number[] | null => {
  const m = /(\d+)\.(\d+)\.(\d+)/.exec(text)
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null
}
const below = (v: number[], floor: number[]) => {
  for (let i = 0; i < 3; i++) if (v[i] !== floor[i]) return v[i] < floor[i]
  return false
}
const message = (error: unknown) => (error instanceof Error ? error.message : String(error))

/** A secrets file's mode, never its contents. null when the file is absent. */
function secretMode(path: string): number | null {
  try {
    return statSync(path).mode & 0o777
  } catch {
    return null
  }
}

function secretCheck(name: string, path: string, required: boolean): Check | null {
  const mode = secretMode(path)
  if (mode === null) return required ? { level: "fail", name, detail: `${path} is missing (runbook, section 5)` } : null
  if (mode & 0o077) return { level: "fail", name, detail: `${path} must be chmod 600, it is ${mode.toString(8)}: chmod 600 ${path}` }
  return { level: "ok", name, detail: path }
}

async function gitIdentity(d: DoctorDeps): Promise<Check> {
  // The worker's sandbox refuses ~/.config. git reads ~/.config/git/config
  // whenever it exists, and a read the sandbox refuses is fatal: every git the
  // worker runs would exit 128. So the file must not exist at all, and the
  // identity must be in ~/.gitconfig.
  const xdg = join(d.paths.home, ".config", "git", "config")
  if (existsSync(xdg)) {
    return {
      level: "fail",
      name: "git identity",
      detail: `${xdg} exists, and the worker's sandbox cannot read it, so every git command there fails. Move what it holds into ~/.gitconfig (git config --global writes there once ~/.gitconfig exists), then delete it`,
    }
  }
  const gitconfig = join(d.paths.home, ".gitconfig")
  const values: string[] = []
  for (const key of ["user.email", "user.name"]) {
    const r = await d.exec("git", ["config", "--global", "--show-origin", key])
    const [origin = "", value = ""] = r.stdout.trim().split("\t")
    if (r.code !== 0 || !value) return { level: "fail", name: "git identity", detail: `${key} is not set: git config --global ${key} "<the agent's>"` }
    if (origin !== `file:${gitconfig}`) {
      return {
        level: "fail",
        name: "git identity",
        detail: `${key} comes from ${origin.replace(/^file:/, "")}, not ~/.gitconfig: the worker's sandbox reads only that one. touch ~/.gitconfig, then git config --global ${key} "${value}"`,
      }
    }
    values.push(value)
  }
  return { level: "ok", name: "git identity", detail: `${values[1]} <${values[0]}> in ~/.gitconfig` }
}

async function github(d: DoctorDeps, slug: string): Promise<Check> {
  const status = await d.exec("gh", ["auth", "status"])
  if (status.code !== 0) return { level: "fail", name: "gh", detail: "not logged in: gh auth login as the mini's own machine user, then gh auth setup-git" }
  const account = /account (\S+)/.exec(`${status.stdout}\n${status.stderr}`)?.[1] ?? "the logged-in user"
  const push = await d.exec("gh", ["api", `repos/${slug}`, "--jq", ".permissions.push"])
  if (push.code !== 0 || push.stdout.trim() !== "true") {
    return { level: "fail", name: "gh", detail: `${account} cannot push to ${slug}: give it Write (the org's agents team), then run this again` }
  }
  return { level: "ok", name: "gh", detail: `${account}, can push to ${slug}` }
}

async function tool(d: DoctorDeps, name: string, command: string, args: string[], floor?: number[]): Promise<Check> {
  const r = await d.exec(command, args)
  const version = (r.stdout.trim() || r.stderr.trim()).split("\n")[0]
  if (r.code !== 0) return { level: "fail", name, detail: `${command} ${args.join(" ")} failed: ${version || `exit ${r.code}`}` }
  const v = semver(version)
  if (floor && v && below(v, floor)) return { level: "fail", name, detail: `${version} is older than ${floor.join(".")}` }
  return { level: "ok", name, detail: version }
}

function pnpm(version: string, code: number): Check {
  if (code === 0 && /^10\./.test(version)) return { level: "ok", name: "pnpm", detail: version }
  return {
    level: "fail",
    name: "pnpm",
    detail:
      `${code === 0 ? version : "missing"} is not pnpm 10, which CI pins: any other ignores package.json's pnpm.onlyBuiltDependencies. ` +
      `brew install pnpm@10, and put /opt/homebrew/opt/pnpm@10/bin first on PATH in ~/.zprofile`,
  }
}

function node(version: string): Check {
  const v = semver(version) ?? [0, 0, 0]
  if (below(v, NODE_FLOOR)) return { level: "fail", name: "node", detail: `${version} is older than the runtime's floor, ${NODE_FLOOR.join(".")}` }
  if (v[0] !== 20) return { level: "warn", name: "node", detail: `${version} works, but CI runs Node 20 (STEP-3156 tracks the move)` }
  return { level: "ok", name: "node", detail: version }
}

/**
 * The front door runs the plugin Claude Code installed, and the worker runs
 * config.pluginRoot. They are one directory only when the marketplace is that
 * checkout (Claude Code 2.1.281 loads a directory marketplace's plugin from
 * the directory itself). Read from Claude Code's own files, whose format is
 * not a contract: so a warning, never a failure.
 */
function frontDoorPlugin(d: DoctorDeps, config: AgentConfig): Check {
  const name = "front door plugin"
  const read = (file: string) => {
    try {
      return JSON.parse(readFileSync(join(d.paths.home, ".claude", "plugins", file), "utf8")) as Record<string, unknown>
    } catch {
      return null
    }
  }
  const checkout = dirname(config.pluginRoot)
  const market = read("known_marketplaces.json")?.["dev-tasks-marketplace"] as { source?: { source?: string; path?: string; repo?: string } } | undefined
  const installed = (read("installed_plugins.json")?.plugins as Record<string, unknown> | undefined)?.["dev-tasks@dev-tasks-marketplace"]
  const add = `in claude, in ${config.repo.path}: /plugin marketplace add ${checkout}, then /plugin install dev-tasks@dev-tasks-marketplace (runbook, section 7)`
  if (!market || !installed) return { level: "warn", name, detail: `the dev-tasks plugin is not installed for the front door: ${add}` }
  const source = market.source ?? {}
  if (source.source !== "directory" || source.path !== checkout) {
    return {
      level: "warn",
      name,
      detail: `the front door's marketplace is ${source.source ?? "unknown"} ${source.path ?? source.repo ?? ""}, but the worker runs ${config.pluginRoot}: remove it and ${add}`,
    }
  }
  return { level: "ok", name, detail: `dev-tasks from ${checkout}, as the worker's` }
}

/**
 * The front door's sandbox leans on how this Claude Code treats its settings
 * (sandbox-probe.ts): trusted only for the version agentctl probe-sandbox
 * last passed on.
 */
function sandboxProbeCheck(d: DoctorDeps, installed: string): Check {
  const name = "sandbox probe"
  const probe = readSandboxProbe(d.paths)
  if (!probe) return { level: "warn", name, detail: "never run: agentctl probe-sandbox, once installed (runbook, section 9)" }
  if (!probe.ok) {
    const failed = probe.checks.filter((c) => !c.ok).map((c) => c.name)
    return { level: "fail", name, detail: `failed on ${probe.claudeVersion} (${failed.join(", ")}): the front door's sandbox may not hold. Keep the mini paused` }
  }
  if (probe.claudeVersion !== installed) {
    return { level: "warn", name, detail: `passed on ${probe.claudeVersion}, but claude is now ${installed || "unknown"}: agentctl probe-sandbox` }
  }
  return { level: "ok", name, detail: `passed on ${probe.claudeVersion}, ${probe.at}` }
}

export async function doctorChecks(d: DoctorDeps): Promise<Check[]> {
  const checks: Check[] = []
  const add = (c: Check | null) => {
    if (c) checks.push(c)
  }
  const profile = d.profile()
  add(
    profile === "agent"
      ? { level: "ok", name: "profile", detail: "agent" }
      : { level: "fail", name: "profile", detail: `${profile}: ~/.claude/dev-tasks-profile.json must say "profile": "agent" (runbook, section 3)` },
  )
  let config: AgentConfig | null = null
  try {
    config = loadConfig(d.paths)
    add({ level: "ok", name: "config", detail: d.paths.config })
  } catch (error) {
    add({ level: "fail", name: "config", detail: message(error) })
  }
  if (config) {
    try {
      assertProfileMini(config, d.profileMini(), d.paths.config)
      add({ level: "ok", name: "mini", detail: config.mini })
    } catch (error) {
      add({ level: "fail", name: "mini", detail: message(error) })
    }
  }
  const linear = secretCheck("linear key", linearKeyPath(d.paths.home), true)
  if (linear?.level === "ok") {
    try {
      // Its line as the plugin's Linear client reads it. The messages name the file, never the key.
      assertLinearKeyFile(d.paths.home)
    } catch (error) {
      linear.level = "fail"
      linear.detail = message(error).replace(/^secrets: /, "")
    }
  }
  add(linear)
  add(secretCheck("slack tokens", slackSecretsPath(d.paths.home), true))
  add(secretCheck("sentry url", agentdSecretsPath(d.paths.home), false))
  add(secretCheck("claude token", claudeTokenPath(d.paths.home), false))
  add(await gitIdentity(d))
  if (config) add(await github(d, config.repo.slug))
  const p = await d.exec("pnpm", ["--version"])
  add(pnpm(p.stdout.trim(), p.code))
  add(node(d.nodeVersion))
  const claude = d.fresh || !config ? "claude" : config.frontDoor.claudePath
  add(await tool(d, "tmux", d.fresh || !config ? "tmux" : config.frontDoor.tmuxPath, ["-V"]))
  add(await tool(d, "jq", "jq", ["--version"]))
  add(await tool(d, "claude", claude, ["--version"], CLAUDE_FLOOR))
  const auth = await d.exec(claude, ["auth", "status"])
  add(
    auth.code === 0
      ? { level: "ok", name: "claude login", detail: "logged in" }
      : { level: "fail", name: "claude login", detail: "not logged in: run claude as this user and log in with the agent's own account" },
  )
  add(sandboxProbeCheck(d, (await d.exec(claude, ["--version"])).stdout.trim().split("\n")[0]))
  if (config) {
    const repo = await d.exec("git", ["-C", config.repo.path, "rev-parse", "--is-inside-work-tree"])
    add(
      repo.code === 0 && repo.stdout.trim() === "true"
        ? { level: "ok", name: "checkout", detail: config.repo.path }
        : { level: "fail", name: "checkout", detail: `${config.repo.path} is not a git checkout: gh repo clone ${config.repo.slug} ${config.repo.path}` },
    )
    const manifest = join(config.pluginRoot, ".claude-plugin", "plugin.json")
    add(
      existsSync(manifest)
        ? { level: "ok", name: "plugin", detail: config.pluginRoot }
        : { level: "fail", name: "plugin", detail: `${manifest} is missing: pluginRoot must be the plugin/ directory of the dev-tasks checkout` },
    )
    add(frontDoorPlugin(d, config))
    // install.sh writes it after doctor --fresh passes, so only a later doctor looks for it.
    if (!d.fresh && !existsSync(frontDoorSettingsPath(d.paths))) {
      add({ level: "warn", name: "front door settings", detail: `${frontDoorSettingsPath(d.paths)} is missing, and the front door cannot start without it: run install.sh` })
    }
  }
  if (d.env.MONDAY_API_KEY) {
    add({ level: "warn", name: "monday", detail: "MONDAY_API_KEY is set in this environment. Monday is read-only for agents: remove it from the shell profile" })
  }
  return checks
}

export function formatDoctor(checks: Check[]): { text: string; ok: boolean } {
  const label = { ok: "ok   ", warn: "WARN ", fail: "FAIL " }
  const failures = checks.filter((c) => c.level === "fail").length
  return {
    ok: failures === 0,
    text: [...checks.map((c) => `${label[c.level]} ${c.name}: ${c.detail}`), failures ? `${failures} to fix` : "ready"].join("\n"),
  }
}
