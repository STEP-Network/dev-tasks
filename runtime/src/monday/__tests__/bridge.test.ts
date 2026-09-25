import { existsSync, mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema, type AgentPaths } from "../../config.ts"
import { countIn, listNew } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import { enqueueSlack } from "../../outbox.ts"
import type { MondayInstructionEntry } from "../../slack/instruction.ts"
import type { TrackerIssue } from "../../tracker.ts"
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import { askDecision } from "../../agentd/decisions.ts"
import { moveJob, recordPr, submitJob } from "../../jobs.ts"
import { createMondayBridge } from "../bridge.ts"
import { MondayRefused, type ColumnChange, type MondayApi, type MondayItem } from "../client.ts"
import type { PeopleIssue, PeopleView } from "../people.ts"
import { enqueueMonday, mondayOutbox, readRecords } from "../store.ts"

const BOARD = "5104953028"
const NATE = "111"
const KRISTOFFER = "222"
const STRANGER = "333"
const AGENT = "900"
const COL = {
  person: "multiple_person_mm7hcr31", kind: "color_mm7hx8zq", state: "color_mm7hvyyt", agent: "dropdown_mm7hmyqg",
  linear: "link_mm7hz1nj", pr: "link_mm7h42x", due: "date_mm7hfrdv", answer: "long_text_mm7hzj39",
}
const GROUPS = [
  { id: "g_needs", title: "Needs you" }, { id: "g_test", title: "Test day" }, { id: "g_req", title: "Requests" },
  { id: "g_work", title: "Agents working on" }, { id: "g_done", title: "Done" },
]
const PR = "https://github.com/STEP-Network/v0-politiske-annoncer/pull/1679"
const T0 = new Date("2026-09-25T09:00:00.000Z")

/** An in-memory board that records every call, as the Monday API would take it. */
function fakeMonday(me = { id: AGENT, name: "PolAds agents", isAdmin: false }, dailyLimit: number | null | Error = null) {
  const items = new Map<string, MondayItem>()
  const logs: ColumnChange[] = []
  const calls: Array<{ method: string; args: unknown[] }> = []
  /** Items Monday cannot be reached for, as in an outage: their updates fail, and are not refused. */
  const down = new Set<string>()
  /** Calls Monday cannot be reached for at all, by method. */
  const broken = new Set<string>()
  let next = 1000
  let clock = T0
  const record = (method: string, args: unknown[]) => calls.push({ method, args })
  const find = (id: string) => {
    const hit = items.get(id)
    // As Monday answers for an item that is gone: a GraphQL error.
    if (!hit) throw new MondayRefused(`Monday: Item ${id} not found`)
    return hit
  }
  const setValues = (item: MondayItem, values: Record<string, unknown>) => {
    for (const [id, v] of Object.entries(values)) {
      const value = (v ?? {}) as { label?: string; labels?: string[]; url?: string; text?: string; date?: string }
      item.columns[id] = { text: value.label ?? value.labels?.join(", ") ?? value.text ?? value.date ?? null, value: JSON.stringify(v) }
    }
  }
  const api: MondayApi = {
    async me() {
      record("me", [])
      return me
    },
    async readBoard(boardId, columnIds, watch) {
      record("readBoard", [boardId, columnIds, watch.columnId, watch.since.toISOString()])
      return { groups: GROUPS, items: structuredClone([...items.values()]), changes: logs.filter((l) => l.at >= watch.since.toISOString()) }
    },
    async dailyLimit() {
      record("dailyLimit", [])
      if (dailyLimit instanceof Error) throw dailyLimit
      return dailyLimit
    },
    async createItem(boardId, groupId, name, values) {
      record("createItem", [boardId, groupId, name, values])
      const id = String(next++)
      const item: MondayItem = { id, name, url: `https://step.monday.com/boards/${BOARD}/pulses/${id}`, groupId, creatorId: me.id, createdAt: clock.toISOString(), columns: {}, updates: [] }
      setValues(item, values)
      items.set(id, item)
      return id
    },
    async setColumns(boardId, itemId, values) {
      record("setColumns", [boardId, itemId, values])
      if (broken.has("setColumns")) throw new Error("Monday: gave up after 3 attempts (status 503)")
      setValues(find(itemId), values)
    },
    async moveItem(itemId, groupId) {
      record("moveItem", [itemId, groupId])
      find(itemId).groupId = groupId
    },
    async postUpdate(itemId, html, threadId = null) {
      record("postUpdate", [itemId, html, threadId])
      if (down.has(itemId)) throw new Error("Monday: gave up after 3 attempts (status 503)")
      const id = `u${next++}`
      find(itemId).updates.push({ id, creatorId: me.id, text: html, createdAt: clock.toISOString(), threadId: threadId ?? id })
      return id
    },
    async like(updateId) {
      record("like", [updateId])
    },
    async archiveItem(itemId) {
      record("archiveItem", [itemId])
      items.delete(itemId)
    },
  }
  return {
    api,
    items,
    calls,
    down,
    broken,
    called: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args),
    writes: () => calls.filter((c) => !["me", "readBoard", "dailyLimit"].includes(c.method)),
    at: (t: Date) => {
      clock = t
    },
    /** A person's update on an item (a reply when threadId is given). */
    says(itemId: string, userId: string, text: string, threadId?: string) {
      const id = `p${next++}`
      find(itemId).updates.push({ id, creatorId: userId, text, createdAt: clock.toISOString(), threadId: threadId ?? id })
      return id
    },
    /** A person's new item in a group, with an optional first update. */
    request(userId: string, name: string, detail?: string, groupId = "g_req") {
      const id = String(next++)
      items.set(id, { id, name, url: `https://step.monday.com/boards/${BOARD}/pulses/${id}`, groupId, creatorId: userId, createdAt: clock.toISOString(), columns: {}, updates: [] })
      if (detail) this.says(id, userId, detail)
      return id
    },
    /** A person writing in the Answer column. */
    answers(itemId: string, userId: string, text: string) {
      const id = `log${next++}`
      logs.push({ id, itemId, userId, text, at: clock.toISOString() })
      return id
    },
    item: (name: RegExp) => [...items.values()].find((i) => name.test(i.name)),
  }
}

/**
 * The people's view of the fake tracker's issues, with the fields only
 * Linear's people-facing reads carry. `parents` maps a sub-issue to its parent.
 */
