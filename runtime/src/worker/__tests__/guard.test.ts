import { mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { denyBannedBash, denyWorkerPaths, workerBashDenial, workerEnv, workerPathDenial, workerToolDenial } from "../guard.ts"

const SECRETS = /^Workers never read or write ~\/\.config or \.env files/

describe("workerBashDenial", () => {
  it("refuses any push, PR create or merge, and --admin, however it is written", () => {
    for (const command of [
      "git push",
      "git push origin HEAD",
      "cd /x && git  push -u origin STEP-7-x",
      "gh pr create --fill",
      "gh pr merge 12 --auto --squash",
      "gh api repos/x/pulls/1/merge -X PUT --admin",
    ]) {
      expect(workerBashDenial(command), command).not.toBeNull()
    }
  })

  it("refuses a command that names ~/.config or a .env file", () => {
    for (const command of [
      "cat ~/.config/linear/.env",
      "cat $HOME/.config/agentd/slack.env",
      'cat "${HOME}/.config/agentd/claude.env"',
      "cat /Users/eve/.config/agentd/claude.env",
      "cd ~ && ls .config",
      "source .env.local",
      "cp .env.example .env",
      "node -e \"require('dotenv').config({ path: '.env.test' })\"",
      "grep KEY ../polads/.env",
    ]) {
      expect(workerBashDenial(command), command).toMatch(SECRETS)
    }
  })

  it("lets ordinary work through", () => {
    for (const command of [
      "git status",
      "git commit -m 'fix: date'",
      "gh pr view 12",
      "pnpm jest lib/x.test.ts --forceExit",
      "git log --oneline -5",
      "rg process.env lib",
      "cat next.config.mjs jest.config.ts",
      "pnpm jest lib/env.test.ts --forceExit",
      "git config --get user.email",
    ]) {
      expect(workerBashDenial(command), command).toBeNull()
    }
  })
})

describe("denyBannedBash", () => {
  it("answers a banned Bash call with a PreToolUse deny and leaves other tools alone", async () => {
    expect(await denyBannedBash({ hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "git push origin staging" } })).toEqual({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: "Workers never push. The launcher pushes your commits after you report.",
      },
    })
    expect(await denyBannedBash({ hook_event_name: "PreToolUse", tool_name: "Edit", tool_input: { file_path: "/x" } })).toEqual({})
  })
})

/** A home with secrets in ~/.config, and a worktree in it with a way out through a symlink. */
function machine() {
  const home = mkdtempSync(join(tmpdir(), "agentd-guard-"))
  mkdirSync(join(home, ".config", "linear"), { recursive: true })
  writeFileSync(join(home, ".config", "linear", ".env"), "LINEAR_API_KEY=lin_api_test\n")
  const worktree = join(home, ".agentd", "worktrees", "STEP-7-fix-the-date")
  mkdirSync(join(worktree, "lib"), { recursive: true })
  writeFileSync(join(worktree, ".git"), "gitdir: /x\n")
  symlinkSync(join(home, ".config", "linear", ".env"), join(worktree, "lib", "key.txt"))
  symlinkSync(home, join(worktree, "out"))
  return { home, worktree, scope: { worktree, home } }
}

