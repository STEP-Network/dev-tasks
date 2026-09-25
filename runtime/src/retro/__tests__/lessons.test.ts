import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { fixFindings, isCorrection, lessonsFile, lessonsFromFeedback, readLessons, recordLessons } from "../lessons.ts"

const NOW = new Date("2026-09-25T10:00:00.000Z")
const paths = () => agentPaths(mkdtempSync(join(tmpdir(), "agentd-lessons-")))
const lesson = (key: string, text = "x") => ({ mini: "eve", issue: "STEP-7", pr: null, category: "blocked" as const, source: "runner" as const, text, key })

describe("recordLessons", () => {
  it("keeps each lesson once, by its key, with its time", () => {
    const p = paths()
    expect(recordLessons(p, [lesson("blocked:J1"), lesson("blocked:J1")], NOW)).toBe(1)
    expect(recordLessons(p, [lesson("blocked:J1"), lesson("blocked:J2")], NOW)).toBe(1)
    expect(readLessons(p).map((l) => [l.key, l.at])).toEqual([
      ["blocked:J1", NOW.toISOString()],
      ["blocked:J2", NOW.toISOString()],
    ])
  })

  it("redacts tokens, drops control characters and cuts a long text: it is data other people wrote", () => {
    const p = paths()
    recordLessons(p, [lesson("k1", "use xoxb-1234-abcd here\u0007 please"), lesson("k2", "y".repeat(5000))], NOW)
    const [a, b] = readLessons(p)
    expect(a.text).toBe("use [redacted] here please")
    expect(b.text).toHaveLength(1500 + " [cut]".length)
    expect(readFileSync(lessonsFile(p), "utf8")).not.toContain("xoxb-1234")
  })

  it("skips a line it cannot read, and a category it does not know", () => {
    const p = paths()
    recordLessons(p, [lesson("k1")], NOW)
    const file = lessonsFile(p)
    const text = readFileSync(file, "utf8")
    writeFileSync(file, `${text}not json\n${JSON.stringify({ ...lesson("k2"), at: NOW.toISOString(), category: "gossip" })}\n`)
    expect(readLessons(p).map((l) => l.key)).toEqual(["k1"])
  })
})

describe("what counts as a must-fix finding", () => {
  it("takes the lines a review tagged BLOCKER or FIX, and never IMPROVEMENT or POLISH", () => {
    const review = [
      "## Review",
      "**BLOCKER** lib/notice.ts:12 reads createdAt instead of publishedAt",
      "- FIX: the migration has no down step",
      "[FIX] app/api/x/route.ts:3 no rate limit",
      "IMPROVEMENT: extract a helper",
      "POLISH lib/a.ts:1 naming",
      "The fixed version looks fine. FIXME in a comment is not a finding.",
    ].join("\n")
    expect(fixFindings(review)).toEqual([
      "**BLOCKER** lib/notice.ts:12 reads createdAt instead of publishedAt",
      "- FIX: the migration has no down step",
      "[FIX] app/api/x/route.ts:3 no rate limit",
    ])
  })
})

describe("what counts as a person's correction", () => {
  it("hears a no, a don't, a revert and a should-have", () => {
    for (const text of [
      "no, use the publication date",
      "No. The date is the signing date",
      "don't merge that yet",
      "please revert the copy change",
      "you should have added a test for the empty case",
      "that's not what I asked",
      "<@UBOT> actually the label goes on the parent",
      "keep the old name instead of renaming it",
    ]) expect(isCorrection(text), text).toBe(true)
  })

  it("is not an instruction, a thanks or a no that corrects nothing", () => {
    for (const text of ["fix it and merge", "looks good, thanks", "no problem, thanks", "no rush", "stop working for now", "re-run it"]) {
      expect(isCorrection(text), text).toBe(false)
    }
  })
})

describe("lessonsFromFeedback", () => {
  it("keeps each point of a revise round, its must-fix findings and each failing check, keyed by where they came from", () => {
    const out = lessonsFromFeedback(
      {
        points: [
          { who: "nate", where: "review, changes requested", at: "2026-09-25T09:00:00Z", body: "Use the publication date." },
          { who: "claude", where: "PR comment", at: "2026-09-25T09:05:00Z", body: "**BLOCKER** lib/notice.ts:12 wrong field\nPOLISH naming" },
        ],
        logs: [{ name: "Test", tail: "FAIL lib/notice.test.ts" }],
      },
      { mini: "eve", issue: "STEP-7", pr: "https://github.com/x/y/pull/1700", round: 2 },
    )
    expect(out.map((l) => [l.category, l.who ?? null, l.text])).toEqual([
      ["review", "nate", "review, changes requested: Use the publication date."],
      ["review", "claude", "PR comment: **BLOCKER** lib/notice.ts:12 wrong field\nPOLISH naming"],
      ["fix", "claude", "**BLOCKER** lib/notice.ts:12 wrong field"],
      ["check", null, "Test failed"],
    ])
    expect(new Set(out.map((l) => l.key)).size).toBe(4)
    expect(out.every((l) => l.pr === "https://github.com/x/y/pull/1700" && l.issue === "STEP-7" && l.source === "github")).toBe(true)
  })
})
