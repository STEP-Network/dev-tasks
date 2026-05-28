/**
 * Shared Zod schema for review-memory rows.
 *
 * Used by:
 *   - hooks/append-review-memory.ts (runtime validation before append)
 *   - src/__tests__/zod-json-schema-sync.test.ts (byte-equality sync test)
 *
 * The JSON Schema mirror lives at plugin/schemas/reviews.schema.json and is
 * generated from this Zod schema via `zod-to-json-schema`. Consumers that
 * want a JSON-Schema-compatible spec read that file; runtime callers go
 * through Zod here.
 *
 * When updating field shapes: update this file; the sync test regenerates
 * the JSON schema and asserts byte-equality with the committed copy. CI
 * fails if the two drift.
 */

import { z } from "zod"

export const findingSchema = z
  .object({
    id: z
      .string()
      .describe(
        "PR-round-index. e.g. '116-r1-1' = first finding of round 1 on PR #116. Stable across re-runs.",
      ),
    severity: z
      .enum(["BLOCKER", "IMPROVEMENT", "POLISH", "PASS", "NA"])
      .describe(
        "Triage tier per .claude/rules/ship-readiness.md. PASS/NA are recorded for completeness but don't drive pattern extraction.",
      ),
    category: z
      .string()
      .describe(
        "Free-text-but-stable signature for grouping (e.g. 'broken_path_reference', 'missing_i18n_key', 'snapshot_mutation_risk'). Pattern extractor groups by this.",
      ),
    file: z
      .string()
      .nullable()
      .optional()
      .describe("Path of the file the finding refers to, relative to repo root. null for whole-PR findings."),
    line: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe("Line number, or null for file-level findings."),
    outcome: z
      .enum(["fixed", "declined", "dismissed", "pending"])
      .describe(
        "What the agent did with the finding. fixed = changed code. declined = posted decline comment per ship-readiness budget. dismissed = ignored as N/A. pending = not yet decided (gets backfilled in next round or on merge).",
      ),
    message: z
      .string()
      .max(1000)
      .optional()
      .describe(
        "Truncated, redacted finding text. Truncated to 1000 chars to keep rows compact. Pattern extractor doesn't need full text — the (category, file) tuple is the primary signal.",
      ),
    raw_text_sha256: z
      .string()
      .regex(/^[a-f0-9]{16}$/, "must be 16 lowercase hex chars")
      .optional()
      .describe(
        "SHA-256 of (file:line:message) truncated to 16 hex chars. Used by GAP-K to dedup identical findings across rounds — same hash means same finding, regardless of which round captured it.",
      ),
  })
  .strict()

export const rowSchema = z
  .object({
    ts: z.string().datetime({ offset: true }).describe("ISO 8601 UTC timestamp of when the review completed."),
    source: z
      .enum(["self-review", "bot-review"])
      .describe(
        "Which capture path produced this row. self-review = local /self-review skill via PostToolUse hook. bot-review = GitHub Claude bot via review-memory-sync.yml.",
      ),
    pr: z
      .number()
      .int()
      .nullable()
      .optional()
      .describe(
        "GitHub PR number, or null for local-only reviews (e.g. agent ran self-review before opening a PR).",
      ),
    branch: z.string().describe("Git branch name when the review ran."),
    commit_sha: z
      .string()
      .optional()
      .describe("Short SHA of HEAD when the review ran. Lets us trace findings back to specific commits."),
    round: z
      .number()
      .int()
      .min(1)
      .describe(
        "1-indexed iteration. Round 1 = first review on a PR. Round 2+ = re-reviews after fixes.",
      ),
    reviewer_prompt_version: z
      .string()
      .describe(
        "Version tag of the reviewer prompt that produced these findings. Bumped when .claude/skills/self-review/SKILL.md changes substantively. Used by GAP-M to avoid conflating findings across prompt versions.",
      ),
    diff_summary: z
      .object({
        files: z.number().int().min(0).optional(),
        lines_added: z.number().int().min(0).optional(),
        lines_removed: z.number().int().min(0).optional(),
        languages: z
          .array(z.string())
          .optional()
          .describe(
            "File extensions touched. Lets pattern extraction filter by .ts vs .tsx vs .md etc.",
          ),
      })
      .strict()
      .optional(),
    findings: z.array(findingSchema),
    rounds_total: z
      .number()
      .int()
      .min(1)
      .nullable()
      .optional()
      .describe("Total rounds for this PR, backfilled when the PR merges. null while PR is open."),
    final_review_addressed: z
      .string()
      .nullable()
      .optional()
      .describe(
        "Final value of reviewAddressed in active-task.json when PR merged. e.g. 'fixed', 'accepted', 'stuck:regression-loop', 'stuck:max-rounds'. null while PR is open.",
      ),
  })
  .strict()

export type ReviewMemoryRow = z.infer<typeof rowSchema>
export type ReviewFinding = z.infer<typeof findingSchema>
