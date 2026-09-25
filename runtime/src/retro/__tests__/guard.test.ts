import { describe, expect, it } from "vitest"
import { frontmatter, parseNameStatus, retroDiffProblems, type DiffEntry } from "../guard.ts"

const SKILL = "---\nname: front-door\ndescription: One wakeup.\n---\n\n# /front-door\n\nStep one.\n"
/** Texts at the base and at the head: every file is plain text with no frontmatter unless given. */
const texts = (before: Record<string, string> = {}, after: Record<string, string> = {}) => ({
  before: (p: string) => before[p] ?? "old text\n",
  after: (p: string) => after[p] ?? "new text\n",
})
const edit = (path: string, extra: Partial<DiffEntry> = {}): DiffEntry => ({ status: "M", path, mode: "100644", ...extra })

describe("what a retro PR may change (STEP-3290)", () => {
  it("lets through text in the worker's prompts, the skills, the rules and the docs", () => {
    const entries = [
      edit("runtime/prompts/worker-lessons.md"),
      edit("plugin/skills/front-door/SKILL.md"),
      edit("plugin/skills/refine/references/examples.md"),
      edit("plugin/rules/testing.md"),
      edit("docs/agent-mini-runbook.md"),
      { status: "A", path: "docs/retros/2026-09-25.md", mode: "100644" },
    ]
    expect(retroDiffProblems(entries, texts({ "plugin/skills/front-door/SKILL.md": SKILL }, { "plugin/skills/front-door/SKILL.md": SKILL.replace("Step one.", "Step one, then two.") }))).toEqual([])
  })

  it("refuses a guard, a hook, a permission, an allowlist, the merge policy, a config or a secret", () => {
    const refused = [
      "runtime/src/worker/guard.ts",
      "runtime/src/retro/guard.ts",
      "plugin/hooks/bash-guard.sh",
      "plugin/hooks/hooks.json",
      "plugin/hooks/README.md",
      ".claude/settings.json",
      ".claude/project-config.json",
      "runtime/templates/config.example.json",
      "runtime/templates/claude-settings.json",
      ".github/workflows/ci.yml",
      "CODEOWNERS",
      "docs/.env.example",
      "docs/allowlist.md",
      "docs/permissions.md",
      "plugin/agents/self-reviewer.md",
      "plugin/rules-routing.json",
      "runtime/prompts/worker-lessons.txt",
      "README.md",
    ]
    for (const path of refused) expect(retroDiffProblems([edit(path)], texts()), path).toEqual([`${path}: not a prompt, checklist, skill or doc the retro may change`])
  })

  it("refuses a frontmatter change, where a skill's tools and permissions live, and a new file that brings one", () => {
    const withTools = SKILL.replace("description: One wakeup.", "description: One wakeup.\nallowed-tools: Bash(*)")
    expect(retroDiffProblems([edit("plugin/skills/front-door/SKILL.md")], texts({ "plugin/skills/front-door/SKILL.md": SKILL }, { "plugin/skills/front-door/SKILL.md": withTools }))).toEqual([
      "plugin/skills/front-door/SKILL.md: its frontmatter changed, where tools and permissions live",
    ])
    expect(retroDiffProblems([{ status: "A", path: "plugin/skills/new/SKILL.md", mode: "100644" }], texts({}, { "plugin/skills/new/SKILL.md": SKILL }))).toEqual([
      "plugin/skills/new/SKILL.md: its frontmatter changed, where tools and permissions live",
    ])
  })

  it("refuses a deletion, a rename out of the allowed places, a symlink and an executable", () => {
    expect(retroDiffProblems([{ status: "D", path: "docs/agent-mini-runbook.md" }], texts())).toEqual(["docs/agent-mini-runbook.md: deleted, where the retro only adds or edits text"])
    expect(retroDiffProblems([{ status: "R", from: "docs/a.md", path: "docs/b.md", mode: "100644" }], texts())).toEqual(["docs/b.md: renamed, where the retro only adds or edits text"])
    expect(retroDiffProblems([{ status: "R", from: "plugin/hooks/bash-guard.sh", path: "docs/b.md", mode: "100644" }], texts())).toEqual([
      "plugin/hooks/bash-guard.sh: not a prompt, checklist, skill or doc the retro may change",
    ])
    expect(retroDiffProblems([edit("docs/x.md", { mode: "120000" })], texts())).toEqual(["docs/x.md: mode 120000, where the retro writes only plain files"])
    expect(retroDiffProblems([edit("docs/x.md", { mode: "100755" })], texts())).toEqual(["docs/x.md: mode 100755, where the retro writes only plain files"])
  })

  it("names every file that is refused, one line each", () => {
    expect(retroDiffProblems([edit("docs/ok.md"), edit("runtime/src/config.ts"), edit(".claude/settings.json")], texts())).toHaveLength(2)
  })

  it("reads git's --name-status, renames included, and a file's frontmatter", () => {
    expect(parseNameStatus("M\tdocs/a.md\nA\truntime/prompts/x.md\nR100\tdocs/old.md\tdocs/new.md\n")).toEqual([
      { status: "M", path: "docs/a.md" },
      { status: "A", path: "runtime/prompts/x.md" },
      { status: "R", path: "docs/new.md", from: "docs/old.md" },
    ])
    expect(frontmatter(SKILL)).toBe("name: front-door\ndescription: One wakeup.")
    expect(frontmatter("# No frontmatter\n---\nnot: it\n---\n")).toBe("")
  })
})