function fakePeople(issues: Map<string, TrackerIssue>, extra: Record<string, Partial<PeopleIssue>> = {}, parents: Record<string, string> = {}) {
  const types: Record<string, string> = { Released: "completed", Canceled: "canceled", Duplicate: "duplicate", Triage: "triage" }
  const view = (i: TrackerIssue): PeopleIssue => ({
    id: i.id, uuid: i.uuid, title: i.title, description: i.description, url: i.url, state: i.state, stateType: types[i.state] ?? "started",
    labels: i.labels, owner: null, requester: null, dueDate: null, prUrl: null, uatSteps: null, ...extra[i.id],
  })
  const parentOf = new Map(Object.entries(parents))
  const byUuid = (uuid: string) => [...issues.values()].find((i) => i.uuid === uuid)
  const adopted: Array<[string, string, number]> = []
  const people: PeopleView = {
    async needsYou() {
      return [...issues.values()]
        .filter((i) => !["Released", "Canceled"].includes(i.state))
        .filter((i) => i.labels.includes("needs-human") || (i.state === "On hold" && (i.labels.includes("human-todo") || i.labels.includes("awaiting-answer"))))
        .map(view)
    },
    async waitingForUat() {
      return [...issues.values()].filter((i) => i.state === "Waiting for UAT").map(view)
    },
    async byIdentifiers(ids) {
      return ids.flatMap((id) => (issues.has(id) ? [view(issues.get(id)!)] : []))
    },
    async adoptFix(child, parent, priority) {
      adopted.push([child, parent, priority])
      const c = byUuid(child)
      const p = byUuid(parent)
      if (c && p) parentOf.set(c.id, p.id)
    },
    async parentOf(id) {
      const parent = issues.get(parentOf.get(id) ?? "")
      if (!parent) return null
      const fixes = [...parentOf].filter(([, p]) => p === parent.id).map(([c]) => issues.get(c)!)
      const openFixes = fixes.filter((f) => f.title.startsWith("UAT fix:") && !["Approved", "Released", "Canceled"].includes(f.state)).map((f) => f.id)
      return { id: parent.id, state: parent.state, openFixes }
    },
  }
  return { people, adopted }
}

interface SetupOptions {
  extra?: Record<string, Partial<PeopleIssue>>
  me?: { id: string; name: string; isAdmin: boolean }
  /** Tracker methods that throw. The same array: empty it and Linear is back. */
  failOn?: string[]
  parents?: Record<string, string>
  dailyLimit?: number | null | Error
  monday?: Record<string, unknown>
}

function setup(seed: TrackerIssue[] = [], opts: SetupOptions = {}) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-monday-")))
  const config = ConfigSchema.parse({
    mini: "eve", repo: { path: "/r" }, pluginRoot: "/p", slack: { allowedUsers: ["UNATE"] },
    bridges: {
      monday: {
        enabled: true,
        people: [{ id: NATE, name: "Nate", linearEmail: "nate@polads.eu" }, { id: KRISTOFFER, name: "Kristoffer", linearEmail: "kristoffer@polads.eu" }],
        defaultPerson: NATE,
        ...opts.monday,
      },
    },
  })
  const failOn = opts.failOn ?? []
  const fake = fakeTracker(seed, undefined, failOn)
  const monday = fakeMonday(opts.me, opts.dailyLimit)
  const { people, adopted } = fakePeople(fake.issues, opts.extra, opts.parents)
  const logged: Array<{ level: string; msg: string; fields?: Record<string, unknown> }> = []
  const log: Logger = {
    info: (msg, fields) => logged.push({ level: "info", msg, fields }),
    warn: (msg, fields) => logged.push({ level: "warn", msg, fields }),
    error: (msg, fields) => logged.push({ level: "error", msg, fields }),
  }
  let now = T0
  const bridge = createMondayBridge({ paths, config, log, now: () => now, api: monday.api, tracker: fake.tracker, people })
  const later = (minutes: number) => {
    now = new Date(now.getTime() + minutes * 60_000)
    monday.at(now)
  }
  const inbox = () => listNew<MondayInstructionEntry>(paths.inbox).map((e) => e.payload)
  const texts = (itemId: string) => monday.items.get(itemId)?.updates.map((u) => u.text) ?? []
  return { paths, config, fake, monday, people, adopted, bridge, later, inbox, logged, texts, failOn }
}

const stateOf = (item: MondayItem | undefined) => item?.columns[COL.state]?.text

