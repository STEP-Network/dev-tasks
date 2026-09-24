/**
 * The tracker adapter contract, plus the pure helpers every implementation
 * shares. Nothing here touches the network, so the whole contract is testable
 * without a key.
 *
 * Source of truth for the shapes: the two-flow spec sections 5, 9.1 and 10.
 */

/** Linear numbers priority 1=Urgent, 2=High, 3=Medium, 4=Low, 0=No priority. */
export type IssuePriority = 0 | 1 | 2 | 3 | 4

export interface TrackerIssue {
  /** The human identifier a PR body must carry: `STEP-123`. */
  id: string
  /** The provider's internal id (a Linear UUID; a Monday item id). */
  uuid: string
  title: string
  /** The full description as Markdown. Empty string when there is none. */
  description: string
  /** The acceptance-criteria block lifted out of `description`. Empty when absent. */
  acceptanceCriteria: string
  /** The workflow state NAME, e.g. `Ready`, `In Progress`. */
  state: string
  labels: string[]
  url: string
  priority: IssuePriority
  /** ISO 8601. Used only for ordering. */
  updatedAt: string
}

export interface CreateIssueInput {
  title: string
  description?: string
  /** Label names, matched exactly, e.g. `["polads", "chore"]`. Linear's grouped
   *  labels (`product/`, `type/`, ...) are addressed by their bare child name,
   *  not the group-qualified path. Unknown names are skipped. */
  labels?: string[]
  /** Target state name. Defaults to the provider's own default when omitted. */
  state?: string
}

export interface Tracker {
  readonly kind: "linear" | "monday"

  /** Reads one issue by its human identifier (`STEP-123`) or provider id. */
  readIssue(ref: string): Promise<TrackerIssue>

  /**
   * Moves the issue to In Progress and records who took it. `claimant` is a
   * machine or person name (the `mini` field, or `whoami`); an implementation
   * that cannot resolve it to a user still records the claim as a comment.
   */
  claimIssue(ref: string, claimant: string): Promise<TrackerIssue>

  createIssue(input: CreateIssueInput): Promise<TrackerIssue>

  comment(ref: string, body: string): Promise<void>

  attachLink(ref: string, url: string, title: string): Promise<void>

  /**
   * The first `limit` Ready issues in `byPriorityThenAge` order, ranked
   * across the whole queue rather than one fetched page.
   */
  listReady(limit?: number): Promise<TrackerIssue[]>
}

/**
 * The real Linear team key. The spec writes `POL-123`; that is superseded by
 * `lib/ci/pr-task-trace.ts` in the PolAds repo, which is what the `Task trace`
 * required check actually runs.
 */
export const LINEAR_TEAM_KEY = "STEP"

/**
 * Deliberately byte-identical to the PolAds CI regex. Case-sensitive, word
 * boundaries both sides. Anything this plugin writes into a PR title or body
 * must satisfy it or a traceable PR fails its own trace check.
 */
export const LINEAR_REF_RE = /\bSTEP-(\d+)\b/

