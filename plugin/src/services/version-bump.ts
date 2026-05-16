/**
 * Pure semver bump-suggestion algorithm + 3-category task classifier.
 *
 * **Why pure**: agents (`/ship-pr` Phase 8, `/release-version` Step 1) handle
 * Monday I/O directly via MCP tools (`mcp__plugin_dev-tasks_dev-tasks__*`). The algorithm itself
 * — "given the task list and milestone state, what's the next version?" — is
 * load-bearing logic that needed a single source of truth + tests. Putting it
 * here lets:
 *   - Agents invoke it from any flow without reimplementing the rules
 *   - Tests pin every branch (v1.0 gate, breaking-change override, etc.)
 *   - Future admin endpoints / CI checks reuse the same helper
 *
 * **Mapping between the 3 surfaces** (see also `.claude/rules/versioning.md`):
 *   - Monday task type → 3-cat: Development → feature, Bugfix → fix,
 *     Maintenance/Refine/Documentation/PM-work → improvement
 *   - 3-cat → bump: any feature → minor, only fix/improvement → patch,
 *     breaking change OR explicit major → major (subject to v1.0 gate)
 *
 * **v1.0 milestone gate** (HARD): refuse to auto-suggest `1.0.0` unless ALL
 * epics listed in `monday.v1MilestoneEpicIds[]` (from the consumer's
 * `.claude/project-config.json`) have status `Done`. The caller passes
 * `v1MilestoneReady` in — this module doesn't fetch from Monday. If the
 * config array is empty, the caller should pass `true` (no gate configured).
 */

export type VersionTaskCategory = 'feature' | 'improvement' | 'fix'

export interface SemVer {
  major: number
  minor: number
  patch: number
}

export type BumpType = 'major' | 'minor' | 'patch'

export interface BumpInputTask {
  /** 3-category type. Use `classifyTaskType()` if you have a raw Monday task_type string. */
  category: VersionTaskCategory
  /** Optional: explicit breaking-change flag from task metadata (overrides bump-by-category). */
  hasBreakingChanges?: boolean
}

export interface BumpInput {
  /** The most-recent released version on the board. */
  latestReleased: SemVer
  /** Tasks to be included in the upcoming version. */
  tasks: BumpInputTask[]
  /**
   * Whether the v1.0 hard gate is satisfied. The caller computes this:
   *   v1MilestoneReady = all epic IDs in `monday.v1MilestoneEpicIds[]`
   *                      have status `Done` (or the array is empty).
   * If false, this algorithm refuses to auto-suggest a major bump that would
   * land on or beyond `1.0.0` — falls through to the highest non-major bump.
   */
  v1MilestoneReady: boolean
  /**
   * Explicit user override — bypasses the v1.0 gate and forces a major bump.
   * Use for release-defining moments (e.g. EU regulatory go-live, a confirmed
   * breaking-API release). Always logged in the rationale.
   */
  forceMajor?: boolean
  /**
   * Auto-assign path override — always picks a patch bump regardless of task
   * categories or breaking-change flags. Used by `updateTask`'s auto-version
   * helper when a task transitions to "Waiting for UAT": every task is a
   * patch by default; minor/major elevations are human decisions (rename the
   * open version's `versionNumber` before promoting). Takes precedence over
   * `forceMajor` if both are set (which shouldn't happen by design).
   */
  forcePatch?: boolean
}

export interface BumpSuggestion {
  next: SemVer
  bumpType: BumpType
  /**
   * Human-readable explanation. Always populated. Includes the trigger
   * (e.g., "1 Feature task" / "all tasks are Fix/Improvement") and any
   * gating decisions ("v1.0 gated on Beta+Live epics — bumping minor").
   */
  rationale: string
  /**
   * If the v1.0 gate blocked a major bump that the diff would otherwise warrant,
   * this is set to the gating message ("Beta epic not Done", etc.).
   * Null when the gate passed (or wasn't relevant).
   */
  gatedByMilestone: string | null
}

/**
 * Classify a Monday task_type string to the 3-category taxonomy.
 * Unknown types default to `improvement` (matches the cautious-bump preference).
 *
 * Mapping (per `.claude/rules/versioning.md`):
 *   Development                              → feature
 *   Bugfix, Bug                              → fix
 *   Maintenance, Refine, Documentation,
 *   PM-work, anything-else                   → improvement
 */
export function classifyTaskType(rawType: string): VersionTaskCategory {
  const t = rawType.toLowerCase().trim()
  if (t === 'development') return 'feature'
  if (t === 'bugfix' || t === 'bug') return 'fix'
  return 'improvement'
}