describe("the Monday bridge: Linear to Needs you (STEP-3289)", () => {
  it("puts a needs-human issue on the board once, in plain English, with its Kind, Person, links and due date, and the next poll writes nothing", async () => {
    const { bridge, monday, texts } = setup(
      [issue({ id: "STEP-7", title: "Move the **VAT** field", state: "In Progress", labels: ["polads", "needs-human"], description: "## Goal\n\nThe VAT field sits on the wrong step." })],
      { extra: { "STEP-7": { owner: { name: "Eve", email: "eve@polads.eu" }, requester: { name: "Kristoffer", email: "kristoffer@polads.eu" }, dueDate: "2026-10-01", prUrl: PR } } },
    )
    await bridge.sync()
    expect(monday.called("createItem")).toEqual([[
      BOARD, "g_needs", "Needs a person: Move the VAT field",
      {
        [COL.kind]: { label: "Approval" }, [COL.state]: { label: "Needs you" }, [COL.linear]: { url: "https://linear.app/step/issue/STEP-7", text: "STEP-7" },
        [COL.person]: { personsAndTeams: [{ id: Number(KRISTOFFER), kind: "person" }] }, [COL.agent]: { labels: ["Eve"] },
        [COL.pr]: { url: PR, text: "PR #1679" }, [COL.due]: { date: "2026-10-01" },
      },
    ]])
    const item = monday.item(/Move the VAT field/)!
    expect(texts(item.id)).toEqual([
      "&quot;Move the VAT field&quot; needs a person to look at it before an agent carries on.<br><br>What it is about: The VAT field sits on the wrong step.<br><br>Reply to this update or write in the Answer column with what should happen. Your reply goes onto the issue.",
    ])
    const before = monday.writes().length
    await bridge.sync()
    await bridge.sync()
    expect(monday.writes()).toHaveLength(before)
    expect(monday.items.size).toBe(1)
  })

  it("gives an item nobody on the list owns to the default person, and keeps one item per Linear id", async () => {
    const { bridge, monday } = setup([issue({ id: "STEP-8", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    expect(monday.called("createItem")[0][3]).toMatchObject({ [COL.person]: { personsAndTeams: [{ id: Number(NATE), kind: "person" }] }, [COL.kind]: { label: "Check" } })
    expect(monday.called("createItem")[0][3]).not.toHaveProperty(COL.agent)
  })

  it("adopts the item a crash left behind rather than create a second one for the same Linear id", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["awaiting-answer"] })])
    await bridge.sync()
    rmSync(join(paths.state, "monday"), { recursive: true, force: true })
    await bridge.sync()
    expect(monday.called("createItem")).toHaveLength(1)
    expect(readRecords(paths)).toEqual([expect.objectContaining({ key: "needs-STEP-7", itemId: monday.item(/STEP|question/)!.id })])
  })

  it("does not put back an item a person deleted while its need lasts", async () => {
    const { bridge, monday, later } = setup([issue({ id: "STEP-8", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    monday.items.delete(monday.item(/job for a person/)!.id)
    later(2)
    await bridge.sync()
    expect(monday.called("createItem")).toHaveLength(1)
  })

  it("shows the worker's question in words, where this mini asked it", async () => {
    const { bridge, monday, texts, paths } = setup([issue({ id: "STEP-7", title: "Fix the date", state: "On hold", labels: ["awaiting-answer"], assigneeId: "user-eve" })], {
      extra: { "STEP-7": { owner: { name: "Eve", email: "eve@polads.eu" } } },
    })
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: "Should the date be the publication date or the order date?", question: true }, T0)
    await bridge.sync()
    const item = monday.item(/Eve has a question: Fix the date/)!
    expect(texts(item.id)[0]).toContain("The question: Should the date be the publication date or the order date?")
  })

  it("moves an item to Done when Linear no longer needs a person, and archives it after 14 days", async () => {
    const { bridge, monday, fake, later, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    const id = monday.item(/STEP|job for a person/)!.id
    fake.issues.set("STEP-7", { ...fake.issues.get("STEP-7")!, state: "Refining" })
    later(2)
    await bridge.sync()
    expect(stateOf(monday.items.get(id))).toBe("Done")
    expect(monday.items.get(id)!.groupId).toBe("g_done")
    later(13 * 24 * 60)
    await bridge.sync()
    expect(monday.items.has(id)).toBe(true)
    later(24 * 60 + 1)
    await bridge.sync()
    expect(monday.called("archiveItem")).toEqual([[id]])
    expect(readRecords(paths)).toEqual([])
  })

  it("brings a Done item back when its issue needs a person again", async () => {
    const { bridge, monday, fake, later } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    const id = monday.item(/job for a person/)!.id
    const parked = fake.issues.get("STEP-7")!
    fake.issues.set("STEP-7", { ...parked, state: "Refining" })
    later(2)
    await bridge.sync()
    fake.issues.set("STEP-7", parked)
    later(2)
    await bridge.sync()
    expect(stateOf(monday.items.get(id))).toBe("Needs you")
    expect(monday.items.get(id)!.groupId).toBe("g_needs")
    expect(monday.called("createItem")).toHaveLength(1)
    // Asked again, the item starts with an empty Answer column.
    expect(monday.called("setColumns").at(-1)?.[2]).toMatchObject({ [COL.answer]: "", [COL.state]: { label: "Needs you" } })
  })
})

describe("the Monday bridge: answers (STEP-3289)", () => {
  function decided() {
    const s = setup([issue({ id: "STEP-7", title: "Fix the date", state: "In Review", labels: ["polads"] })])
    askDecision(s.paths, s.config, {
      id: "infra-STEP-7-abc", issue: "STEP-7", url: PR, question: "CI failed on its infrastructure again.",
      options: [{ reply: "re-run", does: "re-run CI in full once more" }, { reply: "leave it", does: "leave the PR to a person" }],
      defaultReply: "re-run", defaultAction: { kind: "rerun", runs: ["111"] },
    }, T0)
    return s
  }

  it("shows this mini's open decision with its options, and a person's reply becomes the same instruction a Slack reply would", async () => {
    const { bridge, monday, texts, inbox, later } = decided()
    await bridge.sync()
    const item = monday.item(/Eve needs a decision: Fix the date/)!
    expect(monday.called("createItem")[0][3]).toMatchObject({ [COL.kind]: { label: "Decision" }, [COL.agent]: { labels: ["Eve"] }, [COL.pr]: { url: PR, text: "PR #1679" }, [COL.due]: { date: "2026-09-25" } })
    expect(texts(item.id)[0]).toContain("Reply &quot;re-run&quot; to re-run CI in full once more")
    // The fixed verbs read Monday's words: a bare yes counts only in Slack (STEP-3293).
    expect(texts(item.id)[0]).not.toContain("Reply yes")
    later(1)
    const said = monday.says(item.id, NATE, "leave it")
    later(2)
    await bridge.sync()
    expect(inbox()).toEqual([
      expect.objectContaining({
        type: "instruction", key: `instr:monday:${said}`, issue: "STEP-7", user: NATE, userName: "Nate", text: "leave it", actions: ["leave"],
        monday: { itemId: item.id, updateId: said, threadId: said },
      }),
    ])
    expect(stateOf(monday.items.get(item.id))).toBe("Waiting on agent")
    later(2)
    await bridge.sync()
    expect(inbox()).toHaveLength(1)
  })

  it("asks for an answer to the newer question when the words were written before it, and keeps the item waiting (STEP-3293 final pass)", async () => {
    const { bridge, monday, fake, later, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })])
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: "Which date?\n\nMy recommendation: the publication date. Reply yes to go with it, or tell me what you want instead.", question: true }, T0)
    await bridge.sync()
    const item = monday.item(/has a question/)!
    const thread = monday.items.get(item.id)!.updates[0].id
    later(1)
    monday.says(item.id, KRISTOFFER, "yes", thread)
    // A newer question goes out before the next poll reads the yes.
    enqueueSlack(paths, { kind: "issue", issue: "STEP-7", text: "Given the legal rule, which date?\n\nMy recommendation: the submission date. Reply yes to go with it, or tell me what you want instead.", question: true }, new Date(T0.getTime() + 2 * 60_000))
    later(2)
    const writesBefore = monday.called("setColumns").length
    await bridge.sync()
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", description: "## Goal\n\nFix it." })
    expect(String(monday.called("postUpdate").at(-1)?.[1])).toMatch(/^Eve: Thanks, Kristoffer\. I asked a newer question after you wrote this, so I have not taken it as your answer\. Please answer the newer one here: Given the legal rule, which date\?/)
    // The item still needs them: never Waiting on agent, not even for a moment.
    expect(monday.called("setColumns").slice(writesBefore).map((c) => JSON.stringify(c[2]))).not.toContainEqual(expect.stringContaining("Waiting on agent"))
    expect(stateOf(monday.items.get(item.id))).not.toBe("Waiting on agent")
  })

  it("puts a person's answer to a question onto the issue, which goes back to Ready, and says so on the item", async () => {
    const { bridge, monday, fake, later, inbox, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["agent-ready", "awaiting-answer"], description: "## Goal\n\nFix it." })])
    await bridge.sync()
    const item = monday.item(/has a question/)!
    const thread = monday.items.get(item.id)!.updates[0].id
    later(1)
    // Words that would be an instruction elsewhere stay an answer to a question the issue waits on.
    const said = monday.says(item.id, KRISTOFFER, "Use the publication date, then merge", thread)
    later(2)
    await bridge.sync()
    expect(inbox()).toEqual([])
    const now = fake.issues.get("STEP-7")!
    expect(now).toMatchObject({ state: "Ready", labels: ["agent-ready"] })
    expect(now.description).toBe(`## Goal\n\nFix it.\n\n## Answers from Monday\n\n<!-- monday:${said} -->\n**Kristoffer** ([Monday](${item.url}/posts/${thread}?reply=reply-${said})): Use the publication date, then merge`)
    // The reply went out in the same poll, under the person's thread, with a like beside it.
    expect(listNew(mondayOutbox(paths))).toEqual([])
    expect(monday.called("postUpdate").at(-1)).toEqual([item.id, "Eve: Thanks, Kristoffer. I added your answer to the issue, and an agent picks it up again. Nothing needed from you.", thread])
    expect(monday.called("like")).toEqual([[said]])
    later(2)
    await bridge.sync()
    expect(stateOf(monday.items.get(item.id))).toBe("Done")
    // Read once: the next poll neither appends it again nor reads its "merge" as an instruction now the question is gone.
    expect(fake.called("updateIssue")).toHaveLength(1)
    expect(inbox()).toEqual([])
    expect(monday.called("postUpdate").filter((c) => /I added your answer/.test(String(c[1])))).toHaveLength(1)
  })

  it("reads the Answer column as the person who wrote it, and answers with a new update", async () => {
    const { bridge, monday, fake, later } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"], description: "Do the DNS." })])
    await bridge.sync()
    const item = monday.item(/job for a person/)!
    later(1)
    const change = monday.answers(item.id, NATE, "Done, the record is in.")
    later(2)
    await bridge.sync()
    expect(fake.issues.get("STEP-7")!.description).toBe(`Do the DNS.\n\n## Answers from Monday\n\n<!-- monday:log:${change} -->\n**Nate**: Done, the record is in.`)
    expect(monday.called("postUpdate").at(-1)).toEqual([item.id, "Eve: Thanks, Nate. I added your answer to the issue, and an agent looks at it again. Nothing needed from you.", null])
    expect(monday.called("like")).toEqual([])
    later(2)
    await bridge.sync()
    expect(fake.called("updateIssue")).toHaveLength(1)
    expect(monday.called("postUpdate").filter((c) => /I added your answer/.test(String(c[1])))).toHaveLength(1)
  })

  it("ignores anyone not on the allowlist: their updates, their Answer column and their requests", async () => {
    const { bridge, monday, fake, later, inbox, paths } = decided()
    fake.issues.set("STEP-8", issue({ id: "STEP-8", state: "On hold", labels: ["awaiting-answer"] }))
    await bridge.sync()
    const decision = monday.item(/needs a decision/)!
    const question = monday.item(/has a question/)!
    later(1)
    monday.says(decision.id, STRANGER, "merge")
    monday.answers(question.id, STRANGER, "the answer is 42")
    monday.request(STRANGER, "Delete the production database")
    // The agent's own updates are not a person's either.
    monday.says(question.id, AGENT, "re-run")
    later(2)
    await bridge.sync()
    expect(inbox()).toEqual([])
    expect(fake.called("updateIssue")).toEqual([])
    expect(fake.called("createIssue")).toEqual([])
    expect(stateOf(monday.items.get(decision.id))).toBe("Needs you")
    expect(readRecords(paths).map((r) => r.kind).sort()).toEqual(["needs", "needs"])
  })

  it("says so when the issue is gone from Linear, and stops trying", async () => {
    const { bridge, monday, fake, later } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    const item = monday.item(/job for a person/)!
    fake.issues.delete("STEP-7")
    later(1)
    monday.says(item.id, NATE, "done")
    later(2)
    await bridge.sync()
    await bridge.sync()
    expect(monday.called("postUpdate").filter((c) => String(c[1]).includes("no longer in Linear"))).toHaveLength(1)
  })

  it("tries again while Linear refuses, and after a day says it gave up", async () => {
    const { bridge, monday, later, logged } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })], { failOn: ["updateIssue"] })
    await bridge.sync()
    const item = monday.item(/job for a person/)!
    later(1)
    monday.says(item.id, NATE, "done")
    later(2)
    await bridge.sync()
    expect(logged.some((l) => l.level === "warn" && /not acted on yet/.test(l.msg))).toBe(true)
    later(60)
    await bridge.sync()
    expect(monday.called("postUpdate").some((c) => /refused this for a whole day/.test(String(c[1])))).toBe(false)
    later(23 * 60 + 5)
    await bridge.sync()
    expect(monday.called("postUpdate").filter((c) => /refused this for a whole day/.test(String(c[1])))).toHaveLength(1)
    later(2)
    await bridge.sync()
    expect(monday.called("postUpdate").filter((c) => /refused this for a whole day/.test(String(c[1])))).toHaveLength(1)
  })
})

