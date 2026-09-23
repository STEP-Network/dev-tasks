/**
 * The pure half of the tracker adapter. No network, no key, no filesystem.
 *
 * Two of these pin decisions rather than mechanics:
 *  - branchNameFor CONSTRUCTS `STEP-123-slug` instead of returning Linear's
 *    own issue.branchName, which is prefixed with the API key owner's
 *    username ("nate/step-123-…"). An agent's branches must not read as
 *    belonging to whoever's key happens to be installed on that mini.
 *  - byPriorityThenAge puts "No priority" (Linear's 0) LAST, not first.
 *    Linear numbers priority 1=Urgent … 4=Low, 0=none; a naive ascending
 *    sort hands the queue every unprioritised issue before every urgent one.
 */

import { describe, it, expect } from "vitest"
import {
  extractAcceptanceCriteria,
  slugify,
  branchNameFor,
  byPriorityThenAge,
  LINEAR_TEAM_KEY,
  LINEAR_REF_RE,
  type TrackerIssue,
} from "../types.ts"

describe("extractAcceptanceCriteria", () => {
  // The migration writes exactly this heading (scripts/linear/transform.ts:208).
  const doc = [
    "Some preamble.",
    "",
    "## Acceptance criteria",
    "",
    "- [ ] The thing works",
    "- [ ] The other thing works",
    "",
    "## Notes",
    "",
    "Not part of the criteria.",
  ].join("\n")

  it("returns the block under the heading", () => {
    expect(extractAcceptanceCriteria(doc)).toBe(
      "- [ ] The thing works\n- [ ] The other thing works",
    )
  })

  it("stops at a sibling heading and excludes it", () => {
    expect(extractAcceptanceCriteria(doc)).not.toMatch(/Notes/)
  })

  it("does NOT stop at a deeper heading", () => {
    const nested = "## Acceptance criteria\n\n### Given\n\n- a\n\n## After\n\nno"
    expect(extractAcceptanceCriteria(nested)).toBe("### Given\n\n- a")
  })

  it("is case-insensitive and tolerates a trailing colon", () => {
    expect(extractAcceptanceCriteria("### ACCEPTANCE CRITERIA:\n\n- x")).toBe("- x")
  })

  it("returns empty string when there is no such heading", () => {
    expect(extractAcceptanceCriteria("# Title\n\nbody")).toBe("")
  })

  it("returns empty string for empty or undefined input", () => {
    expect(extractAcceptanceCriteria("")).toBe("")
    expect(extractAcceptanceCriteria(undefined as unknown as string)).toBe("")
  })
})

describe("slugify", () => {
  it("lowercases and hyphenates", () => {
    expect(slugify("Fix the Broken Thing")).toBe("fix-the-broken-thing")
  })

  it("strips diacritics rather than dropping the letter", () => {
    // Danish issue titles are ordinary here.
    expect(slugify("Ændr størrelse")).toBe("aendr-stoerrelse")
  })

  it("collapses runs of punctuation and trims the ends", () => {
    expect(slugify("  --- a/b: c!!  ")).toBe("a-b-c")
  })

  it("truncates without leaving a trailing hyphen", () => {
    expect(slugify("aaaa bbbb cccc dddd", 11)).toBe("aaaa-bbbb")
  })

  it("truncates at an exact hyphen boundary without dropping a word", () => {
    expect(slugify("aaaa bbbb cccc", 9)).toBe("aaaa-bbbb")
  })

  it("hard-cuts a single hyphenless word longer than maxLength", () => {
    expect(slugify("abcdefghij", 4)).toBe("abcd")
  })

  it("returns empty string when nothing survives", () => {
    expect(slugify("!!!")).toBe("")
  })
})

describe("branchNameFor", () => {
  it("builds STEP-123-slug in capitals", () => {
    expect(branchNameFor("STEP-123", "Fix the thing")).toBe("STEP-123-fix-the-thing")
  })

  it("upper-cases a lowercase identifier so LINEAR_REF_RE can match it", () => {
    expect(branchNameFor("step-7", "Do it")).toBe("STEP-7-do-it")
  })

  it("falls back to the bare identifier when the title yields no slug", () => {
    expect(branchNameFor("STEP-9", "!!!")).toBe("STEP-9")
  })

  it("produces a name LINEAR_REF_RE matches", () => {
    expect(LINEAR_REF_RE.test(branchNameFor("STEP-42", "Something"))).toBe(true)
  })
})

describe("byPriorityThenAge", () => {
  const issue = (priority: number, updatedAt: string): TrackerIssue => ({
    id: "STEP-1",
    uuid: "u",
    title: "t",
    description: "",
    acceptanceCriteria: "",
    state: "Ready",
    labels: [],
    url: "",
    priority,
    updatedAt,
  })

  it("puts Urgent before Low", () => {
    expect(byPriorityThenAge(issue(1, "2026-01-01"), issue(4, "2026-01-01"))).toBeLessThan(0)
  })

  it("puts No priority (0) LAST, behind Low", () => {
    expect(byPriorityThenAge(issue(0, "2026-01-01"), issue(4, "2026-01-01"))).toBeGreaterThan(0)
  })

  it("breaks a priority tie oldest-first so nothing starves", () => {
    expect(byPriorityThenAge(issue(2, "2026-01-01"), issue(2, "2026-06-01"))).toBeLessThan(0)
  })

  it("sorts a mixed list into the queue order the front door drains", () => {
    const list = [issue(0, "2026-01-01"), issue(3, "2026-05-01"), issue(1, "2026-09-01"), issue(3, "2026-02-01")]
    expect(list.slice().sort(byPriorityThenAge).map((i) => [i.priority, i.updatedAt])).toEqual([
      [1, "2026-09-01"],
      [3, "2026-02-01"],
      [3, "2026-05-01"],
      [0, "2026-01-01"],
    ])
  })
})

describe("the team key is STEP, never POL", () => {
  it("names the real team", () => {
    // The spec writes POL-123; the real key is STEP (lib/ci/pr-task-trace.ts).
    expect(LINEAR_TEAM_KEY).toBe("STEP")
  })

  it("matches the same shape the Task trace CI check matches", () => {
    expect(LINEAR_REF_RE.test("Fixes STEP-3055 in passing")).toBe(true)
    expect(LINEAR_REF_RE.test("POL-3055")).toBe(false)
    expect(LINEAR_REF_RE.test("step-3055")).toBe(false)
  })
})
