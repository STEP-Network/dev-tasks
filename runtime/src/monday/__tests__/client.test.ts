import { describe, expect, it } from "vitest"
import { createMondayApi, MONDAY_API_VERSION, MONDAY_ENDPOINT, MondayRefused } from "../client.ts"

// Built at run time, so no secret scanner mistakes the fixture for a real token.
const TOKEN = ["eyJhbGciOiJIUzI1NiJ9", "eyJ0aWQiOjEyMzQ1Njc4OX0", "c2lnbmF0dXJlLXRlc3Q"].join(".")

type Sent = { url: string; init: RequestInit; body: { query: string; variables: Record<string, unknown> } }

/** A fetch that answers each call in turn, and records what was sent. */
function fakeFetch(answers: Array<{ status?: number; json?: unknown }>) {
  const sent: Sent[] = []
  const f = (async (url: string, init: RequestInit) => {
    sent.push({ url, init, body: JSON.parse(String(init.body)) })
    const a = answers.shift() ?? { json: { data: {} } }
    return new Response(JSON.stringify(a.json ?? {}), { status: a.status ?? 200 })
  }) as unknown as typeof fetch
  return { f, sent }
}

const noSleep = async () => {}
const WATCH = { columnIds: ["long_text_mm7hzj39"], since: new Date("2026-09-25T08:00:00.000Z") }