describe("the Monday bridge: requests (STEP-3289)", () => {
  it("files a person's new request as one Linear Triage issue, links it both ways, and moves it to Agents working on", async () => {
    const { bridge, monday, fake, later, paths } = setup()
    const id = monday.request(KRISTOFFER, "The export button does nothing", "It is on the invoices page, in Chrome.")
    await bridge.sync()
    const [[input]] = fake.called("createIssue") as Array<[{ title: string; description: string; labels: string[]; state: string; clientId: string }]>
    expect(input).toMatchObject({ title: "The export button does nothing", state: "Triage", labels: ["polads", "intake/monday"] })
    expect(input.description).toContain("> The export button does nothing\n>\n> It is on the invoices page, in Chrome.")
    const filed = [...fake.issues.values()].find((i) => i.title === "The export button does nothing")!
    expect(fake.called("attachLink")).toEqual([[filed.id, `https://step.monday.com/boards/${BOARD}/pulses/${id}`, "Monday request"]])
    const item = monday.items.get(id)!
    expect(item.groupId).toBe("g_work")
    expect(item.columns[COL.linear]?.value).toBe(JSON.stringify({ url: filed.url, text: filed.id }))
    expect(stateOf(item)).toBe("Waiting on agent")
    expect(item.columns[COL.kind]?.text).toBe("Request")
    expect(monday.called("postUpdate").at(-1)?.[1]).toBe(`Eve: Thanks, Kristoffer. I filed this for the agents as ${filed.id}. It moves to Done when the change is released. Nothing needed from you.`)
    later(2)
    await bridge.sync()
    // Dragged back into Requests, it is still the same request.
    monday.items.get(id)!.groupId = "g_req"
    later(2)
    await bridge.sync()
    expect(fake.called("createIssue")).toHaveLength(1)
    expect(readRecords(paths)).toEqual([expect.objectContaining({ kind: "request", issue: filed.id, itemId: id, linked: true })])
  })

  it("files a request only once, even when the bridge crashed after Linear took it", async () => {
    const { bridge, monday, fake, paths } = setup()
    monday.request(NATE, "Add a Danish label")
    await bridge.sync()
    rmSync(join(paths.state, "monday"), { recursive: true, force: true })
    const [item] = [...monday.items.values()]
    item.groupId = "g_req"
    await bridge.sync()
    expect(fake.called("createIssue")).toHaveLength(2)
    expect([...fake.issues.values()].filter((i) => i.title === "Add a Danish label")).toHaveLength(1)
  })

  it("follows the issue: Blocked while it is On hold, and Done when it is released", async () => {
    const { bridge, monday, fake, later } = setup()
    const id = monday.request(NATE, "Add a Danish label")
    await bridge.sync()
    const filed = [...fake.issues.values()][0]
    fake.issues.set(filed.id, { ...filed, state: "On hold" })
    later(2)
    await bridge.sync()
    expect(stateOf(monday.items.get(id))).toBe("Blocked")
    fake.issues.set(filed.id, { ...filed, state: "Released" })
    later(2)
    await bridge.sync()
    expect(stateOf(monday.items.get(id))).toBe("Done")
    expect(monday.items.get(id)!.groupId).toBe("g_done")
    expect(monday.called("postUpdate").at(-1)?.[1]).toBe(`Eve: Done: ${filed.id} is released. Nothing needed from you.`)
  })

  it("puts a person's later words on a request onto its issue", async () => {
    const { bridge, monday, fake, later } = setup()
    const id = monday.request(NATE, "Add a Danish label")
    await bridge.sync()
    const filed = [...fake.issues.values()][0]
    later(1)
    monday.says(id, NATE, "Only on the invoice PDF")
    later(2)
    await bridge.sync()
    expect(fake.issues.get(filed.id)!.description).toContain("**Nate**")
    expect(fake.issues.get(filed.id)!.description).toContain("Only on the invoice PDF")
  })
})

