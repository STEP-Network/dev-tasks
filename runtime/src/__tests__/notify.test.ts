import { existsSync, mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../config.ts"
import { listNew } from "../fsq.ts"
import { moveJob, submitJob } from "../jobs.ts"
import { blockedPing, digestDue, digestText, dueSoon, flushPings, mentionsFor, ping, slackSafe, workingHours } from "../notify.ts"
import type { OutboxMessage } from "../outbox.ts"

const TZ = "Europe/Copenhagen"
const config = ConfigSchema.parse({ mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UADA", "UBEN", "UCY"] } })

describe("digestDue (D5)", () => {
  const DAYS = { at: "08:00", days: [1, 2, 3, 4, 5], skipDates: ["2026-12-24"] }
  it.each([
    ["Friday 08:00 in Copenhagen", "2026-09-25T06:00:00.000Z", null, "2026-09-25"],
    ["a minute early", "2026-09-25T05:59:00.000Z", null, null],
    ["late, before noon", "2026-09-25T09:59:00.000Z", null, "2026-09-25"],
    ["noon, too late for today", "2026-09-25T10:00:00.000Z", null, null],
    ["a Saturday", "2026-09-26T06:00:00.000Z", null, null],
    ["a day off", "2026-12-24T07:00:00.000Z", null, null],
    ["posted already today", "2026-09-25T06:30:00.000Z", "2026-09-25", null],
    ["08:00 after the clocks went back", "2026-10-26T07:00:00.000Z", "2026-10-23", "2026-10-26"],
    ["07:30 after the clocks went back", "2026-10-26T06:30:00.000Z", "2026-10-23", null],
  ])("%s", (_, at, posted, expected) => {
    expect(digestDue(new Date(at), TZ, DAYS, posted)).toBe(expected)
  })
})

describe("digestText", () => {
  const group = (title: string, one: string, many: string, n: number) => ({ title, one, many, items: Array.from({ length: n }, (_, i) => ({ name: `${title} ${i + 1}`, url: `https://m.example.test/${title.length}/${i}` })) })

  it("counts each group, links its items, and ends with the requests", () => {
    const text = digestText([group("Decide", "decision", "decisions", 2), group("Approve plan", "plan to approve", "plans to approve", 1), group("Looks good?", "look", "looks", 0)], { requests: { active: 5, readyToTest: 2 } })
    expect(text).toBe(
      [
        "Good morning. Waiting for you: 2 decisions and 1 plan to approve.",
        "Decide: <https://m.example.test/6/0|Decide 1>, <https://m.example.test/6/1|Decide 2>",
        "Approve plan: <https://m.example.test/12/0|Approve plan 1>",
        "Requests: 5 active, 2 ready to test.",
      ].join("\n"),
    )
  })

  it("links five items a group at most, and says how many more", () => {
    expect(digestText([group("Decide", "decision", "decisions", 7)], {})).toContain(", and 2 more")
  })

  it("shows Wave 3's test-day line in place of a count", () => {
    const text = digestText([{ ...group("Test day", "change to try", "changes to try", 3), testDay: true }], { testDay: "Test day in progress (14 of 20 checked)." })
    expect(text).toBe("Good morning.\nTest day in progress (14 of 20 checked).")
  })

  it("says so when nothing waits, so a silent morning means the coordinator is down", () => {
    expect(digestText([group("Decide", "decision", "decisions", 0)], {})).toBe("Good morning. Nothing needs you this morning.")
  })

  it("never lets an item's name mention anyone or break its link", () => {
    expect(slackSafe("Ping <!channel> & <@U1>|x")).toBe("Ping &lt;!channel&gt; &amp; &lt;@U1&gt;x")
    expect(digestText([{ title: "Decide", one: "decision", many: "decisions", items: [{ name: "<!here> now", url: "https://m.example.test/1" }] }], {})).not.toMatch(/<!here>/)
  })
})

describe("ping", () => {
  const paths = () => agentPaths(mkdtempSync(join(tmpdir(), "agentd-ping-")))
  /** 10:00 in Copenhagen. */
  const DAY = new Date("2026-09-25T08:00:00.000Z")

  it("never @-mentions anyone at night: the ping waits, once, and goes at 08:00", () => {
    const p = paths()
    // Thursday night, and Friday morning.
    const night = new Date("2026-09-24T20:00:00.000Z")
    expect(ping(p, config, { key: "blocked:job-3", issue: "STEP-7", reason: "blocked", text: "STEP-7 is blocked." }, night)).toBe(true)
    expect(ping(p, config, { key: "blocked:job-3", issue: "STEP-7", reason: "blocked", text: "again" }, night)).toBe(false)
    expect(listNew<OutboxMessage>(p.outbox)).toEqual([])
    expect(flushPings(p, config, new Date("2026-09-25T05:59:00.000Z"))).toBe(0)
    expect(listNew<OutboxMessage>(p.outbox)).toEqual([])
    expect(flushPings(p, config, new Date("2026-09-25T06:00:00.000Z"))).toBe(1)
    expect(flushPings(p, config, new Date("2026-09-25T06:01:00.000Z"))).toBe(0)
    expect(listNew<OutboxMessage>(p.outbox).map((e) => e.payload)).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-7", text: "<@UADA> <@UBEN> <@UCY> STEP-7 is blocked." })])
  })

  it("sends the night's pings as one call to the people, and each in its thread without a mention, in the order they came", () => {
    const p = paths()
    // Their keys sort the other way round: the time decides.
    ping(p, config, { key: "a-late", issue: "STEP-2", reason: "blocked", text: "STEP-2 is blocked." }, new Date("2026-09-24T21:00:00.000Z"))
    ping(p, config, { key: "z-early", issue: "STEP-1", reason: "blocked", text: "STEP-1 is blocked." }, new Date("2026-09-24T20:00:00.000Z"))
    ping(p, config, { key: "m-mid", issue: "STEP-3", reason: "blocked", text: "STEP-3 is blocked." }, new Date("2026-09-24T20:30:00.000Z"))
    expect(flushPings(p, config, new Date("2026-09-25T06:00:00.000Z"))).toBe(3)
    const sent = listNew<OutboxMessage & { text: string }>(p.outbox).map((e) => e.payload)
    expect(sent.filter((m) => m.kind === "issue").map((m) => m.text)).toEqual(["STEP-1 is blocked.", "STEP-3 is blocked.", "STEP-2 is blocked."])
    expect(sent.filter((m) => m.text.includes("<@"))).toEqual([
      expect.objectContaining({ kind: "post", channel: "questions", text: "<@UADA> <@UBEN> <@UCY> 3 things needed you while it was quiet, each in its own thread:\n- STEP-1 is blocked.\n- STEP-3 is blocked.\n- STEP-2 is blocked." }),
    ])
  })

  it("calls only the one person a night of pings was for", () => {
    const p = paths()
    ping(p, config, { key: "one", issue: "STEP-1", reason: "blocked", text: "first", person: "UBEN" }, new Date("2026-09-24T20:00:00.000Z"))
    ping(p, config, { key: "two", issue: "STEP-2", reason: "blocked", text: "second", person: "UBEN" }, new Date("2026-09-24T21:00:00.000Z"))
    flushPings(p, config, new Date("2026-09-25T06:00:00.000Z"))
    expect(listNew<OutboxMessage & { text: string }>(p.outbox).map((e) => e.payload.text).filter((t) => t.includes("<@"))).toEqual([expect.stringMatching(/^<@UBEN> 2 things/)])
  })

  it("drops a held blocked ping when its job is no longer the issue's latest: retried in the night", () => {
    const p = paths()
    const first = submitJob(p, "STEP-7", null, new Date("2026-09-24T20:00:00.000Z"))
    moveJob(p, first.id, "pending", "done", {})
    ping(p, config, blockedPing(first.id, "STEP-7", "my run stopped unexpectedly"), new Date("2026-09-24T20:05:00.000Z"))
    submitJob(p, "STEP-7", null, new Date("2026-09-24T22:00:00.000Z"))
    expect(flushPings(p, config, new Date("2026-09-25T06:00:00.000Z"))).toBe(0)
    expect(listNew(p.outbox)).toEqual([])
  })

  it("sends a held blocked ping whose job is still the issue's latest", () => {
    const p = paths()
    const only = submitJob(p, "STEP-7", null, new Date("2026-09-24T20:00:00.000Z"))
    moveJob(p, only.id, "pending", "done", {})
    ping(p, config, blockedPing(only.id, "STEP-7", "my run stopped unexpectedly"), new Date("2026-09-24T20:05:00.000Z"))
    expect(flushPings(p, config, new Date("2026-09-25T06:00:00.000Z"))).toBe(1)
  })

  it("keeps weekends quiet until Monday 08:00, but asks at once about money or legal due", () => {
    const p = paths()
    const saturday10 = new Date("2026-09-26T08:00:00.000Z")
    ping(p, config, { key: "blocked:job-5", issue: "STEP-5", reason: "blocked", text: "STEP-5 is blocked." }, saturday10)
    ping(p, config, { key: "money-legal:STEP-6:2026-09-27", issue: "STEP-6", reason: "money-legal-due", text: "STEP-6 needs an answer by 2026-09-27." }, saturday10)
    expect(listNew<OutboxMessage & { text: string }>(p.outbox).map((e) => e.payload.text)).toEqual([expect.stringContaining("STEP-6 needs an answer")])
    expect(flushPings(p, config, new Date("2026-09-27T09:00:00.000Z"))).toBe(0)
    expect(flushPings(p, config, new Date("2026-09-28T06:00:00.000Z"))).toBe(1)
  })

  it("forgets a ping sent more than 14 days ago, and keeps a newer one", () => {
    const p = paths()
    ping(p, config, { key: "old", issue: "STEP-1", reason: "blocked", text: "old" }, new Date("2026-09-10T08:00:00.000Z"))
    // Sent on a Friday, 13 days and 23 hours before.
    ping(p, config, { key: "new", issue: "STEP-2", reason: "blocked", text: "new" }, new Date("2026-09-11T09:00:00.000Z"))
    flushPings(p, config, new Date("2026-09-25T08:00:00.000Z"))
    expect([existsSync(join(p.state, "pings", "old.json")), existsSync(join(p.state, "pings", "new.json"))]).toEqual([false, true])
  })

  it("pings once per key, in the issue's thread, @-mentioning the person", () => {
    const p = paths()
    const at = new Date("2026-09-25T08:00:00.000Z")
    expect(ping(p, config, { key: "money-legal:STEP-7:2026-09-26", issue: "STEP-7", reason: "money-legal-due", text: "STEP-7 needs an answer by 2026-09-26.", person: "UBEN" }, at)).toBe(true)
    expect(ping(p, config, { key: "money-legal:STEP-7:2026-09-26", issue: "STEP-7", reason: "money-legal-due", text: "again", person: "UBEN" }, at)).toBe(false)
    expect(listNew<OutboxMessage>(p.outbox).map((e) => e.payload)).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-7", question: false, text: "<@UBEN> STEP-7 needs an answer by 2026-09-26." })])
  })

  it("lets no reason reach anyone but the people it mentions", () => {
    const p = paths()
    ping(p, config, { key: "blocked:job-2", issue: "STEP-9", reason: "blocked", text: "STEP-9 is blocked: <!channel> read this." }, DAY)
    expect(listNew<OutboxMessage>(p.outbox)[0].payload).toMatchObject({ text: "<@UADA> <@UBEN> <@UCY> STEP-9 is blocked: &lt;!channel&gt; read this." })
  })

  it("mentions all three when the person is not known, and posts in another mini's thread when given", () => {
    expect(mentionsFor(config, null)).toBe("<@UADA> <@UBEN> <@UCY>")
    expect(mentionsFor(config, "UZED")).toBe("<@UADA> <@UBEN> <@UCY>")
    const p = paths()
    ping(p, config, { key: "blocked:job-1", issue: "STEP-8", reason: "blocked", text: "STEP-8 is blocked.", thread: { channelId: "CQ", threadTs: "1790000000.000100" } }, DAY)
    expect(listNew<OutboxMessage>(p.outbox)[0].payload).toMatchObject({ kind: "reply", channelId: "CQ", threadTs: "1790000000.000100" })
  })
})

describe("when a money or legal deadline is close", () => {
  const friday10 = new Date("2026-09-25T08:00:00.000Z")
  it.each([["2026-09-25", true], ["2026-09-26", true], ["2026-09-28", false], ["2026-09-20", true], [null, false]])("due %s", (due, expected) => {
    expect(dueSoon(due, friday10, TZ)).toBe(expected)
  })
  it("pings only in working hours", () => {
    // Hours alone: a Saturday morning is within them (whether a ping may go then is ping's to say).
    expect(workingHours(new Date("2026-09-26T08:00:00.000Z"), TZ)).toBe(true)
    expect([workingHours(new Date("2026-09-25T05:59:00.000Z"), TZ), workingHours(new Date("2026-09-25T06:00:00.000Z"), TZ), workingHours(new Date("2026-09-25T15:59:00.000Z"), TZ), workingHours(new Date("2026-09-25T16:00:00.000Z"), TZ)]).toEqual([false, true, true, false])
  })
})
