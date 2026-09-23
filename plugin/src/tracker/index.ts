/**
 * Which tracker this project uses.
 *
 * `tracker.provider` in .claude/project-config.json, defaulting to `monday`.
 * The default is deliberate: phase 0 ships BEFORE the Linear workspace exists
 * (spec section 14), so defaulting to Linear would break every consumer on
 * release day. PolAds flips the key on cutover weekend, and unflipping it is
 * the rollback.
 *
 * DEV_TASKS_TRACKER overrides it, for the Task 16 rehearsal and for a mini
 * that is testing the Linear path before its project config moves.
 */

import { readFileSync } from "node:fs"
import { join } from "node:path"
import { createLinearTracker } from "./linear.ts"
import { createMondayTracker } from "./monday.ts"
import type { Tracker } from "./types.ts"

export type TrackerProvider = "linear" | "monday"

const DEFAULT_PROVIDER: TrackerProvider = "monday"

function isProvider(value: unknown): value is TrackerProvider {
  return value === "linear" || value === "monday"
}

export function readTrackerProvider(projectRoot: string = process.cwd()): TrackerProvider {
  const fromEnv = process.env.DEV_TASKS_TRACKER
  if (isProvider(fromEnv)) return fromEnv

  try {
    const raw = readFileSync(join(projectRoot, ".claude", "project-config.json"), "utf8")
    const parsed = JSON.parse(raw) as { tracker?: { provider?: unknown } }
    const provider = parsed.tracker?.provider
    // An unrecognised value falls back rather than throwing: a typo must not
    // take /dev, /preview and /ship down, and Monday still works.
    if (isProvider(provider)) return provider
  } catch {
    // No config, or unreadable. Monday is the pre-cutover default.
  }
  return DEFAULT_PROVIDER
}

export function resolveTracker(projectRoot: string = process.cwd()): Tracker {
  return readTrackerProvider(projectRoot) === "linear"
    ? createLinearTracker()
    : createMondayTracker()
}

export { createLinearTracker } from "./linear.ts"
export { createMondayTracker, stripDescriptionDocHeader } from "./monday.ts"
export * from "./types.ts"