describe("the Monday bridge: test day (STEP-3289)", () => {
  const steps = "1. **Open the notice** as `advertiser@test.polads.eu`\n   - Expect: the publication date"

  function uat() {
    return setup([issue({ id: "STEP-7", title: "Fix the date", state: "Waiting for UAT", labels: ["polads"], acceptanceCriteria: "- [ ] The date shows" })], {
      extra: { "STEP-7": { uatSteps: steps, prUrl: PR } },
    })
  }

  it("puts in Test day only what this mini's product ships to the test site", async () => {
    const { bridge, monday } = setup([
      issue({ id: "STEP-7", title: "Fix the date", state: "Waiting for UAT", labels: ["polads"] }),
      issue({ id: "STEP-8", title: "Machine profiles for the plugin", state: "Waiting for UAT", labels: ["dev-tasks"] }),
      issue({ id: "STEP-9", title: "No product named", state: "Waiting for UAT", labels: [] }),
    ])
    await bridge.sync()
    expect(monday.called("createItem").map((c) => c[2])).toEqual(["Try it on the test site: Fix the date"])
  })

  it("archives a Test day item it made for another product at the next poll, and says nothing on it", async () => {
    const { bridge, monday, fake, paths, later } = setup([
      issue({ id: "STEP-7", title: "Fix the date", state: "Waiting for UAT", labels: ["polads"] }),
      issue({ id: "STEP-8", title: "Machine profiles for the plugin", state: "Waiting for UAT", labels: ["polads"] }),
    ])
    await bridge.sync()
    const other = monday.item(/Machine profiles/)!
    const updates = monday.items.get(other.id)!.updates.length
    // As an item made before Test day kept to one product: the issue is another product's.
    fake.issues.set("STEP-8", { ...fake.issues.get("STEP-8")!, labels: ["dev-tasks"] })
    const writesBefore = monday.writes().length
    later(8)
    await bridge.sync()
    expect(monday.called("archiveItem")).toEqual([[other.id]])
    expect(monday.writes().slice(writesBefore).map((c) => c.method)).toEqual(["archiveItem"])
    expect(monday.called("postUpdate").filter((c) => c[0] === other.id)).toHaveLength(updates)
    expect(readRecords(paths).map((r) => r.issue)).toEqual(["STEP-7"])
    // And it stays gone: the issue is not put back on the board.
    later(8)
    await bridge.sync()
    expect(monday.called("createItem")).toHaveLength(2)
    expect(monday.item(/Machine profiles/)).toBeUndefined()
  })

  it("puts an issue waiting for UAT in Test day as a Check, with the exact steps in its body", async () => {
    const { bridge, monday, texts } = uat()
    await bridge.sync()
    const item = monday.item(/Try it on the test site: Fix the date/)!
    expect(item.groupId).toBe("g_test")
    expect(item.columns[COL.kind]?.text).toBe("Check")
    expect(texts(item.id)[0]).toContain("What to check:<br>1. Open the notice as advertiser@test.polads.eu<br>   - Expect: the publication date")
  })

  it("records a person's PASS on the issue: a comment naming them, then Approved, and the item is done", async () => {
    const { bridge, monday, fake, later } = uat()
    await bridge.sync()
    const item = monday.item(/Try it on the test site/)!
    later(1)
    const said = monday.says(item.id, NATE, "PASS, looks right on mobile too")
    later(2)
    await bridge.sync()
    expect(fake.called("comment")).toEqual([["STEP-7", `UAT PASS from Nate on the Monday board (${item.url}/posts/${said}): looks right on mobile too`]])
    expect(fake.issues.get("STEP-7")!.state).toBe("Approved")
    expect(monday.called("postUpdate").some((c) => c[1] === "Eve: Thanks, Nate. I marked it as approved, so it goes out with the next release. Nothing needed from you.")).toBe(true)
    expect(stateOf(monday.items.get(item.id))).toBe("Done")
  })

  it("records a FAIL as a UAT fix sub-issue carrying what they saw, and Needs Correction", async () => {
    const { bridge, monday, fake, adopted, later } = uat()
    await bridge.sync()
    const item = monday.item(/Try it on the test site/)!
    later(1)
    monday.says(item.id, KRISTOFFER, "fail: the date is still the order date")
    later(2)
    await bridge.sync()
    const sub = [...fake.issues.values()].find((i) => i.title === "UAT fix: Fix the date")!
    // As review-uat files one: ready for an agent, at the parent's priority, with a bar for its own review.
    expect(sub).toMatchObject({ state: "Ready", labels: ["bug", "polads", "agent"] })
    expect(sub.description).toContain("> the date is still the order date")
    expect(sub.description).toContain("## Acceptance criteria")
    expect(adopted).toEqual([[sub.uuid, "uuid-STEP-7", 3]])
    expect(fake.called("comment")[0][1]).toMatch(new RegExp(`^UAT FAIL from Kristoffer on the Monday board .*The fix is tracked in ${sub.id}\\.$`))
    expect(fake.issues.get("STEP-7")!.state).toBe("Needs Correction")
  })

  it("reads only PASS or FAIL on a test-day item, and never a verdict for an issue no longer waiting", async () => {
    const { bridge, monday, fake, later } = uat()
    await bridge.sync()
    const item = monday.item(/Try it on the test site/)!
    later(1)
    monday.says(item.id, NATE, "merge it")
    later(2)
    await bridge.sync()
    expect(monday.called("postUpdate").at(-1)?.[1]).toBe("Eve: I read only PASS or FAIL here. Start your reply with PASS if it works, or with FAIL and what you saw.")
    expect(fake.called("updateIssue")).toEqual([])
    fake.issues.set("STEP-7", { ...fake.issues.get("STEP-7")!, state: "On hold", labels: ["polads", "human-todo"] })
    monday.says(item.id, NATE, "PASS")
    later(2)
    await bridge.sync()
    expect(fake.called("comment")).toEqual([])
    expect(fake.issues.get("STEP-7")!.state).toBe("On hold")
  })
})

