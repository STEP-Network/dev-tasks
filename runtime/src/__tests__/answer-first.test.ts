import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../config.ts"
import { answerCore, personKey, planTransition, recordAnswer, recordedAnswers } from "../answer.ts"
import { listNew } from "../fsq.ts"
import { appendAnswer, answerTransition } from "../slack/text.ts"
import { fakeTracker, issue } from "./fakes.ts"

const Q = "2026-09-25T10:00:00.000Z"
const config = ConfigSchema.parse({
  mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UADA", "UBEN"] },
  bridges: { monday: { people: [{ id: "111", name: "Ada", slackId: "UADA" }, { id: "222", name: "Ben" }], defaultPerson: "111" } },
})
function setup() {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-first-")))
  const fake = fakeTracker([issue({ id: "STEP-7", state: "On hold", labels: ["awaiting-answer", "polads"], description: "## Goal\n\nPick a date." })])
  return { paths, fake, deps: { paths, tracker: fake.tracker } }
}
const ada = { issue: "STEP-7", who: "Ada", ts: "1790000010.000100", permalink: null, source: "slack" as const, at: "2026-09-25T10:00:10.000Z", by: "monday:111" }
const ben = { issue: "STEP-7", who: "Ben", ts: "p90", permalink: null, source: "monday" as const, at: "2026-09-25T10:00:40.000Z", by: "monday:222" }

describe("answers keep their time and their person (spec 6)", () => {
  it("writes the time and the person into the answer's marker, and reads them back", () => {
    const d = appendAnswer("## Goal", { ts: "1790000010.000100", userName: "Ada", text: "use the order date", permalink: null, at: ada.at, by: ada.by })
    expect(d).toContain("<!-- slack:1790000010.000100 at=2026-09-25T10:00:10.000Z by=monday:111 -->")
    expect(recordedAnswers(d)).toEqual([{ source: "slack", id: "1790000010.000100", at: ada.at, by: "monday:111", who: "Ada", text: "use the order date", applied: true }])
  })

  it("still reads an answer recorded before markers had a time, and never records it twice", () => {
    const old = "## Goal\n\n## Answers from Monday\n\n<!-- monday:p1 -->\n**Ben**: fine"
    expect(recordedAnswers(old)).toEqual([{ source: "monday", id: "p1", at: null, by: null, who: "Ben", text: "fine", applied: true }])
    expect(appendAnswer(old, { ts: "p1", userName: "Ben", text: "fine", permalink: null, at: ben.at, by: ben.by }, "monday")).toBe(old)
  })

  it("keys a person the same from both doors when their Slack id is known", () => {
    expect(personKey(config, { slack: "UADA" })).toBe("monday:111")
    expect(personKey(config, { monday: "111" })).toBe("monday:111")
    expect(personKey(config, { slack: "UZED" })).toBe("slack:UZED")
  })

  it("compares what two answers decided, not how they said it", () => {
    expect(answerCore("Ada agreed with the recommendation: use the order date. (Their words: \"yes\")")).toBe(answerCore("Use the order date!"))
    expect(answerCore("Ben decided: publication date. (Their words: \"pub date pls\")")).not.toBe(answerCore("use the order date"))
  })
})

