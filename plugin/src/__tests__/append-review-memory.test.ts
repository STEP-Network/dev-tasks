/**
 * Tests for hooks/append-review-memory.ts.
 *
 * Migrated from v0-politiske-annoncer/__tests__/lib/append-review-memory.test.ts
 * (originally jest, converted to vitest as part of moving the script into the
 * plugin). Fixture coverage preserved verbatim — schema validation paths,
 * concurrent-append atomicity, error-path edge cases.
 */

import { spawn, spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join, resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect, beforeEach, afterEach } from "vitest"

const __dirname = dirname(fileURLToPath(import.meta.url))
const PLUGIN_ROOT = resolve(__dirname, "..", "..")
const SCRIPT = resolve(PLUGIN_ROOT, "hooks", "append-review-memory.ts")
const TSX_BIN = resolve(PLUGIN_ROOT, "node_modules", ".bin", "tsx")

function runAppender(
  input: string,
  jsonlPath: string,
): { stdout: string; stderr: string; status: number } {
  const result = spawnSync(TSX_BIN, [SCRIPT], {
    input,
    encoding: "utf-8",
    env: { ...process.env, REVIEWS_PATH_OVERRIDE: jsonlPath },
  })
  return {
    stdout: result.stdout,
    stderr: result.stderr,
    status: result.status ?? -1,
  }
}

function makeValidRow(overrides: Record<string, unknown> = {}) {
  return {
    ts: "2026-05-06T12:00:00Z",
    source: "self-review",
    branch: "feat/test",
    round: 1,
    reviewer_prompt_version: "v1",
    findings: [
      {
        id: "test-r1-1",
        severity: "POLISH",
        category: "uncategorized",
        outcome: "pending",
        message: "test finding",
        raw_text_sha256: "0123456789abcdef",
      },
    ],
    ...overrides,
  }
}

describe("append-review-memory schema validation", () => {
  let tmpDir: string
  let jsonlPath: string

  beforeEach(() => {
    tmpDir = mkdtempSync(join(tmpdir(), "review-memory-test-"))
    jsonlPath = join(tmpDir, "reviews.jsonl")
    writeFileSync(jsonlPath, "")
  })

  afterEach(() => {
    rmSync(tmpDir, { recursive: true, force: true })
  })

  it("appends a schema-valid row as a single newline-terminated line", () => {
    const row = makeValidRow()
    const result = runAppender(JSON.stringify(row), jsonlPath)

    expect(result.status).toBe(0)
    expect(result.stderr).toBe("")
    const written = readFileSync(jsonlPath, "utf-8")
    expect(written).toMatch(/\n$/)
    expect(written.split("\n").filter(Boolean)).toHaveLength(1)
    const parsed = JSON.parse(written.trim())
    expect(parsed.findings[0].id).toBe("test-r1-1")
  })

  it("rejects a row with missing required field", () => {
    const row = makeValidRow()
    delete (row as Record<string, unknown>).ts
    const result = runAppender(JSON.stringify(row), jsonlPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/schema validation failed/i)
    expect(result.stderr).toMatch(/\bts\b/)
  })

  it("rejects a row with invalid severity enum value", () => {
    const row = makeValidRow()
    ;(row.findings[0] as { severity: string }).severity = "CRITICAL"
    const result = runAppender(JSON.stringify(row), jsonlPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/schema validation failed/i)
  })

  it("rejects a malformed raw_text_sha256 (wrong length or non-hex)", () => {
    const row = makeValidRow()
    ;(row.findings[0] as { raw_text_sha256: string }).raw_text_sha256 = "not-hex-and-wrong-length-too"
    const result = runAppender(JSON.stringify(row), jsonlPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/raw_text_sha256/)
  })

  it("accepts a row without raw_text_sha256 (backwards-compatible)", () => {
    const row = makeValidRow()
    delete (row.findings[0] as Record<string, unknown>).raw_text_sha256
    const result = runAppender(JSON.stringify(row), jsonlPath)

    expect(result.status).toBe(0)
    expect(readFileSync(jsonlPath, "utf-8").trim()).toBeTruthy()
  })

  it("rejects empty stdin", () => {
    const result = runAppender("", jsonlPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/empty/i)
  })

  it("rejects malformed JSON", () => {
    const result = runAppender("{not valid json", jsonlPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/not valid json/i)
  })

  it("rejects message > 1000 chars", () => {
    const row = makeValidRow()
    ;(row.findings[0] as { message: string }).message = "x".repeat(1001)
    const result = runAppender(JSON.stringify(row), jsonlPath)

    expect(result.status).not.toBe(0)
    expect(result.stderr).toMatch(/schema validation failed/i)
  })

  it("concurrent appends each land on their own line (POSIX atomicity)", async () => {
    const rows = Array.from({ length: 5 }, (_, i) =>
      makeValidRow({
        findings: [
          {
            id: `concurrent-r1-${i}`,
            severity: "POLISH",
            category: "test",
            outcome: "pending",
            message: `concurrent test ${i}`,
          },
        ],
      }),
    )

    await Promise.all(
      rows.map(
        (row) =>
          new Promise<void>((resolveRun, rejectRun) => {
            const child = spawn(TSX_BIN, [SCRIPT], {
              env: { ...process.env, REVIEWS_PATH_OVERRIDE: jsonlPath },
              stdio: ["pipe", "pipe", "pipe"],
            })
            child.stdin.write(JSON.stringify(row))
            child.stdin.end()
            child.on("exit", (code) => (code === 0 ? resolveRun() : rejectRun(new Error(`exit ${code}`))))
          }),
      ),
    )

    const lines = readFileSync(jsonlPath, "utf-8").split("\n").filter(Boolean)
    expect(lines).toHaveLength(5)
    const ids = lines.map((line) => JSON.parse(line).findings[0].id)
    expect(new Set(ids).size).toBe(5)
    for (let i = 0; i < 5; i++) {
      expect(ids).toContain(`concurrent-r1-${i}`)
    }
  }, 30_000)
})
