/**
 * Every Slack ask becomes one request item (spec 4 and 8): the coordinator
 * gives each open, parentless intake/slack issue its item on the Requests
 * board, whichever mini filed it. Made-up people and ids.
 */
import { rmSync } from "node:fs"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { issue } from "../../__tests__/fakes.ts"
import { readRecords } from "../store.ts"
import { doorsSetup, REQ, THREAD } from "./fake-monday.ts"

type Opts = Parameters<typeof doorsSetup>[1]
const setup = (seed: Parameters<typeof doorsSetup>[0] = [], opts: Opts = {}) => doorsSetup(seed, { ...opts, requests: true })

describe("a Slack ask gets its request item (spec 4 and 8)", () => {
  it("gives each open Slack request one item, with its Requester from the asker's Slack id", async () => {
    const { bridge, monday } = setup([issue({ id: "STEP-20", title: "Export notices as CSV", state: "Triage", labels: ["polads", "intake/slack"], description: "Words\n\n<!-- slack-user:UBEN -->" })], { extra: { "STEP-20": { slackThread: THREAD } } })
    await bridge.sync()
    const item = monday.item(/Export notices as CSV/)!
    expect(monday.boardOf(item.id)).toBe(REQ)
    expect(item.columns).toMatchObject({ r_linear: { text: "STEP-20" }, r_stage: { text: "New" }, r_thread: { text: "Slack thread" } })
    expect(JSON.parse(item.columns.r_person!.value!)).toEqual({ personsAndTeams: [{ id: 222, kind: "person" }] })
  })

  it("links the item from Linear and tells the thread once, on the poll after it is made", async () => {
    const { bridge, fake, slack, later } = setup([issue({ id: "STEP-20", title: "Export", state: "Triage", labels: ["intake/slack"] })], { extra: { "STEP-20": { slackThread: THREAD } } })
    await bridge.sync()
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(fake.calls.filter((c) => c.method === "attachLink" && c.args[2] === "Monday request")).toHaveLength(1)
    expect(slack().filter((m) => m.kind === "reply" && m.text.includes("Monday Requests board"))).toHaveLength(1)
  })

  it("adopts the item a crash left behind by its Linear link", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-20", title: "Export", state: "Triage", labels: ["intake/slack"] })])
    await bridge.sync()
    rmSync(join(paths.state, "monday"), { recursive: true, force: true })
    await bridge.sync()
    expect(monday.called("createItem").filter(([board]) => board === REQ)).toHaveLength(1)
    // Who asked is said once, on the item it made.
    expect(monday.called("postUpdate").filter(([, html]) => String(html).includes("asked for this in Slack"))).toHaveLength(1)
  })

  it("never adopts an issue filed from the board, a sub-issue, or a closed one", async () => {
    const { bridge, monday } = setup(
      [
        issue({ id: "STEP-21", state: "Triage", labels: ["intake/slack", "intake/monday"] }),
        issue({ id: "STEP-22", state: "Ready", labels: ["intake/slack"] }),
        issue({ id: "STEP-23", state: "Released", labels: ["intake/slack"] }),
      ],
      { parents: { "STEP-22": "STEP-10" } },
    )
    await bridge.sync()
    expect(monday.called("createItem").filter(([board]) => board === REQ)).toEqual([])
  })

  it("makes Nate's default person the Requester when the asker is not on the board, and says who asked once", async () => {
    const { bridge, monday, later, texts } = setup([issue({ id: "STEP-20", title: "Export", state: "Triage", labels: ["intake/slack"], description: "Ada wants a CSV export.\n\n<!-- slack-user:UZED -->" })])
    await bridge.sync()
    const item = monday.item(/Export/)!
    expect(JSON.parse(item.columns.r_person!.value!)).toEqual({ personsAndTeams: [{ id: 111, kind: "person" }] })
    later(2)
    await bridge.sync()
    expect(texts(item.id)).toEqual(["Eve: Someone asked for this in Slack: Ada wants a CSV export. I keep this item up to date from Linear."])
  })

  it("names the asker when the board knows them", async () => {
    const { bridge, monday, texts } = setup([issue({ id: "STEP-20", title: "Export", state: "Triage", labels: ["intake/slack"], description: "A CSV export, please.\n\n<!-- slack-user:UBEN -->" })])
    await bridge.sync()
    await bridge.sync()
    expect(texts(monday.item(/Export/)!.id)[0]).toBe("Eve: Ben asked for this in Slack: A CSV export, please. I keep this item up to date from Linear.")
  })

  it("tells no thread when the request has none, and still links the item from Linear", async () => {
    const { bridge, fake, slack, later } = setup([issue({ id: "STEP-20", title: "Export", state: "Triage", labels: ["intake/slack"] })])
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(fake.calls.filter((c) => c.method === "attachLink" && c.args[2] === "Monday request")).toHaveLength(1)
    expect(slack()).toEqual([])
  })

  it("keeps an item made from a board request out of Slack's announcing: it is linked when filed", async () => {
    const { bridge, monday, fake, later, paths } = setup()
    monday.request("111", "Export notices as CSV", undefined, "r_active", REQ)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(fake.calls.filter((c) => c.method === "attachLink").map((c) => c.args[2])).toEqual(["Monday request"])
    expect(readRecords(paths)[0].announced).not.toBe(false)
  })

  it("tries the announcement again next poll when Linear refuses the link", async () => {
    const { bridge, monday, fake, slack, later } = setup([issue({ id: "STEP-20", title: "Export", state: "Triage", labels: ["intake/slack"] })], { extra: { "STEP-20": { slackThread: THREAD } } })
    await bridge.sync()
    const attach = fake.tracker.attachLink
    fake.tracker.attachLink = async () => {
      throw new Error("Linear: 503")
    }
    // Its stage moves on meanwhile: a refused link holds nothing else up.
    fake.issues.set("STEP-20", { ...fake.issues.get("STEP-20")!, state: "Refining" })
    later(2)
    await bridge.sync()
    expect(slack().filter((m) => m.kind === "reply" && m.text.includes("Monday Requests board"))).toEqual([])
    expect(monday.item(/Export/)!.columns.r_stage?.text).toBe("Clarifying")
    fake.tracker.attachLink = attach
    later(2)
    await bridge.sync()
    expect(slack().filter((m) => m.kind === "reply" && m.text.includes("Monday Requests board"))).toHaveLength(1)
  })
})
