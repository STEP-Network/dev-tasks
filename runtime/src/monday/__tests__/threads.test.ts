import { describe, expect, it } from "vitest"
import { slackThreadOf } from "../threads.ts"

describe("slackThreadOf", () => {
  it("reads a thread's first message", () => {
    expect(slackThreadOf("https://acme.slack.com/archives/C0123ABC/p1790000000000100")).toEqual({ channelId: "C0123ABC", threadTs: "1790000000.000100" })
  })
  it("reads a reply's link as the thread it is in", () => {
    expect(slackThreadOf("https://acme.slack.com/archives/C0123ABC/p1790000050000200?thread_ts=1790000000.000100&cid=C0123ABC")).toEqual({ channelId: "C0123ABC", threadTs: "1790000000.000100" })
  })
  it.each([[null], [""], ["https://acme.slack.com.evil.example/archives/C1/p1790000000000100"], ["https://linear.app/step/issue/STEP-7"], ["https://acme.slack.com/archives/C1/p17900"]])("refuses %s", (link) => {
    expect(slackThreadOf(link)).toBeNull()
  })
})