describe("the Monday API client (STEP-3289)", () => {
  it("sends the token only in the Authorization header, on a pinned version, and never follows a redirect with it", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { me: { id: "900", name: "PolAds agents", is_admin: false } } } }])
    const me = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).me()
    expect(me).toEqual({ id: "900", name: "PolAds agents", isAdmin: false })
    expect(sent[0].url).toBe(MONDAY_ENDPOINT)
    expect(sent[0].init.headers).toEqual({ "Content-Type": "application/json", Authorization: TOKEN, "API-Version": MONDAY_API_VERSION })
    expect(sent[0].init.redirect).toBe("error")
    expect(JSON.stringify(sent[0].body)).not.toContain(TOKEN)
  })

  it("names what Monday refused, and never the token", async () => {
    const { f } = fakeFetch([{ json: { errors: [{ message: `Not authorized for ${TOKEN}` }] } }])
    const error = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).me().catch((e: Error) => e)
    expect(String(error)).toMatch(/^Error: Monday: Not authorized for \[redacted\]$/)
    expect(error).toBeInstanceOf(MondayRefused)
  })

  it("tells a limit from a refusal: a limit is Monday out of reach for a while, not this request refused", async () => {
    for (const json of [
      { errors: [{ message: "Complexity budget exhausted, query cost 30001 budget remaining 29958 out of 10000000" }] },
      { error_code: "DAILY_LIMIT_EXCEEDED", error_message: "Daily limit exceeded" },
      { errors: [{ message: "Rate Limit Exceeded", extensions: { code: "RATE_LIMIT_EXCEEDED" } }] },
      { errors: [{ message: "Something went wrong", extensions: { code: "INTERNAL_SERVER_ERROR" } }] },
    ]) {
      const error = await createMondayApi(TOKEN, { fetch: fakeFetch([{ json }]).f, sleep: noSleep }).me().catch((e: Error) => e)
      expect(error).toBeInstanceOf(Error)
      expect(error).not.toBeInstanceOf(MondayRefused)
    }
  })

  it("waits out a rate limit or a server error, then gives up naming the status", async () => {
    const { f, sent } = fakeFetch([{ status: 429 }, { status: 502 }, { json: { data: { me: { id: "1", name: "x", is_admin: false } } } }])
    expect((await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).me()).id).toBe("1")
    expect(sent).toHaveLength(3)
    const down = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }])
    await expect(createMondayApi(TOKEN, { fetch: down.f, sleep: noSleep }).me()).rejects.toThrow(/gave up after 3 attempts \(status 503\)/)
  })

  it("reads the whole board in one call: its groups, its items with their updates and replies, and who changed the Answer column", async () => {
    const item = (id: string, over: Record<string, unknown> = {}) => ({
      id, name: `Item ${id}`, url: `https://step.monday.com/boards/1/pulses/${id}`, created_at: "2026-09-25T08:00:00Z", creator_id: "111",
      group: { id: "topics" }, column_values: [{ id: "color_mm7hvyyt", text: "Needs you", value: '{"index":1}' }], updates: [], ...over,
    })
    const log = (id: string, event: string, data: unknown) => ({ id, event, data: JSON.stringify(data), user_id: "111", created_at: "17592384000000000" })
    const { f, sent } = fakeFetch([
      {
        json: {
          data: {
            boards: [{
              groups: [{ id: "topics", title: "Needs you" }],
              items_page: {
                cursor: "c1",
                items: [item("10", {
                  updates: [{ id: "u1", creator_id: "111", text_body: "merge it", created_at: "2026-09-25T09:00:00Z", replies: [{ id: "r1", creator_id: "222", text_body: "agreed", created_at: "2026-09-25T09:05:00Z" }] }],
                })],
              },
              activity_logs: [
                log("a1", "update_column_value", { pulse_id: 10, column_id: "long_text_mm7hzj39", value: { text: "leave it", changed_at: "x" } }),
                log("a2", "update_column_value", { pulse_id: 10, column_id: "color_mm7hvyyt", value: { label: { text: "Done" } } }),
                log("a3", "create_pulse", { pulse_id: 11 }),
                { id: "a4", event: "update_column_value", data: "not json", user_id: "111", created_at: "1" },
                log("a5", "update_column_value", { pulse_id: 12, column_id: "long_text_mm7hzj39", value: null }),
              ],
            }],
          },
        },
      },
      { json: { data: { next_items_page: { cursor: null, items: [item("11", { creator_id: null })] } } } },
    ])
    const since = new Date("2026-09-25T08:00:00.000Z")
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5104953028", ["color_mm7hvyyt"], { columnIds: ["long_text_mm7hzj39"], since })
    expect(board.groups).toEqual([{ id: "topics", title: "Needs you" }])
    expect(board.items.map((i) => i.id)).toEqual(["10", "11"])
    expect(board.items[0]).toMatchObject({ groupId: "topics", creatorId: "111", columns: { color_mm7hvyyt: { text: "Needs you", value: '{"index":1}' } } })
    expect(board.items[0].updates).toEqual([
      { id: "u1", creatorId: "111", text: "merge it", createdAt: "2026-09-25T09:00:00Z", threadId: "u1" },
      { id: "r1", creatorId: "222", text: "agreed", createdAt: "2026-09-25T09:05:00Z", threadId: "u1" },
    ])
    expect(board.items[1].creatorId).toBeNull()
    expect(board.changes).toEqual([{ id: "a1", itemId: "10", userId: "111", text: "leave it", at: "2025-09-30T13:20:00.000Z", columnId: "long_text_mm7hzj39" }])
    // The log rides on the board's own call: a second call only for the items past the first 100.
    expect(sent).toHaveLength(2)
    expect(sent[0].body.variables).toEqual({ board: ["5104953028"], columns: ["color_mm7hvyyt"] })
    expect(sent[0].body.query).toContain('activity_logs(column_ids: ["long_text_mm7hzj39"]')
    expect(sent[0].body.query).toContain(`from: "${since.toISOString()}"`)
    expect(sent[1].body.variables).toMatchObject({ cursor: "c1" })
  })

  it("refuses a board the token's user cannot see, rather than read it as empty", async () => {
    const { f } = fakeFetch([{ json: { data: { boards: [] } } }])
    await expect(createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5104953028", [], WATCH)).rejects.toThrow(/no board 5104953028/)
  })

  it("reads the account's daily call limit, and says null when monday does not", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { platform_api: { daily_limit: { base: 1000, total: 1500 } } } } }, { json: { data: { platform_api: null } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    expect(await api.dailyLimit()).toBe(1500)
    expect(await api.dailyLimit()).toBeNull()
    expect(sent[0].body.query).toMatch(/^query \{ platform_api \{ daily_limit \{ base total \} \} \}$/)
  })

  it("writes column values as one JSON string, and never lets Monday invent a label", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { create_item: { id: "77" } } } }, { json: { data: { create_update: { id: "u9" } } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    expect(await api.createItem("5104953028", "topics", "Needs a person: X", { color_mm7hvyyt: { label: "Needs you" } })).toBe("77")
    expect(sent[0].body.query).toContain("create_labels_if_missing: false")
    expect(sent[0].body.variables).toEqual({ board: "5104953028", group: "topics", name: "Needs a person: X", values: '{"color_mm7hvyyt":{"label":"Needs you"}}' })
    expect(await api.postUpdate("77", "Hello", "u1")).toBe("u9")
    expect(sent[1].body.variables).toEqual({ item: "77", body: "Hello", parent: "u1" })
  })

  it("puts only ids and column ids it has checked into a query", async () => {
    const api = createMondayApi(TOKEN, { fetch: fakeFetch([]).f, sleep: noSleep })
    await expect(api.readBoard('1"] } }', [], WATCH)).rejects.toThrow(/not a Monday id/)
    await expect(api.readBoard("1", [], { ...WATCH, columnIds: ["long_text_mm7hzj39", 'x"] '] })).rejects.toThrow(/not a Monday column id/)
  })
