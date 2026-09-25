import { describe, expect, it } from "vitest"
import { feedbackFor, JARGON, plainReason, prLink, prRef } from "../plain.ts"

describe("plain words for people (plain.ts)", () => {
  it("says each of the runner's own stop reasons without the machinery's words", () => {
    const reasons = [
      "the wall-clock limit of 90 minutes",
      "the turn limit of 250",
      "the budget of USD 15",
      "the report's self-check is incomplete: siblings (no search command), docs (no search command)",
      "the branch changes tests (a.test.ts) but the report lists no mutation check",
      "no valid final report",
      "the worker ended without a valid report",
      "the report has no PR title",
      "the worker reported done but made no commits",
      "the worker process failed: Claude Code process exited with code 1",
      "an API error: overloaded",
      "an error during execution: tool crashed",
      "origin has no branch STEP-7-fix-the-date to revise",
      "the worktree could not be prepared: fatal: bad object",
      "finishing the job failed: gh pr comment failed",
      "needs input but asked no question",
    ]
    for (const reason of reasons) {
      expect(plainReason(reason), reason).not.toMatch(JARGON)
      expect(plainReason(reason), reason).not.toBe(reason)
    }
    expect(plainReason("the wall-clock limit of 90 minutes.")).toBe("I ran out of time (90 minutes)")
    // The worker's own words, which its rules ask it to write plainly, stay as they are.
    expect(plainReason("The migration needs a person.")).toBe("The migration needs a person")
  })

  it("knows the words Eve's looping message used", () => {
    expect(`Revising PR stopped: the report's self-check is incomplete: siblings (no search command). Reply "fix it"`).toMatch(JARGON)
    expect("I fixed the review comments on PR #1704 and pushed them. Nothing needed from you.").not.toMatch(JARGON)
  })

  it("names a PR by its number, as a Slack link", () => {
    const url = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1704"
    expect(prRef(url)).toBe("PR #1704")
    expect(prLink(url)).toBe(`<${url}|PR #1704>`)
    expect(prLink("https://example.com/x")).toBe("https://example.com/x")
  })

  it("says what a revise job works on, from the reasons agentd gave it", () => {
    expect(feedbackFor(["changes requested by nate"])).toBe("the review comments")
    expect(feedbackFor(["a comment from kris", "asked by Nate in Slack"])).toBe("the review comments")
    expect(feedbackFor(["Claude review failed"])).toBe("the review comments")
    expect(feedbackFor(["Test failed"])).toBe("the failing checks")
    expect(feedbackFor(["changes requested by nate", "Lint failed"])).toBe("the review comments and the failing checks")
  })
})
