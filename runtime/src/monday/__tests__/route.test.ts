/**
 * routeWords, the one place Monday words go (STEP-3289), recording answers
 * through the recorder Slack uses too (answer.ts, STEP-3293 re-review).
 */

import { mkdirSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { answerText } from "../../answer.ts"
import { agentPaths } from "../../config.ts"
import { enqueueSlack } from "../../outbox.ts"
import { withRecommendation } from "../../plain.ts"
import { saveThread, threadFor } from "../../threads.ts"
import { recordPr } from "../../jobs.ts"
import { readLessons } from "../../retro/lessons.ts"
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import { routeWords } from "../route.ts"

const NOW = new Date("2026-09-25T10:00:00.000Z")
const QUESTION = withRecommendation("Which date goes on the notice?", "use the publication date")

function setup(labels = ["agent-ready", "awaiting-answer", "polads"]) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-route-")))
  mkdirSync(paths.state, { recursive: true })
  const fake = fakeTracker([issue({ id: "STEP-7", state: "On hold", labels, description: "Brief" })])
  const say = (text: string, id = "U1", at: string | null = NOW.toISOString()) =>
    routeWords({ paths, tracker: fake.tracker, mini: "eve" }, { issue: "STEP-7", request: false, itemId: "I1", who: { id: "M1", name: "Nate" }, words: { id, text, updateId: id, threadId: null, permalink: null, at }, now: NOW })
  return { paths, fake, say }
}

describe("routeWords: answers on the Monday board (STEP-3293 re-review)", () => {
  it("records a plain yes to a question that recommended something as that recommendation, never a bare yes, as Slack does", async () => {
    // The reviewer's proof, turned round: the board showed the Slack question with its recommendation, and "Nate: yes" was all the issue kept.
    const { paths, fake, say } = setup()
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: QUESTION, question: true }, NOW)
    expect(await say("yes")).toEqual({ to: "issue", movedTo: "Ready" })
    const description = fake.issues.get("STEP-7")!.description
    const recorded = answerText({ who: "Nate", words: "yes", decided: { agreed: true, recommendation: "use the publication date" } })
    expect(recorded).toBe('Nate agreed with the recommendation: use the publication date. (Their words: "yes")')
    expect(description).toMatch(/## Answers from Monday[\s\S]*\*\*Nate\*\*: Nate agreed with the recommendation: use the publication date\. \(Their words: "yes"\)$/)
    expect(description).not.toMatch(/\*\*Nate\*\*: yes$/m)
  })

  it("keeps any other words as they are, and a yes to a question with no recommendation as their words", async () => {
    const worded = setup()
    enqueueSlack(worded.paths, { kind: "issue", issue: "STEP-7", text: QUESTION, question: true }, NOW)
    await worded.say("no, the signing date")
    expect(worded.fake.issues.get("STEP-7")!.description).toMatch(/\*\*Nate\*\*: no, the signing date$/)
    const plain = setup()
    enqueueSlack(plain.paths, { kind: "issue", issue: "STEP-7", text: "Which date goes on the notice?", question: true }, NOW)
    await plain.say("yes")
    expect(plain.fake.issues.get("STEP-7")!.description).toMatch(/\*\*Nate\*\*: yes$/)
  })

  it("leaves no question open in the issue's Slack thread once it is answered on the board: one conversation, answered in either place", async () => {
    const { paths, say } = setup()
    saveThread(paths, { issue: "STEP-7", channelId: "CQ", ts: "1700.1", permalink: null, createdAt: NOW.toISOString(), lastQuestionAt: NOW.toISOString(), lastQuestion: QUESTION, openQuestions: 2 })
    await say("use the publication date, and leave the footer")
    expect(threadFor(paths, "STEP-7")?.openQuestions).toBe(0)
  })

  it("keeps a \"no, do X\" as one lesson for the weekly retro, answer or instruction, however often the board shows it (STEP-3290)", async () => {
    const { paths, say } = setup()
    await say("no, use the signing date, not the publication date", "U1")
    await say("no, use the signing date, not the publication date", "U1")
    await say("use the publication date", "U2")
    // With a PR of this mini's, "don't merge" words are an instruction: still one lesson.
    recordPr(paths, { issue: "STEP-7", url: "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679", openedAt: NOW.toISOString() })
    await say("don't merge it, fix the test first", "U3")
    expect(readLessons(paths)).toEqual([
      expect.objectContaining({ mini: "eve", category: "correction", source: "monday", issue: "STEP-7", who: "Nate", text: "no, use the signing date, not the publication date", key: "correction:monday:U1" }),
      expect.objectContaining({ category: "correction", source: "monday", text: "don't merge it, fix the test first", key: "correction:monday:U3" }),
    ])
  })

  it("never takes words written before this mini's newest question as an answer to it, the rule Slack uses too (STEP-3293 final pass)", async () => {
    // The reviewer's race, turned round: 09:10 Nate writes "yes" on the item, which shows the publication date.
    // 09:12 the front door answers his Slack "why?" with a new recommendation. 09:15 the poll routes his 09:10 words.
    const { paths, fake, say } = setup()
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: QUESTION, question: true }, new Date("2026-09-25T09:00:00.000Z"))
    const newer = withRecommendation("Given the legal rule, which date?", "use the submission date")
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: newer, question: true }, new Date("2026-09-25T09:12:00.000Z"))
    expect(await say("yes", "U1", "2026-09-25T09:10:00.000Z")).toEqual({ to: "newer-question", question: newer })
    // No agreement, nothing recorded for a bare yes, and the issue waits for the newer answer.
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", description: "Brief" })
    // Words that say something stay on the issue, and still move nothing.
    expect(await say("the publication date, whatever the rule says", "U2", "2026-09-25T09:11:00.000Z")).toEqual({ to: "newer-question", question: newer })
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", description: expect.stringMatching(/\*\*Nate\*\*: the publication date, whatever the rule says$/) })
    expect(fake.issues.get("STEP-7")!.description).not.toContain("agreed with the recommendation")
    // Written after it, a yes agrees to the newer one.
    expect(await say("yes", "U3", "2026-09-25T09:14:00.000Z")).toEqual({ to: "issue", movedTo: "Ready" })
    expect(fake.issues.get("STEP-7")!.description).toContain("Nate agreed with the recommendation: use the submission date.")
  })

  it("never turns a yes on a person's to-do into agreement: it means they will do it", async () => {
    const { paths, fake, say } = setup(["polads", "human-todo"])
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: QUESTION, question: true }, NOW)
    await say("yes")
    expect(fake.issues.get("STEP-7")!.description).toMatch(/\*\*Nate\*\*: yes$/)
    expect(fake.issues.get("STEP-7")!.description).not.toContain("agreed with the recommendation")
  })
})
