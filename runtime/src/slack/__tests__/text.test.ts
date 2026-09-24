import { describe, expect, it } from "vitest"
import { answerTransition, appendAnswer, fromSlack, intakeIssue, mentionedUsers, prefixed, stripMention, truncateChars } from "../text.ts"

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

describe("Slack markup", () => {
  const raw = "Fix &lt;title&gt; &amp; date on <https://test.polads.eu/da|the notice page>, ask <@UNATE> in <#C1|polads-intake> <!here>"

  it("reads as Markdown in a description, with mentions named", () => {
    expect(fromSlack(raw, { UNATE: "Nate" })).toBe("Fix <title> & date on [the notice page](https://test.polads.eu/da), ask @Nate in #polads-intake @here")
  })

  it("reads as plain text in a title", () => {
    expect(fromSlack(raw, { UNATE: "Nate" }, "plain")).toBe("Fix <title> & date on the notice page, ask @Nate in #polads-intake @here")
  })

  it("keeps a bare link, a legacy named mention, and an id it has no name for", () => {
    expect(fromSlack("<https://x.eu/a?b=1&amp;c=2> <@U1|eve> <@U9> <!subteam^S1|@devs>")).toBe("https://x.eu/a?b=1&c=2 @eve @U9 @devs")
  })

  it("lists the users a message mentions, in order, and strips this bot's mention in either form", () => {
    expect(mentionedUsers("<@UOTHER> and <@UBOT|eve>, not <#C1|x>")).toEqual(["UOTHER", "UBOT"])
    expect(stripMention("<@UBOT|eve> fix it, <@UBOT>", "UBOT")).toBe("fix it,")
  })
})

describe("intakeIssue", () => {
  const meta = { userName: "Nate", permalink: "https://step.slack.com/archives/CIN/p1727", botUserId: "UBOT", product: "polads" }

  it("files readable text: the title plain, the description Markdown, mentions named", () => {
    expect(
      intakeIssue("<@UBOT> The <https://test.polads.eu/da|notice page> shows &lt;none&gt;\nAs <@UKARL> saw", { ...meta, names: { UKARL: "Karl" } }),
    ).toMatchObject({
      title: "The notice page shows <none>",
      description: "The [notice page](https://test.polads.eu/da) shows <none>\nAs @Karl saw\n\n---\nFiled from Slack by Nate: https://step.slack.com/archives/CIN/p1727",
    })
  })

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

  it("still knows an answer by its Slack link when Linear has dropped the marker", () => {
    // Linear rebuilds a description from its own document model (plugin 1.1.1 met this with claim comments).
    const once = appendAnswer("## Goal\n\nFix it.", answer)
    const rebuilt = once.replace("<!-- slack:1727.9 -->\n", "")
    expect(appendAnswer(rebuilt, answer)).toBe(rebuilt)
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
