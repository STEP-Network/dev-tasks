/**
 * A person's class change (spec 3, D1): a lowering goes through the answer
 * recorder's own Linear account, a raise through the agent's own tracker.
 * Made-up people and ids.
 */
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { changeClass, NeedsRecorder, recorderFor } from "../lower.ts"
import { fakePeople } from "../monday/__tests__/fake-monday.ts"
import { recorderSecretsPath } from "../secrets.ts"
import { fakeTracker, issue } from "./fakes.ts"

const LABELS = {
  issueLabels: {
    nodes: [
      { id: "l-auto", name: "approval/auto", team: { key: "STEP" } },
      { id: "l-look", name: "approval/look", team: { key: "STEP" } },
      { id: "l-try", name: "approval/try", team: { key: "STEP" } },
      // Another team's label of the same name is never the one written.
      { id: "l-other-look", name: "approval/look", team: { key: "OPS" } },
    ],
  },
}

function setup(labels = ["approval/try"], tasks: Array<{ labels: string[]; state?: string }> = [{ labels }, { labels, state: "Released" }]) {
  const fake = fakeTracker([
    issue({ id: "STEP-10", uuid: "u10", state: "In Progress", labels }),
    ...tasks.map((t, n) => issue({ id: `STEP-${11 + n}`, uuid: `u${11 + n}`, state: t.state ?? "Ready", labels: t.labels })),
  ])
  const { people } = fakePeople(fake.issues, {}, Object.fromEntries(tasks.map((_, n) => [`STEP-${11 + n}`, "STEP-10"])))
  const sent: Array<{ query: string; vars: Record<string, any> }> = []
  const transport = async <T,>(query: string, vars: Record<string, unknown> = {}): Promise<T> => {
    sent.push({ query, vars: vars as Record<string, any> })
    return (query.includes("issueLabels") ? LABELS : { issueUpdate: { success: true }, commentCreate: { success: true } }) as T
  }
  return { fake, people, sent, recorder: () => transport }
}
/** A raise never asks for the recorder's key. */
const untouched = () => {
  throw new Error("the recorder's key was read")
}
const toLook = { issue: "STEP-10", to: "look" as const, who: "Ada", where: "https://step.monday.com/boards/777/pulses/5", via: "on Monday" as const }
const updates = (sent: ReturnType<typeof setup>["sent"]) => sent.filter((s) => s.query.includes("issueUpdate")).map((s) => [s.vars.id, s.vars.input])

