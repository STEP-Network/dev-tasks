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
import { frontDoorSettingsPath, frontDoorSettingsProblem } from "../agentd/frontdoor.ts"
import { channelApproval, MANAGED_CHANNEL_JSON, MANAGED_SETTINGS } from "../channel/managed.ts"
import { readHooksProbes, workerClaudePath, type HooksProbe } from "./hooks-probe.ts"
import { readSandboxProbe } from "./sandbox-probe.ts"
import { agentdSecretsPath, assertLinearKeyFile, claudeTokenPath, linearKeyPath, mondaySecretsPath, slackSecretsPath, userTestSecretsPath } from "../secrets.ts"
import { chromeMajor } from "../usertest/chrome.ts"
import { CHROME_DEVTOOLS_MCP_VERSION, chromeDevtoolsMcp } from "../usertest/mcp.ts"
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
  /** The Claude Code workers run: the Agent SDK's own. Default: workerClaudePath(). */
  workerClaude?: () => string | null
  /**
   * Check claude and tmux as PATH finds them, not the paths config.json
   * recorded: install.sh asks for this, so a binary that moved since the last
   * install is found again and recorded, not refused.
   */
  fresh?: boolean
  /** Claude Code's managed settings on this machine. Default: MANAGED_SETTINGS. */
  managedSettings?: string
}

export { MANAGED_SETTINGS }

/**
 * The Slack channel into the front door (STEP-3293) opens only when the
 * machine's managed settings turn channels on and approve exactly the
 * dev-tasks plugin's (channel/managed.ts), the same rule agentd starts the
 * front door by. Without it the front door still reads every message, at its
 * next wakeup: a warning.
 */
export function slackChannelCheck(config: AgentConfig, file: string): Check {
  const name = "slack channel"
  if (!config.frontDoor.channel) return { level: "ok", name, detail: "off in config.json (frontDoor.channel): Slack messages wait for the front door's next wakeup" }
  const approval = channelApproval(file)
  if (approval.ok) return { level: "ok", name, detail: `approved in ${file}` }
  return {
    level: "warn",
    name,
    detail: `${approval.why}, so the front door starts without the Slack channel and reads Slack messages only at its next wakeup. From the admin account, write ${MANAGED_CHANNEL_JSON} there (runbook, section 1)`,
  }
}

/** runtime/package.json's engines floor. */
const NODE_FLOOR = [20, 18, 1]
/**
 * The oldest Claude Code the front door's sandbox was verified on: the
 * sandbox leans on how excludedCommands matches a command (2.1.278 and
 * 2.1.281 checked), and the command line on --permission-prompts none.
 */
const CLAUDE_FLOOR = [2, 1, 278]

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

/**
 * Over SSH the login keychain is out of reach ("User interaction is not
 * allowed"), so gh and claude report no login there although both work in
 * the automatic-login GUI session, where the LaunchAgents run. A failing
 * keychain check is then a warning to run doctor from the mini's own
 * Terminal. The agentctl shim starts node with a clean environment, so it
 * passes the SSH session on as AGENTD_OVER_SSH=1 (templates/shim.sh).
 */
const overSsh = (d: DoctorDeps) => Boolean(d.env.SSH_CONNECTION) || d.env.AGENTD_OVER_SSH === "1"
const KEYCHAIN = "can't check over SSH (login keychain): run doctor from the mini's own Terminal, in person or over Screen Sharing"

