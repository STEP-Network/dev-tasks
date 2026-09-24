/** The files install.sh renders and what Nate copies: runtime/templates and runtime/launchd. */

import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../config.ts"

const read = (path: string) => readFileSync(fileURLToPath(new URL(`../../${path}`, import.meta.url)), "utf8")

describe("templates/config.example.json", () => {
  const example = JSON.parse(read("templates/config.example.json"))

  it("is a valid config for Eve, starting supervised: on the allowlist with nothing on it, and a person merging", () => {
    const config = ConfigSchema.parse(example)
    expect(config).toMatchObject({ mini: "eve", repo: { path: "/Users/eve/polads" }, pluginRoot: "/Users/eve/dev-tasks/plugin" })
    expect(config.queue).toMatchObject({ mode: "allowlist", allow: [] })
    expect(config.worker.autoMerge).toBe(false)
    expect(config.slack.otherAgentBots).toEqual([])
  })

  it("leaves the binaries' paths to install.sh", () => {
    expect(example.frontDoor.claudePath).toBeUndefined()
    expect(example.frontDoor.tmuxPath).toBeUndefined()
  })
})

describe("templates/claude-settings.json, the front door's settings", () => {
  const text = read("templates/claude-settings.json")
  const rendered = JSON.parse(text.replaceAll("__AGENTD_HOME__", "/Users/eve/.agentd").replaceAll("__REPO__", "/Users/eve/polads"))

  it("uses only the placeholders install.sh fills in", () => {
    expect([...new Set(text.match(/__[A-Z_]+__/g))].sort()).toEqual(["__AGENTD_HOME__", "__REPO__"])
  })

  it("keeps the front door out of the code, every credential store and ~/.agentd (spec 6.1, decision 8)", () => {
    expect(rendered.permissions.deny).toEqual(
      expect.arrayContaining([
        "Edit(//Users/eve/polads/**)",
        "Write(//Users/eve/polads/**)",
        "Read(~/.config/**)",
        "Read(~/.ssh/**)",
        "Read(~/.npmrc)",
        "Read(~/.netrc)",
        "Read(~/.git-credentials)",
        "Read(~/.vercel/**)",
        "Read(~/Library/Application Support/com.vercel.cli/**)",
        "Edit(~/.agentd/**)",
        "Bash(~/.agentd/bin/agentctl resume:*)",
        "Bash(~/.agentd/bin/agentctl probe-hooks:*)",
        "Bash(~/.agentd/bin/agentctl probe-sandbox:*)",
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
      ]),
    )
  })

  it("runs agentctl and trackerctl outside the sandbox, and gives sandboxed commands no network, no secret and one place to write", () => {
    // The two read the Linear key and reach Linear, which a sandboxed Node
    // process cannot (its fetch ignores the sandbox's proxy). Everything else
    // stays inside: no read of the key, no write to ~/.agentd.
    expect(rendered.permissions.allow).toEqual(["Bash(~/.agentd/bin/agentctl:*)", "Bash(~/.agentd/bin/trackerctl:*)"])
    expect(rendered.sandbox).toEqual({
      enabled: true,
      autoAllowBashIfSandboxed: true,
      allowUnsandboxedCommands: false,
      excludedCommands: ["~/.agentd/bin/agentctl:*", "~/.agentd/bin/trackerctl:*"],
      network: { allowedDomains: [] },
      filesystem: { allowWrite: ["~/.front-door"] },
    })
  })

  it("turns on the status line and Remote Control, and the plugin", () => {
    expect(rendered.statusLine).toEqual({ type: "command", command: "/Users/eve/.agentd/bin/statusline" })
    expect(rendered).toMatchObject({ remoteControlAtStartup: true, autoContinueAtUsageLimit: true, enabledPlugins: { "dev-tasks@dev-tasks-marketplace": true } })
  })
})

describe("launchd/eu.polads.agentd.plist", () => {
  it("keeps the front door's Claude Code from updating itself under the sandbox probe's feet", () => {
    // agentctl probe-sandbox records the version its checks passed on, and a
    // person updates Claude Code, then probes again (runbook, section 12).
    expect(read("launchd/eu.polads.agentd.plist")).toMatch(/<key>DISABLE_AUTOUPDATER<\/key>\s*<string>1<\/string>/)
  })
})

describe("launchd/*.plist", () => {
  for (const [label, entry] of [
    ["eu.polads.agentd", "src/agentd/main.ts"],
    ["eu.polads.slack-bridge", "src/slack/bridge.ts"],
  ]) {
    const plist = read(`launchd/${label}.plist`)

    it(`${label} runs ${entry} with an explicit PATH, restarting only a failed exit`, () => {
      expect(plist).toContain(`<string>${label}</string>`)
      expect(plist).toContain(`<string>__RUNTIME__/${entry}</string>`)
      expect(plist).toMatch(/<key>PATH<\/key>\s*<string>__PATH__<\/string>/)
      expect(plist).toMatch(/<key>AGENTD_HOME<\/key>\s*<string>__AGENTD_HOME__<\/string>/)
      expect(plist).toMatch(/<key>SuccessfulExit<\/key>\s*<false\/>/)
      expect(plist).toContain(`__AGENTD_HOME__/logs/${label.replace("eu.polads.", "")}.launchd.log`)
      expect([...new Set(plist.match(/__[A-Z_]+__/g))].sort()).toEqual(["__AGENTD_HOME__", "__NODE__", "__PATH__", "__RUNTIME__"])
    })
  }
})
