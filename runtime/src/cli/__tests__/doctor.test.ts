import { chmodSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { beforeEach, describe, expect, it } from "vitest"
import { agentPaths, type AgentPaths } from "../../config.ts"
import { fakeExec } from "../../__tests__/fakes.ts"
import type { ExecResult } from "../../worker/git.ts"
import { doctorChecks, formatDoctor, repoToolchain, type DoctorDeps } from "../doctor.ts"
import { recordHooksProbe, type HooksProbe } from "../hooks-probe.ts"
import { recordSandboxProbe } from "../sandbox-probe.ts"

type Responses = Array<[RegExp, Partial<ExecResult>]>

let home = ""
let paths: AgentPaths

function secret(rel: string, body: string, mode = 0o600) {
  const file = join(home, rel)
  mkdirSync(join(file, ".."), { recursive: true })
  writeFileSync(file, body)
  chmodSync(file, mode)
}

beforeEach(() => {
  home = mkdtempSync(join(tmpdir(), "doctor-"))
  process.env.AGENTD_HOME = ""
  paths = agentPaths(home)
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(
    paths.config,
    JSON.stringify({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: join(home, "dev-tasks", "plugin"), slack: { allowedUsers: ["UNATE"] } }),
  )
  secret(".config/linear/.env", "LINEAR_API_KEY=lin_api_test\n")
  secret(".config/agentd/slack.env", "SLACK_BOT_TOKEN=xoxb-t\nSLACK_APP_TOKEN=xapp-t\n")
  mkdirSync(join(home, "dev-tasks", "plugin", ".claude-plugin"), { recursive: true })
  writeFileSync(join(home, "dev-tasks", "plugin", ".claude-plugin", "plugin.json"), JSON.stringify({ name: "dev-tasks", version: "1.2.0" }))
  mkdirSync(join(home, ".claude", "plugins"), { recursive: true })
  writeFileSync(
    join(home, ".claude", "plugins", "known_marketplaces.json"),
    JSON.stringify({ "dev-tasks-marketplace": { source: { source: "directory", path: join(home, "dev-tasks") } } }),
  )
  writeFileSync(join(home, ".claude", "plugins", "installed_plugins.json"), JSON.stringify({ version: 2, plugins: { "dev-tasks@dev-tasks-marketplace": [{ scope: "user" }] } }))
  writeFileSync(join(paths.root, "front-door-settings.json"), JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: false } }))
  recordSandboxProbe(paths, { at: "2026-09-24T12:00:00.000Z", claudePath: "claude", claudeVersion: "2.1.281 (Claude Code)", ok: true, checks: [] })
  recordHooksProbe(paths, hooksProbe({}))
})

/** A hooks probe that passed on the SDK's binary, which workers run (SDK below). */
function hooksProbe(over: Partial<HooksProbe>): HooksProbe {
  return {
    at: "2026-09-24T12:00:00.000Z", kind: "scripted", claudePath: SDK, claudeVersion: "2.1.281 (Claude Code)",
    ok: true, pluginHookFired: true, workerGuardFired: true, loadedPlugins: ["dev-tasks"], checks: [], ...over,
  }
}
const SDK = "/Users/eve/dev-tasks/runtime/node_modules/@anthropic-ai/claude-agent-sdk-darwin-arm64/claude"

const READY: Responses = [
  [/^git config --global --show-origin user\.email$/, { stdout: "file:HOME/.gitconfig\teve@polads.eu\n" }],
  [/^git config --global --show-origin user\.name$/, { stdout: "file:HOME/.gitconfig\teve\n" }],
  [/^git -C \/Users\/eve\/polads rev-parse --is-inside-work-tree$/, { stdout: "true\n" }],
  [/^gh auth status$/, { stdout: "github.com\n  ✓ Logged in to github.com account eve-polads (keyring)\n" }],
  [/^gh api repos\/STEP-Network\/v0-politiske-annoncer --jq \.permissions\.push$/, { stdout: "true\n" }],
  [/^pnpm --version$/, { stdout: "10.33.0\n" }],
  [/^tmux -V$/, { stdout: "tmux 3.5a\n" }],
  [/^claude --version$/, { stdout: "2.1.281 (Claude Code)\n" }],
  [/^claude auth status$/, { stdout: "{}" }],
  [/^jq --version$/, { stdout: "jq-1.7.1\n" }],
  [/claude-agent-sdk-darwin-arm64\/claude --version$/, { stdout: "2.1.281 (Claude Code)\n" }],
]

