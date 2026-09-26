/**
 * agentctl monday migrate (spec 8): the Requests group moves to the Requests
 * board, open Slack asks are labelled, with a snapshot and a way back. Made-up
 * people and ids; the Needs-you board's ids are public since STEP-3289.
 */
import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import type { Logger } from "../../log.ts"
import type { TrackerIssue } from "../../tracker.ts"
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import { createMondayBridge } from "../bridge.ts"
import { applyMigration, planMigration, reverseMigration, type MigrateDeps } from "../migrate.ts"
import type { PeopleIssue } from "../people.ts"
import { readRecords, saveRecord } from "../store.ts"
import { BOARD, fakeMonday, fakePeople, GROUPS, NEEDS_COLUMNS as COL, REQ, REQUEST_COLUMNS, REQUEST_GROUPS, T0 } from "./fake-monday.ts"

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} }
const column = (id: string) => ({ id, title: id, type: "text" })

/** The two boards, the Needs-you board's columns with one the bridge does not know, and a bridge on the same paths for one poll. */
function setup(bridge: { enabled: boolean }, seed: TrackerIssue[] = []) {
  const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-migrate-")))
  const configFor = (enabled: boolean) =>
    ConfigSchema.parse({
      mini: "eve", repo: { path: "/r", product: "polads" }, pluginRoot: "/p", slack: { allowedUsers: ["UADA", "UBEN"] },
      bridges: {
        monday: {
          enabled, people: [{ id: "111", name: "Ada", slackId: "UADA" }, { id: "222", name: "Ben", slackId: "UBEN" }], defaultPerson: "111",
          requests: { boardId: REQ, columns: REQUEST_COLUMNS },
        },
      },
    })
  const monday = fakeMonday(undefined, null, { [BOARD]: GROUPS, [REQ]: REQUEST_GROUPS })
  monday.columnsOf(BOARD, [column("name"), ...Object.values(COL).map(column), column("col_extra")])
  monday.columnsOf(REQ, [column("name"), ...Object.values(REQUEST_COLUMNS).map(column)])
  const fake = fakeTracker(seed)
  const { people } = fakePeople(fake.issues)
  const deps: MigrateDeps = { config: configFor(bridge.enabled), paths, api: monday.api, tracker: fake.tracker, people }
  const bridgeOnce = () => createMondayBridge({ paths, config: configFor(true), log: quiet, now: () => new Date(), api: monday.api, tracker: fake.tracker, people }).sync()
  return { deps, monday, fake, paths, bridgeOnce }
}

