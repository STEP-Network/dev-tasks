import { describe, expect, it } from "vitest"
import { answerEntries, keepAnswers } from "../answers.ts"

const ADA = "<!-- slack:1790000010.000100 at=2026-09-25T10:00:10.000Z by=monday:111 -->\n**Ada**: use the order date"
const BEN = "<!-- monday:p90 at=2026-09-25T10:00:40.000Z by=monday:222 -->\n**Ben**: the publication date"
const current = `## Goal\n\nPick a date.\n\n## Answers from Slack\n\n${ADA}`

describe("the recorder's answer entries survive any other edit (review, 2026-09-25)", () => {
  it("reads each entry with its source, time and person", () => {
    expect(answerEntries(current)).toEqual([expect.objectContaining({ source: "slack", id: "1790000010.000100", by: "monday:111", who: "Ada", text: "use the order date", heading: "## Answers from Slack" })])
  })

  it("lets an edit through that keeps every entry as it was", () => {
    expect(keepAnswers(current, current.replace("Pick a date.", "Pick the notice's date."))).toEqual({ description: current.replace("Pick a date.", "Pick the notice's date.") })
  })

  it("refuses an edit that adds an entry, or changes one", () => {
    expect(keepAnswers(current, `${current}\n\n## Answers from Monday\n\n${BEN}`)).toMatchObject({ refused: expect.stringMatching(/answer recorder/) })
    expect(keepAnswers(current, current.replace("use the order date", "use the publication date"))).toMatchObject({ refused: expect.stringMatching(/answer recorder/) })
    expect(keepAnswers(current, current.replace("by=monday:111", "by=monday:222"))).toMatchObject({ refused: expect.stringMatching(/answer recorder/) })
  })

  it("puts back an entry an edit leaves out under its own heading, never under the last one", () => {
    expect(keepAnswers(current, "## Goal\n\nA shorter brief.")).toEqual({ description: `## Goal\n\nA shorter brief.\n\n## Answers from Slack\n\n${ADA}` })
    const planned = `${current}\n\n## Plan\n\nShip it.`
    expect(keepAnswers(planned, "## Goal\n\nA shorter brief.\n\n## Answers from Slack\n\n## Plan\n\nShip it.")).toEqual({
      description: `## Goal\n\nA shorter brief.\n\n## Answers from Slack\n\n${ADA}\n\n## Plan\n\nShip it.`,
    })
  })

  it("reads a bare marker as an entry, so an edit can neither add one nor drop one", () => {
    const bare = `${current}\n\n## Answers from Monday\n\n<!-- monday:p91 -->`
    expect(answerEntries(bare).map((e) => [e.source, e.id, e.who])).toEqual([["slack", "1790000010.000100", "Ada"], ["monday", "p91", null]])
    expect(keepAnswers(current, bare)).toMatchObject({ refused: expect.stringMatching(/adds one \(monday:p91\)/) })
    expect(keepAnswers(current, `${current}\n<!-- monday:p92 -->\nwords after it`)).toMatchObject({ refused: expect.stringMatching(/adds one \(monday:p92\)/) })
    expect(keepAnswers(bare, current)).toEqual({ description: bare })
  })

  it("keeps the asker's marker as the recorder wrote it, so the Requester cannot change", () => {
    const asked = `Export notices\n<!-- slack-user:UADA -->\n\n## Answers from Slack\n\n${ADA}`
    expect(keepAnswers(asked, asked.replace("UADA", "UBEN"))).toMatchObject({ refused: expect.stringMatching(/answer recorder/) })
    expect(keepAnswers(`Export notices\n\n## Answers from Slack\n\n${ADA}`, asked)).toMatchObject({ refused: expect.stringMatching(/adds one \(slack-user:UADA\)/) })
    // Put back before the first heading, where slackAskerOf (Task 8) reads it.
    expect(keepAnswers(asked, `Export notices\n\n## Answers from Slack\n\n${ADA}`)).toEqual({ description: `Export notices\n\n<!-- slack-user:UADA -->\n\n## Answers from Slack\n\n${ADA}` })
  })
})
