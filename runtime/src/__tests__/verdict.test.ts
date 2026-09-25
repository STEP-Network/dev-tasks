import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../config.ts"
import { stableUuid } from "../monday/render.ts"
import { parseVerdict, recordVerdict, verdictReply } from "../verdict.ts"
import { fakeTracker, issue } from "./fakes.ts"

describe("parseVerdict", () => {
  it.each([
    ["PASS", false, { verdict: "pass", note: "" }],
    ["pass.", false, { verdict: "pass", note: "" }],
    ["Pass!", false, { verdict: "pass", note: "" }],
    ["pass: works on my phone", false, { verdict: "pass", note: "works on my phone" }],
    ["PASS, looks right on mobile too", false, { verdict: "pass", note: "looks right on mobile too" }],
    ["PASS - works", false, { verdict: "pass", note: "works" }],
    ["PASS — works", false, { verdict: "pass", note: "works" }],
    ["PASS\nworks on mobile", false, { verdict: "pass", note: "works on mobile" }],
    ["PASS 👍", false, { verdict: "pass", note: "" }],
    ["PASS 👍🏽 works on mobile", false, { verdict: "pass", note: "works on mobile" }],
    ["PASS ", false, { verdict: "pass", note: "" }],
    ["PASS\u00a0", false, { verdict: "pass", note: "" }],
    ["PASS\u00a0- works", false, { verdict: "pass", note: "works" }],
    ["PASS—works", false, { verdict: "pass", note: "works" }],
    ["FAIL", false, { verdict: "fail", note: "" }],
    ["FAIL: the date is wrong", false, { verdict: "fail", note: "the date is wrong" }],
    ["fail - the date is wrong", false, { verdict: "fail", note: "the date is wrong" }],
    ["yes", false, null],
    ["Looks good", true, { verdict: "pass", note: "" }],
    ["looks good to me", true, { verdict: "pass", note: "" }],
    ["Looks right.", true, { verdict: "pass", note: "" }],
    ["Looks good 👍", true, { verdict: "pass", note: "" }],
    ["looks good\u00a0✅", true, { verdict: "pass", note: "" }],
    ["change: the button should be blue", true, { verdict: "fail", note: "the button should be blue" }],
    ["Change : the button should be blue", true, { verdict: "fail", note: "the button should be blue" }],
    ["PASS", true, { verdict: "pass", note: "" }],
    ["yes", true, { verdict: "pass", note: "" }],
  ])("%s (Look: %s) is a verdict", (text, look, expected) => {
    expect(parseVerdict(text as string, look as boolean)).toEqual(expected)
  })

  // Review of #137: a question or a verb phrase is not a verdict, and a verdict word needs an end or a separator after it.
  it.each([
    ["pass me the link again?", false],
    ["Pass me the link", true],
    ["pass?", false],
    ["PASS? it looked fine to me", false],
    ["passing thoughts", false],
    ["PASS\u00a0works", false],
    ["Pass-through is fine", false],
    ["FAIL-the date is wrong", false],
    ["Fail-safe mode works", false],
    ["pass-rate looks ok", false],
    ["looks good-ish", true],
    ["fail to see why this matters", false],
    ["FAIL the date is wrong", false],
    ["fail?", true],
    ["change the button to blue", true],
    ["change", true],
    ["change: x", false],
    ["looks good?", true],
    ["it looks good to me", true],
    ["looks goodish", true],
  ])("%s (Look: %s) is not", (text, look) => {
    expect(parseVerdict(text as string, look as boolean)).toBeNull()
  })
})