it("watches several columns and says which one changed", async () => {
    const log = (id: string, column: string, text: string) => ({ id, event: "update_column_value", user_id: "111", created_at: "2026-09-25T08:01:00.000Z", data: JSON.stringify({ column_id: column, pulse_id: 42, value: { label: { text } }, textual_value: text }) })
    const { f, sent } = fakeFetch([{ json: { data: { boards: [{ groups: [], items_page: { cursor: null, items: [] }, activity_logs: [log("1", "col_answer", "yes"), log("2", "col_class", "Look"), log("3", "col_other", "x")] }] } } }])
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5", ["col_answer", "col_class"], { columnIds: ["col_answer", "col_class"], since: new Date("2026-09-25T08:00:00.000Z") })
    expect(sent[0].body.query).toContain('activity_logs(column_ids: ["col_answer","col_class"]')
    expect(board.changes.map((c) => [c.columnId, c.text])).toEqual([["col_answer", "yes"], ["col_class", "Look"]])
  })

  it("reads a status column's new label from its log entry", async () => {
    const entry = { id: "9", event: "update_column_value", user_id: "111", created_at: "2026-09-25T08:01:00.000Z", data: JSON.stringify({ column_id: "col_class", pulse_id: 42, value: { label: { text: "Look", style: {} } } }) }
    const { f } = fakeFetch([{ json: { data: { boards: [{ groups: [], items_page: { cursor: null, items: [] }, activity_logs: [entry] }] } } }])
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5", [], { columnIds: ["col_class"], since: new Date("2026-09-25T08:00:00.000Z") })
    expect(board.changes.map((c) => c.text)).toEqual(["Look"])
  })

  it("gives every change's time as ISO, whichever form Monday wrote it in, so times compare in order (review)", async () => {
    const at = (id: string, created_at: string) => ({ id, event: "update_column_value", user_id: "111", created_at, data: JSON.stringify({ column_id: "col_class", pulse_id: 42, value: { label: { text: "Look" } } }) })
    const logs = [at("1", "17592384000000000"), at("2", "2026-09-25T08:01:00Z"), at("3", "2026-09-25 08:02:00 UTC"), at("4", "not a time")]
    const { f } = fakeFetch([{ json: { data: { boards: [{ groups: [], items_page: { cursor: null, items: [] }, activity_logs: logs }] } } }])
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5", [], { columnIds: ["col_class"], since: new Date("2026-09-25T08:00:00.000Z") })
    // One it cannot read at all is kept as Monday wrote it: a person's change is never dropped.
    expect(board.changes.map((c) => [c.id, c.at])).toEqual([
      ["1", "2025-09-30T13:20:00.000Z"],
      ["2", "2026-09-25T08:01:00.000Z"],
      ["3", "2026-09-25T08:02:00.000Z"],
      ["4", "not a time"],
    ])
  })

  it("reads no activity log when no column is watched", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { boards: [{ groups: [], items_page: { cursor: null, items: [] } }] } } }])
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5", ["col_stage"], { columnIds: [], since: new Date("2026-09-25T08:00:00.000Z") })
    expect(sent[0].body.query).not.toContain("activity_logs")
    expect(board.changes).toEqual([])
  })

  it("reads the items a connect-boards column links", async () => {
    const item = {
      id: "42", name: "Pick a date", url: "u", created_at: "2026-09-25T08:00:00Z", creator_id: "900", group: { id: "g1" }, updates: [],
      column_values: [{ id: "col_request", text: "Better dates", value: null, linked_item_ids: ["77"] }, { id: "col_kind", text: "Decision", value: "{\"index\":1}" }],
    }
    const { f, sent } = fakeFetch([{ json: { data: { boards: [{ groups: [{ id: "g1", title: "Decide" }], items_page: { cursor: null, items: [item] }, activity_logs: [] }] } } }])
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5", ["col_request", "col_kind"], { columnIds: ["col_answer"], since: new Date("2026-09-25T08:00:00.000Z") })
    expect(sent[0].body.query).toContain("... on BoardRelationValue { linked_item_ids }")
    expect(board.items[0].columns.col_request).toEqual({ text: "Better dates", value: null, linked: ["77"] })
    expect(board.items[0].columns.col_kind).toEqual({ text: "Decision", value: "{\"index\":1}" })
  })

  it("lists a board's columns", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { boards: [{ columns: [{ id: "name", title: "Name", type: "name" }, { id: "col_kind", title: "Kind", type: "status" }] }] } } }])
    const columns = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).boardColumns("5")
    expect(sent[0].body.variables).toEqual({ board: ["5"] })
    expect(columns).toEqual([{ id: "name", title: "Name", type: "name" }, { id: "col_kind", title: "Kind", type: "status" }])
    const none = fakeFetch([{ json: { data: { boards: [] } } }])
    await expect(createMondayApi(TOKEN, { fetch: none.f, sleep: noSleep }).boardColumns("5")).rejects.toThrow(/no board 5/)
  })

  it("moves an item to another board with every column mapped, and checks each id first", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { items: [{ subitems: [] }] } } }, { json: { data: { move_item_to_board: { id: "42" } } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    await api.moveItemToBoard("88", "g_active", "42", [{ source: "col_linear", target: "col_req_linear" }, { source: "col_agent", target: null }])
    expect(sent[1].body.query).toContain("move_item_to_board(board_id: $board, group_id: $group, item_id: $item, columns_mapping: $mapping)")
    expect(sent[1].body.variables).toEqual({ board: "88", group: "g_active", item: "42", mapping: [{ source: "col_linear", target: "col_req_linear" }, { source: "col_agent", target: null }] })
    await expect(api.moveItemToBoard("88", "g_active", "42", [{ source: "col linear", target: null }])).rejects.toThrow(/Monday column id/)
    await expect(api.moveItemToBoard("88", "g_active", "42", [{ source: "col_linear", target: "col-x" }])).rejects.toThrow(/Monday column id/)
    await expect(api.moveItemToBoard("88", "g_active", "4x", [])).rejects.toThrow(/Monday id/)
    expect(sent).toHaveLength(2)
  })

  it("refuses to move an item that has subitems: the move sends no subitem mapping, so they would be lost (review)", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { items: [{ subitems: [{ id: "7" }, { id: "8" }] }] } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    await expect(api.moveItemToBoard("88", "g_active", "42", [])).rejects.toThrow(
      new MondayRefused("Monday: item 42 has 2 subitems, which a move to another board would lose: move them off it first"),
    )
    expect(sent).toHaveLength(1)
    expect(sent[0].body.variables).toEqual({ item: ["42"] })
  })
})

