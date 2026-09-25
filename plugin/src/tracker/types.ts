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
  /** The Linear user holding the issue: on a mini, that agent's member account. null when unassigned. */
  assigneeId: string | null
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
  /** A UUID the caller chose, sent as the new issue's id. A caller that can crash between
   *  "created" and "recorded" (the Slack bridge filing intake) sends the same id again:
   *  a create whose id is already taken reads that issue back and returns it, so the
   *  retry opens no second issue. Anything but a UUID is refused before the write. */
  clientId?: string
  /** The parent issue (`STEP-123` or its uuid): this one is its sub-issue. Linear only. */
  parent?: string
  /** A Linear project's id, and one of its milestones' ids. Linear only. */
  projectId?: string
  milestoneId?: string
  /** A calendar day, YYYY-MM-DD: the target week's Friday. Anything else is refused before the write. */
  dueDate?: string
}

/** A Linear project with milestones (spec 4: more than 5 tasks, more than one release, or several phases). */
export interface ProjectInput {
  name: string
  /** One short line: Linear keeps a project's description to 255 characters. */
  summary?: string
  /** The plan, as Markdown. */
  content?: string
  targetDate?: string
  milestones: Array<{ name: string; targetDate?: string }>
  /** A UUID the caller chose, as CreateIssueInput.clientId: a second run makes nothing new. */
  clientId?: string
}

export interface TrackerProject {
  id: string
  name: string
  url: string
  targetDate: string | null
  milestones: Array<{ id: string; name: string; targetDate: string | null }>
}

/** The Linear user an API key belongs to. Every person and every agent has their own
 *  account (2026-09-24), so on a mini this is that agent's member account. */
export interface TrackerUser {
  id: string
  name: string
  email: string
}

/** A partial update applied in one write. Absent fields are left alone. */
export interface IssuePatch {
  description?: string
  /** A state NAME. An unknown name throws: a park that silently did less would re-queue the issue. */
  state?: string
  /** Bare label names, as in CreateIssueInput.labels. Unknown names throw, for the same reason. */
  addLabels?: string[]
  removeLabels?: string[]
  /** "me" assigns the key's owner. null unassigns. */
  assignee?: "me" | null
  /** YYYY-MM-DD, or null to clear it. */
  dueDate?: string | null
  /** A project's id, or null to take the issue out of its project. */
  projectId?: string | null
  /** A milestone's id, or null to clear it. */
  milestoneId?: string | null
}

/** Every claim comment starts with this. The heartbeat edits the same comment (spec 6.5). */
export const CLAIM_PREFIX = "claimed by "

export interface ClaimRecord {
  issue: TrackerIssue
  /** The mini named in the claim comment: the machine profile's `mini`, e.g. "eve". */
  claimant: string
  commentId: string
  claimedAt: string
  /** The claim comment's last edit (its heartbeat), or its creation when never edited. */
  heartbeatAt: string
}

export interface ClaimComment {
  id: string
  body: string
  createdAt: string
  editedAt: string | null
}

// The time is exactly toISOString's shape: newestClaim ranks claims by
// comparing these strings, which is only chronological for one fixed format.
// Fixed width, so nothing after it is checked: Linear derives `body` from its
// own document model and may give the break before a heartbeat back as a
// backslash break or a space.
const CLAIM_RE = /^claimed by (\S+) at (\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z)/

export function claimCommentBody(claimant: string, at: string): string {
  return `${CLAIM_PREFIX}${claimant} at ${at}`
}

export function parseClaim(body: string): { claimant: string; claimedAt: string } | null {
  const m = CLAIM_RE.exec(body)
  return m ? { claimant: m[1], claimedAt: m[2] } : null
}

/**
 * Keeps the claim line and replaces any earlier heartbeat line. The claim line
 * is rebuilt from its parts, not copied: if Linear gave the earlier break back
 * as a space, the first line would still hold the old beat and each heartbeat
 * would grow the comment.
 */
export function withHeartbeat(body: string, at: string): string {
  const claim = parseClaim(body)
  const line = claim ? claimCommentBody(claim.claimant, claim.claimedAt) : body.split("\n")[0]
  return `${line}\nheartbeat ${at}`
}

/** The newest claim among `comments`, optionally only `claimant`'s. */
export function newestClaim(comments: ClaimComment[], claimant?: string): Omit<ClaimRecord, "issue"> | null {
  let best: Omit<ClaimRecord, "issue"> | null = null
  for (const c of comments) {
    const parsed = parseClaim(c.body)
    if (!parsed || (claimant !== undefined && parsed.claimant !== claimant)) continue
    const record = { claimant: parsed.claimant, commentId: c.id, claimedAt: parsed.claimedAt, heartbeatAt: c.editedAt ?? c.createdAt }
    if (!best || record.claimedAt > best.claimedAt) best = record
  }
  return best
}

export interface Tracker {
  readonly kind: "linear" | "monday"

  /** Reads one issue by its human identifier (`STEP-123`) or provider id. */
  readIssue(ref: string): Promise<TrackerIssue>

  /**
   * Linear: leaves a `claimed by <claimant> at <time>` comment, then assigns
   * the issue to the key's owner (on a mini, that agent's member account)
   * and moves it to In Progress. The comment's edit time is the heartbeat.
   * Refuses an issue someone else holds. Monday (cutover only): moves it to
   * In Progress and leaves the same comment, assigning nobody.
   */
  claimIssue(ref: string, claimant: string): Promise<TrackerIssue>

  createIssue(input: CreateIssueInput): Promise<TrackerIssue>
  /** A project with its milestones, each made once under ids named from clientId. The Monday tracker refuses it. */
  createProject(input: ProjectInput): Promise<TrackerProject>

  comment(ref: string, body: string): Promise<void>

  attachLink(ref: string, url: string, title: string): Promise<void>

  /**
   * The first `limit` Ready issues in `byPriorityThenAge` order, ranked
   * across the whole queue rather than one fetched page.
   */
  listReady(limit?: number): Promise<TrackerIssue[]>

  /** The user the API key belongs to. */
  whoami(): Promise<TrackerUser>

  /** Applies `patch` in one write and returns the issue as it now is. */
  updateIssue(ref: string, patch: IssuePatch): Promise<TrackerIssue>

  /** Refreshes the heartbeat on `claimant`'s newest claim comment. false when there is none. */
  touchClaim(ref: string, claimant: string): Promise<boolean>

  /** Unassigns, puts the issue back in Ready, and comments why. */
  releaseIssue(ref: string, reason: string): Promise<void>

  /** In Progress issues assigned to the key's owner, with their newest claim: what the 6-hour sweeper reads. */
  listClaims(): Promise<ClaimRecord[]>

  /** Every issue in a state, sorted by byPriorityThenAge, cut to `limit`. An unknown state throws. */
  listByState(state: string, limit?: number): Promise<TrackerIssue[]>
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