describe("the Monday bridge: its own guards (STEP-3289)", () => {
  it("refuses an admin's token, writes nothing, and says why once", async () => {
    const { bridge, monday, logged } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })], { me: { id: AGENT, name: "Nate", isAdmin: true } })
    await bridge.sync()
    await bridge.sync()
    expect(monday.writes()).toEqual([])
    expect(monday.called("readBoard")).toEqual([])
    expect(logged.filter((l) => l.level === "error")).toEqual([expect.objectContaining({ fields: { reason: expect.stringMatching(/admin/) } })])
  })

  it("refuses a token whose user is one of the people, which would read its own updates as theirs", async () => {
    const { bridge, monday } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })], { me: { id: NATE, name: "Nate", isAdmin: false } })
    await bridge.sync()
    expect(monday.writes()).toEqual([])
  })

  it("names a group the board is missing, rather than write to the wrong one", async () => {
    const { bridge, monday, config } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })])
    config.bridges.monday!.groups.testDay = "Test Tuesday"
    await expect(bridge.sync()).rejects.toThrow(/no group named "Test Tuesday"/)
    expect(monday.writes()).toEqual([])
  })

  it("posts the replies agentd queued, prefixed with the agent's name, with a like beside them, and escaped", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    const item = monday.item(/job for a person/)!
    enqueueMonday(paths, { itemId: item.id, threadId: "p1", text: "Revising <b>it</b> now: job j1.", like: "p2" }, T0)
    await bridge.drain()
    expect(monday.called("postUpdate").at(-1)).toEqual([item.id, "Eve: Revising &lt;b&gt;it&lt;/b&gt; now: job j1.", "p1"])
    expect(monday.called("like")).toEqual([["p2"]])
    expect(listNew(mondayOutbox(paths))).toEqual([])
    const reads = monday.calls.length
    await bridge.drain()
    expect(monday.calls.length).toBe(reads)
  })
})

describe("the Monday bridge: whose words move this mini (STEP-3289 review)", () => {
  it("puts a request's words onto its issue, never to agentd, whatever they say, even once this mini has a PR for it", async () => {
    const { bridge, monday, fake, later, inbox, paths } = setup()
    const id = monday.request(NATE, "Add a Danish label")
    await bridge.sync()
    const filed = [...fake.issues.values()][0]
    recordPr(paths, { issue: filed.id, url: PR, openedAt: T0.toISOString() })
    later(1)
    monday.says(id, NATE, "Please fix the date and resolve the typo, then merge")
    later(2)
    await bridge.sync()
    expect(inbox()).toEqual([])
    expect(fake.issues.get(filed.id)!.description).toContain("Please fix the date and resolve the typo, then merge")
  })

  it("reads the fixed verbs as words where this mini has no work of its own on the issue, and as an instruction where it has a PR", async () => {
    const { bridge, monday, fake, later, inbox, paths } = setup([
      issue({ id: "STEP-7", state: "In Progress", labels: ["needs-human"], description: "Mine." }),
      issue({ id: "STEP-8", state: "In Progress", labels: ["needs-human"], description: "Bob's." }),
    ])
    recordPr(paths, { issue: "STEP-7", url: PR, openedAt: T0.toISOString() })
    await bridge.sync()
    const ids = { mine: readRecords(paths).find((r) => r.issue === "STEP-7")!.itemId, other: readRecords(paths).find((r) => r.issue === "STEP-8")!.itemId }
    later(1)
    monday.says(ids.other, NATE, "hold off on this, I'll handle it")
    monday.says(ids.mine, NATE, "fix it")
    later(2)
    await bridge.sync()
    // "hold off" on an issue this mini holds nothing of pauses nothing here, and reaches the issue.
    expect(existsSync(paths.pauseFile)).toBe(false)
    expect(fake.issues.get("STEP-8")!.description).toContain("hold off on this, I'll handle it")
    expect(inbox()).toEqual([expect.objectContaining({ issue: "STEP-7", actions: ["revise"] })])
  })
})

