import { describe, expect, it } from "vitest"
import { testDayVerb } from "../answer.ts"

describe("testDayVerb (Wave 3, spec 7: the fixed test-day verbs)", () => {
  it("reads begin testday, however it is spaced, with a mention or a please", () => {
    for (const text of ["begin testday", "Begin test day.", "<@UBOT> begin testday", "please begin testday!", "start test day", "<@UBOT|eve> start testday"]) {
      expect(testDayVerb(text)).toEqual({ verb: "start" })
    }
  })

  it("never reads a sentence that only mentions test day", () => {
    for (const text of ["when do we begin testday?", "begin testday next week", "don't begin testday", "testday", "begin", ""]) expect(testDayVerb(text)).toBeNull()
  })

  it("reads a checkpoint verdict with what the person saw", () => {
    expect(testDayVerb("4 pass")).toEqual({ verb: "verdict", n: 4, verdict: "pass", note: "" })
    expect(testDayVerb("#12 FAIL: the price shows 0 kr")).toEqual({ verb: "verdict", n: 12, verdict: "fail", note: "the price shows 0 kr" })
    expect(testDayVerb("3. fail\nthe button does nothing")).toEqual({ verb: "verdict", n: 3, verdict: "fail", note: "the button does nothing" })
    expect(testDayVerb("<@UBOT> 7 pass")).toEqual({ verb: "verdict", n: 7, verdict: "pass", note: "" })
    expect(testDayVerb("4 fail the price\n  shows 0 kr ")).toEqual({ verb: "verdict", n: 4, verdict: "fail", note: "the price shows 0 kr" })
  })

  it("reads no verdict from a message with several: a FAIL never becomes a PASS's note", () => {
    for (const text of [
      "5 pass\n6 fail no logo", "5 pass, 6 fail no logo", "5 pass; #6 fail", "5 pass 6 fail", "4 fail the price\n5. pass", "4 fail, 2 pass",
      // However the two are joined (review of eec5b29).
      "5 pass and 6 fail no logo", "5 pass & 6 fail", "5 pass / 6 fail", "5 pass | 6 fail", "5 pass + 6 fail", "5 pass — 6 fail", "5 pass – 6 fail",
      "5 pass (6 fail)", "5 pass * 6 fail", "5 pass then 6 fail", "5 pass but 6 fail", "5 pass ✅ 6 fail", "5 pass og 6 fail", "5 pass\n• 6 fail",
      "5 fail no logo and 6 pass", "4 fail the price, 5 pass",
    ]) {
      expect(testDayVerb(text), text).toEqual({ verb: "several" })
    }
    // A number that is not a checkpoint's is still one verdict.
    for (const note of ["the total shows 3 items", "the price shows 0 kr", "step 3 fails", "2 of 3 buttons work", "tried 3 times, 2 failed"]) {
      expect(testDayVerb(`4 fail ${note}`), note).toEqual({ verb: "verdict", n: 4, verdict: "fail", note })
    }
    // A number right before pass or fail is read as a second checkpoint: asked again, never guessed.
    expect(testDayVerb("4 fail: only 2 pass the check")).toEqual({ verb: "several" })
  })

  it("never reads a verdict without its checkpoint, or a word that only starts like one", () => {
    for (const text of ["pass", "fail it", "4 passed", "4 failing", "1234 pass", "step 4 pass"]) expect(testDayVerb(text)).toBeNull()
  })

  it("reads the two answers to a failed checkpoint and nothing near them", () => {
    for (const text of ["fix before release", "Fix it before the release.", "fix now"]) expect(testDayVerb(text)).toEqual({ verb: "decide", answer: "fix" })
    for (const text of ["next week", "Hold it back", "hold back to next week", "Next week!"]) expect(testDayVerb(text)).toEqual({ verb: "decide", answer: "next-week" })
    for (const text of ["maybe next week?", "fix the header before release", "not next week", "next week please fix it", "fix before release? not sure", "fix now or later"]) {
      expect(testDayVerb(text)).toBeNull()
    }
  })
})