describe("the first answer counts (spec 6)", () => {
  it("records the first answer after the question and moves the issue", async () => {
    const { deps, fake } = setup()
    const r = await recordAnswer(deps, { ...ada, words: "use the order date" }, { since: Q })
    expect(r).toMatchObject({ outcome: "recorded", movedTo: "Refining" })
    expect(fake.issues.get("STEP-7")!.labels).not.toContain("awaiting-answer")
  })

  it("keeps a different second answer from another person on the issue, applies nothing, and says whose answer counts", async () => {
    const { deps, fake } = setup()
    await recordAnswer(deps, { ...ada, words: "use the order date" }, { since: Q })
    fake.issues.set("STEP-7", { ...fake.issues.get("STEP-7")!, state: "On hold", labels: ["awaiting-answer"] })
    const r = await recordAnswer(deps, { ...ben, words: "the publication date" }, { since: Q })
    expect(r).toMatchObject({ outcome: "second", movedTo: null, first: { who: "Ada", text: "use the order date" } })
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", labels: ["awaiting-answer"] })
    const answers = recordedAnswers(fake.issues.get("STEP-7")!.description)
    expect(answers.map((a) => [a.who, a.applied])).toEqual([["Ada", true], ["Ben", false]])
  })

  it("records the same answer from a second person once", async () => {
    const { deps, fake } = setup()
    await recordAnswer(deps, { ...ada, words: "use the order date" }, { since: Q })
    const before = fake.issues.get("STEP-7")!.description
    const r = await recordAnswer(deps, { ...ben, words: "yes", decided: { agreed: true, recommendation: "use the order date" } }, { since: Q })
    expect(r.outcome).toBe("same")
    expect(fake.issues.get("STEP-7")!.description).toBe(before)
  })

  it("takes a later answer from the same person as their correction, even after a second answer that was not applied", async () => {
    const { deps } = setup()
    await recordAnswer(deps, { ...ada, words: "use the order date" }, { since: Q })
    await recordAnswer(deps, { ...ben, words: "the publication date" }, { since: Q })
    const r = await recordAnswer(deps, { ...ada, ts: "1790000099.000100", at: "2026-09-25T10:05:00.000Z", words: "no, the publication date" }, { since: Q })
    expect(r.outcome).toBe("recorded")
  })

  it("does not count an answer from before the question as the first", async () => {
    const { deps, fake } = setup()
    await recordAnswer(deps, { ...ada, at: "2026-09-25T09:00:00.000Z", words: "old words" }, { since: null })
    fake.issues.set("STEP-7", { ...fake.issues.get("STEP-7")!, state: "On hold", labels: ["awaiting-answer"] })
    expect((await recordAnswer(deps, { ...ben, words: "the publication date" }, { since: Q })).outcome).toBe("recorded")
  })
})

describe("a Try plan is approved by the recorder alone (review, 2026-09-25)", () => {
  const plan = () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-plan-")))
    const fake = fakeTracker([issue({ id: "STEP-9", state: "On hold", labels: ["awaiting-answer", "plan-to-approve", "approval/try"] })])
    return { fake, deps: { paths, tracker: fake.tracker } }
  }

  it("a person's yes to the plan marks it approved", async () => {
    const { deps, fake } = plan()
    await recordAnswer(deps, { ...ada, issue: "STEP-9", words: "yes", decided: { agreed: true, recommendation: "Build it as planned" } }, { since: Q })
    expect(fake.issues.get("STEP-9")!.labels).toEqual(expect.arrayContaining(["plan-approved", "approval/try"]))
    expect(fake.issues.get("STEP-9")!.labels).not.toContain("plan-to-approve")
    // The detection layer (Task 0): every plan approval is announced, with who and where.
    expect(listNew<{ kind: string; channel: string; text: string }>(deps.paths.outbox).map((e) => e.payload)).toContainEqual(
      expect.objectContaining({ kind: "post", channel: "agents", text: expect.stringMatching(/^STEP-9's plan was approved by Ada in Slack \(.+\)\. If Ada did not do this, take plan-approved off in Linear\.$/) }),
    )
  })

  it("any other answer sends it back to be planned again, and approves nothing", async () => {
    const { deps, fake } = plan()
    await recordAnswer(deps, { ...ada, issue: "STEP-9", words: "make it two tasks" }, { since: Q })
    expect(fake.issues.get("STEP-9")!.labels).not.toContain("plan-to-approve")
    expect(fake.issues.get("STEP-9")!.labels).not.toContain("plan-approved")
    expect(listNew(deps.paths.outbox)).toEqual([])
  })

  it("reads a plan's answer: an agreement approves it, anything else only takes the question away, and no plan, no change", () => {
    expect(planTransition({ labels: ["plan-to-approve"] }, {})).toEqual({ removeLabels: ["plan-to-approve"] })
    expect(planTransition({ labels: ["approval/try"] }, { decided: { agreed: true, recommendation: "Build it as planned" } })).toEqual({})
  })
})

describe("an answer clears what asked for a person", () => {
  it("clears needs-human and awaiting-answer, and moves only a parked issue", () => {
    expect(answerTransition({ state: "In Progress", labels: ["needs-human"] })).toEqual({ removeLabels: ["needs-human"] })
    expect(answerTransition({ state: "On hold", labels: ["awaiting-answer", "needs-human"] })).toEqual({ state: "Refining", removeLabels: ["awaiting-answer", "needs-human"] })
    expect(answerTransition({ state: "Ready", labels: [] })).toEqual({})
  })
})
