/**
 * Source-level invariants over the skill markdown.
 *
 * A skill is prose; what CAN be pinned is that its load-bearing LITERALS are
 * present and its retired ones are gone. Two of these are contradictions that
 * would otherwise ship in silence: a skill that bans `--auto` shipping beside
 * a skill that runs it, and any skill reaching for `--admin`, which spec
 * section 11 keeps banned outright.
 */

import { existsSync, readdirSync, readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, "..", "..")

function skill(name: string): string {
  return readFileSync(resolve(PLUGIN_ROOT, "skills", name, "SKILL.md"), "utf-8")
}

function rule(file: string): string {
  return readFileSync(resolve(PLUGIN_ROOT, "rules", file), "utf-8")
}

describe("babysit-prs no longer bans auto-merge", () => {
  const source = skill("babysit-prs")

  it("carries no DO NOT use gh pr merge --auto line", () => {
    expect(source).not.toMatch(/DO NOT use\s+`?gh pr merge --auto`?/i)
  })

  it("does not tell the agent to reach for --admin", () => {
    // Spec section 11: no --admin merges, bypass actors stay empty.
    // (Not a blanket /--admin/ ban: the skill's own prose says "Never `--admin`"
    // as an instruction, which itself contains the substring "--admin".)
    expect(source).not.toMatch(/gh pr merge[^\n`]*--admin/)
    expect(source).not.toMatch(/[Uu]se `--admin/)
  })

  it("still explains what the skill is for", () => {
    // A guard that passes because the file was emptied is not a guard.
    expect(source.length).toBeGreaterThan(2000)
    expect(source).toMatch(/gh pr merge/)
  })
})

describe("/dev", () => {
  const source = skill("dev")

  it("declares itself user-invocable with the name dev", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*dev\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("writes NOTHING to the tracker", () => {
    // Spec section 5: "No tracker writes, no subtasks, no hours."
    expect(source).not.toMatch(/trackerctl(\.ts["']?)?\s+(create|claim|comment|attach)/)
  })

  it("reads the issue through trackerctl rather than an MCP tool", () => {
    expect(source).toMatch(/trackerctl\.ts["']?\s+branch/)
    expect(source).not.toMatch(/mcp__plugin_dev-tasks/)
  })

  it("works in the MAIN checkout unless --worktree is passed", () => {
    expect(source).toMatch(/--worktree/)
    expect(source).toMatch(/main checkout/i)
  })

  it("ends with /preview when devSurface is preview", () => {
    expect(source).toMatch(/devSurface/)
    expect(source).toMatch(/\/preview/)
  })
})

describe("/preview", () => {
  const source = skill("preview")

  it("declares itself user-invocable with the name preview", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*preview\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("pushes the FEATURE branch and never the base", () => {
    expect(source).toMatch(/git push -u origin HEAD/)
    expect(source).not.toMatch(/git push\s+origin\s+(staging|main)\b/)
  })

  it("prints the protection bypass query", () => {
    // A preview URL without it 302s an unauthenticated reader to a login page.
    expect(source).toMatch(/VERCEL_AUTOMATION_BYPASS_SECRET/)
    expect(source).toMatch(/x-vercel-set-bypass-cookie/)
  })

  it("runs no local build, lint, test or Playwright", () => {
    expect(source).not.toMatch(/pnpm (build|lint|test)\b/)
    expect(source).not.toMatch(/playwright test/)
  })
})

describe("/ship", () => {
  const source = skill("ship")

  it("declares itself user-invocable with the name ship", () => {
    expect(source).toMatch(/^---\n[\s\S]*?\bname:\s*ship\b[\s\S]*?\buser_invocable:\s*true\b[\s\S]*?\n---/m)
  })

  it("runs tsc --noEmit as the ONE local check, with an opt-out", () => {
    expect(source).toMatch(/tsc --noEmit/)
    expect(source).toMatch(/--skip-typecheck/)
  })

  it("runs no other local check", () => {
    expect(source).not.toMatch(/pnpm (build|lint|test)\b/)
    expect(source).not.toMatch(/playwright test/)
    expect(source).not.toMatch(/validate-schema/)
  })

  it("creates an issue when none is linked", () => {
    expect(source).toMatch(/trackerctl\.ts["']?\s+create/)
  })

  it("puts the identifier in BOTH the PR title and the PR body", () => {
    // LINEAR_REF_RE reads the BODY (lib/ci/pr-task-trace.ts); Linear's own
    // autolink reads the TITLE. Only one of the two is the CI check.
    expect(source).toMatch(/PR title/i)
    expect(source).toMatch(/PR body/i)
    expect(source).toMatch(/STEP-/)
  })

  it("writes the Monday provider's Task trace line, not a bare id", () => {
    // TASK_LINE_RE in lib/ci/pr-task-trace.ts matches this exact shape on
    // origin/staging while tracker.provider defaults to monday; a bare id
    // in the body matches neither TASK_LINE_RE nor LINEAR_REF_RE.
    expect(source).toMatch(/Monday\.com Task: #/)
    expect(source).toMatch(/STEP-/)
  })

  it("labels by Linear's bare label name, not a group-qualified path", () => {
    // The real STEP workspace's labels are bare (`chore`, `polads`, ...).
    // The adapter matches by exact name and silently skips unknown ones, so
    // a group-qualified path like `type/chore` never applies a label.
    expect(source).not.toMatch(/--label\s+"?type\//)
  })

  it("arms auto-merge with the exact flags, and never --admin", () => {
    expect(source).toMatch(/gh pr merge .*--auto --squash --delete-branch/)
    expect(source).not.toMatch(/gh pr merge[^\n`]*--admin/)
    expect(source).not.toMatch(/[Uu]se `--admin/)
  })

  it("targets the configured base and never pushes to it", () => {
    expect(source).toMatch(/git\.defaultBase/)
    expect(source).toMatch(/git push -u origin HEAD/)
    expect(source).not.toMatch(/git push\s+origin\s+(staging|main)\b/)
  })

  it("stops after opening the PR — no CI polling loop", () => {
    expect(source).toMatch(/stops?\b/i)
    expect(source).not.toMatch(/gh pr checks --watch/)
  })
})

describe("plugin rules are read on demand", () => {
  // rule-autoload is opt-in since 1.0.1 (STEP-3088), so a plugin rule reaches
  // the agent only when a skill names it. The name has to resolve in a
  // consumer project, and a skill that runs under the Linear provider must not
  // send the agent to a rule that only describes the Monday pipeline.
  const MARKER = "**Monday provider only.**"
  const ruleFiles = readdirSync(resolve(PLUGIN_ROOT, "rules")).filter((f) => f.endsWith(".md"))
  const mondayOnly = ruleFiles.filter((f) =>
    rule(f).split("\n").slice(0, 12).some((line) => line.includes(MARKER)),
  )

  // Skills that run on the Monday MCP tools or inside the legacy
  // /pickup-task → /ship-pr pipeline. Every other skill can run in a Linear
  // project, so every other skill is checked.
  const MONDAY_SKILLS = new Set([
    "audit-versions",
    "create-task",
    "file-retro",
    "investigate-request",
    "log-progress",
    "pickup-task",
    "plan-task",
    "refine-task",
    "release-version",
    "self-review",
    "ship-pr",
    "triage-feedback",
    "write-uat-spec",
  ])
  const skillNames = readdirSync(resolve(PLUGIN_ROOT, "skills"), { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)

  it("marks exactly the Monday-era rules", () => {
    // The full list, so dropping one banner can't quietly take that rule out
    // of the Linear-skill check below.
    expect([...mondayOnly].sort()).toEqual([
      "agent-autonomy.md",
      "agent-orchestration.md",
      "autonomous-by-default.md",
      "e2e-masterplan.md",
      "meta-workflow.md",
      "release-flow.md",
      "task-lifecycle.md",
      "versioning.md",
      "versions-lifecycle.md",
      "workflow-pipeline.md",
      "worktree-discipline.md",
    ])
  })

  it("exempts only skills that exist", () => {
    // A renamed skill would otherwise drop out of the check without a sound.
    for (const name of MONDAY_SKILLS) {
      expect(existsSync(resolve(PLUGIN_ROOT, "skills", name, "SKILL.md")), name).toBe(true)
    }
  })

  // `.claude/rules/<rule>.md` is the consumer's folder, where plugin rules do
  // not live, and `plugin/rules/` only exists inside this repo. A bare
  // `<rule>.md` gives the agent nothing to Read. `${CLAUDE_PLUGIN_ROOT}/rules/`
  // (substituted in skill content) or, in a hook, the same prefix printed
  // with a fallback, resolves everywhere.
  const names = ruleFiles.map((f) => f.replace(/\.md$/, "")).join("|")
  const unresolvable = new RegExp(`(?:\\.claude|plugin)/rules/(?:${names})\\.md`)
  const bare = new RegExp(`(?<![\\w/.-])(?:${names})\\.md`)

  it("names plugin rules by a path that resolves in a consumer project", () => {
    for (const name of skillNames) {
      expect(skill(name), name).not.toMatch(unresolvable)
      expect(skill(name), name).not.toMatch(bare)
    }
  })

  it("points hook and script messages at rule paths that resolve", () => {
    // With autoload off, a block message is often the only way the agent
    // hears about a rule.
    const files: string[] = []
    for (const [dir, exts] of [
      ["hooks", [".sh", ".py"]],
      ["hooks/lib", [".sh"]],
      ["scripts", [".sh"]],
    ] as const) {
      for (const f of readdirSync(resolve(PLUGIN_ROOT, dir))) {
        if (exts.some((ext) => f.endsWith(ext))) files.push(`${dir}/${f}`)
      }
    }
    expect(files.length).toBeGreaterThan(30)
    for (const file of files) {
      const source = readFileSync(resolve(PLUGIN_ROOT, file), "utf-8")
      expect(source, file).not.toMatch(unresolvable)
      expect(source, file).not.toMatch(bare)
    }
  })

  it("keeps skills that can run under Linear away from Monday-only rules", () => {
    const offenders: string[] = []
    for (const name of skillNames.filter((s) => !MONDAY_SKILLS.has(s))) {
      for (const line of skill(name).split("\n")) {
        for (const file of mondayOnly) {
          if (line.includes(file) && !line.includes("Monday provider only")) {
            offenders.push(`${name}: ${file}`)
          }
        }
      }
    }
    expect(offenders).toEqual([])
  })
})
