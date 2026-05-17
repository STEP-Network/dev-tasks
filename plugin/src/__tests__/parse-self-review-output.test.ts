/**
 * Tests for hooks/parse-self-review-output.py.
 *
 * Migrated from v0-politiske-annoncer/__tests__/lib/parse-self-review-output.test.ts
 * (originally jest, converted to vitest as part of moving the script into the
 * plugin). The parser is Python; we test via subprocess. Fixtures preserved
 * verbatim.
 */

import { spawnSync } from "node:child_process"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { writeFileSync, unlinkSync } from "node:fs"
import { describe, it, expect } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, "..", "..")
const PARSER = resolve(PLUGIN_ROOT, "hooks", "parse-self-review-output.py")

function runParser(
  input: string,
  extraEnv: Record<string, string> = {},
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync("python3", [PARSER], {
    input,
    encoding: "utf-8",
    env: { ...process.env, STATE_FILE: "", ...extraEnv },
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? -1,
  }
}

function parseRow(stdout: string): Record<string, unknown> | null {
  const trimmed = stdout.trim()
  if (!trimmed) return null
  return JSON.parse(trimmed)
}

describe("parse-self-review-output parser", () => {
  it("emits empty stdout on malformed JSON input", () => {
    const result = runParser("{not valid json at all")
    expect(result.status).toBe(0)
    expect(result.stdout).toBe("")
  })

  it("handles tool_response as a string (not an object)", () => {
    const input = JSON.stringify({
      tool_response: "🔴 BLOCKER — file.ts:42 — auth check missing",
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row).not.toBeNull()
    expect((row!.findings as unknown[]).length).toBeGreaterThan(0)
  })

  it("emits a row with no findings when tool_response.content is missing", () => {
    const input = JSON.stringify({
      tool_response: { unrelated_key: "foo" },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row).not.toBeNull()
    expect(row!.findings).toEqual([])
  })

  it("joins tool_response.content array of mixed dicts and strings", () => {
    const input = JSON.stringify({
      tool_response: {
        content: [
          { text: "🔴 BLOCKER — file.ts:10 — bad" },
          "🟠 IMPROVEMENT — other.ts:20 — meh",
          { text: "🟡 POLISH — third.md:30 — nit" },
        ],
      },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row).not.toBeNull()
    const findings = row!.findings as Array<{ severity: string; file: string }>
    expect(findings.length).toBe(3)
    const severities = findings.map((f) => f.severity).sort()
    expect(severities).toEqual(["BLOCKER", "IMPROVEMENT", "POLISH"])
  })

  it("redacts emails in finding messages", () => {
    const input = JSON.stringify({
      tool_response: {
        content: "🔴 BLOCKER — user.ts:5 — leaked alice@example.com in test fixture",
      },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row).not.toBeNull()
    const msg = (row!.findings as Array<{ message: string }>)[0].message
    expect(msg).not.toMatch(/alice@example\.com/)
    expect(msg).toMatch(/\[EMAIL_REDACTED\]/)
  })

  it("redacts long token-shaped strings", () => {
    const tokenish = "abcdefghijklmnopqrstuvwxyz0123456789ABCDEFGH"
    const input = JSON.stringify({
      tool_response: {
        content: `🔴 BLOCKER — config.ts:7 — exposed key ${tokenish}`,
      },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    const msg = (row!.findings as Array<{ message: string }>)[0].message
    expect(msg).not.toContain(tokenish)
    expect(msg).toMatch(/\[TOKEN_REDACTED\]/)
  })

  it("redacts password-shaped assignments", () => {
    const input = JSON.stringify({
      tool_response: {
        content: '🔴 BLOCKER — env.ts:1 — found password="literal12345" in code',
      },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    const msg = (row!.findings as Array<{ message: string }>)[0].message
    expect(msg).not.toContain("literal12345")
    expect(msg).toMatch(/\[REDACTED\]/)
  })

  it("attaches a 16-hex-char raw_text_sha256 to each finding", () => {
    const input = JSON.stringify({
      tool_response: { content: "🔴 BLOCKER — file.ts:1 — same finding text" },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    const findings = row!.findings as Array<{ raw_text_sha256: string }>
    expect(findings[0].raw_text_sha256).toMatch(/^[a-f0-9]{16}$/)
  })

  it("produces identical raw_text_sha256 for the same (file, line, message)", () => {
    const input = JSON.stringify({
      tool_response: { content: "🟠 IMPROVEMENT — same.ts:99 — duplicate finding" },
    })
    const a = parseRow(runParser(input).stdout)
    const b = parseRow(runParser(input).stdout)
    const aHash = (a!.findings as Array<{ raw_text_sha256: string }>)[0].raw_text_sha256
    const bHash = (b!.findings as Array<{ raw_text_sha256: string }>)[0].raw_text_sha256
    expect(aHash).toBe(bHash)
  })

  it("respects explicit `iteration N` markers in the prose for round detection", () => {
    const input = JSON.stringify({
      tool_response: {
        content: "Self-review iteration 3 — 🔴 BLOCKER — x.ts:1 — bad",
      },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row!.round).toBe(3)
  })

  it("respects explicit `round N` markers in the prose", () => {
    const input = JSON.stringify({
      tool_response: { content: "Round 5 self-review — 🔴 BLOCKER — y.ts:2 — bad" },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row!.round).toBe(5)
  })

  it("defaults round to 1 when no markers and no PR/active-task", () => {
    const input = JSON.stringify({
      tool_response: { content: "🔴 BLOCKER — z.ts:3 — bad" },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row!.round).toBe(1)
  })

  it("only extracts severity-tagged lines, not arbitrary prose", () => {
    const input = JSON.stringify({
      tool_response: {
        content: [
          "Some narrative prose without severity markers.",
          "Another sentence about why something might fail or pass theoretically.",
          "🔴 BLOCKER — actual.ts:1 — real finding",
          "More narrative. No severity here.",
        ].join("\n"),
      },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    const findings = row!.findings as Array<{ severity: string; file: string }>
    expect(findings.length).toBe(1)
    expect(findings[0].file).toBe("actual.ts")
  })

  it("emits a row even when no findings are extracted (so Loop 1 still tracks the iteration)", () => {
    const input = JSON.stringify({
      tool_response: { content: "All checks passed cleanly." },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    expect(row).not.toBeNull()
    expect(row!.findings).toEqual([])
    expect(row!.source).toBe("self-review")
    expect(row!.round).toBe(1)
  })

  it("normalizes FAIL severity to BLOCKER", () => {
    const input = JSON.stringify({
      tool_response: { content: "❌ Docs — FAIL: file.md line 73 — broken reference" },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    const findings = row!.findings as Array<{ severity: string }>
    expect(findings[0].severity).toBe("BLOCKER")
  })

  it("extracts file path and line number from severity lines", () => {
    const input = JSON.stringify({
      tool_response: { content: "🔴 BLOCKER — components/Button.tsx:42 — bad" },
    })
    const result = runParser(input)
    const row = parseRow(result.stdout)
    const findings = row!.findings as Array<{ file: string; line: number }>
    expect(findings[0].file).toBe("components/Button.tsx")
    expect(findings[0].line).toBe(42)
  })

  it("uses bot-comment-count + 1 for round detection (path 2)", () => {
    const input = JSON.stringify({
      tool_response: { content: "🔴 BLOCKER — file.ts:1 — issue" },
    })
    const result = runParser(input, { BOT_REVIEW_COUNT_OVERRIDE: "2" })
    const row = parseRow(result.stdout)
    expect(row!.round).toBe(3)
  })

  it("falls back to default round=1 when bot count is 0 and no markers", () => {
    const input = JSON.stringify({
      tool_response: { content: "🔴 BLOCKER — file.ts:1 — issue" },
    })
    const result = runParser(input, { BOT_REVIEW_COUNT_OVERRIDE: "0" })
    const row = parseRow(result.stdout)
    expect(row!.round).toBe(1)
  })

  it("explicit `iteration N` markers in prose take priority over bot count", () => {
    const input = JSON.stringify({
      tool_response: {
        content: "Self-review iteration 2 — 🔴 BLOCKER — file.ts:1 — issue",
      },
    })
    const result = runParser(input, { BOT_REVIEW_COUNT_OVERRIDE: "5" })
    const row = parseRow(result.stdout)
    expect(row!.round).toBe(2)
  })

  it("reads round from active-task.json reviewAddressed history (path 3) when bot count is 0", () => {
    const tmpStateFile = `/tmp/parser-test-state-${Date.now()}-${process.pid}.json`
    writeFileSync(
      tmpStateFile,
      JSON.stringify({ reviewAddressed: "round 1 fixed; round 2 declined" }),
    )
    const input = JSON.stringify({
      tool_response: { content: "🔴 BLOCKER — file.ts:1 — issue" },
    })
    try {
      const result = runParser(input, {
        BOT_REVIEW_COUNT_OVERRIDE: "0",
        STATE_FILE: tmpStateFile,
      })
      const row = parseRow(result.stdout)
      expect(row!.round).toBe(3)
    } finally {
      unlinkSync(tmpStateFile)
    }
  })
})
