/**
 * Argument parsing for trackerctl. The subcommands themselves are covered by
 * the adapter tests; what is worth pinning here is the parsing, because the
 * callers are MARKDOWN SKILLS — a mis-parsed flag surfaces as a skill that
 * quietly does the wrong thing rather than as a type error.
 *
 * The --description case is the one that bites: an issue description is
 * multi-line prose containing spaces, quotes and newlines.
 */

import { describe, it, expect } from "vitest"
import { parseArgs } from "../../../scripts/trackerctl.ts"

describe("parseArgs", () => {
  it("reads a subcommand and its positional", () => {
    expect(parseArgs(["read", "STEP-123"])).toMatchObject({
      command: "read",
      positional: ["STEP-123"],
    })
  })

  it("collects repeated --label into an array", () => {
    const parsed = parseArgs(["create", "--title", "T", "--label", "type/chore", "--label", "product/polads"])
    expect(parsed.flags.label).toEqual(["type/chore", "product/polads"])
  })

  it("keeps a single-valued flag as a string", () => {
    expect(parseArgs(["create", "--title", "Fix the thing"]).flags.title).toBe("Fix the thing")
  })

  it("keeps newlines and quotes inside a flag value intact", () => {
    const body = 'Line one\n\n## Acceptance criteria\n\n- [ ] the "thing" works'
    expect(parseArgs(["create", "--title", "T", "--description", body]).flags.description).toBe(body)
  })

  it("treats a bare --flag with no value as the boolean true", () => {
    expect(parseArgs(["ready", "--json"]).flags.json).toBe(true)
  })

  it("does not mistake a negative number for a flag", () => {
    expect(parseArgs(["ready", "--limit", "-1"]).flags.limit).toBe("-1")
  })

  it("throws a usage error on no subcommand at all", () => {
    expect(() => parseArgs([])).toThrowError(/usage/i)
  })
})
