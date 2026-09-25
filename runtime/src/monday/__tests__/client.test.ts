import { describe, expect, it } from "vitest"
import { createMondayApi, MONDAY_API_VERSION, MONDAY_ENDPOINT } from "../client.ts"

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
  })

  it("waits out a rate limit or a server error, then gives up naming the status", async () => {
    const { f, sent } = fakeFetch([{ status: 429 }, { status: 502 }, { json: { data: { me: { id: "1", name: "x", is_admin: false } } } }])
    expect((await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).me()).id).toBe("1")
    expect(sent).toHaveLength(3)
    const down = fakeFetch([{ status: 503 }, { status: 503 }, { status: 503 }])
    await expect(createMondayApi(TOKEN, { fetch: down.f, sleep: noSleep }).me()).rejects.toThrow(/gave up after 3 attempts \(status 503\)/)
  })

  it("reads the whole board: its groups, every page of items, and each item's updates and replies", async () => {
    const item = (id: string, over: Record<string, unknown> = {}) => ({
      id, name: `Item ${id}`, url: `https://step.monday.com/boards/1/pulses/${id}`, created_at: "2026-09-25T08:00:00Z", creator_id: "111",
      group: { id: "topics" }, column_values: [{ id: "color_mm7hvyyt", text: "Needs you", value: '{"index":1}' }], updates: [], ...over,
    })
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
            }],
          },
        },
      },
      { json: { data: { next_items_page: { cursor: null, items: [item("11", { creator_id: null })] } } } },
    ])
    const board = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5104953028", ["color_mm7hvyyt"])
    expect(board.groups).toEqual([{ id: "topics", title: "Needs you" }])
    expect(board.items.map((i) => i.id)).toEqual(["10", "11"])
    expect(board.items[0]).toMatchObject({ groupId: "topics", creatorId: "111", columns: { color_mm7hvyyt: { text: "Needs you", value: '{"index":1}' } } })
    expect(board.items[0].updates).toEqual([
      { id: "u1", creatorId: "111", text: "merge it", createdAt: "2026-09-25T09:00:00Z", threadId: "u1" },
      { id: "r1", creatorId: "222", text: "agreed", createdAt: "2026-09-25T09:05:00Z", threadId: "u1" },
    ])
    expect(board.items[1].creatorId).toBeNull()
    expect(sent[0].body.variables).toEqual({ board: ["5104953028"], columns: ["color_mm7hvyyt"] })
    expect(sent[1].body.variables).toMatchObject({ cursor: "c1" })
  })

  it("refuses a board the token's user cannot see, rather than read it as empty", async () => {
    const { f } = fakeFetch([{ json: { data: { boards: [] } } }])
    await expect(createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).readBoard("5104953028", [])).rejects.toThrow(/no board 5104953028/)
  })

  it("reads who changed the Answer column, and what they wrote, from the board's activity log", async () => {
    const log = (id: string, event: string, data: unknown) => ({ id, event, data: JSON.stringify(data), user_id: "111", created_at: "17592384000000000" })
    const { f, sent } = fakeFetch([
      {
        json: {
          data: {
            boards: [{
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
    ])
    const since = new Date("2026-09-25T08:00:00.000Z")
    const changes = await createMondayApi(TOKEN, { fetch: f, sleep: noSleep }).columnLog("5104953028", "long_text_mm7hzj39", since)
    expect(changes).toEqual([{ id: "a1", itemId: "10", userId: "111", text: "leave it", at: "2025-09-30T13:20:00.000Z" }])
    expect(sent[0].body.query).toContain('column_ids: ["long_text_mm7hzj39"]')
    expect(sent[0].body.query).toContain(`from: "${since.toISOString()}"`)
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
    await expect(api.columnLog('1"] } }', "long_text_mm7hzj39", new Date())).rejects.toThrow(/not a Monday id/)
    await expect(api.columnLog("1", 'x"] ', new Date())).rejects.toThrow(/not a Monday column id/)
  })
})
