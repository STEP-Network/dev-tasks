import { describe, expect, it } from "vitest"
import { ConfigSchema } from "../../config.ts"
import { frontmatter, parseNameStatus, privateIn, privateNames, privateTextProblems, retroDiffProblems, type DiffEntry } from "../guard.ts"

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
      "plugin/skills/new/SKILL.md: a new file with frontmatter, where tools and permissions live",
    ])
  })

  it("reads frontmatter as Claude Code's loader does, so no fence it accepts slips past (review B2)", () => {
    const TOOLS = "name: helper\ndescription: always use\nallowed-tools: Bash(*), Read(**)\n"
    const added = (text: string) => retroDiffProblems([{ status: "A", path: "plugin/skills/helper/SKILL.md", mode: "100644" }], texts({}, { "plugin/skills/helper/SKILL.md": text }))
    const NEW = "plugin/skills/helper/SKILL.md: a new file with frontmatter, where tools and permissions live"
    // The loader reads allowed-tools from each of these. The old check saw no frontmatter in the first three.
    expect(added(`\uFEFF---\n${TOOLS}---\n# Helper\n`)).toEqual(["plugin/skills/helper/SKILL.md: carries a byte-order mark, which hides frontmatter from the check"])
    expect(added(`---   \n${TOOLS}---\n# Helper\n`)).toEqual([NEW])
    expect(added(`---\n${TOOLS}---   \n# Helper\n`)).toEqual([NEW])
    expect(added(`---\r\n${TOOLS.replace(/\n/g, "\r\n")}---\r\n# Helper\r\n`)).toEqual([NEW])
    expect(added(`---\n\n${TOOLS}---\n# Helper\n`)).toEqual([NEW])
    // Frontmatter with nothing in it is still frontmatter, in a new file.
    expect(added("---\n---\n# Helper\n")).toEqual([NEW])
    // A fence Claude Code does not read but another reader might.
    expect(added(`\n---\n${TOOLS}---\n# Helper\n`)).toEqual(["plugin/skills/helper/SKILL.md: opens with a --- fence, where frontmatter would go"])
    // A rule in the middle of the text is a rule.
    expect(added("# Helper\n\n---\n\nStep one.\n")).toEqual([])
  })

  it("refuses an edit that reshapes the frontmatter's fences or adds a byte-order mark, and lets a body edit through", () => {
    const path = "plugin/skills/front-door/SKILL.md"
    const edited = (after: string) => retroDiffProblems([edit(path)], texts({ [path]: SKILL }, { [path]: after }))
    expect(edited(SKILL.replace("Step one.", "Step one, then two."))).toEqual([])
    expect(edited(SKILL.replace("One wakeup.\n---\n", "One wakeup.\n---   \n"))).toEqual([`${path}: its frontmatter changed, where tools and permissions live`])
    expect(edited(`\uFEFF${SKILL}`)).toEqual([`${path}: carries a byte-order mark, which hides frontmatter from the check`])
    const doc = "docs/agent-mini-runbook.md"
    expect(retroDiffProblems([edit(doc)], texts({ [doc]: "# Runbook\n" }, { [doc]: "\uFEFF# Runbook\n" }))).toEqual([`${doc}: carries a byte-order mark, which hides frontmatter from the check`])
  })

  it("refuses a changed line that adds what looks like a secret, and not one that was there already", () => {
    const doc = "docs/agent-mini-runbook.md"
    const before = "# Runbook\n\nExample: `LINEAR_API_KEY=lin_api_example` goes in ~/.config.\n"
    const edited = (after: string) => retroDiffProblems([edit(doc)], texts({ [doc]: before }, { [doc]: after }))
    for (const leak of ["postgres://polads:hunter2@ep-x.neon.tech/neondb", "https://eve:s3cret@github.com/x", "RESEND_API_KEY=re_live_abc123", "Authorization: Bearer abcdefghijkl", "use xoxb-1234-abcd"]) {
      expect(edited(`${before}\nSee ${leak}.\n`), leak).toEqual([`${doc}: adds what looks like a secret`])
    }
    expect(edited(`${before}\nA plain line.\n`)).toEqual([])
  })

  describe("nothing private in a public line (dev-tasks is public)", () => {
    const known = privateNames(
      ConfigSchema.parse({
        mini: "eve",
        repo: { path: "/r" },
        pluginRoot: "/p",
        slack: { allowedUsers: ["UNATE"], otherAgentBots: ["UBOBBOT"] },
        bridges: { monday: { boardId: "5104953028", people: [{ id: "70001", name: "Nate Refslund" }, { id: "70002", name: "Søren Å" }], defaultPerson: "70001" } },
      }),
    )
    const what = (line: string) => privateIn(line, known)

    it("takes the people's names, and their Slack and Monday ids, from the config", () => {
      expect(known).toEqual({ names: ["Nate Refslund", "Nate", "Refslund", "Søren Å", "Søren"], slackIds: ["UNATE", "UBOBBOT"], mondayIds: ["5104953028", "70001", "70002"] })
    })

    it("a Slack member id: any U0 or W0 id, and the ones the config names", () => {
      for (const line of ["cc <@U0ABCDEF12>", "W0XYZ1234 asked", "ask UNATE", "the bot UBOBBOT"]) expect(what(line), line).toBe("a Slack member id")
      for (const line of ["U0 bolt", "UNATED", "a U-turn"]) expect(what(line), line).toBeNull()
    })

    it("an email, with @ or with the (at) the brief writes for it", () => {
      for (const line of ["write to a.b+c@example.com", "someone(at)example.com said", "someone (at) example.co.uk"]) expect(what(line), line).toBe("an email address")
      for (const line of ["meet at 10", "an @-mention", "npm i @scope/pkg"]) expect(what(line), line).toBeNull()
    })

    it("a link to PolAds: its repository by name, and any polads.eu host", () => {
      for (const line of ["https://github.com/STEP-Network/v0-politiske-annoncer/pull/1700", "in v0-politiske-annoncer", "see https://test.polads.eu/notice/1", "polads.eu itself"]) {
        expect(what(line), line).toBe("a link to PolAds")
      }
      for (const line of ["https://github.com/STEP-Network/dev-tasks/pull/120", "PolAds's notices", "the pollads eu"]) expect(what(line), line).toBeNull()
    })

    it("a person's name, whole or in part, as a whole word in any case, letters outside ASCII included", () => {
      for (const line of ["Nate said so", "ask nate", "Refslund's rule", "Søren wants it", "as Søren Å put it"]) expect(what(line), line).toBe("a person's name")
      for (const line of ["an innate habit", "Natelle", "Sørensen"]) expect(what(line), line).toBeNull()
    })

    it("a Monday id the config names: the board's and each person's", () => {
      for (const line of ["board 5104953028", "person 70002"]) expect(what(line), line).toBe("a Monday id")
      for (const line of ["51049530281", "3 of 5 PRs this week missed sibling call sites", "STEP-3290"]) expect(what(line), line).toBeNull()
    })

    it("names each private line of a text by its kind and number, never by its words", () => {
      expect(privateTextProblems("# Retro\n\nNate asked.\nFine.\nmail a@b.dk\n", "the PR body", known)).toEqual([
        "the PR body, line 3: a person's name, which must not be public",
        "the PR body, line 5: an email address, which must not be public",
      ])
    })

    it("refuses an added line of the diff that carries one, and not a line that was there already", () => {
      const doc = "docs/agent-mini-runbook.md"
      const before = "# Runbook\n\nAsk Nate before a release.\n"
      const problems = (after: string) => retroDiffProblems([edit(doc)], texts({ [doc]: before }, { [doc]: after }), known)
      expect(problems(`${before}\nAsk first.\n`)).toEqual([])
      expect(problems(`${before}\nAsk Søren first.\n`)).toEqual([`${doc}, line 5: a person's name, which must not be public`])
    })
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
    // The loader's closing fence takes the blank lines after it too.
    expect(frontmatter(SKILL)).toBe("---\nname: front-door\ndescription: One wakeup.\n---\n\n")
    expect(frontmatter(`\uFEFF${SKILL}`)).toBe("---\nname: front-door\ndescription: One wakeup.\n---\n\n")
    expect(frontmatter("# No frontmatter\n---\nnot: it\n---\n")).toBeNull()
  })
})
