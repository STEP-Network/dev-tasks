/**
 * A request's place on the Requests board, from Linear (spec 4): its Stage,
 * its Progress ("3 of 5 done"), its group, and the Class, Type and target
 * week the board shows. PURE. A request is one anchor issue, the Triage issue
 * the ask became. Its tasks are the anchor's sub-issues, whether or not a
 * Linear project holds them, so both shapes read the same way here.
 */
import { classOfLabels } from "../tracker.ts"
import type { PeopleIssue } from "./people.ts"

export type Stage = "New" | "Clarifying" | "Plan to approve" | "Building" | "Checking" | "Ready to test" | "Released" | "Declined" | "On hold"
export type RequestIssue = Pick<PeopleIssue, "state" | "stateType" | "labels">
export interface RequestWork {
  anchor: RequestIssue | null
  children: RequestIssue[]
}

const gone = (i: RequestIssue) => i.stateType === "canceled" || i.stateType === "duplicate"
const released = (i: RequestIssue) => i.stateType === "completed"
/** A task in one of these is still being built: a sub-issue being refined included, since its request is past the plan. */
const BUILDING = new Set(["Triage", "Backlog", "Refining", "Ready", "In Progress", "In Review", "Needs Correction", "On hold"])
const byPeople = (labels: readonly string[]) => labels.includes("approval/look") || labels.includes("approval/try")

/** The tasks that count: the sub-issues not canceled or duplicate, or the anchor alone when it has none. */
function tasksOf(w: RequestWork): RequestIssue[] {
  const live = w.children.filter((c) => !gone(c))
  return live.length ? live : w.anchor ? [w.anchor] : []
}

export function requestStage(w: RequestWork): Stage {
  const { anchor } = w
  if (!anchor) return "New"
  if (gone(anchor)) return "Declined"
  if (!w.children.some((c) => !gone(c)) && !released(anchor)) {
    if (anchor.state === "Triage") return "New"
    if (anchor.state === "Backlog" || anchor.state === "Refining") return "Clarifying"
    if (anchor.state === "On hold") {
      if (anchor.labels.includes("plan-to-approve")) return "Plan to approve"
      return anchor.labels.includes("awaiting-answer") ? "Clarifying" : "On hold"
    }
  }
  // Never Released while a task is open, whatever the anchor says (Review Focus 4).
  const open = tasksOf(w).filter((t) => !released(t))
  if (!open.length) return "Released"
  if (open.every((t) => t.state === "On hold")) return "On hold"
  if (open.some((t) => BUILDING.has(t.state))) return "Building"
  if (open.some((t) => t.state === "Waiting for UAT" && (byPeople(t.labels) || byPeople(anchor.labels)))) return "Ready to test"
  // Approved work waits only for the release: after a person's test for Look and Try, after the agents' for Auto.
  if (open.every((t) => t.state === "Approved") && byPeople(anchor.labels)) return "Ready to test"
  return "Checking"
}

const BEFORE_TASKS: readonly Stage[] = ["New", "Clarifying", "Plan to approve", "Declined"]

export function progressText(w: RequestWork, stage: Stage, question: boolean): string {
  if (question && stage === "Released") return "Answered"
  if (BEFORE_TASKS.includes(stage) && !w.children.some((c) => !gone(c))) return ""
  const tasks = tasksOf(w)
  if (!tasks.length) return ""
  const done = tasks.filter((t) => released(t) || t.state === "Approved").length
  const text = `${done} of ${tasks.length} done`
  return stage !== "Released" && done === tasks.length ? `${text}, out with the next release` : text
}

export function requestGroup(stage: Stage): "active" | "released" | "closed" {
  return stage === "Released" ? "released" : stage === "Declined" || stage === "On hold" ? "closed" : "active"
}

export function classOf(labels: readonly string[]): "Auto" | "Look" | "Try" | null {
  const c = classOfLabels([...labels])
  return c ? (c === "try" ? "Try" : c === "look" ? "Look" : "Auto") : null
}

const TYPES: Record<string, "Feature" | "Change" | "Bug" | "Question"> = { feature: "Feature", improvement: "Change", chore: "Change", bug: "Bug", question: "Question" }
export function typeOf(labels: readonly string[]): "Feature" | "Change" | "Bug" | "Question" | null {
  return labels.map((l) => TYPES[l]).find(Boolean) ?? null
}

/** The Monday to Sunday week a date falls in, as a Monday week column holds it. */
export function weekOf(date: string | null): { startDate: string; endDate: string } | null {
  if (!date || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return null
  const noon = new Date(`${date}T12:00:00Z`)
  const monday = new Date(noon.getTime() - ((noon.getUTCDay() + 6) % 7) * 86_400_000)
  return { startDate: monday.toISOString().slice(0, 10), endDate: new Date(monday.getTime() + 6 * 86_400_000).toISOString().slice(0, 10) }
}

/** Every task settled and one released: the anchor itself can be marked Released. */
export function workDone(w: RequestWork): boolean {
  return w.children.length > 0 && w.children.every((c) => released(c) || gone(c)) && w.children.some(released)
}