/**
 * Parse a version-string into the structured form. Tolerates the `v` prefix.
 * Returns null for malformed input — callers should treat null as "no
 * latest released yet" (cold-start case) and seed with `{ major: 0, minor: 0, patch: 0 }`.
 */
export function parseSemVer(input: string): SemVer | null {
  const trimmed = input.trim().replace(/^v/i, '')
  const parts = trimmed.split('.')
  if (parts.length !== 3) return null
  // Strict numeric validation — reject pre-release suffixes ("1.0.0-alpha"),
  // build metadata ("1.0.0+build"), and any non-digit characters. Monday
  // version numbers are always pure-numeric major.minor.patch in this project,
  // and silently accepting suffixes risks downstream surprises.
  if (!parts.every(p => /^\d+$/.test(p))) return null
  const [maj, min, pat] = parts.map(p => Number.parseInt(p, 10))
  return { major: maj, minor: min, patch: pat }
}

export function formatSemVer(v: SemVer): string {
  return `${v.major}.${v.minor}.${v.patch}`
}

const V1_GATE_MESSAGE =
  'v1.0.0 gated on milestone epics configured in monday.v1MilestoneEpicIds (all must be Done)'

/**
 * The canonical bump-suggestion algorithm.
 *
 * Decision tree:
 *   1. Forced major (caller override) → bump major. v1.0 gate STILL applies if
 *      it would land on 1.0.0 — caller's force is for major-tier moments, not
 *      for skipping the milestone gate. (If forceMajor + already past 1.0.0,
 *      no gate concern.)
 *   2. Any task with `hasBreakingChanges: true` → would bump major; subject to
 *      the v1.0 gate. If gated, falls through to minor.
 *   3. Any task with category 'feature' → bump minor.
 *   4. Otherwise (only fix/improvement) → bump patch.
 *
 * **Idempotence note**: when called with empty `tasks`, returns a patch bump.
 * This is the conservative default — no work content, no semver weight.
 */
export function computeBumpSuggestion(input: BumpInput): BumpSuggestion {
  const { latestReleased, tasks, v1MilestoneReady, forceMajor, forcePatch } = input
  const featureCount = tasks.filter(t => t.category === 'feature').length
  const fixCount = tasks.filter(t => t.category === 'fix').length
  const improvementCount = tasks.filter(t => t.category === 'improvement').length
  const breakingCount = tasks.filter(t => t.hasBreakingChanges === true).length

  // Determine intended bump type purely from the diff.
  // Order matters: forcePatch overrides everything (auto-assign default),
  // then forceMajor / breaking-change, then feature → minor, else patch.
  let intended: BumpType
  if (forcePatch) {
    intended = 'patch'
  } else if (forceMajor || breakingCount > 0) {
    intended = 'major'
  } else if (featureCount > 0) {
    intended = 'minor'
  } else {
    intended = 'patch'
  }

  // v1.0 gate: only applies when the intended bump would land at or past 1.0.0
  // AND we are coming from a 0.x.y release.
  const isStillSubV1 = latestReleased.major === 0
  const wouldCrossV1 = isStillSubV1 && intended === 'major'

  let gatedByMilestone: string | null = null
  let actualBump: BumpType = intended
  if (wouldCrossV1 && !v1MilestoneReady) {
    gatedByMilestone = V1_GATE_MESSAGE
    // Fall through to highest non-major bump
    actualBump = featureCount > 0 ? 'minor' : 'patch'
  }

  const next = applyBump(latestReleased, actualBump)
  const rationale = buildRationale({
    intended,
    actualBump,
    featureCount,
    fixCount,
    improvementCount,
    breakingCount,
    forceMajor,
    forcePatch,
    gatedByMilestone,
    next,
  })

  return { next, bumpType: actualBump, rationale, gatedByMilestone }
}

function applyBump(v: SemVer, type: BumpType): SemVer {
  if (type === 'major') return { major: v.major + 1, minor: 0, patch: 0 }
  if (type === 'minor') return { major: v.major, minor: v.minor + 1, patch: 0 }
  return { major: v.major, minor: v.minor, patch: v.patch + 1 }
}

interface RationaleInput {
  intended: BumpType
  actualBump: BumpType
  featureCount: number
  fixCount: number
  improvementCount: number
  breakingCount: number
  forceMajor: boolean | undefined
  forcePatch: boolean | undefined
  gatedByMilestone: string | null
  next: SemVer
}

