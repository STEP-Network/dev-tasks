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

  it("runs Eve's model at xhigh, in the workers and at the front door (STEP-3367)", () => {
    const config = ConfigSchema.parse(example)
    expect(config.worker).toMatchObject({ defaultModel: "claude-opus-5-5", complexModel: "claude-opus-5-5", effort: "xhigh", fanOut: true })
    expect(config.frontDoor).toMatchObject({ model: "claude-opus-5-5", effort: "xhigh" })
  })

  it("leaves the binaries' paths to install.sh", () => {
    expect(example.frontDoor.claudePath).toBeUndefined()
    expect(example.frontDoor.tmuxPath).toBeUndefined()
  })

  it("shows the Monday bridge's Wave 2 keys, off, with made-up ids (runbook, Two boards and two doors)", () => {
    const monday = ConfigSchema.parse(example).bridges.monday!
    expect([monday.enabled, monday.digest.enabled]).toEqual([false, false])
    expect(Object.keys(monday.requests!.columns).sort()).toEqual(["class", "linear", "progress", "requester", "size", "slackThread", "stage", "targetWeek", "type"])
    expect(monday.columns).toMatchObject({ recommendation: expect.any(String), request: expect.any(String), slackThread: expect.any(String) })
    expect(monday.groups).toMatchObject({ needsYou: "Decide", approvePlan: "Approve plan", looks: "Looks good?", fyi: "FYI" })
    expect(monday.people.every((p) => p.slackId && /EXAMPLE/.test(p.slackId))).toBe(true)
    expect(example.slack.allowedUsers.every((u: string) => /EXAMPLE/.test(u))).toBe(true)
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
        "Bash(~/.agentd/bin/agentctl retry:*)",
        "Bash(~/.agentd/bin/agentctl probe-hooks:*)",
        "Bash(~/.agentd/bin/agentctl probe-sandbox:*)",
        "Bash(git push:*)",
        "Bash(gh pr create:*)",
        "Bash(gh pr merge:*)",
      ]),
    )
  })

  it("denies the GitHub MCP server's write tools, by either name it may carry (STEP-3293 review)", () => {
    // Slack words reach the front door as a prompt now. It writes to GitHub
    // through nothing: agentd opens, fixes and merges PRs. Reads stay.
    const writes = ["merge_pull_request", "push_files", "create_or_update_file", "delete_file", "create_branch", "create_pull_request", "update_pull_request", "update_pull_request_branch", "pull_request_review_write", "create_and_submit_pull_request_review", "add_comment_to_pending_review", "add_issue_comment", "add_reply_to_pull_request_comment", "update_issue_comment", "issue_write", "create_issue", "update_issue", "sub_issue_write", "create_repository", "fork_repository", "run_workflow", "rerun_workflow_run", "rerun_failed_jobs", "cancel_workflow_run", "delete_repository", "create_pull_request_with_copilot", "assign_copilot_to_issue", "request_copilot_review"]
    for (const server of ["mcp__github__", "mcp__plugin_github_github__"]) {
      for (const tool of writes) expect(rendered.permissions.deny, `${server}${tool}`).toContain(`${server}${tool}`)
    }
    const github = rendered.permissions.deny.filter((rule: string) => /^mcp__(github|plugin_github_github)__/.test(rule))
    expect(github.every((rule: string) => writes.some((tool) => rule.endsWith(`__${tool}`)))).toBe(true)
  })

  it("denies the Linear MCP server's write tools, by every name it may carry: trackerctl is the only way to change an issue (Wave 1)", () => {
    // trackerctl never lowers an approval class. A Linear MCP write would go round it.
    const writes = ["save_issue", "save_comment", "delete_comment", "create_issue_label", "save_issue_label", "retire_issue_label", "restore_issue_label", "save_project", "save_project_label", "retire_project_label", "restore_project_label", "save_milestone", "save_document", "save_status_update", "delete_status_update", "create_attachment", "create_attachment_from_upload", "prepare_attachment_upload", "delete_attachment", "share_issue", "unshare_issue", "save_release", "save_release_note", "merge_diff", "update_diff", "save_diff_comment", "delete_diff_comment", "resolve_diff_thread", "submit_diff_review", "mark_notification"]
    for (const server of ["mcp__linear__", "mcp__linear-server__", "mcp__plugin_linear_linear__"]) {
      for (const tool of writes) expect(rendered.permissions.deny, `${server}${tool}`).toContain(`${server}${tool}`)
    }
    // Reads stay: the front door reads issues through trackerctl, and may through the MCP.
    const linear = rendered.permissions.deny.filter((rule: string) => /^mcp__(linear|linear-server|plugin_linear_linear)__/.test(rule))
    expect(linear.every((rule: string) => writes.some((tool) => rule.endsWith(`__${tool}`)))).toBe(true)
    expect(linear).not.toContain("mcp__linear-server__get_issue")
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

  it("refuses every other session's message, from this machine or another (STEP-3367)", () => {
    expect(rendered).toMatchObject({ crossSessionInbound: "refuse", isolatePeerMachines: true })
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
