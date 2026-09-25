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
 * permissions live. So a new file brings none, and no file carries a
 * byte-order mark.
 *
 * dev-tasks is public. So no changed line, and no line of the PR's body, may
 * carry what looks like a secret, or anything private (PRIVATE_RULES): a Slack
 * member id, an email, a link to PolAds, a person's name or a Monday id. The
 * quotes and links a retro rests on go to a private Linear issue
 * (retro/evidence.ts), and the PR names only that issue.
 */

import type { AgentConfig } from "../config.ts"
import { redactSecrets } from "./lessons.ts"

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

/**
 * Claude Code's own frontmatter reader (2.1.282), which loads a skill's
 * allowed-tools: it drops one leading byte-order mark, then matches this.
 * Its closing `---` need not start a line, and `\s*` lets a fence carry
 * spaces or a carriage return.
 */
const LOADER_FRONTMATTER = /^---\s*\n([\s\S]*?)---\s*\n?/
const OPENING_FENCE = /^\s*---/
const BOM = "\uFEFF"

/** A Markdown file's frontmatter block as Claude Code reads it, fences included, or null when it has none. */
export function frontmatter(text: string): string | null {
  return LOADER_FRONTMATTER.exec(text.startsWith(BOM) ? text.slice(1) : text)?.[0] ?? null
}

/** What this mini's config names that must never be public: the people (their names), and their Slack and Monday ids. */
export interface PrivateNames {
  /** Each person's full name and each part of it of three letters or more, matched as whole words in any case. */
  names: string[]
  slackIds: string[]
  mondayIds: string[]
}

export function privateNames(config: Pick<AgentConfig, "slack" | "bridges">): PrivateNames {
  const monday = config.bridges.monday
  const people = monday?.people ?? []
  return {
    names: [...new Set(people.flatMap((p) => [p.name.trim(), ...p.name.split(/\s+/).filter((part) => part.length >= 3)]))],
    slackIds: [...config.slack.allowedUsers, ...config.slack.otherAgentBots],
    mondayIds: monday ? [...new Set([monday.boardId, monday.defaultPerson, ...people.map((p) => p.id)])] : [],
  }
}

const literal = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
/** `s` as a whole word, a name with letters outside ASCII included. */
const word = (s: string, flags = "") => new RegExp(`(?<![\\p{L}\\p{N}_])${literal(s)}(?![\\p{L}\\p{N}_])`, `u${flags}`)

/** What a public line must never carry, each with the words a person reads. */
export const PRIVATE_RULES: ReadonlyArray<{ what: string; found(line: string, known: PrivateNames): boolean }> = [
  { what: "a Slack member id", found: (line, known) => /\b[UW]0[A-Z0-9]{5,}\b/.test(line) || known.slackIds.some((id) => word(id).test(line)) },
  // The retro's brief writes a lesson's @ as (at), so that spelling counts too.
  { what: "an email address", found: (line) => /[\w.%+-]+(?:@|\s*\(at\)\s*)[\w-]+(?:\.[\w-]+)*\.[a-z]{2,}\b/i.test(line) },
  { what: "a link to PolAds", found: (line) => /v0-politiske-annoncer|\b(?:[\w-]+\.)*polads\.eu\b/i.test(line) },
  { what: "a person's name", found: (line, known) => known.names.some((name) => word(name, "i").test(line)) },
  { what: "a Monday id", found: (line, known) => known.mondayIds.some((id) => word(id).test(line)) },
]

/** The first private thing a line carries, as PRIVATE_RULES words it, or null. */
export function privateIn(line: string, known: PrivateNames): string | null {
  return PRIVATE_RULES.find((rule) => rule.found(line, known))?.what ?? null
}

/** One problem per line of `text` that carries something private. The problem names the kind, never the words themselves. */
export function privateTextProblems(text: string, where: string, known: PrivateNames): string[] {
  return text.split("\n").flatMap((line, i) => {
    const what = privateIn(line, known)
    return what ? [`${where}, line ${i + 1}: ${what}, which must not be public`] : []
  })
}

/** Whether a problem is one of privateTextProblems', for the plain note in Slack. */
export const isPrivateProblem = (problem: string) => problem.endsWith(", which must not be public")

const NO_NAMES: PrivateNames = { names: [], slackIds: [], mondayIds: [] }

/**
 * Why the retro may not open a PR with this diff, one line per file: none
 * when every change is text in the allowed places. `before` and `after` read
 * a changed file's text at the base and at the branch head.
 */
export function retroDiffProblems(entries: DiffEntry[], texts: { before(path: string): string | null; after(path: string): string | null }, known: PrivateNames = NO_NAMES): string[] {
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
    const before = e.status === "M" ? texts.before(e.path) : null
    const after = texts.after(e.path)
    if (after === null) {
      problems.push(`${e.path}: unreadable at the branch head`)
      continue
    }
    if (after.includes(BOM)) {
      problems.push(`${e.path}: carries a byte-order mark, which hides frontmatter from the check`)
      continue
    }
    // A new file's "before" is none, so any frontmatter at all is a change.
    const was = frontmatter(before ?? "")
    const now = frontmatter(after)
    if (now !== was) {
      problems.push(e.status === "A" ? `${e.path}: a new file with frontmatter, where tools and permissions live` : `${e.path}: its frontmatter changed, where tools and permissions live`)
      continue
    }
    // No frontmatter to Claude Code, but a fence another reader might take for one.
    if (now === null && OPENING_FENCE.test(after) && !OPENING_FENCE.test(before ?? "")) {
      problems.push(`${e.path}: opens with a --- fence, where frontmatter would go`)
      continue
    }
    const had = new Set((before ?? "").split("\n"))
    const added = after.split("\n").map((line, i) => ({ line, n: i + 1 })).filter(({ line }) => !had.has(line))
    if (added.some(({ line }) => redactSecrets(line) !== line)) {
      problems.push(`${e.path}: adds what looks like a secret`)
      continue
    }
    for (const { line, n } of added) {
      const what = privateIn(line, known)
      if (what) problems.push(`${e.path}, line ${n}: ${what}, which must not be public`)
    }
  }
  return problems
}
