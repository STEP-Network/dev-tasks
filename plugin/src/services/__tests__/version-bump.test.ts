import {
  classifyTaskType,
  compareSemVer,
  computeBumpSuggestion,
  computeNextPlannedVersion,
  formatSemVer,
  parseSemVer,
} from '../version-bump.ts'

describe('classifyTaskType (3-cat mapping)', () => {
  it.each([
    ['Development', 'feature'],
    ['development', 'feature'],
    ['  Development  ', 'feature'],
    ['Bugfix', 'fix'],
    ['Bug', 'fix'],
    ['Maintenance', 'improvement'],
    ['Refine', 'improvement'],
    ['Documentation', 'improvement'],
    ['PM-work', 'improvement'],
    ['', 'improvement'],
    ['SomethingNew', 'improvement'],
  ])('%s → %s', (input, expected) => {
    expect(classifyTaskType(input)).toBe(expected)
  })
})

describe('parseSemVer', () => {
  it.each([
    ['0.7.0', { major: 0, minor: 7, patch: 0 }],
    ['v0.7.0', { major: 0, minor: 7, patch: 0 }],
    ['V1.2.3', { major: 1, minor: 2, patch: 3 }],
    ['  1.0.0  ', { major: 1, minor: 0, patch: 0 }],
    ['10.20.30', { major: 10, minor: 20, patch: 30 }],
  ])('parses %s', (input, expected) => {
    expect(parseSemVer(input)).toEqual(expected)
  })

  it.each([['1.0'], ['1'], ['v'], [''], ['1.a.0'], ['-1.0.0'], ['1.0.0-alpha']])(
    'rejects %s',
    (input) => {
      expect(parseSemVer(input)).toBeNull()
    },
  )
})

describe('formatSemVer', () => {
  it('renders X.Y.Z', () => {
    expect(formatSemVer({ major: 0, minor: 7, patch: 0 })).toBe('0.7.0')
    expect(formatSemVer({ major: 12, minor: 34, patch: 56 })).toBe('12.34.56')
  })
})

describe('compareSemVer', () => {
  const a: { major: number; minor: number; patch: number } = { major: 0, minor: 7, patch: 0 }
  it('a == a → 0', () => expect(compareSemVer(a, a)).toBe(0))
  it('major diff dominates', () => expect(compareSemVer({ major: 1, minor: 0, patch: 0 }, a)).toBeGreaterThan(0))
  it('minor diff when major equal', () =>
    expect(compareSemVer({ major: 0, minor: 8, patch: 0 }, a)).toBeGreaterThan(0))
  it('patch diff when major+minor equal', () =>
    expect(compareSemVer({ major: 0, minor: 7, patch: 1 }, a)).toBeGreaterThan(0))
})

describe('computeBumpSuggestion — basic bump rules', () => {
  const v0_7_0 = { major: 0, minor: 7, patch: 0 }

  it('only Fix/Improvement → patch bump', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [{ category: 'fix' }, { category: 'improvement' }, { category: 'improvement' }],
      v1MilestoneReady: false,
    })
    expect(s.bumpType).toBe('patch')
    expect(s.next).toEqual({ major: 0, minor: 7, patch: 1 })
    expect(s.gatedByMilestone).toBeNull()
    expect(s.rationale).toMatch(/only Fix\/Improvement/)
  })

  it('any Feature → minor bump', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [{ category: 'feature' }, { category: 'fix' }, { category: 'improvement' }],
      v1MilestoneReady: false,
    })
    expect(s.bumpType).toBe('minor')
    expect(s.next).toEqual({ major: 0, minor: 8, patch: 0 })
    expect(s.gatedByMilestone).toBeNull()
    expect(s.rationale).toMatch(/Feature/i)
  })

  it('breakingChange flag → would-be major (subject to gate)', () => {
    // Coming from 1.x — gate doesn't apply
    const s = computeBumpSuggestion({
      latestReleased: { major: 1, minor: 5, patch: 0 },
      tasks: [{ category: 'feature', hasBreakingChanges: true }],
      v1MilestoneReady: true,
    })
    expect(s.bumpType).toBe('major')
    expect(s.next).toEqual({ major: 2, minor: 0, patch: 0 })
    expect(s.gatedByMilestone).toBeNull()
    expect(s.rationale).toMatch(/breaking change/i)
  })

  it('forceMajor=true → major bump (subject to gate)', () => {
    const s = computeBumpSuggestion({
      latestReleased: { major: 1, minor: 0, patch: 0 },
      tasks: [{ category: 'fix' }],
      v1MilestoneReady: true,
      forceMajor: true,
    })
    expect(s.bumpType).toBe('major')
    expect(s.next).toEqual({ major: 2, minor: 0, patch: 0 })
    expect(s.rationale).toMatch(/forceMajor=true/)
  })

  it('empty tasks → patch (conservative default)', () => {
    const s = computeBumpSuggestion({ latestReleased: v0_7_0, tasks: [], v1MilestoneReady: false })
    expect(s.bumpType).toBe('patch')
    expect(s.next).toEqual({ major: 0, minor: 7, patch: 1 })
  })
})