function deps(over: Partial<DoctorDeps> = {}, responses: Responses = []): DoctorDeps {
  // The first matching pattern answers, so a test's own answers go first.
  const withHome = [...responses, ...READY].map(([re, r]) => [re, r.stdout === undefined ? r : { ...r, stdout: r.stdout.replace("HOME", home) }] as [RegExp, typeof r])
  return { paths, exec: fakeExec(withHome).exec, env: {}, nodeVersion: "20.20.2", profile: () => "agent", profileMini: () => "eve", workerClaude: () => SDK, ...over }
}

const failed = async (d: DoctorDeps) => (await doctorChecks(d)).filter((c) => c.level === "fail").map((c) => `${c.name}: ${c.detail}`)
const warned = async (d: DoctorDeps) => (await doctorChecks(d)).filter((c) => c.level === "warn").map((c) => `${c.name}: ${c.detail}`)

describe("doctorChecks", () => {
  it("passes a ready mini, and says so", async () => {
    const checks = await doctorChecks(deps())
    expect(checks.filter((c) => c.level !== "ok")).toEqual([])
    const { text, ok } = formatDoctor(checks)
    expect(ok).toBe(true)
    expect(text.split("\n").at(-1)).toBe("ready")
    expect(text).toContain("ok    gh: eve-polads, can push to STEP-Network/v0-politiske-annoncer")
  })

  /** The checkout config.json names, with PolAds's package.json as of STEP-3156 (#1664) unless given another. */
  function checkout(pkg: Record<string, unknown> = { engines: { node: "24.x" }, packageManager: "pnpm@12.6.0+sha512.abc" }): Responses {
    const repo = join(home, "polads")
    mkdirSync(repo, { recursive: true })
    const config = JSON.parse(readFileSync(paths.config, "utf8"))
    writeFileSync(paths.config, JSON.stringify({ ...config, repo: { path: repo } }))
    writeFileSync(join(repo, "package.json"), JSON.stringify(pkg))
    return [
      [/rev-parse --is-inside-work-tree$/, { stdout: "true\n" }],
      [/^pnpm --version$/, { stdout: "12.6.0\n" }],
    ]
  }

  it("takes the latest pnpm, and warns only below the one the checkout's packageManager names", async () => {
    const answers = checkout()
    expect((await doctorChecks(deps({ nodeVersion: "24.3.0" }, answers))).filter((c) => c.level !== "ok")).toEqual([])
    expect(await warned(deps({ nodeVersion: "24.3.0" }, [[/^pnpm --version$/, { stdout: "13.0.1\n" }], ...answers]))).toEqual([])
    const old: Responses = [[/^pnpm --version$/, { stdout: "10.33.0\n" }], ...answers]
    expect(await failed(deps({ nodeVersion: "24.3.0" }, old))).toEqual([])
    expect(await warned(deps({ nodeVersion: "24.3.0" }, old))).toEqual([
      expect.stringMatching(/^pnpm: 10\.33\.0 is older than 12\.6\.0, which the checkout's packageManager names\. .*pnpm self-update\. .*brew upgrade pnpm/),
    ])
  })

  it("takes any pnpm when the checkout names none, and refuses a missing one", async () => {
    const answers = checkout({ engines: { node: "24.x" } })
    expect(await warned(deps({ nodeVersion: "24.3.0" }, [[/^pnpm --version$/, { stdout: "9.0.0\n" }], ...answers]))).toEqual([])
    expect(await failed(deps({ nodeVersion: "24.3.0" }, [[/^pnpm --version$/, { code: 127, stderr: "command not found: pnpm" }], ...answers]))).toEqual([
      expect.stringMatching(/^pnpm: missing: pnpm's own installer .*brew install pnpm/),
    ])
  })

  it("takes the latest Node, warns below the checkout's engines.node floor, and refuses one below the runtime's", async () => {
    const answers = checkout()
    for (const version of ["24.0.0", "24.3.0", "26.9.0"]) expect(await warned(deps({ nodeVersion: version }, answers)), version).toEqual([])
    expect(await warned(deps({ nodeVersion: "22.11.0" }, answers))).toEqual([expect.stringMatching(/^node: 22\.11\.0 is older than the checkout's engines\.node, 24\.x: brew upgrade node/)])
    expect(await failed(deps({ nodeVersion: "22.11.0" }, answers))).toEqual([])
    expect(await failed(deps({ nodeVersion: "20.10.0" }, answers))).toEqual([expect.stringMatching(/^node: 20\.10\.0 .*runtime's floor, 20\.18\.1/)])
    // Never a pin: no word about CI's Node, whatever runs.
    expect((await doctorChecks(deps({ nodeVersion: "20.20.2" })))).not.toContainEqual(expect.objectContaining({ detail: expect.stringMatching(/CI/) }))
  })

  it("reads the floor from the ranges engines.node is written in", () => {
    const floor = (node: string) => {
      const repo = join(home, `range-${Math.random().toString(36).slice(2)}`)
      mkdirSync(repo, { recursive: true })
      writeFileSync(join(repo, "package.json"), JSON.stringify({ engines: { node } }))
      return repoToolchain(repo).nodeFloor
    }
    expect(floor("24.x")).toEqual([24, 0, 0])
    expect(floor(">=24")).toEqual([24, 0, 0])
    expect(floor("^24.1.2")).toEqual([24, 1, 2])
    expect(floor(">=20.18.1 <27")).toEqual([20, 18, 1])
    expect(floor("*")).toBeNull()
    expect(repoToolchain(join(home, "no-checkout"))).toEqual({ nodeRange: null, nodeFloor: null, pnpm: null })
  })

  it("refuses a git identity the worker's sandbox cannot read", async () => {
    const problems = await failed(deps({}, [[/user\.email$/, { stdout: "file:HOME/.config/git/config\teve@polads.eu\n" }]]))
    expect(problems).toEqual([expect.stringMatching(/^git identity: user\.email comes from .*\.config\/git\/config.*~\/\.gitconfig/)])
    expect(await failed(deps({}, [[/user\.name$/, { code: 1, stdout: "" }]]))).toEqual([expect.stringMatching(/^git identity: user\.name is not set/)])
  })

  it("refuses a ~/.config/git/config at all, since git in the worker's sandbox dies reading it", async () => {
    // Even with the identity in ~/.gitconfig: git reads the XDG file whenever
    // it exists, and a read the sandbox refuses is fatal (exit 128).
    mkdirSync(join(home, ".config", "git"), { recursive: true })
    writeFileSync(join(home, ".config", "git", "config"), "[credential]\n\thelper = osxkeychain\n")
    expect(await failed(deps())).toEqual([expect.stringMatching(/^git identity: .*\.config\/git\/config exists.*delete it/)])
  })

  it("checks claude and tmux as PATH finds them when install asks, so a moved binary is found again", async () => {
    const config = JSON.parse(readFileSync(paths.config, "utf8"))
    writeFileSync(paths.config, JSON.stringify({ ...config, frontDoor: { claudePath: "/old/claude", tmuxPath: "/old/tmux" } }))
    const moved: Responses = [[/^\/old\//, { code: 127, stderr: "No such file or directory" }]]
    expect((await failed(deps({}, moved))).map((f) => f.split(":")[0]).sort()).toEqual(["claude", "claude login", "tmux"])
    expect(await failed(deps({ fresh: true }, moved))).toEqual([])
  })

  it("trusts the front door's sandbox only on the Claude Code version the probe last passed on", async () => {
    rmSync(join(paths.state, "sandbox-probe.json"))
    expect(await warned(deps())).toEqual([expect.stringMatching(/^sandbox probe: never run: agentctl probe-sandbox/)])
    recordSandboxProbe(paths, { at: "2026-09-24T12:00:00.000Z", claudePath: "claude", claudeVersion: "2.1.270 (Claude Code)", ok: true, checks: [] })
    expect(await warned(deps())).toEqual([expect.stringMatching(/^sandbox probe: passed on claude 2\.1\.270 .*front door's claude is claude 2\.1\.281.*agentctl probe-sandbox/)])
    recordSandboxProbe(paths, {
      at: "2026-09-24T12:00:00.000Z",
      claudePath: "claude",
      claudeVersion: "2.1.281 (Claude Code)",
      ok: false,
      checks: [{ name: "a substitution runs sandboxed", ok: false, detail: "[]" }],
    })
    expect(await failed(deps())).toEqual([expect.stringMatching(/^sandbox probe: failed on 2\.1\.281 .*a substitution runs sandboxed.*paused/)])
  })

  it("trusts the worker's hooks only on the binary workers run, at the version a probe passed on", async () => {
    rmSync(join(paths.state, "hooks-probe.json"))
    expect(await warned(deps())).toEqual([expect.stringMatching(/^hooks probe: never run: agentctl probe-hooks --scripted/)])
    // An SDK update since: a probe of the old binary proves nothing about the new one.
    recordHooksProbe(paths, hooksProbe({ claudeVersion: "2.1.270 (Claude Code)" }))
    expect(await warned(deps())).toEqual([expect.stringMatching(/^hooks probe: agentctl probe-hooks --scripted passed on \S+ 2\.1\.270 .*workers run \S+claude 2\.1\.281.*agentctl probe-hooks --scripted$/)])
    // Nor does one of another binary, the front door's say.
    recordHooksProbe(paths, hooksProbe({ claudePath: "/opt/homebrew/bin/claude" }))
    expect(await warned(deps())).toEqual([expect.stringMatching(/^hooks probe: .*passed on \/opt\/homebrew\/bin\/claude .*but workers run/)])
    recordHooksProbe(paths, hooksProbe({ ok: false, pluginHookFired: false, checks: [{ name: "the plugin's guard refuses git reset --hard", ok: false, detail: "Exit code 128" }] }))
    expect(await failed(deps())).toEqual([expect.stringMatching(/^hooks probe: agentctl probe-hooks --scripted failed on 2\.1\.281 \(Claude Code\) \(the plugin's guard refuses git reset --hard\): keep the mini paused$/)])
  })

  it("accepts the real-model probe as proof too, even beside a failed scripted one", async () => {
    recordHooksProbe(paths, hooksProbe({ ok: false, pluginHookFired: false }))
    recordHooksProbe(paths, hooksProbe({ kind: "model", at: "2026-09-24T13:00:00.000Z" }))
    const hooks = (await doctorChecks(deps())).find((c) => c.name === "hooks probe")
    expect(hooks).toEqual({ level: "ok", name: "hooks probe", detail: "agentctl probe-hooks passed on 2.1.281 (Claude Code), 2026-09-24T13:00:00.000Z" })
    // A failed model probe alone, with no fired hooks named check by check.
    rmSync(join(paths.state, "hooks-probe.json"))
    recordHooksProbe(paths, hooksProbe({ kind: "model", ok: false, workerGuardFired: false }))
    expect(await failed(deps())).toEqual([expect.stringMatching(/^hooks probe: agentctl probe-hooks failed on 2\.1\.281 \(Claude Code\) \(plugin hooks fired, the worker's guard did NOT fire\)/)])
  })

  it("fails without the Agent SDK's claude, which no worker starts without", async () => {
    expect(await failed(deps({ workerClaude: () => null }))).toEqual([expect.stringMatching(/^hooks probe: the Agent SDK's claude is missing.*npm ci$/)])
  })

  it("fails, after an install, on front door settings that are gone, unparseable or without the sandbox", async () => {
    const file = join(paths.root, "front-door-settings.json")
    rmSync(file)
    expect(await failed(deps())).toEqual([expect.stringMatching(/^front door settings: .*front-door-settings\.json is missing.*install\.sh/)])
    // Before the first install (doctor --fresh), it is not there yet.
    expect(await failed(deps({ fresh: true }))).toEqual([])
    // claude would start on this one with no sandbox and no deny rules.
    writeFileSync(file, "{ not json")
    expect(await failed(deps())).toEqual([expect.stringMatching(/^front door settings: .*not valid JSON/)])
    writeFileSync(file, JSON.stringify({ sandbox: { enabled: true, allowUnsandboxedCommands: true } }))
    expect(await failed(deps())).toEqual([expect.stringMatching(/^front door settings: .*does not turn the sandbox on/)])
  })

  it("fails on a sandbox block or allow rules the front door would inherit", async () => {
    // Its --settings are added to the user's and the checkout's local settings, not put in their place.
    const repo = join(home, "polads")
    mkdirSync(join(repo, ".claude"), { recursive: true })
    const config = JSON.parse(readFileSync(paths.config, "utf8"))
    writeFileSync(paths.config, JSON.stringify({ ...config, repo: { path: repo } }))
    const answers: Responses = [[/rev-parse --is-inside-work-tree$/, { stdout: "true\n" }]]
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ enabledPlugins: {}, permissions: { deny: ["Bash(rm:*)"] } }))
    expect(await failed(deps({}, answers))).toEqual([])
    writeFileSync(join(home, ".claude", "settings.json"), JSON.stringify({ sandbox: { excludedCommands: ["touch:*"] } }))
    writeFileSync(join(repo, ".claude", "settings.local.json"), JSON.stringify({ permissions: { allow: ["Bash(npm test:*)"] } }))
    expect(await failed(deps({}, answers))).toEqual([
      expect.stringMatching(/^settings the front door inherits: .*settings\.json has a sandbox block, .*settings\.local\.json has permissions\.allow rules/),
    ])
  })

  it("refuses a Claude Code older than the one the sandbox was verified on", async () => {
    expect(await failed(deps({}, [[/^claude --version$/, { stdout: "2.1.270 (Claude Code)\n" }]]))).toEqual([
      expect.stringMatching(/^claude: 2\.1\.270 .* older than 2\.1\.278/),
    ])
  })

  it("refuses a secrets file other users can read, and a missing one, without printing a value", async () => {
    chmodSync(join(home, ".config/linear/.env"), 0o644)
    const problems = await failed(deps())
    expect(problems).toEqual([expect.stringMatching(/^linear key: .*chmod 600/)])
    expect(problems.join()).not.toContain("lin_api_test")
    chmodSync(join(home, ".config/linear/.env"), 0o600)
    secret(".config/agentd/claude.env", "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat-x\n", 0o640)
    expect(await failed(deps())).toEqual([expect.stringMatching(/^claude token: .*chmod 600/)])
  })

  it("wants the Monday token only on the mini the Monday bridge runs on (STEP-3289)", async () => {
    const config = JSON.parse(readFileSync(paths.config, "utf8"))
    const monday = (enabled: boolean) =>
      writeFileSync(paths.config, JSON.stringify({ ...config, bridges: { monday: { enabled, people: [{ id: 1, name: "Nate" }], defaultPerson: 1 } } }))
    monday(false)
    expect(await failed(deps())).toEqual([])
    monday(true)
    expect(await failed(deps())).toEqual([expect.stringMatching(/^monday token: .*monday\.env is missing/)])
    secret(".config/agentd/monday.env", "MONDAY_API_TOKEN=eyJx\n", 0o644)
    expect(await failed(deps())).toEqual([expect.stringMatching(/^monday token: .*chmod 600/)])
    chmodSync(join(home, ".config/agentd/monday.env"), 0o600)
    expect(await failed(deps())).toEqual([])
  })

  it("refuses a GitHub login that cannot push, and no login at all", async () => {
    expect(await failed(deps({}, [[/--jq \.permissions\.push$/, { stdout: "false\n" }]]))).toEqual([
      expect.stringMatching(/^gh: eve-polads cannot push to STEP-Network\/v0-politiske-annoncer.*Write/),
    ])
    expect(await failed(deps({}, [[/^gh auth status$/, { code: 1, stderr: "You are not logged into any GitHub hosts." }]]))).toEqual([
      expect.stringMatching(/^gh: not logged in.*gh auth login/),
    ])
  })

  it("sends keychain checks that fail over SSH to the mini's own Terminal, and refuses them there", async () => {
    // Over SSH the login keychain is locked, so gh and claude see no login
    // although agentd's LaunchAgents, in the GUI session, have one.
    const locked: Responses = [
      [/^gh auth status$/, { code: 1, stderr: "User interaction is not allowed." }],
      [/^claude auth status$/, { code: 1, stdout: '{"loggedIn":false}' }],
    ]
    // SSH_CONNECTION as install.sh sees it, AGENTD_OVER_SSH as the agentctl shim passes it on.
    for (const env of [{ SSH_CONNECTION: "100.64.0.2 51234 100.64.0.9 22" }, { AGENTD_OVER_SSH: "1" }]) {
      expect(await failed(deps({ env }, locked))).toEqual([])
      expect(await warned(deps({ env }, locked))).toEqual([
        expect.stringMatching(/^gh: can't check over SSH \(login keychain\): .*own Terminal/),
        expect.stringMatching(/^claude login: can't check over SSH \(login keychain\): .*own Terminal/),
      ])
    }
    // In the GUI session they fail, and a mark that is not 1 is no SSH session.
    expect((await failed(deps({}, locked))).map((f) => f.split(":")[0])).toEqual(["gh", "claude login"])
    expect((await failed(deps({ env: { AGENTD_OVER_SSH: "" } }, locked))).map((f) => f.split(":")[0])).toEqual(["gh", "claude login"])
  })

  it("refuses a laptop profile, a missing config and two names for one mini", async () => {
    expect(await failed(deps({ profile: () => "human" }))).toEqual([expect.stringMatching(/^profile: .*"profile": "agent"/)])
    expect(await failed(deps({ profileMini: () => "bob" }))).toEqual([expect.stringMatching(/^mini: .*"eve".*"bob"/)])
    const noConfig = await failed(deps({ paths: { ...paths, config: join(home, "nowhere", "config.json") } }))
    expect(noConfig).toEqual([expect.stringMatching(/^config: .*config\.example\.json/)])
  })

  it("warns when the front door would not run the checkout's plugin, and when a Monday key is exported", async () => {
    writeFileSync(
      join(home, ".claude", "plugins", "known_marketplaces.json"),
      JSON.stringify({ "dev-tasks-marketplace": { source: { source: "github", repo: "STEP-Network/dev-tasks" } } }),
    )
    const warnings = await warned(deps({ env: { MONDAY_API_KEY: "x" } }))
    expect(warnings).toEqual([
      expect.stringMatching(/^front door plugin: .*github.*worker runs .*dev-tasks\/plugin/),
      expect.stringMatching(/^monday: MONDAY_API_KEY is set.*read-only for agents/),
    ])
    expect(warnings.join()).not.toContain("=x")
  })
})
