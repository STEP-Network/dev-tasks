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
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import { routeWords } from "../route.ts"

const NOW = new Date("2026-09-25T10:00:00.000Z")
const QUESTION = withRecommendation("Which date goes on the notice?", "use the publication date")

function setup(labels = ["agent-ready", "awaiting-answer", "polads"]) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-route-")))
  mkdirSync(paths.state, { recursive: true })
  const fake = fakeTracker([issue({ id: "STEP-7", state: "On hold", labels, description: "Brief" })])
  const say = (text: string, id = "U1") =>
    routeWords({ paths, tracker: fake.tracker }, { issue: "STEP-7", request: false, itemId: "I1", who: { id: "M1", name: "Nate" }, words: { id, text, updateId: id, threadId: null, permalink: null }, now: NOW })
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

  it("never turns a yes on a person's to-do into agreement: it means they will do it", async () => {
    const { paths, fake, say } = setup(["polads", "human-todo"])
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: QUESTION, question: true }, NOW)
    await say("yes")
    expect(fake.issues.get("STEP-7")!.description).toMatch(/\*\*Nate\*\*: yes$/)
    expect(fake.issues.get("STEP-7")!.description).not.toContain("agreed with the recommendation")
  })
})
