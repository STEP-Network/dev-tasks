/**
 * The subscription's rate limits, as the front door's status line records them:
 * runtime/bin/statusline.sh writes ~/.agentd/state/usage.json from the
 * `rate_limits` object Claude Code (v2.1.251+, Pro and Max plans) passes to a
 * status line. Workers use the same account, so one snapshot serves both.
 * Without a snapshot, or without rate limits in it, nothing is held back.
 */

import { join } from "node:path"
import type { AgentPaths } from "./config.ts"
import { readJson } from "./fsq.ts"

export interface UsageSnapshot {
  at: string
  sessionId?: string | null
  fiveHourPct: number | null
  /** Epoch seconds. */
  fiveHourResetsAt: number | null
  sevenDayPct: number | null
  sevenDayResetsAt: number | null
}

export const usagePath = (paths: AgentPaths) => join(paths.state, "usage.json")

export function readUsage(paths: AgentPaths): UsageSnapshot | null {
  return readJson<UsageSnapshot>(usagePath(paths))
}

/** A window's percentage, or null once its reset time has passed and the number means nothing. */
function live(pct: number | null | undefined, resetsAt: number | null | undefined, now: Date): number | null {
  if (pct === null || pct === undefined) return null
  if (resetsAt !== null && resetsAt !== undefined && resetsAt * 1000 <= now.getTime()) return null
  return pct
}

/** While the account is at a limit: when the latest binding window resets. Otherwise null. */
export function limitedUntil(u: UsageSnapshot | null, now: Date): Date | null {
  if (!u) return null
  const ends: number[] = []
  if ((live(u.fiveHourPct, u.fiveHourResetsAt, now) ?? 0) >= 100 && u.fiveHourResetsAt) ends.push(u.fiveHourResetsAt * 1000)
  if ((live(u.sevenDayPct, u.sevenDayResetsAt, now) ?? 0) >= 100 && u.sevenDayResetsAt) ends.push(u.sevenDayResetsAt * 1000)
  return ends.length ? new Date(Math.max(...ends)) : null
}

/** Why no develop job may start now, or null. Spec 6.6: under 20 percent of the week left, only refine and answer. */
export function developBlockedByUsage(
  u: UsageSnapshot | null,
  q: { lightModeWeeklyPct: number; fiveHourStopPct: number },
  now: Date,
): string | null {
  if (!u) return null
  const week = live(u.sevenDayPct, u.sevenDayResetsAt, now)
  if (week !== null && week >= q.lightModeWeeklyPct) return `weekly usage at ${Math.round(week)} percent (light mode)`
  const five = live(u.fiveHourPct, u.fiveHourResetsAt, now)
  if (five !== null && five >= q.fiveHourStopPct) return `5-hour usage at ${Math.round(five)} percent`
  return null
}