describe("a person's class change (D1)", () => {
  it("lowers the anchor and its open tasks with the recorder's key, and says on the anchor who asked", async () => {
    const { fake, people, sent, recorder } = setup()
    expect(await changeClass({ tracker: fake.tracker, recorder, people }, toLook)).toEqual({ outcome: "lowered", issues: ["STEP-11", "STEP-10"], from: "try" })
    // The tasks first and the anchor last, so a failure half-way is finished by the next try: the anchor still asks for it.
    expect(updates(sent)).toEqual([
      ["u11", { addedLabelIds: ["l-look"], removedLabelIds: ["l-auto", "l-try"] }],
      ["u10", { addedLabelIds: ["l-look"], removedLabelIds: ["l-auto", "l-try"] }],
    ])
    expect(sent.find((s) => s.query.includes("commentCreate"))?.vars.input).toEqual({
      issueId: "u10",
      body: "Class lowered from Try to Look by Ada on Monday, as they asked (https://step.monday.com/boards/777/pulses/5).",
    })
    // Nothing of a lowering goes through the agent's own account.
    expect(fake.calls.filter((c) => c.method === "updateIssue" || c.method === "comment")).toEqual([])
  })

  it("never raises a task on a lowering, and leaves a closed one alone", async () => {
    const { fake, people, sent, recorder } = setup(["approval/try"], [{ labels: ["approval/auto"] }, { labels: [] }, { labels: ["approval/try"], state: "Canceled" }])
    expect(await changeClass({ tracker: fake.tracker, recorder, people }, toLook)).toMatchObject({ outcome: "lowered", issues: ["STEP-10"] })
    expect(updates(sent).map(([id]) => id)).toEqual(["u10"])
  })

  it("raises through the agent's own tracker, never the recorder, and never lowers a task", async () => {
    const { fake, people, sent } = setup(["approval/auto"], [{ labels: ["approval/auto"] }, { labels: [] }, { labels: ["approval/try"] }])
    expect(await changeClass({ tracker: fake.tracker, recorder: untouched, people }, toLook)).toEqual({ outcome: "raised", issues: ["STEP-11", "STEP-12", "STEP-10"], from: "auto" })
    expect(sent).toEqual([])
    expect(fake.issues.get("STEP-10")!.labels).toEqual(["approval/look"])
    expect(fake.issues.get("STEP-12")!.labels).toEqual(["approval/look"])
    expect(fake.issues.get("STEP-13")!.labels).toEqual(["approval/try"])
  })

  it("sets a class where there was none through the agent's own tracker, as a raise", async () => {
    const { fake, people, sent } = setup([], [])
    expect(await changeClass({ tracker: fake.tracker, recorder: untouched, people }, toLook)).toEqual({ outcome: "raised", issues: ["STEP-10"], from: null })
    expect(sent).toEqual([])
    expect(fake.issues.get("STEP-10")!.labels).toEqual(["approval/look"])
  })

  it("refuses a lowering with no recorder key, so lowering stays in Linear, and changes nothing", async () => {
    const { fake, people } = setup()
    await expect(changeClass({ tracker: fake.tracker, recorder: () => null, people }, toLook)).rejects.toBeInstanceOf(NeedsRecorder)
    expect(fake.calls.filter((c) => c.method === "updateIssue")).toEqual([])
  })

  it("changes nothing when the class is already that", async () => {
    const { fake, people, sent } = setup(["approval/look"])
    expect(await changeClass({ tracker: fake.tracker, recorder: untouched, people }, toLook)).toEqual({ outcome: "same", issues: [], from: "look" })
    expect(sent).toEqual([])
  })

  it("stops, and says nothing on the issue, when Linear has no label for the class", async () => {
    const { fake, people, sent } = setup()
    const bare = async <T,>(query: string, vars: Record<string, unknown> = {}): Promise<T> => {
      sent.push({ query, vars: vars as Record<string, any> })
      return { issueLabels: { nodes: [] } } as T
    }
    await expect(changeClass({ tracker: fake.tracker, recorder: () => bare, people }, toLook)).rejects.toThrow("Linear has no label approval/look")
    expect(sent.filter((s) => !s.query.includes("issueLabels"))).toEqual([])
  })

  it("stops when Linear does not take a label change, before it says one happened", async () => {
    const { fake, people, sent } = setup()
    const refusing = async <T,>(query: string, vars: Record<string, unknown> = {}): Promise<T> => {
      sent.push({ query, vars: vars as Record<string, any> })
      return (query.includes("issueLabels") ? LABELS : { issueUpdate: { success: false } }) as T
    }
    await expect(changeClass({ tracker: fake.tracker, recorder: () => refusing, people }, toLook)).rejects.toThrow("Linear did not change STEP-11's class")
    expect(sent.filter((s) => s.query.includes("commentCreate"))).toEqual([])
  })
})

describe("recorderFor: the recorder's key, only from its own file (D1)", () => {
  const home = () => mkdtempSync(join(tmpdir(), "recorder-"))
  const write = (h: string, text: string, mode: number) => {
    mkdirSync(dirname(recorderSecretsPath(h)), { recursive: true })
    writeFileSync(recorderSecretsPath(h), text)
    chmodSync(recorderSecretsPath(h), mode)
  }

  it("is null without the file, so a lowering stays in Linear", () => {
    expect(recorderFor(home())).toBeNull()
  })

  it("refuses the file while other users can read it", () => {
    const h = home()
    write(h, "RECORDER_LINEAR_KEY=lin_api_recorder\n", 0o644)
    expect(() => recorderFor(h)).toThrow(/chmod 600/)
    chmodSync(recorderSecretsPath(h), 0o600)
    expect(recorderFor(h)).toEqual(expect.any(Function))
  })
})
