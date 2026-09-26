import { describe, expect, it } from "vitest"
import { MondayRefused } from "../client.ts"
import { BOARD, fakeMonday, GROUPS, NEEDS_COLUMNS, SUBITEMS, T0 } from "./fake-monday.ts"

/** The fake is what Wave 2's tests read two boards through: it must behave as Monday does, or they prove nothing. */
describe("the in-memory Monday account", () => {
  const REQUESTS = "8800000001"
  const REQUEST_GROUPS = [{ id: "g_active", title: "Active" }]
  const two = () => fakeMonday(undefined, null, { [BOARD]: GROUPS, [REQUESTS]: REQUEST_GROUPS })
  const watch = (columnIds: string[] = [NEEDS_COLUMNS.answer]) => ({ columnIds, since: T0 })

  it("reads each board's own groups and items, and refuses a board it does not have", async () => {
    const monday = two()
    const needs = await monday.api.createItem(BOARD, "g_needs", "A question", {})
    const request = monday.request("111", "Export notices", undefined, "g_active", REQUESTS)
    expect((await monday.api.readBoard(BOARD, [], watch())).items.map((i) => i.id)).toEqual([needs])
    const board = await monday.api.readBoard(REQUESTS, [], watch())
    expect(board.groups).toEqual(REQUEST_GROUPS)
    expect(board.items.map((i) => [i.id, i.url])).toEqual([[request, `https://step.monday.com/boards/${REQUESTS}/pulses/${request}`]])
    await expect(monday.api.readBoard("123", [], watch())).rejects.toBeInstanceOf(MondayRefused)
  })

  it("moves an item between boards with its id, keeping only the mapped columns", async () => {
    const monday = two()
    const id = monday.request("111", "Export notices")
    await monday.api.setColumns(BOARD, id, { [NEEDS_COLUMNS.linear]: { url: "https://linear.app/x/issue/STEP-7", text: "STEP-7" }, [NEEDS_COLUMNS.agent]: { labels: ["Eve"] } })
    await monday.api.moveItemToBoard(REQUESTS, "g_active", id, [{ source: NEEDS_COLUMNS.linear, target: "col_req_linear" }, { source: NEEDS_COLUMNS.agent, target: null }])
    expect(monday.boardOf(id)).toBe(REQUESTS)
    const moved = monday.items.get(id)!
    expect(moved.groupId).toBe("g_active")
    expect(Object.keys(moved.columns)).toEqual(["col_req_linear"])
    expect(moved.columns.col_req_linear.text).toBe("STEP-7")
    expect((await monday.api.readBoard(BOARD, [], watch())).items).toEqual([])
  })

  it("refuses a move whose mapping leaves out one of the board's columns, as Monday does, and moves nothing", async () => {
    const monday = two()
    monday.columnsOf(BOARD, [{ id: "name", title: "Name", type: "name" }, { id: NEEDS_COLUMNS.linear, title: "Linear", type: "link" }, { id: NEEDS_COLUMNS.agent, title: "Agent", type: "dropdown" }])
    const id = monday.request("111", "Export notices")
    await expect(monday.api.moveItemToBoard(REQUESTS, "g_active", id, [{ source: NEEDS_COLUMNS.linear, target: "col_req_linear" }])).rejects.toThrow(
      new MondayRefused(`Monday: the column mapping leaves out ${NEEDS_COLUMNS.agent}`),
    )
    expect(monday.boardOf(id)).toBe(BOARD)
    await monday.api.moveItemToBoard(REQUESTS, "g_active", id, [{ source: NEEDS_COLUMNS.linear, target: "col_req_linear" }, { source: NEEDS_COLUMNS.agent, target: null }])
    expect(monday.boardOf(id)).toBe(REQUESTS)
  })

  it("writes a text column from a plain string and a connected column from item ids, and links items", async () => {
    const monday = two()
    const id = await monday.api.createItem(BOARD, "g_needs", "A question", { text_rec: "Use the order date", col_request: { item_ids: [42] } })
    expect(monday.items.get(id)!.columns.text_rec.text).toBe("Use the order date")
    expect(monday.items.get(id)!.columns.col_request.linked).toEqual(["42"])
    monday.link(id, "col_request", ["77"])
    expect((await monday.api.readBoard(BOARD, [], watch())).items[0].columns.col_request).toEqual({ text: null, value: null, linked: ["77"] })
  })

  it("keeps each column's log to the board and the columns watched", async () => {
    const monday = two()
    const needs = await monday.api.createItem(BOARD, "g_needs", "A question", {})
    const request = monday.request("111", "Export notices", undefined, "g_active", REQUESTS)
    monday.answers(needs, "111", "yes")
    monday.answers(request, "111", "Look", "col_class")
    expect((await monday.api.readBoard(BOARD, [], watch())).changes.map((c) => [c.itemId, c.columnId])).toEqual([[needs, NEEDS_COLUMNS.answer]])
    expect((await monday.api.readBoard(REQUESTS, [], watch(["col_class"]))).changes.map((c) => c.text)).toEqual(["Look"])
    expect((await monday.api.readBoard(REQUESTS, [], watch([]))).changes).toEqual([])
  })

  it("answers boardColumns with what the test set", async () => {
    const monday = two()
    monday.columnsOf(BOARD, [{ id: "name", title: "Name", type: "name" }])
    expect(await monday.api.boardColumns(BOARD)).toEqual([{ id: "name", title: "Name", type: "name" }])
    expect(await monday.api.boardColumns(REQUESTS)).toEqual([])
  })

  it("keeps subitems under their item on the subitems board, where writes reach them, and hands out copies", async () => {
    const monday = two()
    const parent = await monday.api.createItem(BOARD, "g_test", "Test day", {})
    const sub = await monday.api.createSubitem(parent, "1. Public: the notice page", { col_verdict: { label: "To test" } })
    expect(monday.boardOf(sub)).toBe(SUBITEMS)
    expect(monday.subitems.get(parent)?.map((s) => [s.name, s.columns.col_verdict.text])).toEqual([["1. Public: the notice page", "To test"]])
    await monday.api.setColumns(SUBITEMS, sub, { col_verdict: { label: "FAIL" } })
    expect(monday.subitems.get(parent)?.[0].columns.col_verdict.text).toBe("FAIL")
    await monday.api.setColumns(SUBITEMS, sub, { col_note: "the price shows 0" })
    const read = await monday.api.readSubitems(parent, ["col_verdict"])
    // Only the columns asked for, as Monday answers.
    expect(Object.keys(read[0].columns)).toEqual(["col_verdict"])
    expect((await monday.api.readSubitems(parent, ["col_note"]))[0].columns).toEqual({ col_note: { text: "the price shows 0", value: JSON.stringify("the price shows 0") } })
    read[0].name = "changed by the reader"
    expect(monday.subitems.get(parent)?.[0].name).toBe("1. Public: the notice page")
    // A subitem is not an item of its parent's board.
    expect((await monday.api.readBoard(BOARD, [], watch())).items.map((i) => i.id)).toEqual([parent])
    expect(await monday.api.readSubitems(await monday.api.createItem(BOARD, "g_test", "No checkpoints", {}), [])).toEqual([])
    await expect(monday.api.readSubitems("404", [])).rejects.toBeInstanceOf(MondayRefused)
    await expect(monday.api.createSubitem("404", "1. x", {})).rejects.toBeInstanceOf(MondayRefused)
  })

  it("reads a board's column log since a time, the subitems board's from subitemLogs, and refuses a board it does not have", async () => {
    const monday = two()
    const needs = await monday.api.createItem(BOARD, "g_needs", "A question", {})
    monday.answers(needs, "111", "yes")
    monday.answers(monday.request("111", "Export notices", undefined, "g_active", REQUESTS), "111", "no")
    monday.subitemLogs.push(
      { id: "s1", itemId: "701", userId: "111", text: "PASS", at: "2026-09-25T08:59:00.000Z", columnId: "col_verdict" },
      { id: "s2", itemId: "701", userId: "222", text: "FAIL", at: "2026-09-25T09:05:00.000Z", columnId: "col_verdict" },
      { id: "s3", itemId: "701", userId: "222", text: "a note", at: "2026-09-25T09:06:00.000Z", columnId: "col_note" },
    )
    expect((await monday.api.columnChanges(SUBITEMS, ["col_verdict"], T0)).map((c) => c.id)).toEqual(["s2"])
    expect((await monday.api.columnChanges(BOARD, [NEEDS_COLUMNS.answer], T0)).map((c) => c.itemId)).toEqual([needs])
    // As the client says it: out of the token's reach, not a refusal.
    const unseen = await monday.api.columnChanges("123", ["col_verdict"], T0).catch((e: Error) => e)
    expect(String(unseen)).toMatch(/no board 123/)
    expect(unseen).not.toBeInstanceOf(MondayRefused)
  })

  it("seeds a subitem and a doc a run saved before a restart, and writes reach them", async () => {
    const monday = two()
    const parent = await monday.api.createItem(BOARD, "g_test", "Test day", {})
    expect(monday.subitem(parent, "1. Public: the notice page", { col_verdict: { label: "To test" } }, "sub-1")).toBe("sub-1")
    const made = monday.subitem(parent, "2. Admin: the queue")
    expect(monday.boardOf("sub-1")).toBe(SUBITEMS)
    await monday.api.setColumns(SUBITEMS, "sub-1", { col_verdict: { label: "PASS" } })
    expect((await monday.api.readSubitems(parent, ["col_verdict"])).map((s) => [s.id, s.columns.col_verdict?.text ?? null])).toEqual([["sub-1", "PASS"], [made, null]])
    expect(() => monday.subitem(parent, "again", {}, "sub-1")).toThrow(/exists already/)
    expect(() => monday.subitem("404", "x")).toThrow(MondayRefused)
    monday.doc("doc-1", "# Test day")
    await monday.api.appendDoc("doc-1", "## Before you start")
    expect(monday.docs.get("doc-1")).toBe("# Test day\n## Before you start")
    // A new doc never takes a seeded one's id.
    expect(await monday.api.createItemDoc(parent, "col_doc", "Test day")).toBe("doc-2")
    expect(monday.docs.get("doc-1")).toBe("# Test day\n## Before you start")
  })

  it("renames an item only on its own board", async () => {
    const monday = two()
    const id = await monday.api.createItem(BOARD, "g_test", "Test day", {})
    await monday.api.renameItem(BOARD, id, "Test day 2026-10-02")
    expect(monday.items.get(id)!.name).toBe("Test day 2026-10-02")
    await expect(monday.api.renameItem(REQUESTS, id, "x")).rejects.toBeInstanceOf(MondayRefused)
    await expect(monday.api.renameItem(BOARD, "404", "x")).rejects.toBeInstanceOf(MondayRefused)
  })

  it("creates a named doc on an item, appends markdown to it as one text, and refuses a doc it does not have", async () => {
    const monday = two()
    const id = await monday.api.createItem(BOARD, "g_test", "Test day", {})
    const doc = await monday.api.createItemDoc(id, "col_doc", "Test day 2026-10-02")
    expect(doc).toBe("doc-1")
    expect(monday.docNames.get(doc)).toBe("Test day 2026-10-02")
    await monday.api.appendDoc(doc, "# Test day")
    await monday.api.appendDoc(doc, "## Before you start\r\nSign in")
    expect(monday.docs.get(doc)).toBe("# Test day\n## Before you start\nSign in")
    await expect(monday.api.appendDoc("doc-9", "x")).rejects.toBeInstanceOf(MondayRefused)
    await expect(monday.api.createItemDoc("404", "col_doc", "x")).rejects.toBeInstanceOf(MondayRefused)
  })

  it("counts the new calls as writes or reads, and fails a write as an outage would when told to", async () => {
    const monday = two()
    const id = await monday.api.createItem(BOARD, "g_test", "Test day", {})
    await monday.api.readSubitems(id, [])
    await monday.api.columnChanges(SUBITEMS, ["col_verdict"], T0)
    await monday.api.createSubitem(id, "1. x", {})
    await monday.api.renameItem(BOARD, id, "Test day 2026-10-02")
    const doc = await monday.api.createItemDoc(id, "col_doc", "Test day")
    await monday.api.appendDoc(doc, "x")
    expect(monday.writes().map((c) => c.method)).toEqual(["createItem", "createSubitem", "renameItem", "createItemDoc", "appendDoc"])
    for (const method of ["createSubitem", "renameItem", "createItemDoc", "appendDoc"]) monday.broken.add(method)
    for (const call of [monday.api.createSubitem(id, "2. y", {}), monday.api.renameItem(BOARD, id, "z"), monday.api.createItemDoc(id, "col_doc", "z"), monday.api.appendDoc(doc, "z")]) {
      const error = await call.catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(MondayRefused)
    }
    expect(monday.subitems.get(id)).toHaveLength(1)
    expect(monday.items.get(id)!.name).toBe("Test day 2026-10-02")
    expect(monday.docs.get(doc)).toBe("x")
  })
})
