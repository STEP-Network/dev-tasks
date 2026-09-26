/**
 * agentctl monday migrate (spec 8): the Requests group moves to the Requests
 * board, open Slack asks are labelled, with a snapshot and a way back. Made-up
 * people and ids; the Needs-you board's ids are public since STEP-3289.
 */
import { existsSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths, ConfigSchema } from "../../config.ts"
import type { Logger } from "../../log.ts"
import type { TrackerIssue } from "../../tracker.ts"
import { fakeTracker, issue } from "../../__tests__/fakes.ts"
import { createMondayBridge } from "../bridge.ts"
import { applyMigration, BRIDGE_WAIT, planMigration, readSnapshots, reverseMigration, type MigrateDeps } from "../migrate.ts"
import type { PeopleIssue } from "../people.ts"
import { migratingPath, readRecords, saveRecord, syncingPath, writeCursor } from "../store.ts"
import { BOARD, fakeMonday, fakePeople, GROUPS, NEEDS_COLUMNS as COL, REQ, REQUEST_COLUMNS, REQUEST_GROUPS, T0 } from "./fake-monday.ts"

const quiet: Logger = { info: () => {}, warn: () => {}, error: () => {} }
/** The bridge's last poll, an hour ago: agentd has stopped polling since it was turned off. */
const polledLongAgo = (paths: ReturnType<typeof agentPaths>) => writeCursor(paths, new Date(Date.now() - 60 * 60_000))
const column = (id: string, types: Record<string, string> = {}) => ({ id, title: id, type: types[id] ?? "text" })

/**
 * The two boards, the Needs-you board's columns with one the bridge does not
 * know (and more, of the `types` given), and a bridge on the same paths for
 * one poll.
 */