describe('computeBumpSuggestion — v1.0 milestone gate (HARD)', () => {
  const v0_7_0 = { major: 0, minor: 7, patch: 0 }

  it('breaking change while still 0.x AND v1 NOT ready → falls through to minor', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [{ category: 'feature', hasBreakingChanges: true }],
      v1MilestoneReady: false,
    })
    expect(s.bumpType).toBe('minor')
    expect(s.next).toEqual({ major: 0, minor: 8, patch: 0 })
    expect(s.gatedByMilestone).toMatch(/Beta epic.*Live epic.*Done/)
    expect(s.rationale).toMatch(/Falling through/)
  })

  it('breaking change while still 0.x with only fix/improvement AND v1 NOT ready → patch', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [{ category: 'fix', hasBreakingChanges: true }],
      v1MilestoneReady: false,
    })
    expect(s.bumpType).toBe('patch')
    expect(s.next).toEqual({ major: 0, minor: 7, patch: 1 })
    expect(s.gatedByMilestone).not.toBeNull()
  })

  it('forceMajor while still 0.x AND v1 NOT ready → falls through (gate beats force)', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [{ category: 'feature' }],
      v1MilestoneReady: false,
      forceMajor: true,
    })
    expect(s.bumpType).toBe('minor')
    expect(s.gatedByMilestone).not.toBeNull()
  })

  it('breaking change while still 0.x AND v1 IS ready → 1.0.0 (celebratory!)', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [{ category: 'feature', hasBreakingChanges: true }],
      v1MilestoneReady: true,
    })
    expect(s.bumpType).toBe('major')
    expect(s.next).toEqual({ major: 1, minor: 0, patch: 0 })
    expect(s.gatedByMilestone).toBeNull()
  })

  it('forceMajor while still 0.x AND v1 IS ready → 1.0.0', () => {
    const s = computeBumpSuggestion({
      latestReleased: v0_7_0,
      tasks: [],
      v1MilestoneReady: true,
      forceMajor: true,
    })
    expect(s.bumpType).toBe('major')
    expect(s.next).toEqual({ major: 1, minor: 0, patch: 0 })
  })

  it('major bump when ALREADY past 1.x → gate does not apply', () => {
    const s = computeBumpSuggestion({
      latestReleased: { major: 2, minor: 5, patch: 0 },
      tasks: [{ category: 'feature', hasBreakingChanges: true }],
      v1MilestoneReady: false, // even if false — gate is for crossing 1.0.0 only
    })
    expect(s.bumpType).toBe('major')
    expect(s.next).toEqual({ major: 3, minor: 0, patch: 0 })
    expect(s.gatedByMilestone).toBeNull()
  })
})

describe('computeBumpSuggestion — rationale strings', () => {
  it('mentions task counts in plural-aware form', () => {
    const s = computeBumpSuggestion({
      latestReleased: { major: 0, minor: 7, patch: 0 },
      tasks: [
        { category: 'feature' },
        { category: 'feature' },
        { category: 'fix' },
        { category: 'improvement' },
        { category: 'improvement' },
        { category: 'improvement' },
      ],
      v1MilestoneReady: false,
    })
    expect(s.rationale).toMatch(/2 Features/)
    expect(s.rationale).toMatch(/1 Fix/)
    expect(s.rationale).toMatch(/3 Improvements/)
  })

  it('mentions singular forms correctly', () => {
    const s = computeBumpSuggestion({
      latestReleased: { major: 0, minor: 7, patch: 0 },
      tasks: [{ category: 'feature' }, { category: 'fix' }, { category: 'improvement' }],
      v1MilestoneReady: false,
    })
    expect(s.rationale).toMatch(/1 Feature/)
    expect(s.rationale).toMatch(/1 Fix/)
    expect(s.rationale).toMatch(/1 Improvement/)
    expect(s.rationale).not.toMatch(/Features|Fixes|Improvements/)
  })
})