async function github(d: DoctorDeps, slug: string): Promise<Check> {
  const status = await d.exec("gh", ["auth", "status"])
  if (status.code !== 0 && overSsh(d)) return { level: "warn", name: "gh", detail: KEYCHAIN }
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

export interface RepoToolchain {
  /** package.json's engines.node, as written (`24.x`). */
  nodeRange: string | null
  /** The lowest version that range names: `24.x` is 24.0.0. */
  nodeFloor: number[] | null
  /** packageManager's pnpm version (`pnpm@12.6.0`). */
  pnpm: string | null
}

/**
 * What the checkout's package.json asks of the toolchain. The mini installs
 * the latest Node and pnpm, so these are floors, never pins. All null with no
 * checkout yet, or for what it does not name.
 */
export function repoToolchain(repo: string | null): RepoToolchain {
  const none: RepoToolchain = { nodeRange: null, nodeFloor: null, pnpm: null }
  if (!repo) return none
  let pkg: { engines?: { node?: unknown }; packageManager?: unknown }
  try {
    pkg = JSON.parse(readFileSync(join(repo, "package.json"), "utf8"))
  } catch {
    return none
  }
  const range = typeof pkg.engines?.node === "string" ? pkg.engines.node : null
  const lowest = range ? /(\d+)(?:\.(\d+))?(?:\.(\d+))?/.exec(range) : null
  const pm = typeof pkg.packageManager === "string" ? /^pnpm@(\d+\.\d+\.\d+)/.exec(pkg.packageManager) : null
  return {
    nodeRange: lowest ? range : null,
    nodeFloor: lowest ? [Number(lowest[1]), Number(lowest[2] ?? 0), Number(lowest[3] ?? 0)] : null,
    pnpm: pm ? pm[1] : null,
  }
}

function pnpm(version: string, code: number, want: RepoToolchain): Check {
  if (code !== 0) {
    return { level: "fail", name: "pnpm", detail: "missing: pnpm's own installer as this user, or brew install pnpm from the admin account (runbook, section 1)" }
  }
  const v = semver(version)
  if (want.pnpm && v && below(v, semver(want.pnpm)!)) {
    return {
      level: "warn",
      name: "pnpm",
      detail:
        `${version} is older than ${want.pnpm}, which the checkout's packageManager names. ` +
        "A pnpm from pnpm's own installer (~/Library/pnpm): pnpm self-update. From Homebrew: brew upgrade pnpm, from the admin account",
    }
  }
  return { level: "ok", name: "pnpm", detail: version }
}

function node(version: string, want: RepoToolchain): Check {
  const v = semver(version) ?? [0, 0, 0]
  if (below(v, NODE_FLOOR)) return { level: "fail", name: "node", detail: `${version} is older than the runtime's floor, ${NODE_FLOOR.join(".")}` }
  if (want.nodeFloor && below(v, want.nodeFloor)) {
    return { level: "warn", name: "node", detail: `${version} is older than the checkout's engines.node, ${want.nodeRange}: brew upgrade node, from the admin account` }
  }
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
function sandboxProbeCheck(d: DoctorDeps, claude: string, installed: string): Check {
  const name = "sandbox probe"
  const probe = readSandboxProbe(d.paths)
  if (!probe) return { level: "warn", name, detail: "never run: agentctl probe-sandbox, once installed (runbook, section 9)" }
  if (!probe.ok) {
    const failed = probe.checks.filter((c) => !c.ok).map((c) => c.name)
    return { level: "fail", name, detail: `failed on ${probe.claudeVersion} (${failed.join(", ")}): the front door's sandbox may not hold. Keep the mini paused` }
  }
  if (probe.claudeVersion !== installed || probe.claudePath !== claude) {
    return {
      level: "warn",
      name,
      detail: `passed on ${probe.claudePath} ${probe.claudeVersion}, but the front door's claude is ${claude} ${installed || "unknown"}: agentd will not start it until agentctl probe-sandbox passes`,
    }
  }
  return { level: "ok", name, detail: `passed on ${probe.claudeVersion}, ${probe.at}` }
}

/**
 * Whether the plugin's hooks and the worker's guard fire in a worker session
 * (hooks-probe.ts): trusted only for the binary workers run, at the version a
 * probe passed on. Either probe is proof, the free scripted one or the
 * real-model one.
 */
function hooksProbeCheck(d: DoctorDeps, binary: string | null, installed: string): Check {
  const name = "hooks probe"
  if (!binary) return { level: "fail", name, detail: "the Agent SDK's claude is missing, and no worker can start without it: cd ~/dev-tasks/runtime && npm ci" }
  const probes = Object.values(readHooksProbes(d.paths)).filter((p): p is HooksProbe => Boolean(p))
  const label = (p: HooksProbe) => (p.kind === "scripted" ? "agentctl probe-hooks --scripted" : "agentctl probe-hooks")
  if (!probes.length) return { level: "warn", name, detail: "never run: agentctl probe-hooks --scripted, once installed (runbook, section 9)" }
  const current = (p: HooksProbe) => p.claudePath === binary && p.claudeVersion === installed
  const passed = probes.filter((p) => p.ok && current(p)).sort((a, b) => b.at.localeCompare(a.at))[0]
  if (passed) return { level: "ok", name, detail: `${label(passed)} passed on ${passed.claudeVersion}, ${passed.at}` }
  const failed = probes.find(current)
  if (failed) {
    const what = failed.checks.filter((c) => !c.ok).map((c) => c.name)
    const fired = `plugin hooks ${failed.pluginHookFired ? "fired" : "did NOT fire"}, the worker's guard ${failed.workerGuardFired ? "fired" : "did NOT fire"}`
    return { level: "fail", name, detail: `${label(failed)} failed on ${failed.claudeVersion} (${what.length ? what.join(", ") : fired}): keep the mini paused` }
  }
  const last = [...probes].sort((a, b) => b.at.localeCompare(a.at))[0]
  return {
    level: "warn",
    name,
    detail: `${label(last)} ${last.ok ? "passed" : "failed"} on ${last.claudePath} ${last.claudeVersion}, but workers run ${binary} ${installed || "unknown"}: agentctl probe-hooks --scripted`,
  }
}

/**
 * The front door's --settings are added to the user's and the project's, not
 * put in their place: a `sandbox` block or `permissions.allow` rules in the
 * user's settings or the checkout's settings.local.json reach the front door
 * too, and can loosen its sandbox (an excludedCommands entry runs that command
 * outside it). PolAds's own .claude/settings.json is reviewed code.
 */
function looseningSettings(home: string, repo: string): Check {
  const name = "settings the front door inherits"
  const found: string[] = []
  for (const file of [join(home, ".claude", "settings.json"), join(repo, ".claude", "settings.local.json")]) {
    let settings: { sandbox?: unknown; permissions?: { allow?: unknown } }
    try {
      settings = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    if (settings?.sandbox !== undefined) found.push(`${file} has a sandbox block`)
    if (Array.isArray(settings?.permissions?.allow) && settings.permissions.allow.length) found.push(`${file} has permissions.allow rules`)
  }
  return found.length
    ? { level: "fail", name, detail: `${found.join(", ")}: the front door inherits them, and they can loosen its sandbox. Move them out` }
    : { level: "ok", name, detail: "no sandbox block and no allow rules in the user's settings or settings.local.json" }
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
  // Only the coordinator mini holds one (STEP-3289), and there agentd will not start without it.
  add(secretCheck("monday token", mondaySecretsPath(d.paths.home), Boolean(config?.bridges.monday?.enabled)))
  add(await gitIdentity(d))
  if (config) add(await github(d, config.repo.slug))
  const p = await d.exec("pnpm", ["--version"])
  const toolchain = repoToolchain(config?.repo.path ?? null)
  add(pnpm(p.stdout.trim(), p.code, toolchain))
  add(node(d.nodeVersion, toolchain))
  const claude = d.fresh || !config ? "claude" : config.frontDoor.claudePath
  add(await tool(d, "tmux", d.fresh || !config ? "tmux" : config.frontDoor.tmuxPath, ["-V"]))
  add(await tool(d, "jq", "jq", ["--version"]))
  add(await tool(d, "claude", claude, ["--version"], CLAUDE_FLOOR))
  const auth = await d.exec(claude, ["auth", "status"])
  add(
    auth.code === 0
      ? { level: "ok", name: "claude login", detail: "logged in" }
      : overSsh(d)
        ? { level: "warn", name: "claude login", detail: KEYCHAIN }
        : { level: "fail", name: "claude login", detail: "not logged in: run claude as this user and log in with the agent's own account" },
  )
  // Compared with the path agentd starts the front door with, whichever claude doctor asked.
  add(sandboxProbeCheck(d, config?.frontDoor.claudePath ?? "claude", (await d.exec(claude, ["--version"])).stdout.trim().split("\n")[0]))
  const worker = (d.workerClaude ?? workerClaudePath)()
  add(hooksProbeCheck(d, worker, worker ? (await d.exec(worker, ["--version"])).stdout.trim().split("\n")[0] : ""))
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
    add(slackChannelCheck(config, d.managedSettings ?? MANAGED_SETTINGS))
    // install.sh writes it after doctor --fresh passes, so only a later doctor looks for it.
    if (!d.fresh) {
      const problem = frontDoorSettingsProblem(d.paths)
      add(problem ? { level: "fail", name: "front door settings", detail: problem } : { level: "ok", name: "front door settings", detail: frontDoorSettingsPath(d.paths) })
    }
    add(looseningSettings(d.paths.home, config.repo.path))
  }
  if (d.env.MONDAY_API_KEY) {
    add({ level: "warn", name: "monday", detail: "MONDAY_API_KEY is set in this environment. Monday is read-only for agents: remove it from the shell profile" })
  }
  if (config) for (const check of await userTestChecks(d, config)) add(check)
  return checks
}

/** chrome-devtools-mcp's --allowedUrlPattern needs Chrome 149 or newer. */
const CHROME_FLOOR = 149

/** The browser test's lines (WS5), where config.json turns it on. */
export async function userTestChecks(d: DoctorDeps, config: AgentConfig): Promise<Check[]> {
  const u = config.usertest
  if (!u.enabled) return []
  const checks: Check[] = []
  const version = await d.exec(u.chromePath, ["--version"], { timeoutMs: 30_000 })
  const major = version.code === 0 ? chromeMajor(version.stdout) : null
  checks.push(
    major === null
      ? { level: "fail", name: "browser test Chrome", detail: `no Google Chrome at ${u.chromePath}: brew install --cask google-chrome, from the admin account` }
      : major < CHROME_FLOOR
        ? { level: "fail", name: "browser test Chrome", detail: `Chrome ${major} is older than ${CHROME_FLOOR}, which the browser allowlist needs: update Chrome` }
        : { level: "ok", name: "browser test Chrome", detail: `Chrome ${major}` },
  )
  try {
    const mcp = chromeDevtoolsMcp()
    checks.push(
      mcp.version === CHROME_DEVTOOLS_MCP_VERSION && existsSync(mcp.bin)
        ? { level: "ok", name: "browser test tool", detail: `chrome-devtools-mcp ${mcp.version}` }
        : { level: "fail", name: "browser test tool", detail: `chrome-devtools-mcp ${mcp.version}, not ${CHROME_DEVTOOLS_MCP_VERSION}: run npm ci in the runtime` },
    )
  } catch (error) {
    checks.push({ level: "fail", name: "browser test tool", detail: message(error) })
  }
  checks.push(
    Number(d.nodeVersion.split(".")[0]) >= 22
      ? { level: "ok", name: "browser test node", detail: d.nodeVersion }
      : { level: "fail", name: "browser test node", detail: `Node ${d.nodeVersion}: the browser test needs Node 22 or newer` },
  )
  checks.push(
    secretCheck("browser test secrets", userTestSecretsPath(d.paths.home), false) ?? {
      level: "warn",
      name: "browser test secrets",
      detail: `${userTestSecretsPath(d.paths.home)} is missing: the browser test runs signed out, and cannot open a protected preview`,
    },
  )
  if (!u.personas.length) checks.push({ level: "warn", name: "browser test personas", detail: "none: every browser test runs as a visitor who is not signed in" })
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