describe("recordVerdict, from either door", () => {
  const setup = (state = "Waiting for UAT", labels = ["polads", "approval/look"]) => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-verdict-")))
    const fake = fakeTracker([issue({ id: "STEP-7", title: "Wider buttons", state, labels, priority: 2 })])
    const adopted: Array<[string, string, number]> = []
    const people = { adoptFix: async (c: string, p: string, n: number) => void adopted.push([c, p, n]), parentOf: async () => null }
    return { fake, adopted, deps: { paths, tracker: fake.tracker, people, product: "polads", now: () => new Date("2026-09-25T10:00:00Z") } }
  }

  it("approves on a pass from Slack, and names the person and the door", async () => {
    const { deps, fake } = setup()
    const out = await recordVerdict(deps, { issue: "STEP-7", who: "Ada", verdict: { verdict: "pass", note: "" }, where: "https://x.slack.com/archives/C1/p1", source: "slack", key: "C1:1790000000.000100" })
    expect(out).toEqual({ outcome: "passed" })
    expect(fake.issues.get("STEP-7")!.state).toBe("Approved")
    expect(fake.calls.find((c) => c.method === "comment")!.args[1]).toBe("UAT PASS from Ada in Slack (https://x.slack.com/archives/C1/p1).")
  })

  it("files one fix for a Look's change, named by the door and the message, and sends the change back", async () => {
    const { deps, fake, adopted } = setup()
    const v = { issue: "STEP-7", who: "Ben", verdict: { verdict: "fail" as const, note: "the button should be blue" }, where: "w", source: "slack" as const, key: "C1:1790000000.000200" }
    const out = await recordVerdict(deps, v)
    expect(out).toMatchObject({ outcome: "failed" })
    const created = fake.calls.find((c) => c.method === "createIssue")!.args[0] as { clientId: string; description: string }
    expect(created.clientId).toBe(stableUuid("slack-uat-fail:C1:1790000000.000200"))
    expect(created.description).toContain("> the button should be blue")
    expect(adopted).toHaveLength(1)
    expect(fake.issues.get("STEP-7")!.state).toBe("Needs Correction")
  })

  it("records nothing on an issue no longer waiting to be tried", async () => {
    const { deps, fake } = setup("Approved")
    expect(await recordVerdict(deps, { issue: "STEP-7", who: "Ada", verdict: { verdict: "fail", note: "x" }, where: "w", source: "monday", key: "p1" })).toEqual({ outcome: "not-waiting", state: "Approved" })
    expect(fake.calls.filter((c) => c.method !== "readIssue")).toEqual([])
  })

  it("names a Monday fix as it always was, so a retry across the upgrade files nothing twice", async () => {
    const { deps, fake } = setup()
    await recordVerdict(deps, { issue: "STEP-7", who: "Ada", verdict: { verdict: "fail", note: "" }, where: "https://m/p9", source: "monday", key: "u9001" })
    const created = fake.calls.find((c) => c.method === "createIssue")!.args[0] as { clientId: string; description: string }
    expect(created.clientId).toBe(stableUuid("monday-uat-fail:u9001"))
    expect(created.description).toContain("as they wrote it on the Monday board")
    expect(created.description).toContain("> (no details given)")
    expect(fake.calls.filter((c) => c.method === "comment").map((c) => c.args[1])).toEqual([expect.stringMatching(/^UAT FAIL from Ada on the Monday board \(https:\/\/m\/p9\)\. The fix is tracked in /)])
  })

  it("closes the loop after a fix passes: its parent goes back for review once no fix is open, and a failure there is only logged", async () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-verdict-")))
    const fake = fakeTracker([issue({ id: "STEP-8", title: "UAT fix: Wider buttons", state: "Waiting for UAT" }), issue({ id: "STEP-7", state: "Needs Correction" })])
    const warned: string[] = []
    const people = { adoptFix: async () => {}, parentOf: async () => ({ id: "STEP-7", state: "Needs Correction", openFixes: [] }) }
    const deps = { paths, tracker: fake.tracker, people, product: "polads", now: () => new Date("2026-09-25T10:00:00Z"), log: { warn: (m: string) => void warned.push(m) } }
    expect(await recordVerdict(deps, { issue: "STEP-8", who: "Ada", verdict: { verdict: "pass", note: "" }, where: "w", source: "slack", key: "C1:1" })).toEqual({ outcome: "passed" })
    expect(fake.issues.get("STEP-7")!.state).toBe("Agent UAT")
    expect(fake.calls.filter((c) => c.method === "comment").map((c) => c.args[1])).toContain("STEP-8 is fixed and approved (Ada, in Slack), so STEP-7 goes back for its review against its full acceptance criteria.")
    fake.issues.set("STEP-8", { ...fake.issues.get("STEP-8")!, state: "Waiting for UAT" })
    const broken = { ...deps, people: { ...people, parentOf: async () => { throw new Error("Linear down") } } }
    expect(await recordVerdict(broken, { issue: "STEP-8", who: "Ada", verdict: { verdict: "pass", note: "" }, where: "w", source: "slack", key: "C1:2" })).toEqual({ outcome: "passed" })
    expect(warned).toEqual(["slack closing the loop failed after the words were recorded"])
  })

  it("answers in the words the Monday board always used", () => {
    expect(verdictReply("Ada", { outcome: "passed" })).toBe("Thanks, Ada. I marked it as approved, so it goes out with the next release. Nothing needed from you.")
    expect(verdictReply("Ada", { outcome: "failed", fix: "STEP-9" })).toBe("Thanks, Ada. I wrote down what you saw as STEP-9, and the change goes back to be fixed. Nothing needed from you.")
    expect(verdictReply("Ada", { outcome: "not-waiting", state: "Approved" })).toBe("This change is no longer waiting for a test, so I did not record your verdict. Nothing needed from you.")
  })
})