describe("workerPathDenial", () => {
  it("refuses reading or writing ~/.config and any .env file, however the path is written", () => {
    const { home, worktree, scope } = machine()
    for (const [tool, input] of [
      ["Read", { file_path: join(home, ".config", "linear", ".env") }],
      ["Read", { file_path: "~/.config/agentd/slack.env" }],
      ["Read", { file_path: join(worktree, "lib", "key.txt") }],
      ["Read", { file_path: join(worktree, ".env.local") }],
      ["Read", { file_path: ".env.production" }],
      ["Write", { file_path: join(worktree, ".env") }],
      ["Grep", { pattern: "KEY", path: join(home, ".config") }],
      ["Grep", { pattern: "KEY", path: worktree, glob: ".env*" }],
      ["Glob", { pattern: "**/.env*", path: worktree }],
      ["LS", { path: join(worktree, "out", ".config") }],
      // Grep runs ripgrep with --hidden: a search of home, or of any folder above it, reads ~/.config.
      ["Grep", { pattern: "lin_api", path: home }],
      ["Grep", { pattern: "lin_api", path: "/" }],
      ["Glob", { pattern: "**/*", path: "~" }],
    ] as const) {
      expect(workerPathDenial(tool, input, scope), `${tool} ${JSON.stringify(input)}`).toMatch(SECRETS)
    }
  })

  it("lets the tracked .env.example template through, and nothing that only starts with its name", () => {
    const { worktree, scope } = machine()
    expect(workerPathDenial("Read", { file_path: ".env.example" }, scope)).toBeNull()
    expect(workerPathDenial("Edit", { file_path: join(worktree, ".env.example") }, scope)).toBeNull()
    expect(workerBashDenial("git diff -- .env.example")).toBeNull()
    expect(workerPathDenial("Read", { file_path: ".env.example.local" }, scope)).toMatch(SECRETS)
    expect(workerBashDenial("cat .env.example.local")).toMatch(SECRETS)
  })

  it("takes a relative path from the session's own directory, which a cd can move", () => {
    const { home, worktree, scope } = machine()
    expect(workerPathDenial("Grep", { pattern: "lin_api", path: "." }, scope, home)).toMatch(SECRETS)
    expect(workerPathDenial("Grep", { pattern: "lin_api", path: "." }, scope, worktree)).toBeNull()
    expect(workerPathDenial("Write", { file_path: "notes.md" }, scope, home)).toMatch(/^Workers write only inside their worktree/)
  })

  it("knows ~/.config by where it really is when it is a symlink", () => {
    const { home, scope } = machine()
    const other = mkdtempSync(join(tmpdir(), "agentd-guard-home-"))
    mkdirSync(join(other, "dotfiles", "config", "agentd"), { recursive: true })
    symlinkSync(join(other, "dotfiles", "config"), join(other, ".config"))
    const linked = { ...scope, home: other }
    expect(workerPathDenial("Read", { file_path: join(other, "dotfiles", "config", "agentd", "slack.env") }, linked)).toMatch(SECRETS)
    expect(workerPathDenial("Read", { file_path: join(home, "dotfiles", "notes.md") }, scope)).toBeNull()
  })

  it("reads Grep's glob the way the tool splits it, and lets an exclusion through", () => {
    const { scope } = machine()
    expect(workerPathDenial("Grep", { pattern: "KEY", glob: "*.ts,.env*" }, scope)).toMatch(SECRETS)
    expect(workerPathDenial("Grep", { pattern: "KEY", glob: "src/**/*.ts .env.local" }, scope)).toMatch(SECRETS)
    expect(workerPathDenial("Grep", { pattern: "KEY", glob: "*.{ts,tsx} !.env*" }, scope)).toBeNull()
  })

  it("refuses changing the agent configuration Claude Code runs outside the sandbox, and lets it be read", () => {
    const { worktree, scope } = machine()
    for (const file of [join(".claude", "hooks", "e2e-gate-guard.sh"), join(".claude", "settings.json"), join(".claude", "settings.local.json"), ".mcp.json"]) {
      expect(workerPathDenial("Write", { file_path: join(worktree, file) }, scope), file).toMatch(/^Workers never change the project's agent configuration/)
      expect(workerPathDenial("Read", { file_path: join(worktree, file) }, scope), file).toBeNull()
    }
    expect(workerPathDenial("Edit", { file_path: join(worktree, ".claude", "rules", "copy.md") }, scope)).toBeNull()
  })

  it("refuses writing outside the worktree, through a symlink too, and git's own files", () => {
    const { home, worktree, scope } = machine()
    expect(workerPathDenial("Write", { file_path: join(home, "notes.md") }, scope)).toBe(`Workers write only inside their worktree, ${worktree}.`)
    expect(workerPathDenial("Edit", { file_path: join(worktree, "out", "notes.md") }, scope)).toMatch(/^Workers write only inside their worktree/)
    expect(workerPathDenial("NotebookEdit", { notebook_path: "/tmp/x.ipynb" }, scope)).toMatch(/^Workers write only inside their worktree/)
    expect(workerPathDenial("Write", { file_path: join(worktree, ".git") }, scope)).toBe("Workers never edit git's own files. Commit with git instead.")
    expect(workerPathDenial("Edit", { file_path: join(worktree, "vendor", ".git", "config") }, scope)).toMatch(/^Workers never edit git's own files/)
  })

  it("lets ordinary reads and writes through", () => {
    const { home, worktree, scope } = machine()
    expect(workerPathDenial("Read", { file_path: join(worktree, "lib", "x.ts") }, scope)).toBeNull()
    expect(workerPathDenial("Write", { file_path: join(worktree, "lib", "new.ts") }, scope)).toBeNull()
    expect(workerPathDenial("Edit", { file_path: "lib/x.ts" }, scope)).toBeNull()
    expect(workerPathDenial("Edit", { file_path: join(worktree, ".github", "workflows", "ci.yml") }, scope)).toBeNull()
    expect(workerPathDenial("Read", { file_path: join(home, "dev-tasks", "plugin", "README.md") }, scope)).toBeNull()
    expect(workerPathDenial("Grep", { pattern: "process.env", path: worktree }, scope)).toBeNull()
    expect(workerPathDenial("Grep", { pattern: "claimIssue", path: join(home, "dev-tasks") }, scope)).toBeNull()
    expect(workerPathDenial("Glob", { pattern: "**/*.config.ts" }, scope)).toBeNull()
    expect(workerPathDenial("TodoWrite", { todos: [] }, scope)).toBeNull()
  })
})

describe("denyWorkerPaths and workerToolDenial", () => {
  it("deny a secret read as a PreToolUse hook and name the same rule for canUseTool", async () => {
    const { home, scope } = machine()
    const hook = denyWorkerPaths(scope)
    const input = { file_path: join(home, ".config", "linear", ".env") }
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: input })).toMatchObject({
      hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: expect.stringMatching(SECRETS) },
    })
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Read", tool_input: { file_path: "lib/x.ts" } })).toEqual({})
    // The hook takes a relative path from the cwd in its input.
    expect(await hook({ hook_event_name: "PreToolUse", tool_name: "Grep", tool_input: { pattern: "k", path: "." }, cwd: home })).toMatchObject({
      hookSpecificOutput: { permissionDecision: "deny" },
    })
    expect(workerToolDenial("Read", input, scope)).toMatch(SECRETS)
    expect(workerToolDenial("Bash", { command: "cat ~/.config/linear/.env" }, scope)).toMatch(SECRETS)
    expect(workerToolDenial("Bash", { command: "git push" }, scope)).toMatch(/^Workers never push/)
    expect(workerToolDenial("Bash", { command: "pnpm lint" }, scope)).toBeNull()
  })
})