describe('computeNextPlannedVersion', () => {
  it('after X.Y.0 (minor release) → X.(Y+1).0', () => {
    expect(computeNextPlannedVersion({ major: 0, minor: 7, patch: 0 }, false)).toEqual({
      major: 0,
      minor: 8,
      patch: 0,
    })
  })

  it('after X.Y.Z (patch release) → X.Y.(Z+1)', () => {
    expect(computeNextPlannedVersion({ major: 0, minor: 7, patch: 3 }, false)).toEqual({
      major: 0,
      minor: 7,
      patch: 4,
    })
  })

  it('after X.0.0 (major release, X > 0) → (X+1).0.0', () => {
    expect(computeNextPlannedVersion({ major: 1, minor: 0, patch: 0 }, true)).toEqual({
      major: 2,
      minor: 0,
      patch: 0,
    })
  })

  it('cold start (0.0.0) with v1 NOT ready → 0.1.0', () => {
    // major=0 + minor=0 + patch=0 → would default to 1.0.0
    // but v1 NOT ready → falls through to next minor (0.1.0)
    expect(computeNextPlannedVersion({ major: 0, minor: 0, patch: 0 }, false)).toEqual({
      major: 0,
      minor: 1,
      patch: 0,
    })
  })

  it('cold start (0.0.0) with v1 IS ready → 1.0.0', () => {
    expect(computeNextPlannedVersion({ major: 0, minor: 0, patch: 0 }, true)).toEqual({
      major: 1,
      minor: 0,
      patch: 0,
    })
  })
})

describe("computeBumpSuggestion — forcePatch (auto-assign path)", () => {
  it("forcePatch + Feature task → still patch", () => {
    const result = computeBumpSuggestion({
      latestReleased: { major: 0, minor: 9, patch: 0 },
      tasks: [{ category: "feature" }],
      v1MilestoneReady: false,
      forcePatch: true,
    })
    expect(result.bumpType).toBe("patch")
    expect(result.next).toEqual({ major: 0, minor: 9, patch: 1 })
    expect(result.rationale).toContain("forcePatch=true")
  })

  it("forcePatch + breaking change → still patch (overrides everything)", () => {
    const result = computeBumpSuggestion({
      latestReleased: { major: 0, minor: 9, patch: 5 },
      tasks: [{ category: "feature", hasBreakingChanges: true }],
      v1MilestoneReady: true,
      forcePatch: true,
    })
    expect(result.bumpType).toBe("patch")
    expect(result.next).toEqual({ major: 0, minor: 9, patch: 6 })
    expect(result.gatedByMilestone).toBeNull()
  })

  it("forcePatch from cold start (0.0.0) → 0.0.1", () => {
    const result = computeBumpSuggestion({
      latestReleased: { major: 0, minor: 0, patch: 0 },
      tasks: [{ category: "fix" }],
      v1MilestoneReady: false,
      forcePatch: true,
    })
    expect(result.bumpType).toBe("patch")
    expect(result.next).toEqual({ major: 0, minor: 0, patch: 1 })
  })

  it("forcePatch + mixed task types → still patch", () => {
    const result = computeBumpSuggestion({
      latestReleased: { major: 1, minor: 2, patch: 3 },
      tasks: [
        { category: "feature" },
        { category: "fix" },
        { category: "improvement" },
        { category: "feature", hasBreakingChanges: true },
      ],
      v1MilestoneReady: true,
      forcePatch: true,
    })
    expect(result.bumpType).toBe("patch")
    expect(result.next).toEqual({ major: 1, minor: 2, patch: 4 })
  })

  it("forcePatch + empty tasks → still patch", () => {
    const result = computeBumpSuggestion({
      latestReleased: { major: 0, minor: 5, patch: 0 },
      tasks: [],
      v1MilestoneReady: false,
      forcePatch: true,
    })
    expect(result.bumpType).toBe("patch")
    expect(result.next).toEqual({ major: 0, minor: 5, patch: 1 })
  })
})
