/**
 * Approval classes (the human-agent flow spec, section 3): Auto, Look and Try,
 * as the Linear labels approval/auto, approval/look and approval/try. An agent
 * may set a class or raise one, never lower one or take it away: only a person
 * lowers a class, and the PolAds Approval class check fails a PR whose issue
 * an agent lowered. Pure: trackerctl and the runtime share it.
 */

import type { IssuePatch } from "./types.ts"

export const APPROVAL_CLASSES = ["auto", "look", "try"] as const
export type ApprovalClass = (typeof APPROVAL_CLASSES)[number]

export const approvalLabel = (c: ApprovalClass): string => `approval/${c}`

export const classRank = (c: ApprovalClass): number => APPROVAL_CLASSES.indexOf(c)

export function classOfLabel(name: string): ApprovalClass | null {
  const m = /^approval\/(auto|look|try)$/.exec(name)
  return m ? (m[1] as ApprovalClass) : null
}

/** The highest class among the labels: two at once count as the higher. */
export function classOfLabels(names: readonly string[]): ApprovalClass | null {
  let best: ApprovalClass | null = null
  for (const name of names) {
    const c = classOfLabel(name)
    if (c && (best === null || classRank(c) > classRank(best))) best = c
  }
  return best
}

export class LowersClass extends Error {}

export function touchesApproval(patch: IssuePatch): boolean {
  return [...(patch.addLabels ?? []), ...(patch.removeLabels ?? [])].some((name) => classOfLabel(name) !== null)
}

/**
 * The patch as it goes to Linear when it touches an approval label: one class
 * added at most, never lower than the issue's class now, and the issue's other
 * approval labels removed in the same write so it carries one. Throws
 * LowersClass for a patch that would lower the class or take it away.
 */
export function approvalPatch(currentLabels: readonly string[], patch: IssuePatch): IssuePatch {
  if (!touchesApproval(patch)) return patch
  const added = (patch.addLabels ?? []).map(classOfLabel).filter((c): c is ApprovalClass => c !== null)
  if (added.length > 1) throw new LowersClass("Add one approval label at a time: an issue carries one class.")
  const current = classOfLabels(currentLabels)
  const next = added[0] ?? null
  if (current && (next === null || classRank(next) < classRank(current))) {
    throw new LowersClass(`${approvalLabel(current)} stays: an agent never lowers an approval class or takes it away. Only a person does, in Linear.`)
  }
  if (next === null) return patch
  const others = currentLabels.filter((name) => classOfLabel(name) !== null && name !== approvalLabel(next))
  const removeLabels = [...new Set([...(patch.removeLabels ?? []).filter((name) => classOfLabel(name) === null), ...others])]
  const out: IssuePatch = { ...patch }
  delete out.removeLabels
  if (removeLabels.length) out.removeLabels = removeLabels
  return out
}
