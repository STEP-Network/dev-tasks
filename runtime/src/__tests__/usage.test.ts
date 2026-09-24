import { describe, expect, it } from "vitest"
import { developBlockedByUsage, limitedUntil, type UsageSnapshot } from "../usage.ts"

const NOW = new Date("2026-09-24T08:00:00.000Z")
const inAnHour = NOW.getTime() / 1000 + 3600
const anHourAgo = NOW.getTime() / 1000 - 3600
const Q = { lightModeWeeklyPct: 80, fiveHourStopPct: 90 }
const snap = (over: Partial<UsageSnapshot>): UsageSnapshot => ({
  at: NOW.toISOString(), fiveHourPct: 10, fiveHourResetsAt: inAnHour, sevenDayPct: 10, sevenDayResetsAt: inAnHour, ...over,
})

describe("developBlockedByUsage", () => {
  it("blocks at 80 percent of the week (light mode) and at 90 percent of five hours", () => {
    expect(developBlockedByUsage(snap({ sevenDayPct: 81.4 }), Q, NOW)).toBe("weekly usage at 81 percent (light mode)")
    expect(developBlockedByUsage(snap({ fiveHourPct: 93 }), Q, NOW)).toBe("5-hour usage at 93 percent")
    expect(developBlockedByUsage(snap({}), Q, NOW)).toBeNull()
  })

  it("ignores a window whose reset time has passed, and says nothing without a snapshot", () => {
    expect(developBlockedByUsage(snap({ sevenDayPct: 99, sevenDayResetsAt: anHourAgo }), Q, NOW)).toBeNull()
    expect(developBlockedByUsage(null, Q, NOW)).toBeNull()
  })

  it("fails open on a snapshot without rate limits (a plan whose status line has none)", () => {
    const empty = snap({ fiveHourPct: null, fiveHourResetsAt: null, sevenDayPct: null, sevenDayResetsAt: null })
    expect(developBlockedByUsage(empty, Q, NOW)).toBeNull()
    expect(limitedUntil(empty, NOW)).toBeNull()
  })
})

describe("limitedUntil", () => {
  it("is the reset of a window at 100 percent, else null", () => {
    expect(limitedUntil(snap({ fiveHourPct: 100 }), NOW)).toEqual(new Date(inAnHour * 1000))
    expect(limitedUntil(snap({ fiveHourPct: 99 }), NOW)).toBeNull()
    expect(limitedUntil(snap({ fiveHourPct: 100, fiveHourResetsAt: anHourAgo }), NOW)).toBeNull()
  })

  it("is the later reset when both windows are spent", () => {
    const later = inAnHour + 86_400
    expect(limitedUntil(snap({ fiveHourPct: 100, sevenDayPct: 100, sevenDayResetsAt: later }), NOW)).toEqual(new Date(later * 1000))
  })
})