describe("the Monday bridge: when Linear is down (STEP-3289 review)", () => {
  it("keeps an Answer column change Linear refused, however long it stays down, and applies it once Linear is back", async () => {
    const { bridge, monday, fake, later, failOn } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"], description: "Do the DNS." })])
    await bridge.sync()
    const item = monday.item(/job for a person/)!
    failOn.push("updateIssue")
    later(1)
    monday.answers(item.id, NATE, "Done, the record is in.")
    later(2)
    await bridge.sync()
    // Long past the activity log's window.
    later(45)
    await bridge.sync()
    expect(fake.called("updateIssue")).toHaveLength(2)
    failOn.length = 0
    later(45)
    await bridge.sync()
    expect(fake.issues.get("STEP-7")!.description).toContain("**Nate**: Done, the record is in.")
    later(45)
    await bridge.sync()
    expect(fake.called("updateIssue")).toHaveLength(3)
  })
})

describe("the Monday bridge: replies (STEP-3289 review)", () => {
  it("drops a reply Monday refuses at once, and stops for the loop when Monday is out of reach, every reply kept in order", async () => {
    const { bridge, monday, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] }), issue({ id: "STEP-8", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    const [a, b] = readRecords(paths).map((r) => r.itemId)
    monday.down.add(a)
    enqueueMonday(paths, { itemId: "9999", threadId: null, text: "for a deleted item", like: null }, T0)
    enqueueMonday(paths, { itemId: a, threadId: null, text: "first for a", like: null }, T0)
    enqueueMonday(paths, { itemId: a, threadId: null, text: "second for a", like: null }, T0)
    enqueueMonday(paths, { itemId: b, threadId: null, text: "for b", like: null }, T0)
    await bridge.drain()
    const posted = () => monday.called("postUpdate").filter((c) => String(c[1]).startsWith("Eve: ")).map((c) => `${c[0]} ${c[1]}`)
    // Out of reach is Monday's, not one item's: nothing after it is tried this loop, so agentd is not held up.
    expect(posted()).toEqual([`9999 Eve: for a deleted item`, `${a} Eve: first for a`])
    expect(countIn(mondayOutbox(paths), "failed")).toBe(1)
    expect(countIn(mondayOutbox(paths), "new")).toBe(3)
    monday.down.delete(a)
    await bridge.drain()
    expect(monday.items.get(a)!.updates.map((u) => u.text).filter((t) => t.startsWith("Eve: "))).toEqual(["Eve: first for a", "Eve: second for a"])
    expect(monday.items.get(b)!.updates.map((u) => u.text).filter((t) => t.startsWith("Eve: "))).toEqual(["Eve: for b"])
    expect(countIn(mondayOutbox(paths), "new")).toBe(0)
  })

  it("likes a person's update only beside a reply that says the thing was done", async () => {
    const { bridge, monday, later } = setup([issue({ id: "STEP-7", title: "Fix the date", state: "Waiting for UAT", labels: ["polads"] })])
    await bridge.sync()
    const item = monday.item(/Try it on the test site/)!
    later(1)
    monday.says(item.id, NATE, "merge it")
    later(2)
    await bridge.sync()
    expect(monday.called("postUpdate").at(-1)?.[1]).toMatch(/I read only PASS or FAIL here/)
    expect(monday.called("like")).toEqual([])
  })
})

describe("the Monday bridge: test day, closing the loop (STEP-3289 review)", () => {
  const seed = (fixState: string) => [
    issue({ id: "STEP-5", title: "Fix the date", state: "Needs Correction", labels: ["polads"] }),
    issue({ id: "STEP-8", title: "UAT fix: the date", state: "Waiting for UAT", labels: ["polads", "bug"] }),
    issue({ id: "STEP-9", title: "UAT fix: the label", state: fixState, labels: ["polads", "bug"] }),
  ]

  it("sends a UAT fix's parent back to Agent UAT once a person passes its last open fix", async () => {
    const { bridge, monday, fake, later } = setup(seed("Released"), { parents: { "STEP-8": "STEP-5", "STEP-9": "STEP-5" } })
    await bridge.sync()
    later(1)
    monday.says(monday.item(/UAT fix: the date/)!.id, NATE, "PASS")
    later(2)
    await bridge.sync()
    expect(fake.issues.get("STEP-8")!.state).toBe("Approved")
    expect(fake.issues.get("STEP-5")!.state).toBe("Agent UAT")
    expect(fake.called("comment").find((c) => c[0] === "STEP-5")?.[1]).toMatch(/^STEP-8 is fixed and approved \(Nate, on the Monday board\), so STEP-5 goes back/)
  })

  it("leaves the parent in Needs Correction while another of its fixes is open", async () => {
    const { bridge, monday, fake, later } = setup(seed("In Progress"), { parents: { "STEP-8": "STEP-5", "STEP-9": "STEP-5" } })
    await bridge.sync()
    later(1)
    monday.says(monday.item(/UAT fix: the date/)!.id, NATE, "PASS")
    later(2)
    await bridge.sync()
    expect(fake.issues.get("STEP-8")!.state).toBe("Approved")
    expect(fake.issues.get("STEP-5")!.state).toBe("Needs Correction")
  })
})

describe("the Monday bridge: requests one at a time (STEP-3289 review)", () => {
  it("files the other requests when Linear refuses one", async () => {
    const { bridge, monday, fake, logged } = setup()
    const create = fake.tracker.createIssue
    fake.tracker.createIssue = async (input) => {
      if (input.title.startsWith("Broken")) throw new Error("Linear: refused (fake)")
      return create(input)
    }
    monday.request(NATE, "Broken request")
    monday.request(KRISTOFFER, "Add a Danish label")
    await bridge.sync()
    expect([...fake.issues.values()].map((i) => i.title)).toEqual(["Add a Danish label"])
    expect(logged.some((l) => l.level === "warn" && /request not filed yet/.test(l.msg))).toBe(true)
  })
})