function setup(bridge: { enabled: boolean }, seed: TrackerIssue[] = [], types: Record<string, string> = {}) {
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
  const extra = Object.keys(types).filter((id) => !Object.values(COL).includes(id) && id !== "col_extra")
  monday.columnsOf(BOARD, [column("name"), ...[...Object.values(COL), "col_extra", ...extra].map((id) => column(id, types))])
  monday.columnsOf(REQ, [column("name"), ...Object.values(REQUEST_COLUMNS).map((id) => column(id))])
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
    // It holds every column's value: only this user reads it.
    expect(statSync(result.snapshot).mode & 0o777).toBe(0o600)
    expect(snapshot.items).toEqual([expect.objectContaining({ itemId: a, name: "Export notices", groupId: "g_req", columns: expect.objectContaining({ [COL.kind]: expect.any(String), [COL.state]: expect.any(String) }) })])
    expect(monday.calls.findIndex((c) => c.method === "moveItemToBoard")).toBeGreaterThan(monday.calls.findIndex((c) => c.method === "readBoard"))
  })

  it("has its snapshot written before anything that can fail, and lets the lock go when it stops", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    monday.request("111", "Export notices", undefined, "g_req")
    const plan = await planMigration(deps)
    const api = { ...monday.api, readBoard: (board: string, columns: string[], watch: { columnIds: string[]; since: Date }) => (board === REQ ? Promise.reject(new Error("Monday: gave up after 3 attempts (status 503)")) : monday.api.readBoard(board, columns, watch)) }
    await expect(applyMigration({ ...deps, api }, plan)).rejects.toThrow(/status 503/)
    expect(readdirSync(join(paths.state, "monday")).filter((f) => f.startsWith("migration-"))).toHaveLength(1)
    expect(monday.called("moveItemToBoard")).toEqual([])
    expect(existsSync(migratingPath(paths))).toBe(false)
  })

  it("reverses: each item back in its group with every column as it was, the labels off, and the items made for them archived", async () => {
    const { deps, monday, fake, paths, bridgeOnce } = setup({ enabled: false }, [issue({ id: "STEP-40", title: "Old Slack ask", state: "Triage", description: "x\n\n---\nFiled from Slack by Ada: https://acme.slack.com/archives/C1/p1" })])
    const a = monday.request("111", "Export notices", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" } })
    const before = structuredClone(monday.items.get(a)!.columns)
    const result = await applyMigration(deps, await planMigration(deps))
    await bridgeOnce() // the bridge, turned on, made STEP-40's request item
    const made = readRecords(paths).find((r) => r.issue === "STEP-40")!.itemId
    polledLongAgo(paths)
    const back = await reverseMigration(deps, readSnapshots(result.snapshot))
    expect(back).toMatchObject({ restored: [a], unlabelled: ["STEP-40"], archived: [made], kept: [], failed: [] })
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

describe("agentctl monday migrate: the review's FIX FIRST list", () => {
  it("finishes a way back that stopped half-way on a second run: each column on its own, and only what still differs", async () => {
    const { deps, monday } = setup({ enabled: false })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" }, [COL.state]: { label: "Waiting on agent" } })
    const before = structuredClone(monday.items.get(a)!.columns)
    const snap = readSnapshots((await applyMigration(deps, await planMigration(deps))).snapshot)
    monday.brokenColumns.add(COL.kind)
    const first = await reverseMigration(deps, snap)
    expect(first.restored).toEqual([])
    expect(first.failed).toEqual([expect.objectContaining({ what: `item ${a} (Export notices), column ${COL.kind}` })])
    // The item is back, and the columns Monday took are there: the one it refused waits for the next run.
    expect([monday.boardOf(a), monday.items.get(a)!.groupId]).toEqual([BOARD, "g_req"])
    expect(monday.items.get(a)!.columns[COL.state]).toEqual(before[COL.state])
    monday.brokenColumns.clear()
    const writes = monday.called("setColumns").length
    expect(await reverseMigration(deps, snap)).toMatchObject({ restored: [a], failed: [] })
    expect(monday.called("setColumns").slice(writes)).toEqual([[BOARD, a, { [COL.kind]: { label: "Request" } }]])
    expect(monday.items.get(a)!.columns[COL.kind]).toEqual(before[COL.kind])
    // All back: a third run changes nothing.
    const done = monday.calls.length
    expect(await reverseMigration(deps, snap)).toMatchObject({ restored: [a], failed: [] })
    expect(monday.calls.slice(done).filter((c) => !["readBoard", "boardColumns"].includes(c.method))).toEqual([])
    // Moved to another group since: the way back puts it in its own.
    await monday.api.moveItem(a, "g_done")
    await reverseMigration(deps, snap)
    expect(monday.items.get(a)!.groupId).toBe("g_req")
  })

  it("restores only what Monday lets it write, in the form Monday takes: a connected item as item ids, no read-only column", async () => {
    const { deps, monday } = setup({ enabled: false }, [], { col_extra: "formula", col_rel: "board_relation", [COL.kind]: "status" })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    const item = monday.items.get(a)!
    const changedAt = "2026-09-01T10:00:00.000Z"
    item.columns.col_extra = { text: "3", value: "3" }
    item.columns.col_rel = { text: "Old request", value: JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 42 }], changed_at: changedAt }) }
    item.columns[COL.kind] = { text: "Request", value: JSON.stringify({ index: 3, post_id: null, changed_at: changedAt }) }
    const snap = readSnapshots((await applyMigration(deps, await planMigration(deps))).snapshot)
    const writes = monday.called("setColumns").length
    expect(await reverseMigration(deps, snap)).toMatchObject({ restored: [a], failed: [] })
    const wrote = monday.called("setColumns").slice(writes).map((call) => call[2] as Record<string, unknown>)
    expect(wrote).toEqual(expect.arrayContaining([{ col_rel: { item_ids: [42] } }, { [COL.kind]: { index: 3 } }]))
    expect(wrote.filter((v) => "col_extra" in v)).toEqual([])
  })

  it("never archives an item a person made that the bridge took over: it stays, and the bridge lets it go", async () => {
    const { deps, monday, paths, bridgeOnce } = setup({ enabled: false }, [issue({ id: "STEP-40", title: "Old Slack ask", state: "Triage", description: "x\n\n---\nFiled from Slack by Ada: https://acme.slack.com/archives/C1/p1" })])
    // Outside Active, so it is not a new ask of Ben's: only the link makes it STEP-40's.
    const mine = monday.request("222", "Ben's own item", undefined, "r_closed", REQ)
    await monday.api.setColumns(REQ, mine, { r_linear: { url: "https://linear.app/step/issue/STEP-40", text: "STEP-40" } })
    const result = await applyMigration(deps, await planMigration(deps))
    await bridgeOnce()
    expect(readRecords(paths).find((r) => r.issue === "STEP-40")).toMatchObject({ itemId: mine, takenOver: true })
    polledLongAgo(paths)
    expect(await reverseMigration(deps, readSnapshots(result.snapshot))).toMatchObject({ archived: [], kept: [mine], unlabelled: ["STEP-40"], failed: [] })
    expect(monday.items.has(mine)).toBe(true)
    expect(readRecords(paths).find((r) => r.issue === "STEP-40")).toBeUndefined()
  })

  it("leaves an item with subitems or files where it is, and says why: the move would lose them", async () => {
    const { deps, monday } = setup({ enabled: false }, [], { col_sub: "subtasks", col_file: "file" })
    const a = monday.request("111", "Has subitems", undefined, "g_req")
    const b = monday.request("111", "Has a file", undefined, "g_req")
    const c = monday.request("111", "Plain", undefined, "g_req")
    monday.items.get(a)!.columns.col_sub = { text: "Step one", value: JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 7 }] }) }
    monday.items.get(b)!.columns.col_file = { text: "https://files.example/x.pdf", value: JSON.stringify({ files: [{ name: "x.pdf" }] }) }
    const plan = await planMigration(deps)
    expect(plan.moves.map((m) => m.itemId)).toEqual([c])
    const fix = "which the move would lose: move them off or remove them by hand, then run again"
    expect(plan.refused).toEqual([
      { itemId: a, name: "Has subitems", why: `it has subitems, ${fix}` },
      { itemId: b, name: "Has a file", why: `it has files in col_file, ${fix}` },
    ])
    const done = await applyMigration(deps, plan)
    expect(done.moved).toEqual([c])
    expect(done.failed).toEqual([
      { what: `item ${a} (Has subitems)`, error: `it has subitems, ${fix}` },
      { what: `item ${b} (Has a file)`, error: `it has files in col_file, ${fix}` },
    ])
    expect([monday.boardOf(a), monday.boardOf(b)]).toEqual([BOARD, BOARD])
    // One item alone that cannot go: planned, refused, never a "not in the group".
    expect(await planMigration(deps, a)).toMatchObject({ moves: [], refused: [{ itemId: a }] })
  })

  it("holds the bridge off while it runs, and refuses a second run, or one while the bridge polled lately", async () => {
    const { deps, monday, paths, bridgeOnce } = setup({ enabled: false })
    monday.request("111", "Export notices", undefined, "g_req")
    mkdirSync(join(paths.state, "monday"), { recursive: true })
    writeFileSync(migratingPath(paths), "left from an earlier run")
    await expect(applyMigration(deps, await planMigration(deps))).rejects.toThrow(/a migration is running on this mini, or one stopped half-way/)
    await expect(reverseMigration(deps, { at: T0.toISOString(), needsBoard: BOARD, requestsBoard: REQ, items: [], labelled: [] })).rejects.toThrow(/a migration is running/)
    // The bridge does not poll while one runs.
    const reads = monday.called("readBoard").length
    await bridgeOnce()
    expect(monday.called("readBoard")).toHaveLength(reads)
    rmSync(migratingPath(paths))
    // agentd still polls with the bridge on, from before the config said off.
    await bridgeOnce()
    await expect(applyMigration(deps, await planMigration(deps))).rejects.toThrow(/the Monday bridge read the board \d+ seconds ago/)
    expect(monday.called("moveItemToBoard")).toEqual([])
    polledLongAgo(paths)
    expect((await applyMigration(deps, await planMigration(deps))).moved).toHaveLength(1)
    expect(existsSync(migratingPath(paths))).toBe(false)
  })

  it("restores an item a first run could not move as the run that moved it found it", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    const a = monday.request("111", "One", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" } })
    monday.broken.add("moveItemToBoard")
    await applyMigration(deps, await planMigration(deps))
    monday.broken.delete("moveItemToBoard")
    // Changed while it waited on the Needs-you board: that is how it was when it moved.
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Check" } })
    await applyMigration(deps, await planMigration(deps))
    expect(readSnapshots(join(paths.state, "monday")).items).toEqual([expect.objectContaining({ itemId: a, columns: expect.objectContaining({ [COL.kind]: JSON.stringify({ label: "Check" }) }) })])
  })

  it("takes each item as the latest run that moved it found it, and leaves one no run moved, and its changes since, alone", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    const a = monday.request("111", "One", undefined, "g_req")
    const b = monday.request("111", "Two", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" } })
    await monday.api.setColumns(BOARD, b, { [COL.kind]: { label: "Request" } })
    // a moves and comes back, is changed, and moves again. b's move fails, and it is changed where it stayed.
    const first = await applyMigration(deps, await planMigration(deps, a))
    await reverseMigration(deps, readSnapshots(first.snapshot))
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Check" } })
    monday.down.add(b)
    expect((await applyMigration(deps, await planMigration(deps))).moved).toEqual([a])
    monday.down.delete(b)
    await monday.api.setColumns(BOARD, b, { [COL.kind]: { label: "Approval" } })
    const snap = readSnapshots(join(paths.state, "monday"))
    expect(snap.items.map((i) => [i.itemId, i.columns[COL.kind]])).toEqual([[a, JSON.stringify({ label: "Check" })]])
    await reverseMigration(deps, snap)
    expect([monday.items.get(a)!.columns[COL.kind]?.text, monday.items.get(b)!.columns[COL.kind]?.text]).toEqual(["Check", "Approval"])
  })

  it("never moves back an item that got subitems or files on the Requests board: the move would lose them", async () => {
    const { deps, monday } = setup({ enabled: false })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    const b = monday.request("111", "Wider buttons", undefined, "g_req")
    const snap = readSnapshots((await applyMigration(deps, await planMigration(deps))).snapshot)
    monday.columnsOf(REQ, [
      { id: "name", title: "name", type: "text" }, ...Object.values(REQUEST_COLUMNS).map((id) => ({ id, title: id, type: "text" })),
      { id: "r_sub", title: "Subitems", type: "subtasks" }, { id: "r_file", title: "Files", type: "file" },
    ])
    monday.items.get(a)!.columns.r_sub = { text: "Step one", value: JSON.stringify({ linkedPulseIds: [{ linkedPulseId: 7 }] }) }
    monday.items.get(b)!.columns.r_file = { text: "https://files.example/mockup.png", value: JSON.stringify({ files: [{ name: "mockup.png" }] }) }
    const back = await reverseMigration(deps, snap)
    const fix = "which the move would lose: move them off or remove them by hand, then run again"
    expect(back.failed).toEqual([
      { what: `item ${a} (Export notices)`, error: `it has subitems, ${fix}` },
      { what: `item ${b} (Wider buttons)`, error: `it has files in Files, ${fix}` },
    ])
    expect(back.restored).toEqual([])
    expect([monday.boardOf(a), monday.boardOf(b)]).toEqual([REQ, REQ])
  })

  it("writes down each item before it moves it, so a run cut short leaves a way back for what it moved", async () => {
    const { deps, monday } = setup({ enabled: false })
    const a = monday.request("111", "One", undefined, "g_req")
    const b = monday.request("111", "Two", undefined, "g_req")
    const seen: unknown[] = []
    let file = ""
    const api = {
      ...monday.api,
      moveItemToBoard: async (...args: Parameters<typeof monday.api.moveItemToBoard>) => {
        file ||= readdirSync(join(deps.paths.state, "monday")).find((f) => f.startsWith("migration-"))!
        const snap = JSON.parse(readFileSync(join(deps.paths.state, "monday", file), "utf8"))
        seen.push({ moved: snap.moved, moving: snap.moving })
        return monday.api.moveItemToBoard(...args)
      },
    }
    await applyMigration({ ...deps, api }, await planMigration(deps))
    expect(seen).toEqual([{ moved: [], moving: a }, { moved: [a], moving: b }])
    // Cut short while b moved: b counts as moved, as the run may have moved it.
    const snap = JSON.parse(readFileSync(join(deps.paths.state, "monday", file), "utf8"))
    writeFileSync(join(deps.paths.state, "monday", file), JSON.stringify({ ...snap, moved: [a], moving: b }))
    expect(readSnapshots(join(deps.paths.state, "monday", file)).items.map((i) => i.itemId)).toEqual([a, b])
  })

  it("waits a while for a bridge poll under way, never starts under one, and a bridge that stopped mid-poll holds nothing up", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    monday.request("111", "Export notices", undefined, "g_req")
    mkdirSync(join(paths.state, "monday"), { recursive: true })
    const was = { ...BRIDGE_WAIT }
    Object.assign(BRIDGE_WAIT, { waitMs: 60, stepMs: 10 })
    try {
      writeFileSync(syncingPath(paths), JSON.stringify({ pid: process.pid, at: new Date().toISOString() }))
      await expect(applyMigration(deps, await planMigration(deps))).rejects.toThrow(/the Monday bridge is still reading the board after/)
      expect(existsSync(migratingPath(paths))).toBe(false)
      expect(monday.called("moveItemToBoard")).toEqual([])
      // The poll ends while it waits: it goes ahead.
      Object.assign(BRIDGE_WAIT, { waitMs: 2_000 })
      setTimeout(() => rmSync(syncingPath(paths), { force: true }), 30)
      expect((await applyMigration(deps, await planMigration(deps))).moved).toHaveLength(1)
      // Its process is gone: the mark is stale, and nothing waits on it.
      monday.request("111", "Another", undefined, "g_req")
      writeFileSync(syncingPath(paths), JSON.stringify({ pid: 2 ** 22 + 12345, at: new Date().toISOString() }))
      Object.assign(BRIDGE_WAIT, { waitMs: 0 })
      expect((await applyMigration(deps, await planMigration(deps))).moved).toHaveLength(1)
    } finally {
      Object.assign(BRIDGE_WAIT, was)
    }
  })

  it("marks each poll while it works, and leaves no mark behind, polling or waiting for a migration", async () => {
    const { monday, paths, bridgeOnce } = setup({ enabled: false })
    let marked = false
    const reads = monday.api.readBoard
    monday.api.readBoard = async (...args) => {
      marked ||= existsSync(syncingPath(paths))
      return reads(...args)
    }
    await bridgeOnce()
    expect(marked).toBe(true)
    expect(existsSync(syncingPath(paths))).toBe(false)
    mkdirSync(join(paths.state, "monday"), { recursive: true })
    writeFileSync(migratingPath(paths), "a run")
    await bridgeOnce()
    expect(existsSync(syncingPath(paths))).toBe(false)
  })

  it("fails only the column whose kept value it cannot read, and restores the rest", async () => {
    const { deps, monday } = setup({ enabled: false })
    const a = monday.request("111", "Export notices", undefined, "g_req")
    await monday.api.setColumns(BOARD, a, { [COL.kind]: { label: "Request" }, [COL.state]: { label: "Waiting on agent" } })
    const snap = readSnapshots((await applyMigration(deps, await planMigration(deps))).snapshot)
    snap.items[0].columns[COL.kind] = "{not json"
    const back = await reverseMigration(deps, snap)
    expect(back.failed).toEqual([expect.objectContaining({ what: `item ${a} (Export notices), column ${COL.kind}` })])
    expect(monday.items.get(a)!.columns[COL.state]?.text).toBe("Waiting on agent")
  })

  it("reverses every run in a directory, each item as the run that moved it found it", async () => {
    const { deps, monday, paths } = setup({ enabled: false })
    const a = monday.request("111", "One", undefined, "g_req")
    const b = monday.request("111", "Two", undefined, "g_work")
    await applyMigration(deps, await planMigration(deps, a))
    await applyMigration(deps, await planMigration(deps))
    const snap = readSnapshots(join(paths.state, "monday"))
    expect(snap.items.map((i) => i.itemId).sort()).toEqual([a, b].sort())
    expect((await reverseMigration(deps, snap)).restored.sort()).toEqual([a, b].sort())
    expect([monday.items.get(a)!.groupId, monday.items.get(b)!.groupId]).toEqual(["g_req", "g_work"])
    expect(() => readSnapshots(mkdtempSync(join(tmpdir(), "no-snapshots-")))).toThrow(/holds no migration snapshot/)
  })
})
