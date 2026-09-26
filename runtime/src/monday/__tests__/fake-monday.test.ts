import { describe, expect, it } from "vitest"
import { MondayRefused } from "../client.ts"
import { BOARD, fakeMonday, GROUPS, NEEDS_COLUMNS, T0 } from "./fake-monday.ts"

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
})
