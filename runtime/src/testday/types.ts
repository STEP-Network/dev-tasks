/**
 * Test day (WS7, spec 7): one guided test of the release candidate a week.
 * The shapes the controller keeps in state/testday/run.json, the commands the
 * two bridges file for it, and the Monday labels it reads and writes.
 */

/** The guide's journeys, in this order (spec 7), and Other for a change no journey took. */
export const ROLES = ["Advertiser", "Publisher", "Admin", "Public", "Other"] as const
export type Role = (typeof ROLES)[number]
/** The roles a mini's config maps to personas. */
export type GuideRole = Exclude<Role, "Other">

/** Where a command came from, and where its answer goes. */
export type Door =
  | { kind: "slack"; channel: string; threadTs: string; ts: string }
  | { kind: "monday"; itemId: string; updateId: string | null; threadId: string | null }
  | { kind: "none" }

interface CommandBase {
  type: "testday"
  key: string
  /** The person's name as the door knows it. */
  who: string
  /** Their Slack or Monday id. */
  whoId: string
  /** One key for the same person through either door (answer.ts personKey): the first verdict counts. */
  whoKey: string
  via: "slack" | "monday"
  door: Door
  receivedAt: string
}

export type TestDayCommand = CommandBase &
  (
    | { verb: "start" }
    | { verb: "release" }
    | { verb: "cancel" }
    | { verb: "verdict"; n: number; verdict: "pass" | "fail"; note: string }
    | { verb: "decide"; issue: string; answer: "fix" | "next-week" }
  )

export type Phase = "cutting" | "deploying" | "guiding" | "dry-run" | "testing" | "releasing" | "released" | "stopped"
export type CheckpointStatus = "open" | "pass" | "fail" | "fixing" | "recheck" | "held"

export interface Verdict {
  who: string
  /** personKey: the same person through either door. */
  whoKey: string
  via: "slack" | "monday" | "agent"
  at: string
  note: string
}

/** One workflow dispatch and what came of it. */
export interface Dispatch {
  requestId: string
  dispatchedAt: string | null
  runUrl: string | null
  prUrl: string | null
  done: "merged" | "failed" | null
  problem: string | null
}

export interface Checkpoint {
  n: number
  issue: string
  title: string
  role: Role
  kind: "try" | "look"
  subitemId: string | null
  status: CheckpointStatus
  verdict: Verdict | null
  decision: { askedAt: string; itemId: string | null; answer: "fix" | "next-week" | null; by: string | null } | null
  fix: { issue: string; prNumber: number | null; pick: Dispatch | null } | null
  /** The staging PRs that brought this change, oldest first: a hold reverts them newest first. */
  prNumbers: number[]
}

export interface GuideStep {
  issue: string
  title: string
  kind: "try" | "look"
  /** A path on the release candidate, starting with "/". The renderer adds the host. */
  path: string
  do: string[]
  lookFor: string[]
}

export interface GuideJourney {
  role: Role
  steps: GuideStep[]
}

export interface TestGuide {
  intro: string
  journeys: GuideJourney[]
  /** Test data the dry run found (a notice id, a publisher to pick), shown before the journeys. */
  data: string[]
}

export interface TestDayRun {
  /** YYYY-MM-DD, with -2, -3 for a second start the same day. */
  id: string
  /** testday-<id>: the Slack thread's key and every workflow's request id prefix. */
  key: string
  phase: Phase
  startedBy: string
  startedAt: string
  /** The Monday Test day item. */
  itemId: string
  cut: Dispatch & { replace: boolean; sha: string | null }
  deployedAt: string | null
  guide: TestGuide | null
  docId: string | null
  checkpoints: Checkpoint[]
  /** Holds by staging PR number. */
  holds: Record<string, Dispatch>
  release: Dispatch | null
  /** Running sessions by name: "guide", "dryrun", "recheck-<n>". */
  sessions: Partial<Record<string, { pid: number; startedAt: string }>>
  problem: string | null
  /** From when the subitems board's log was last read. */
  lastVerdictReadAt: string | null
}

/** The Test day item's status column. A person presses Start, Release or Cancel; the agent writes the rest. */
export const ITEM_STATUS = {
  idle: "Not started",
  start: "Start",
  preparing: "Preparing",
  testing: "Testing",
  ready: "Ready to release",
  release: "Release",
  releasing: "Releasing",
  released: "Released",
  cancel: "Cancel",
  stopped: "Stopped",
} as const

/** The labels a person presses, and what each asks for. Every other label is the agent's to write. */
export const PERSON_PRESSES: Readonly<Record<string, "start" | "release" | "cancel">> = { Start: "start", Release: "release", Cancel: "cancel" }

/** A checkpoint subitem's verdict column. A person sets PASS or FAIL; the agent writes the rest. */
export const VERDICT_LABEL = { open: "To test", pass: "PASS", fail: "FAIL", fixing: "Fixing", recheck: "Re-check", held: "Held back" } as const
