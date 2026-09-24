import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it } from "vitest"
import { agentPaths, assertProfileMini, loadConfig, MINI_RE, readProfileMini } from "../config.ts"

const MINIMAL = {
  mini: "eve",
  repo: { path: "/Users/eve/polads" },
  pluginRoot: "/Users/eve/dev-tasks/plugin",
  slack: { allowedUsers: ["U06LHEHFD3P"] },
}

function withConfig(value: unknown) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-config-")))
  mkdirSync(paths.root, { recursive: true })
  writeFileSync(paths.config, JSON.stringify(value))
  return paths
}

afterEach(() => {
  delete process.env.AGENTD_HOME
})

describe("agentPaths", () => {
  it("puts everything under ~/.agentd", () => {
    const paths = agentPaths("/Users/eve")
    expect(paths.root).toBe("/Users/eve/.agentd")
    expect(paths.outbox).toBe("/Users/eve/.agentd/outbox")
    expect(paths.threads).toBe("/Users/eve/.agentd/state/threads")
    expect(paths.pauseFile).toBe("/Users/eve/.agentd/PAUSE")
  })

  it("honours AGENTD_HOME", () => {
    process.env.AGENTD_HOME = "/tmp/elsewhere"
    expect(agentPaths("/Users/eve").inbox).toBe("/tmp/elsewhere/inbox")
  })
})

describe("loadConfig", () => {
  it("fills every default from a minimal file", () => {
    const config = loadConfig(withConfig(MINIMAL))
    expect(config.repo).toEqual({ path: "/Users/eve/polads", slug: "STEP-Network/v0-politiske-annoncer", base: "staging", product: "polads" })
    expect(config.slack.channels).toEqual({ agents: "polads-agents", questions: "polads-questions", intake: "polads-intake", releases: "polads-releases" })
    expect(config.slack.otherAgentBots).toEqual([])
    expect(config.worker).toEqual({ defaultModel: "sonnet", complexModel: "opus", maxTurns: 250, maxBudgetUsd: 15, wallClockMinutes: 90 })
    expect(config.queue.mode).toBe("allowlist")
    expect(config.claims).toEqual({ heartbeatMinutes: 15, ttlHours: 6 })
    expect(config.frontDoor.model).toBe("sonnet")
  })

  it("names the file and the field when the file is invalid", () => {
    expect(() => loadConfig(withConfig({ ...MINIMAL, mini: "Eve!" }))).toThrow(/config\.json is invalid: mini/)
    expect(() => loadConfig(withConfig({ ...MINIMAL, slack: { allowedUsers: [] } }))).toThrow(/slack\.allowedUsers/)
  })

  it("takes Slack member ids only, where a bot or app id would quietly match nobody", () => {
    expect(() => loadConfig(withConfig({ ...MINIMAL, slack: { allowedUsers: ["nate"] } }))).toThrow(/slack\.allowedUsers\.0 .*member id/)
    expect(() => loadConfig(withConfig({ ...MINIMAL, slack: { ...MINIMAL.slack, otherAgentBots: ["B0123ABC"] } }))).toThrow(/slack\.otherAgentBots\.0 .*member id/)
    expect(loadConfig(withConfig({ ...MINIMAL, slack: { ...MINIMAL.slack, otherAgentBots: ["U0BOBBOT1"] } })).slack.otherAgentBots).toEqual(["U0BOBBOT1"])
  })

  it("says where to start when there is no file", () => {
    expect(() => loadConfig(agentPaths(mkdtempSync(join(tmpdir(), "agentd-empty-"))))).toThrow(/templates\/config\.example\.json/)
  })
})

describe("the mini has one name (decision 2)", () => {
  it("takes exactly the names trackerctl takes, the ones a claim comment can carry", () => {
    // Two copies of one pattern would drift: pin config.json's to trackerctl's.
    const trackerctl = readFileSync(new URL("../../../plugin/scripts/trackerctl.ts", import.meta.url), "utf8")
    expect(trackerctl).toContain(`const MINI_RE = ${MINI_RE}`)
    for (const name of ["eve mini", " eve", "Eve", "3eve", ""]) {
      expect(() => loadConfig(withConfig({ ...MINIMAL, mini: name }))).toThrow(/config\.json is invalid: mini/)
    }
  })

  it("asks hooks/lib/profile.sh for the machine's mini, and gets null where it reports none", () => {
    const home = mkdtempSync(join(tmpdir(), "agentd-profile-"))
    const env = { ...process.env, HOME: home }
    expect(readProfileMini(env)).toBeNull()
    mkdirSync(join(home, ".claude"))
    const profile = join(home, ".claude", "dev-tasks-profile.json")
    writeFileSync(profile, '{ "profile": "human", "devSurface": "localhost", "mini": null }')
    expect(readProfileMini(env)).toBeNull()
    writeFileSync(profile, '{ "profile": "agent", "devSurface": "preview", "mini": "eve" }')
    expect(readProfileMini(env)).toBe("eve")
    writeFileSync(profile, "{ this is not json")
    expect(readProfileMini(env)).toBeNull()
  })

  it("throws when the reader itself is broken, rather than pass for a machine without a mini", () => {
    // plugin 1.1.1's rule for trackerctl too: a moved or failing reader is not a laptop.
    expect(() => readProfileMini(process.env, join(tmpdir(), "no-such-profile.sh"))).toThrow(/no-such-profile\.sh could not report this machine's mini/)
  })

  it("refuses a config.json that names another mini than the machine profile, naming both", () => {
    const paths = withConfig(MINIMAL)
    const config = loadConfig(paths)
    expect(() => assertProfileMini(config, "eve", paths.config)).not.toThrow()
    expect(() => assertProfileMini(config, "bob", paths.config)).toThrow(/mini "eve".*mini "bob"/)
    expect(() => assertProfileMini(config, null, paths.config)).toThrow(/mini "eve".*no mini.*no jq/)
  })
})
