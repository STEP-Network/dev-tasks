import { describe, expect, it } from "vitest"
import { answerTransition, appendAnswer, intakeIssue, prefixed, truncateChars } from "../text.ts"

describe("prefixed and truncateChars", () => {
  it("puts the mini's name first", () => {
    expect(prefixed("eve", "filed STEP-9")).toBe("eve: filed STEP-9")
  })

  it("cuts on characters, never inside an emoji or a Danish letter", () => {
    expect(truncateChars("æøå".repeat(40), 10)).toBe("æøåæøåæ...")
    expect(truncateChars("🎉".repeat(20), 8)).toBe("🎉🎉🎉🎉🎉...")
    expect(truncateChars("short", 80)).toBe("short")
  })

  it("counts a flag, or a letter written with a combining mark, as one character", () => {
    expect(truncateChars("🇩🇰".repeat(10), 5)).toBe("🇩🇰🇩🇰...")
    expect(truncateChars("å".repeat(10), 5)).toBe("åå...")
  })
})

describe("intakeIssue", () => {
  const meta = { userName: "Nate", permalink: "https://step.slack.com/archives/CIN/p1727", botUserId: "UBOT", product: "polads" }

  it("uses the first line as the title and keeps the whole request, with who and where", () => {
    expect(intakeIssue("<@UBOT>  The notice page shows the wrong date\nSeen on test.polads.eu/da/notices/123", meta)).toEqual({
      title: "The notice page shows the wrong date",
      description:
        "The notice page shows the wrong date\nSeen on test.polads.eu/da/notices/123\n\n---\nFiled from Slack by Nate: https://step.slack.com/archives/CIN/p1727",
      labels: ["polads"],
      state: "Triage",
    })
  })

  it("files nothing for a bare mention", () => {
    expect(intakeIssue("<@UBOT>   ", meta)).toBeNull()
  })
})

describe("appendAnswer", () => {
  const answer = { ts: "1727.9", userName: "Nate", text: "Use the publication date", permalink: "https://s/p17279" }

  it("adds the heading once and one entry per Slack message, and a redelivery changes nothing", () => {
    const once = appendAnswer("## Goal\n\nFix it.", answer)
    expect(once).toBe(
      "## Goal\n\nFix it.\n\n## Answers from Slack\n\n<!-- slack:1727.9 -->\n**Nate** ([Slack](https://s/p17279)): Use the publication date",
    )
    expect(appendAnswer(once, answer)).toBe(once)
    const twice = appendAnswer(once, { ...answer, ts: "1728.1", text: "And the Danish label", permalink: null })
    expect(twice.match(/## Answers from Slack/g)).toHaveLength(1)
    expect(twice.endsWith("<!-- slack:1728.1 -->\n**Nate**: And the Danish label")).toBe(true)
  })
})

describe("answerTransition", () => {
  it("returns a parked, agent-ready issue to Ready and drops awaiting-answer", () => {
    expect(answerTransition({ state: "On hold", labels: ["agent-ready", "awaiting-answer", "polads"] })).toEqual({
      state: "Ready",
      removeLabels: ["awaiting-answer"],
    })
  })

  it("sends a parked issue that was never refined back to Refining", () => {
    expect(answerTransition({ state: "On hold", labels: ["polads"] })).toEqual({ state: "Refining" })
  })

  it("leaves an issue a worker is running alone", () => {
    expect(answerTransition({ state: "In Progress", labels: ["agent-ready"] })).toEqual({})
  })
})
