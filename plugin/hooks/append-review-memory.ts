#!/usr/bin/env tsx
/**
 * Append a row to <consumer>/.claude/review-memory/reviews.jsonl after schema
 * validation against the shared Zod schema.
 *
 * Invoked by:
 *   - plugin/hooks/post-self-review.sh — Loop 1, local /self-review capture
 *   - Future: a GitHub Action for bot-review capture (mirror invocation)
 *
 * Reads ONE JSON object from stdin, validates, appends.
 *
 * Path resolution:
 *   1. REVIEWS_PATH_OVERRIDE (test harness)
 *   2. <consumer-repo-root>/.claude/review-memory/reviews.jsonl
 *      (consumer repo root = CLAUDE_PROJECT_DIR ?? cwd)
 *
 * Atomicity: `appendFileSync` under PIPE_BUF (4KB on POSIX) is atomic. Our
 * rows are well under that, so concurrent appends from parallel post-self-
 * review fires don't interleave.
 */

import { appendFileSync, mkdirSync, readFileSync } from "node:fs"
import { dirname, resolve } from "node:path"
import { rowSchema } from "./lib/reviews-schema.ts"

const REVIEWS_PATH = process.env.REVIEWS_PATH_OVERRIDE
  ? resolve(process.env.REVIEWS_PATH_OVERRIDE)
  : resolve(
      process.env.CLAUDE_PROJECT_DIR ?? process.cwd(),
      ".claude/review-memory/reviews.jsonl",
    )

function fail(msg: string): never {
  process.stderr.write(`append-review-memory: ${msg}\n`)
  process.exit(1)
}

function readStdin(): string {
  try {
    return readFileSync(0, "utf-8")
  } catch (err) {
    fail(`could not read stdin: ${err instanceof Error ? err.message : String(err)}`)
  }
}

function main() {
  const raw = readStdin().trim()
  if (!raw) {
    fail("stdin was empty — expected a single JSON object")
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch (err) {
    fail(`stdin was not valid JSON: ${err instanceof Error ? err.message : String(err)}`)
  }

  const result = rowSchema.safeParse(parsed)
  if (!result.success) {
    const errors = result.error.issues
      .map((i) => `  - ${i.path.join(".") || "(root)"}: ${i.message}`)
      .join("\n")
    fail(`schema validation failed:\n${errors}`)
  }

  // Ensure parent dir exists — first-run consumers without .claude/review-memory/
  // shouldn't get a confusing ENOENT.
  try {
    mkdirSync(dirname(REVIEWS_PATH), { recursive: true })
  } catch (err) {
    fail(`could not create parent dir: ${err instanceof Error ? err.message : String(err)}`)
  }

  const line = JSON.stringify(result.data) + "\n"
  appendFileSync(REVIEWS_PATH, line, { encoding: "utf-8" })

  process.stdout.write(
    `✓ appended review-memory row (source=${result.data.source}, round=${result.data.round}, findings=${result.data.findings.length})\n`,
  )
}

main()