/** Wave 3 Task 11: test day's checkpoints are subitems, and its guide is a doc on the Test day item. */
describe("subitems, item names and item docs (Wave 3)", () => {
  const SINCE = new Date("2026-09-25T08:00:00.000Z")

  it("reads an item's subitems with their columns", async () => {
    const sub = { id: "701", name: "1. Advertiser: pay by card (STEP-7)", url: "u", created_at: "2026-09-25T08:00:00Z", creator_id: "900", group: { id: "topics" }, column_values: [{ id: "col_verdict", text: "PASS", value: "{\"index\":1}" }], updates: [] }
    const { f, sent } = fakeFetch([{ json: { data: { items: [{ subitems: [sub] }] } } }, { json: { data: { items: [{ subitems: null }] } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    const subs = await api.readSubitems("42", ["col_verdict"])
    expect(sent[0].body.variables).toEqual({ item: ["42"], columns: ["col_verdict"] })
    expect(sent[0].body.query).toContain("items(ids: $item) { subitems {")
    expect(subs).toHaveLength(1)
    expect(subs[0]).toMatchObject({ id: "701", name: "1. Advertiser: pay by card (STEP-7)", creatorId: "900", columns: { col_verdict: { text: "PASS" } } })
    expect(await api.readSubitems("42", ["col_verdict"])).toEqual([])
  })

  it("refuses to read the subitems of an item Monday does not have, rather than read them as none", async () => {
    const { f } = fakeFetch([{ json: { data: { items: [] } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    await expect(api.readSubitems("42", ["col_verdict"])).rejects.toThrow(new MondayRefused("Monday: no item 42, or the token's user cannot see it"))
    await expect(api.readSubitems("4x", [])).rejects.toThrow(/not a Monday id/)
  })

  it("reads who changed a column on another board (the subitems board), oldest first", async () => {
    const entry = (id: string, user: string, at: string, column: string, text: string) => ({ id, event: "update_column_value", user_id: user, created_at: at, data: JSON.stringify({ column_id: column, pulse_id: 701, textual_value: text }) })
    const { f, sent } = fakeFetch([{
      json: { data: { boards: [{ activity_logs: [entry("10", "111", "2026-09-25T09:30:00.000Z", "col_verdict", "PASS"), entry("9", "222", "2026-09-25T09:00:00.000Z", "col_verdict", "FAIL"), entry("11", "222", "2026-09-25T09:40:00.000Z", "col_note", "x")] }] } },
    }])
    const changes = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).columnChanges("77", ["col_verdict"], SINCE)
    expect(sent[0].body.variables).toEqual({ board: ["77"] })
    expect(sent[0].body.query).toContain(`activity_logs(column_ids: ["col_verdict"], from: "${SINCE.toISOString()}"`)
    expect(changes).toEqual([
      { id: "9", itemId: "701", userId: "222", text: "FAIL", at: "2026-09-25T09:00:00.000Z", columnId: "col_verdict" },
      { id: "10", itemId: "701", userId: "111", text: "PASS", at: "2026-09-25T09:30:00.000Z", columnId: "col_verdict" },
    ])
  })

  it("reads no log when no column is asked for, refuses a board it cannot see, and checks what goes into the query", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { boards: [] } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    expect(await api.columnChanges("77", [], SINCE)).toEqual([])
    expect(sent).toHaveLength(0)
    await expect(api.columnChanges("77", ["col_verdict"], SINCE)).rejects.toThrow(/no board 77/)
    await expect(api.columnChanges("77", ['x"] '], SINCE)).rejects.toThrow(/not a Monday column id/)
    await expect(api.columnChanges('7"]', ["col_verdict"], SINCE)).rejects.toThrow(/not a Monday id/)
    expect(sent).toHaveLength(1)
  })

  it("creates a subitem, renames an item, and never lets Monday invent a label", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { create_subitem: { id: "702" } } } }, { json: { data: { change_simple_column_value: { id: "42" } } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    expect(await api.createSubitem("42", "2. Publisher: approve", { col_verdict: { label: "To test" } })).toBe("702")
    await api.renameItem("5", "42", "Test day 2026-10-02")
    expect(sent[0].body.query).toContain("create_subitem(parent_item_id: $parent, item_name: $name, column_values: $values, create_labels_if_missing: false)")
    expect(sent[0].body.variables).toEqual({ parent: "42", name: "2. Publisher: approve", values: JSON.stringify({ col_verdict: { label: "To test" } }) })
    expect(sent[1].body.query).toContain('change_simple_column_value(board_id: $board, item_id: $item, column_id: "name", value: $name)')
    expect(sent[1].body.variables).toEqual({ board: "5", item: "42", name: "Test day 2026-10-02" })
  })

  it("refuses a subitem Monday did not create, rather than hand back no id", async () => {
    const { f } = fakeFetch([{ json: { data: { create_subitem: null } } }])
    await expect(createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).createSubitem("42", "1. x", {})).rejects.toThrow(new MondayRefused("Monday: no subitem was created under item 42"))
  })

  it("creates a doc in an item's doc column, names it, and fills it from markdown", async () => {
    const { f, sent } = fakeFetch([
      { json: { data: { create_doc: { id: "3001" } } } },
      { json: { data: { update_doc_name: null } } },
      { json: { data: { add_content_to_doc_from_markdown: { success: true, error: null } } } },
      { json: { data: { add_content_to_doc_from_markdown: { success: false, error: "too long" } } } },
      { json: { data: { add_content_to_doc_from_markdown: null } } },
    ])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    expect(await api.createItemDoc("42", "col_doc", "Test day 2026-10-02")).toBe("3001")
    expect(sent[0].body.query).toContain("create_doc(location: { board: { item_id: $item, column_id: $column } }) { id }")
    expect(sent[0].body.variables).toEqual({ item: "42", column: "col_doc" })
    // update_doc_name answers Monday's JSON scalar, which takes no selection: `{ id }` after it is refused.
    expect(sent[1].body.query).toMatch(/update_doc_name\(docId: \$doc, name: \$name\) \}$/)
    expect(sent[1].body.variables).toEqual({ doc: "3001", name: "Test day 2026-10-02" })
    await api.appendDoc("3001", "# Test day\r\n\n1. Open the page")
    expect(sent[2].body.query).toContain("add_content_to_doc_from_markdown(docId: $doc, markdown: $markdown) { success error }")
    expect(sent[2].body.variables).toEqual({ doc: "3001", markdown: "# Test day\n\n1. Open the page" })
    await expect(api.appendDoc("3001", "x")).rejects.toThrow(new MondayRefused("Monday: the doc did not take the text (too long)"))
    await expect(api.appendDoc("3001", "x")).rejects.toThrow(new MondayRefused("Monday: the doc did not take the text (no reason given)"))
  })

  it("refuses a doc Monday did not create, and checks the column id first", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { create_doc: null } } }])
    const api = createMondayApi(TOKEN, { fetch: f, sleep: noSleep })
    await expect(api.createItemDoc("42", "col_doc", "Test day")).rejects.toThrow(new MondayRefused("Monday: no doc was created on item 42"))
    await expect(api.createItemDoc("42", "col-doc", "Test day")).rejects.toThrow(/not a Monday column id/)
    expect(sent).toHaveLength(1)
  })

  it("keeps a doc it created when naming it fails: a retry would put a second doc on the item", async () => {
    const { f, sent } = fakeFetch([{ json: { data: { create_doc: { id: "3001" } } } }, { json: { errors: [{ message: "Doc is locked" }] } }])
    expect(await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).createItemDoc("42", "col_doc", "Test day")).toBe("3001")
    expect(sent).toHaveLength(2)
  })
})
