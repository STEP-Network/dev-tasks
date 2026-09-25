import { describe, expect, it } from "vitest"
import { parseInstruction } from "../instruction.ts"

const actions = (text: string) => parseInstruction(text).actions

describe("parseInstruction (STEP-3285)", () => {
  it("reads what Nate wrote to Eve's escalations as instructions", () => {
    // #polads-questions, 2026-09-25: each got a ✅ and nothing else.
    expect(actions("then make it green and merge")).toEqual(["revise", "merge"])
    expect(actions("then make it green. take care of it")).toEqual(["revise"])
    expect(actions("fix it and merge")).toEqual(["revise", "merge"])
  })

  it("knows each action by its usual words", () => {
    for (const [text, want] of [
      ["please re-run it", ["rerun"]],
      ["rerun", ["rerun"]],
      ["run the tests again", ["rerun"]],
      ["retry the checks", ["rerun"]],
      ["retry", ["retry"]],
      ["try again", ["retry"]],
      ["carry on", ["retry"]],
      ["merge it", ["merge"]],
      ["pause for now", ["pause"]],
      ["hold off until Monday", ["pause"]],
      ["leave it, I'll take it", ["leave"]],
      ["address the review", ["revise"]],
    ] as const) {
      expect(actions(text), text).toEqual(want)
    }
  })

  it("names no action that is negated, and none in chatter", () => {
    expect(actions("fix it, but don't merge")).toEqual(["revise"])
    expect(actions("no need to re-run")).toEqual([])
    expect(actions("do not merge this yet")).toEqual([])
    expect(actions("looks good, thanks")).toEqual([])
    expect(actions("which date did you pick?")).toEqual([])
    // Past tense and common words are not commands.
    expect(actions("I fixed the DNS record, you can continue")).toEqual([])
    expect(actions("resolved on our side")).toEqual([])
  })

  it("reads mentions and links in Slack's markup as plain words, and finds what they name", () => {
    expect(parseInstruction("<@UEVE> fix <https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679|#1679> and merge")).toEqual({
      actions: ["revise", "merge"],
      target: { url: "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679", pr: 1679 },
    })
    expect(parseInstruction("<@UEVE> re-run STEP-3187").target).toEqual({ issue: "STEP-3187" })
    expect(parseInstruction("<@UEVE> merge #1687").target).toEqual({ pr: 1687 })
    expect(parseInstruction("<@UEVE> merge PR 1689").target).toEqual({ pr: 1689 })
    expect(parseInstruction("<@UEVE> fix the login page").target).toEqual({})
  })
})