describe("workerEnv", () => {
  it("drops keys that would switch billing or leak a secret, and adds the extras", () => {
    const env = workerEnv({ PATH: "/bin", HOME: "/Users/eve", ANTHROPIC_API_KEY: "sk-x", LINEAR_API_KEY: "lin_api_x", SLACK_BOT_TOKEN: "xoxb-x", DATABASE_URL: "postgres://x", GH_TOKEN: "ghp_x" }, { DEV_TASKS_PROFILE: "agent" })
    expect(env).toEqual({ PATH: "/bin", HOME: "/Users/eve", DEV_TASKS_PROFILE: "agent" })
  })

  it("drops every other way to another bill or another account, and the Monday key the plugin's hooks would write with", () => {
    const env = workerEnv(
      { PATH: "/bin", ANTHROPIC_BASE_URL: "https://x", ANTHROPIC_AUTH_TOKEN: "t", CLAUDE_CODE_USE_BEDROCK: "1", CLAUDE_CODE_USE_VERTEX: "1", MONDAY_API_KEY: "m", GITHUB_TOKEN: "g", SENTRY_CRON_URL: "https://s", CLAUDE_CODE_OAUTH_TOKEN: "oauth" },
      {},
    )
    expect(env).toEqual({ PATH: "/bin", CLAUDE_CODE_OAUTH_TOKEN: "oauth" })
  })
})