const AC_HEADING_RE = /^(#{1,6})\s*acceptance\s+criteria\s*:?\s*$/i
const ANY_HEADING_RE = /^(#{1,6})\s/
// Any indentation, not CommonMark's 0-3 spaces: a fence inside a checklist
// item is indented, and missing one costs the rest of the criteria.
const FENCE_RE = /^\s*(`{3,}|~{3,})(.*)$/

interface Fence {
  char: string
  length: number
}

/** The fence open AFTER `line`: `open` carried on, a new one, or null. */
function stepFence(open: Fence | null, line: string): Fence | null {
  const m = FENCE_RE.exec(line)
  if (!m) return open
  const run = m[1]
  if (open) {
    // Only a run of the SAME character, at least as long, alone on its line
    // closes a fence. Anything else is the fence's content.
    const closes = run[0] === open.char && run.length >= open.length && !m[2].trim()
    return closes ? null : open
  }
  // A backtick fence's info string cannot itself contain a backtick; such a
  // line is inline code, not a fence.
  if (run[0] === "`" && m[2].includes("`")) return null
  return { char: run[0], length: run.length }
}

/**
 * Lifts the acceptance-criteria block out of an issue description.
 *
 * `scripts/linear/transform.ts` writes the heading as `## Acceptance
 * criteria`, so that is the shape this matches — at any level, in any case,
 * with or without a trailing colon. The block ends at the next heading of the
 * SAME OR SHALLOWER level; a deeper heading is part of the criteria. Lines in
 * a fenced code block are never headings: a shell comment or a Markdown
 * sample inside one neither starts the block nor ends it.
 */
export function extractAcceptanceCriteria(markdown: string): string {
  if (!markdown) return ""

  let fence: Fence | null = null
  let level = 0
  const body: string[] = []
  // \r?\n: FENCE_RE's `.` stops at a \r, so a CRLF line never matched it.
  for (const line of markdown.split(/\r?\n/)) {
    const wasInFence = fence !== null
    fence = stepFence(fence, line)
    // The opening and closing fence lines count as code too.
    const isCode = wasInFence || fence !== null

    if (level === 0) {
      const m = isCode ? null : AC_HEADING_RE.exec(line.trim())
      if (m) level = m[1].length
      continue
    }
    const h = isCode ? null : ANY_HEADING_RE.exec(line.trim())
    if (h && h[1].length <= level) break
    body.push(line)
  }
  return body.join("\n").trim()
}

// Transliterations that NFKD alone does not produce. Danish and German titles
// are ordinary in this workspace, and "ndr strrelse" is not a usable slug.
const TRANSLITERATE: Array<[RegExp, string]> = [
  [/æ/g, "ae"],
  [/ø/g, "oe"],
  [/å/g, "aa"],
  [/ß/g, "ss"],
]

/**
 * Lowercases, transliterates Danish/German diacritics, and hyphenates.
 *
 * Truncates at a WORD boundary rather than a raw character slice: when the
 * cut would land mid-word, the partial trailing word is dropped instead of
 * kept half-written. A single hyphenless word longer than `maxLength` has no
 * boundary to fall back to and is hard-cut.
 */
export function slugify(text: string, maxLength = 48): string {
  if (!text) return ""
  let s = text.toLowerCase()
  for (const [from, to] of TRANSLITERATE) s = s.replace(from, to)
  s = s
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
  if (s.length <= maxLength) return s

  let cut = s.slice(0, maxLength)
  const landedMidWord = s[maxLength] !== "-"
  if (landedMidWord && cut.includes("-")) {
    cut = cut.slice(0, cut.lastIndexOf("-"))
  }
  return cut.replace(/-+$/, "")
}

/**
 * `STEP-123-fix-the-thing`.
 *
 * Linear's own `issue.branchName` is NOT used: its default format prefixes the
 * API key owner's username (`nate/step-123-…`), so an agent's branches would
 * read as belonging to whoever's key is installed on that mini. Linear links a
 * branch on the identifier appearing ANYWHERE in the name, so the constructed
 * form autolinks exactly as well.
 */
export function branchNameFor(issueId: string, title: string): string {
  const id = issueId.trim().toUpperCase()
  const slug = slugify(title)
  return slug ? `${id}-${slug}` : id
}

/** 0 ("No priority") sorts LAST; every real priority sorts ahead of it. */
const priorityRank = (p: number): number => (p === 0 ? 5 : p)

/** The two fields the queue order reads, so a lean ranking node sorts too. */
type Rankable = { priority: number; updatedAt: string }

/**
 * Queue order for the front door: most urgent first, and within one priority
 * the OLDEST first, so a low-priority issue cannot starve behind a stream of
 * newer ones at the same level.
 */
export function byPriorityThenAge(a: Rankable, b: Rankable): number {
  const d = priorityRank(a.priority) - priorityRank(b.priority)
  if (d !== 0) return d
  return a.updatedAt.localeCompare(b.updatedAt)
}