function buildRationale(r: RationaleInput): string {
  const parts: string[] = []
  const pieces: string[] = []
  if (r.featureCount > 0) pieces.push(`${r.featureCount} Feature${r.featureCount === 1 ? '' : 's'}`)
  if (r.fixCount > 0) pieces.push(`${r.fixCount} Fix${r.fixCount === 1 ? '' : 'es'}`)
  if (r.improvementCount > 0) pieces.push(`${r.improvementCount} Improvement${r.improvementCount === 1 ? '' : 's'}`)
  if (r.breakingCount > 0) pieces.push(`${r.breakingCount} breaking change${r.breakingCount === 1 ? '' : 's'}`)
  const taskSummary = pieces.length > 0 ? pieces.join(', ') : 'no linked tasks'

  if (r.forcePatch) {
    parts.push(`forcePatch=true → patch bump (auto-assign default; minor/major elevation is human-only).`)
  } else if (r.forceMajor) {
    parts.push(`forceMajor=true → ${r.intended} bump.`)
  } else if (r.intended === 'major' && r.breakingCount > 0) {
    parts.push(`${r.breakingCount} breaking change(s) detected → would bump major.`)
  } else if (r.intended === 'minor') {
    parts.push(`${r.featureCount} Feature(s) detected → minor bump.`)
  } else {
    parts.push(`only Fix/Improvement tasks (${taskSummary}) → patch bump.`)
  }

  if (r.gatedByMilestone) {
    parts.push(`But: ${r.gatedByMilestone}. Falling through to ${r.actualBump} bump → v${formatSemVer(r.next)}.`)
  } else if (r.intended !== r.actualBump) {
    // Defensive — should not happen unless gate logic changes
    parts.push(`Adjusted to ${r.actualBump} → v${formatSemVer(r.next)}.`)
  } else {
    parts.push(`Recommend v${formatSemVer(r.next)}.`)
  }

  parts.push(`Tasks: ${taskSummary}.`)
  return parts.join(' ')
}

/**
 * Compute the *next* placeholder version for the rolling-draft slot after a
 * release. Used by `/release-version` Step 8 to keep the roadmap pre-populated
 * so the next PR's `/ship-pr` Phase 8 doesn't HARD BLOCK on a missing version.
 *
 * Strategy:
 *   - After a major release (X.0.0), default placeholder is `(X+1).0.0` (next major).
 *   - After a minor release (X.Y.0) with Y > 0, default placeholder is `X.(Y+1).0` (next minor).
 *   - After a patch release (X.Y.Z) with Z > 0, default placeholder is `X.Y.(Z+1)` (next patch).
 *
 * **v1.0 gate still applies**: never auto-create a `1.0.0` placeholder unless
 * `v1MilestoneReady` is true. If gated, suggest the next minor instead.
 *
 * Returns the suggested SemVer. The caller checks Monday for an existing
 * version with that number and either skips (idempotent) or creates.
 */
export function computeNextPlannedVersion(latestReleased: SemVer, v1MilestoneReady: boolean): SemVer {
  let next: SemVer
  if (latestReleased.patch > 0) {
    next = { major: latestReleased.major, minor: latestReleased.minor, patch: latestReleased.patch + 1 }
  } else if (latestReleased.minor > 0) {
    next = { major: latestReleased.major, minor: latestReleased.minor + 1, patch: 0 }
  } else {
    // X.0.0 → would default to (X+1).0.0
    next = { major: latestReleased.major + 1, minor: 0, patch: 0 }
  }

  // v1.0 gate: refuse a 1.0.0 default if not ready.
  // The branch above only produces next.major === 1 when latestReleased is
  // exactly { 0, 0, 0 } (cold start) — both prior `if`s required latestReleased
  // patch===0 AND minor===0 to fall through. So the gate fallback is always
  // 0.1.0; hardcoding it makes the invariant readable at a glance.
  const wouldCrossV1 = latestReleased.major === 0 && next.major === 1
  if (wouldCrossV1 && !v1MilestoneReady) {
    return { major: 0, minor: 1, patch: 0 }
  }
  return next
}

/**
 * Compare two SemVers. Returns negative if a < b, positive if a > b, 0 if equal.
 * Useful for sorting + "is this version already released" checks.
 */
export function compareSemVer(a: SemVer, b: SemVer): number {
  if (a.major !== b.major) return a.major - b.major
  if (a.minor !== b.minor) return a.minor - b.minor
  return a.patch - b.patch
}
