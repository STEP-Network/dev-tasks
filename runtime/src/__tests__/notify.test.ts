import { mkdtempSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../config.ts"
import { listNew } from "../fsq.ts"
import { digestDue, digestText, dueSoon, mentionsFor, ping, slackSafe, workingHours } from "../notify.ts"
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

  it("pings once per key, in the issue's thread, @-mentioning the person", () => {
    const p = paths()
    const at = new Date("2026-09-25T08:00:00.000Z")
    expect(ping(p, config, { key: "money-legal:STEP-7:2026-09-26", issue: "STEP-7", reason: "money-legal-due", text: "STEP-7 needs an answer by 2026-09-26.", person: "UBEN" }, at)).toBe(true)
    expect(ping(p, config, { key: "money-legal:STEP-7:2026-09-26", issue: "STEP-7", reason: "money-legal-due", text: "again", person: "UBEN" }, at)).toBe(false)
    expect(listNew<OutboxMessage>(p.outbox).map((e) => e.payload)).toEqual([expect.objectContaining({ kind: "issue", issue: "STEP-7", question: false, text: "<@UBEN> STEP-7 needs an answer by 2026-09-26." })])
  })

  it("lets no reason reach anyone but the people it mentions", () => {
    const p = paths()
    ping(p, config, { key: "blocked:job-2", issue: "STEP-9", reason: "blocked", text: "STEP-9 is blocked: <!channel> read this." }, new Date())
    expect(listNew<OutboxMessage>(p.outbox)[0].payload).toMatchObject({ text: "<@UADA> <@UBEN> <@UCY> STEP-9 is blocked: &lt;!channel&gt; read this." })
  })

  it("mentions all three when the person is not known, and posts in another mini's thread when given", () => {
    expect(mentionsFor(config, null)).toBe("<@UADA> <@UBEN> <@UCY>")
    expect(mentionsFor(config, "UZED")).toBe("<@UADA> <@UBEN> <@UCY>")
    const p = paths()
    ping(p, config, { key: "blocked:job-1", issue: "STEP-8", reason: "blocked", text: "STEP-8 is blocked.", thread: { channelId: "CQ", threadTs: "1790000000.000100" } }, new Date())
    expect(listNew<OutboxMessage>(p.outbox)[0].payload).toMatchObject({ kind: "reply", channelId: "CQ", threadTs: "1790000000.000100" })
  })
})

describe("when a money or legal deadline is close", () => {
  const friday10 = new Date("2026-09-25T08:00:00.000Z")
  it.each([["2026-09-25", true], ["2026-09-26", true], ["2026-09-28", false], ["2026-09-20", true], [null, false]])("due %s", (due, expected) => {
    expect(dueSoon(due, friday10, TZ)).toBe(expected)
  })
  it("pings only in working hours", () => {
    expect([workingHours(new Date("2026-09-25T05:59:00.000Z"), TZ), workingHours(new Date("2026-09-25T06:00:00.000Z"), TZ), workingHours(new Date("2026-09-25T15:59:00.000Z"), TZ), workingHours(new Date("2026-09-25T16:00:00.000Z"), TZ)]).toEqual([false, true, true, false])
  })
})
