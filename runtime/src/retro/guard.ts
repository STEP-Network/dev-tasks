/**
 * What a retro PR may change (STEP-3290): the agents' own prompts, checklists,
 * skills and docs, as text. Never a guard, a hook, a permission, an allowlist,
 * the merge policy, a configuration or a secret. The runner checks the
 * branch's diff against this before it pushes, and refuses the whole PR on
 * any file outside it: no push, no PR, and a plain note in Slack.
 *
 * Markdown only, in four places, added or modified in place (a deletion, a
 * rename, a symlink or an executable is refused). A file's frontmatter stays
 * as it was: a skill's or an agent's frontmatter is where its tools and
 * permissions live.
 */

export const RETRO_ALLOWED: ReadonlyArray<{ re: RegExp; what: string }> = [
  { re: /^runtime\/prompts\/[\w.-]+\.md$/, what: "the worker's prompts (runtime/prompts/*.md)" },
  { re: /^plugin\/skills\/[\w.-]+\/(?:[\w.-]+\/)*[\w.-]+\.md$/, what: "the skills (plugin/skills/**/*.md)" },
  { re: /^plugin\/rules\/[\w.-]+\.md$/, what: "the rules (plugin/rules/*.md)" },
  { re: /^docs\/(?:[\w.-]+\/)*[\w.-]+\.md$/, what: "the docs, the runbook among them (docs/**/*.md)" },
]

/** Never, even inside those places: whatever a name says is configuration, a hook or a secret. */
const NEVER = /(^|\/)(\.claude|\.github|hooks?)(\/|$)|settings|permission|secret|credential|CODEOWNERS|allowlist|config|\.env/i

export interface DiffEntry {
  /** git's status letter: A, M, D, R, C, T. */
  status: string
  path: string
  /** A rename's or a copy's source. */
  from?: string
  /** The file's mode at the branch head, from git ls-tree. */
  mode?: string
}

/** git diff --name-status -M output, one entry per line. */
export function parseNameStatus(out: string): DiffEntry[] {
  return out
    .split("\n")
    .filter((l) => l.trim())
    .map((line) => {
      const [status, a, b] = line.split("\t")
      return b !== undefined ? { status: status[0], path: b, from: a } : { status: status[0], path: a }
    })
}

/** A Markdown file's frontmatter: the block between a leading `---` and the next, or "" when it has none. */
export function frontmatter(text: string): string {
  const m = /^---\r?\n([\s\S]*?)\r?\n---(\r?\n|$)/.exec(text)
  return m ? m[1] : ""
}

/**
 * Why the retro may not open a PR with this diff, one line per file: none
 * when every change is text in the allowed places. `before` and `after` read
 * a changed file's text at the base and at the branch head.
 */
export function retroDiffProblems(entries: DiffEntry[], texts: { before(path: string): string | null; after(path: string): string | null }): string[] {
  const problems: string[] = []
  for (const e of entries) {
    const paths = e.from ? [e.from, e.path] : [e.path]
    const outside = paths.find((p) => NEVER.test(p) || !RETRO_ALLOWED.some((a) => a.re.test(p)))
    if (outside) {
      problems.push(`${outside}: not a prompt, checklist, skill or doc the retro may change`)
      continue
    }
    if (e.status !== "A" && e.status !== "M") {
      problems.push(`${e.path}: ${e.status === "D" ? "deleted" : e.status === "R" ? "renamed" : "changed in kind"}, where the retro only adds or edits text`)
      continue
    }
    if (e.mode !== undefined && e.mode !== "100644") {
      problems.push(`${e.path}: mode ${e.mode}, where the retro writes only plain files`)
      continue
    }
    const before = e.status === "M" ? texts.before(e.path) : ""
    const after = texts.after(e.path)
    if (after === null) {
      problems.push(`${e.path}: unreadable at the branch head`)
      continue
    }
    if (frontmatter(before ?? "") !== frontmatter(after)) problems.push(`${e.path}: its frontmatter changed, where tools and permissions live`)
  }
  return problems
}
