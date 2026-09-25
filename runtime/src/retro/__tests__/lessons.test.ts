import { spawn } from "node:child_process"
import { existsSync, mkdtempSync, readFileSync, utimesSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { fixFindings, isCorrection, lessonsFile, lessonsFromFeedback, readLessons, recordLessons, redactSecrets } from "../lessons.ts"

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

  it("redacts credentials in URLs, key=, token=, secret= and password= values, Postgres URLs and the like, and leaves prose alone (review IMP-4)", () => {
    const cases: Array<[string, string]> = [
      ["clone https://eve:ghs_notatoken@github.com/x.git", "clone https://[redacted]@github.com/x.git"],
      ["redis://:hunter2@cache:6379/0", "redis://[redacted]@cache:6379/0"],
      ["DATABASE_URL=postgres://polads:hunter2@ep-x.eu-central-1.aws.neon.tech/neondb?sslmode=require", "DATABASE_URL=postgres://[redacted]"],
      ["see postgresql://u@host/db for it", "see postgres://[redacted] for it"],
      ["RESEND_API_KEY=re_abc123 and PADDLE_SECRET='s p'", "RESEND_API_KEY=[redacted] and PADDLE_SECRET=[redacted]"],
      ["curl 'https://x.test/cb?token=abc123&page=2'", "curl 'https://x.test/cb?token=[redacted]&page=2'"],
      ["set password=hunter2; then db_passwd=x", "set password=[redacted]; then db_passwd=[redacted]"],
      ['{"apiKey": "abc123", "name": "x"}', '{"apiKey": "[redacted]", "name": "x"}'],
      ["client_secret: 'abc'", 'client_secret: "[redacted]"'],
      ["Authorization: Bearer abcdefgh.ijkl", "Authorization: Bearer [redacted]"],
      ["jwt eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.sig here", "jwt [redacted] here"],
      ["-----BEGIN RSA PRIVATE KEY-----\nMIIE\n-----END RSA PRIVATE KEY-----\nafter", "[redacted private key]\nafter"],
      // Prose about tokens and keys is not a secret.
      ["the token expired, so check the key and the password rules", "the token expired, so check the key and the password rules"],
      ["keyboard=qwerty and https://github.com/x/pull/1", "keyboard=qwerty and https://github.com/x/pull/1"],
    ]
    for (const [text, kept] of cases) expect(redactSecrets(text), text).toBe(kept)
    const p = paths()
    recordLessons(p, [lesson("k1", "DATABASE_URL=postgres://polads:hunter2@ep-x.neon.tech/db")], NOW)
    expect(readFileSync(lessonsFile(p), "utf8")).not.toContain("hunter2")
  })

  it("waits for another process's lock before it reads, dedupes and appends, and breaks one a dead holder left (review IMP-5)", () => {
    const p = paths()
    recordLessons(p, [lesson("k1")], NOW)
    const lock = `${lessonsFile(p)}.lock`
    // Another process holds the lock for 300 ms, then appends k2 and lets go.
    const holder = spawn(process.execPath, [
      "-e",
      `const fs = require("node:fs"); fs.writeFileSync(${JSON.stringify(lock)}, "1"); setTimeout(() => { fs.appendFileSync(${JSON.stringify(lessonsFile(p))}, JSON.stringify(${JSON.stringify({ ...lesson("k2"), at: NOW.toISOString() })}) + "\\n"); fs.rmSync(${JSON.stringify(lock)}) }, 300)`,
    ])
    const started = Date.now()
    while (!existsSync(lock) && Date.now() - started < 5000) Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 5)
    expect(existsSync(lock)).toBe(true)
    // k2 is the holder's: read after it let go, it is not written twice.
    expect(recordLessons(p, [lesson("k2"), lesson("k3")], NOW)).toBe(1)
    expect(Date.now() - started).toBeGreaterThanOrEqual(200)
    expect(readLessons(p).map((l) => l.key)).toEqual(["k1", "k2", "k3"])
    expect(existsSync(lock)).toBe(false)
    holder.kill()
    // A lock nobody has touched for a minute is a holder that died mid-write.
    writeFileSync(lock, "99999")
    const stale = new Date(Date.now() - 60_000)
    utimesSync(lock, stale, stale)
    expect(recordLessons(p, [lesson("k4")], NOW)).toBe(1)
    expect(existsSync(lock)).toBe(false)
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