describe("the Monday bridge: the account's daily API calls (STEP-3289 review)", () => {
  it("polls no more often than apiShare of the account's daily calls allows, and every pollMinutes when there are plenty", async () => {
    const standard = setup([], { dailyLimit: 1000 })
    expect(standard.bridge.pollEveryMs()).toBe(2 * 60_000)
    await standard.bridge.sync()
    // 20 percent of 1,000 calls is 200 reads a day: one every 7.2 minutes, rounded up.
    expect(standard.bridge.pollEveryMs()).toBe(8 * 60_000)
    const pro = setup([], { dailyLimit: 10_000 })
    await pro.bridge.sync()
    expect(pro.bridge.pollEveryMs()).toBe(2 * 60_000)
    const narrow = setup([], { dailyLimit: 10_000, monday: { apiShare: 0.01 } })
    await narrow.bridge.sync()
    expect(narrow.bridge.pollEveryMs()).toBe(15 * 60_000)
  })

  it("reads the limit once a day, and assumes the smallest plan's, saying so once, when Monday does not tell it", async () => {
    const s = setup([], { dailyLimit: new Error("Monday: Field 'platform_api' doesn't exist") })
    await s.bridge.sync()
    s.later(2)
    await s.bridge.sync()
    expect(s.monday.called("dailyLimit")).toHaveLength(1)
    // 1,000 calls a day (Free, Basic, Standard): every 8 minutes.
    expect(s.bridge.pollEveryMs()).toBe(8 * 60_000)
    s.later(24 * 60 + 1)
    await s.bridge.sync()
    expect(s.monday.called("dailyLimit")).toHaveLength(2)
    expect(s.logged.filter((l) => /daily API limit/.test(l.msg))).toHaveLength(1)
    const silent = setup([], { dailyLimit: null })
    await silent.bridge.sync()
    expect(silent.bridge.pollEveryMs()).toBe(8 * 60_000)
  })
})

describe("the Monday bridge: agents on the board (STEP-3289 review)", () => {
  it("names only its own agent unless agentLabels lists the others", async () => {
    const extra = { "STEP-7": { owner: { name: "Bob", email: "bob@polads.eu" } } }
    const alone = setup([issue({ id: "STEP-7", state: "On hold", labels: ["awaiting-answer"] })], { extra })
    await alone.bridge.sync()
    expect(alone.monday.called("createItem")[0][3]).not.toHaveProperty(COL.agent)
    const both = setup([issue({ id: "STEP-7", state: "On hold", labels: ["awaiting-answer"] })], { extra, monday: { agentLabels: ["Eve", "Bob"] } })
    await both.bridge.sync()
    expect(both.monday.called("createItem")[0][3]).toMatchObject({ [COL.agent]: { labels: ["Bob"] } })
  })
})

describe("the Monday bridge: words sent to agentd stay on the issue too (STEP-3289 final review)", () => {
  const blockedJob = (paths: AgentPaths) => {
    const job = submitJob(paths, "STEP-7", null, new Date("2026-09-25T07:00:00.000Z"))
    moveJob(paths, job.id, "pending", "done", { endedAt: "2026-09-25T07:30:00.000Z", result: { status: "blocked", reason: "no PR title", prUrl: null, branch: null, costUsd: null, turns: null, minutes: 5 } })
  }

  it("keeps an instruction's words on the issue, and leaves a parked issue where it is for agentd to act", async () => {
    const { bridge, monday, fake, later, inbox, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["needs-human", "agent-ready"], description: "Goal." })])
    blockedJob(paths)
    await bridge.sync()
    const item = monday.item(/Needs a person/)!
    later(1)
    const said = monday.says(item.id, NATE, "retry it please")
    later(2)
    await bridge.sync()
    expect(inbox()).toEqual([expect.objectContaining({ issue: "STEP-7", actions: ["retry"] })])
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "On hold", description: expect.stringContaining(`<!-- monday:${said} -->\n**Nate** `) })
  })

  it("counts a blocked job only while it is the issue's most recent one", async () => {
    const { bridge, monday, fake, later, inbox, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["needs-human", "agent-ready"], description: "Goal." })])
    blockedJob(paths)
    // A newer job since: the blocked one is history, so "retry" is only words.
    submitJob(paths, "STEP-7", null, new Date("2026-09-25T08:00:00.000Z"))
    await bridge.sync()
    later(1)
    monday.says(monday.item(/Needs a person/)!.id, NATE, "retry it please")
    later(2)
    await bridge.sync()
    expect(inbox()).toEqual([])
    expect(fake.issues.get("STEP-7")).toMatchObject({ state: "Ready", description: expect.stringContaining("retry it please") })
  })
})

describe("the Monday bridge: words are routed once (STEP-3289 final review)", () => {
  it("never routes the same words twice when Monday fails after the Linear write", async () => {
    const { bridge, monday, fake, later } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"], description: "Do the DNS." })])
    await bridge.sync()
    const item = monday.item(/job for a person/)!
    later(1)
    monday.says(item.id, NATE, "Done, the record is in.")
    monday.broken.add("setColumns")
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(fake.called("updateIssue")).toHaveLength(1)
    expect(fake.issues.get("STEP-7")!.description.match(/the record is in/g)).toHaveLength(1)
    expect(monday.called("postUpdate").filter((c) => /I added your answer/.test(String(c[1])))).toHaveLength(1)
  })

  it("records a PASS once when closing the loop fails after it", async () => {
    const { bridge, monday, fake, later, people, logged } = setup([
      issue({ id: "STEP-5", title: "Fix the date", state: "Needs Correction", labels: ["polads"] }),
      issue({ id: "STEP-8", title: "UAT fix: the date", state: "Waiting for UAT", labels: ["polads", "bug"] }),
    ], { parents: { "STEP-8": "STEP-5" } })
    people.parentOf = async () => {
      throw new Error("Linear: gave up after 6 attempts (last status 503)")
    }
    await bridge.sync()
    const item = monday.item(/UAT fix: the date/)!
    later(1)
    monday.says(item.id, NATE, "PASS")
    later(2)
    await bridge.sync()
    later(2)
    await bridge.sync()
    expect(fake.called("comment").filter((c) => c[0] === "STEP-8")).toHaveLength(1)
    expect(fake.issues.get("STEP-8")!.state).toBe("Approved")
    expect(logged.some((l) => l.level === "warn" && /closing the loop failed after the words were recorded/.test(l.msg))).toBe(true)
  })

  it("keeps a refused Answer column change redacted on the record", async () => {
    const { bridge, monday, later, failOn, paths } = setup([issue({ id: "STEP-7", state: "On hold", labels: ["human-todo"] })])
    await bridge.sync()
    failOn.push("updateIssue")
    later(1)
    monday.answers(monday.item(/job for a person/)!.id, NATE, "the key is xoxb-1-2-abc")
    later(2)
    await bridge.sync()
    const [kept] = readRecords(paths).flatMap((r) => Object.values(r.retry ?? {}))
    expect(kept.text).toBe("the key is [redacted]")
  })
})
