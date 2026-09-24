import { spawn, spawnSync } from "node:child_process"
import { chmodSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { checkLocal } from "../main.ts"

const CONFIG = { mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] } }
const RUNTIME = fileURLToPath(new URL("../../..", import.meta.url))

function home(profileMini: string | null) {
  const h = mkdtempSync(join(tmpdir(), "agentd-home-"))
  mkdirSync(join(h, ".agentd"), { recursive: true })
  writeFileSync(join(h, ".agentd", "config.json"), JSON.stringify(CONFIG))
  mkdirSync(join(h, ".claude"))
  writeFileSync(join(h, ".claude", "dev-tasks-profile.json"), JSON.stringify({ profile: "agent", devSurface: "preview", mini: profileMini }))
  return h
}

function secret(path: string, text: string) {
  mkdirSync(join(path, ".."), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, 0o600)
}

// A key exported in the shell that runs the tests would skip the key file check.
const inherited = process.env.LINEAR_API_KEY
beforeEach(() => {
  delete process.env.LINEAR_API_KEY
})
afterEach(() => {
  if (inherited === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = inherited
})

/** agentd as launchd runs it, with the mini from the real hooks/lib/profile.sh, and no Linear, tmux or Sentry in reach. */
const runAgentd = (h: string) =>
  spawnSync(join(RUNTIME, "node_modules", ".bin", "tsx"), [join(RUNTIME, "src", "agentd", "main.ts")], {
    cwd: h,
    env: { PATH: process.env.PATH ?? "", HOME: h },
    encoding: "utf8",
    timeout: 30_000,
  })

describe("starting agentd", () => {
  it("refuses when config.json and the machine profile name different minis, before it reads a secret (decision 2)", () => {
    // No Linear key exists: an error about it would mean the check came too late.
    const paths = agentPaths(home("alice"))
    expect(() => checkLocal(paths, "alice")).toThrow(/mini "eve".*mini "alice"/)
    expect(() => checkLocal(paths, null)).toThrow(/mini "eve".*no mini/)
    // The same config with the profile's agreement gets past the check, to the missing key.
    expect(() => checkLocal(paths, "eve")).toThrow(/^secrets: /)
  })

  it("reads the config and the optional Sentry check-in URL, and nothing of Slack's", () => {
    const h = home("eve")
    secret(join(h, ".config", "linear", ".env"), "LINEAR_API_KEY=lin_api_test\n")
    expect(checkLocal(agentPaths(h), "eve")).toMatchObject({ config: { mini: "eve" }, sentryUrl: null })
    secret(join(h, ".config", "agentd", "agentd.env"), "SENTRY_CRON_URL=https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/k/\n")
    expect(checkLocal(agentPaths(h), "eve").sentryUrl).toBe("https://o1.ingest.de.sentry.io/api/2/cron/eve-mini/k/")
  })

  it("as a process, records the refusal in agentd.json and exits 0 so launchd leaves it stopped", () => {
    const h = home("alice")
    const run = runAgentd(h)
    expect(run.status).toBe(0)
    const status = JSON.parse(readFileSync(join(h, ".agentd", "state", "agentd.json"), "utf8"))
    expect(status).toMatchObject({ pid: expect.any(Number), error: expect.stringMatching(/mini "eve".*mini "alice"/) })
  }, 30_000)

  it("as a process, will not run beside another agentd, and leaves that one's agentd.json alone", () => {
    // A live process whose command line names agentd holds the lock, as launchd's would.
    const h = home("eve")
    const other = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)", "src/agentd/main.ts"], { stdio: "ignore" })
    try {
      mkdirSync(join(h, ".agentd", "state"), { recursive: true })
      writeFileSync(join(h, ".agentd", "state", "agentd.pid"), String(other.pid))
      const run = runAgentd(h)
      expect(run.status).toBe(1)
      expect(run.stderr).toMatch(new RegExp(`another agentd is running here, pid ${other.pid}`))
      expect(() => readFileSync(join(h, ".agentd", "state", "agentd.json"), "utf8")).toThrow(/ENOENT/)
    } finally {
      other.kill()
    }
  }, 30_000)
})