describe("agentctl monday migrate (spec 8)", () => {
  it("plans every item of the Requests and Agents working on groups, Linear and Person carried and every other column dropped", async () => {
    const { deps, monday } = setup({ enabled: false })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    const b = monday.request("222", "Wider buttons", undefined, "g_work")
    monday.request("111", "A question", undefined, "g_needs")
    const plan = await planMigration(deps)
    expect(plan.moves.map((m) => [m.itemId, m.from, m.to])).toEqual([[a, "Requests", "active"], [b, "Agents working on", "active"]])
    expect(plan.mapping).toEqual([
      { source: COL.person, target: "r_person" }, { source: COL.kind, target: null }, { source: COL.state, target: null }, { source: COL.agent, target: null },
      { source: COL.linear, target: "r_linear" }, { source: COL.pr, target: null }, { source: COL.due, target: null }, { source: COL.answer, target: null }, { source: "col_extra", target: null },
    ])
  })

  it("sends a request that is already done to Released", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    const a = monday.request("111", "Old request", undefined, "g_work")
    saveRecord(paths, { key: `request-${a}`, kind: "request", issue: "STEP-5", itemId: a, state: "Done", bodyHash: null, createdAt: T0.toISOString(), doneAt: T0.toISOString(), handled: [] })
    expect((await planMigration(deps)).moves[0].to).toBe("released")
  })

  it("labels only open, parentless issues filed from Slack that carry neither intake label", async () => {
    const { deps } = setup({ enabled: false }, [
      issue({ id: "STEP-40", title: "Old Slack ask", state: "Triage", description: "x\n\n---\nFiled from Slack by Ada: https://acme.slack.com/archives/C1/p1" }),
      issue({ id: "STEP-41", state: "Triage", labels: ["intake/slack"], description: "Filed from Slack by Ada" }),
      issue({ id: "STEP-42", state: "Triage", labels: ["intake/monday"], description: "Filed from Slack by Ada" }),
    ])
    expect((await planMigration(deps)).label.map((l) => l.issue)).toEqual(["STEP-40"])
  })

  it("refuses to move anything while the bridge is on", async () => {
    const { deps, monday } = setup({ enabled: true })
    monday.request("111", "Export notices", undefined, "g_req")
    await expect(applyMigration(deps, await planMigration(deps))).rejects.toThrow(/turn the Monday bridge off first/)
    expect(monday.called("moveItemToBoard")).toEqual([])
  })

  it("moves each item once, keeping its id and its record, and a second run moves nothing", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    saveRecord(paths, { key: `request-${a}`, kind: "request", issue: "STEP-5", itemId: a, state: "Waiting on agent", bodyHash: null, createdAt: T0.toISOString(), doneAt: null, handled: [] })
    expect((await applyMigration(deps, await planMigration(deps))).moved).toEqual([a])
    expect([monday.boardOf(a), monday.items.get(a)!.groupId]).toEqual([REQ, "r_active"])
    expect(readRecords(paths)[0].itemId).toBe(a)
    expect((await applyMigration(deps, await planMigration(deps))).moved).toEqual([])
  })

  it("writes a snapshot of every item it will move, with every column and its group, before the first move", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" }, [COL.state]: { label: "Waiting on agent" } })
    const result = await applyMigration(deps, await planMigration(deps))
    const snapshot = JSON.parse(readFileSync(result.snapshot, "utf8"))
    expect(result.snapshot.startsWith(join(paths.state, "monday", "migration-"))).toBe(true)
    expect(snapshot.items).toEqual([expect.objectContaining({ itemId: a, name: "Export notices", groupId: "g_req", columns: expect.objectContaining({ [COL.kind]: expect.any(String), [COL.state]: expect.any(String) }) })])
    expect(monday.calls.findIndex((c) => c.method === "moveItemToBoard")).toBeGreaterThan(monday.calls.findIndex((c) => c.method === "readBoard"))
  })

  it("reverses: each item back in its group with every column as it was, the labels off, and the items made for them archived", async () => {
    const { deps, monday, fake, paths, bridgeOnce } = setup({ enabled: false }, [issue({ id: "STEP-40", title: "Old Slack ask", state: "Triage", description: "x\n\n---\nFiled from Slack by Ada: https://acme.slack.com/archives/C1/p1" })])
    const a = monday.request("111", "Export notices", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" } })
    const before = structuredClone(monday.items.get(a)!.columns)
    const result = await applyMigration(deps, await planMigration(deps))
    await bridgeOnce() // the bridge, turned on, made STEP-40's request item
    const made = readRecords(paths).find((r) => r.issue === "STEP-40")!.itemId
    const back = await reverseMigration(deps, JSON.parse(readFileSync(result.snapshot, "utf8")))
    expect(back).toMatchObject({ restored: [a], unlabelled: ["STEP-40"], archived: [made], failed: [] })
    expect([monday.boardOf(a), monday.items.get(a)!.groupId]).toEqual([BOARD, "g_req"])
    expect(monday.items.get(a)!.columns[COL.kind]).toEqual(before[COL.kind])
    expect(fake.issues.get("STEP-40")!.labels).not.toContain("intake/slack")
    expect(monday.items.has(made)).toBe(false)
  })

  it("reports a Monday failure half-way, and a second run finishes the rest", async () => {
    const { deps, monday } = setup({ enabled: false })
    const a = monday.request("111", "One", undefined, "g_req")
    const b = monday.request("111", "Two", undefined, "g_req")
    monday.broken.add("moveItemToBoard")
    expect((await applyMigration(deps, await planMigration(deps))).failed).toHaveLength(2)
    monday.broken.delete("moveItemToBoard")
    expect((await applyMigration(deps, await planMigration(deps))).moved).toEqual([a, b])
  })

  it("never labels a sub-issue or one filed from the board, whatever the people view gives", async () => {
    const { deps } = setup({ enabled: false })
    const view = (id: string, over: Partial<PeopleIssue>): PeopleIssue => ({
      id, uuid: `uuid-${id}`, title: id, description: "Filed from Slack by Ada", url: `https://linear.app/step/issue/${id}`, state: "Triage", stateType: "triage",
      labels: [], owner: null, requester: null, dueDate: null, prUrl: null, uatSteps: null, parent: null, slackThread: null, project: null, ...over,
    })
    const people = { openIssuesFiledFromSlack: async () => [view("STEP-50", {}), view("STEP-51", { parent: "STEP-50" }), view("STEP-52", { labels: ["intake/monday"] })] }
    expect((await planMigration({ ...deps, people })).label.map((l) => l.issue)).toEqual(["STEP-50"])
  })

  it("plans one item alone with --only, and labels nothing then", async () => {
    const { deps, monday } = setup({ enabled: false }, [issue({ id: "STEP-40", state: "Triage", description: "Filed from Slack by Ada" })])
    monday.request("111", "One", undefined, "g_req")
    const b = monday.request("111", "Two", undefined, "g_work")
    const plan = await planMigration(deps, b)
    expect([plan.moves.map((m) => m.itemId), plan.label]).toEqual([[b], []])
    await expect(planMigration(deps, "999")).rejects.toThrow(/999 is not in the Requests or Agents working on group/)
  })

  it("refuses to plan before the Requests board is in config", async () => {
    const { deps } = setup({ enabled: false })
    const bare = { ...deps, config: ConfigSchema.parse({ ...deps.config, bridges: { monday: { ...deps.config.bridges.monday!, requests: undefined } } }) }
    await expect(planMigration(bare)).rejects.toThrow(/bridges\.monday\.requests is not in config\.json/)
  })

  it("refuses to reverse while the bridge is on", async () => {
    const { deps } = setup({ enabled: true })
    await expect(reverseMigration(deps, { at: T0.toISOString(), needsBoard: BOARD, requestsBoard: REQ, items: [], labelled: [] })).rejects.toThrow(/turn the Monday bridge off first/)
  })
})
