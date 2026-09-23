/**
 * The Linear transport. `fetch` is mocked throughout — no key, no network.
 *
 * The retry case that matters is the one people leave out: Linear reports
 * SOME transient failures as GraphQL errors over an HTTP 200 ("Internal
 * server error", rate limiting). A client that only retries on status codes
 * turns a blip into a hard failure mid-import.
 *
 * The throttle is asserted by counting calls under a fake clock rather than
 * by sleeping; a test that really waits 1.5 s per request is a test nobody
 * runs.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from "vitest"
import { randomUUID } from "node:crypto"
import {
  linearRequest,
  loadLinearKey,
  resetLinearClientForTests,
  LinearCreateConflictError,
  LINEAR_ENDPOINT,
} from "../linear-client.ts"
import { createLinearTracker } from "../linear.ts"

const ORIGINAL_KEY = process.env.LINEAR_API_KEY
const ORIGINAL_HOME = process.env.HOME

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  })
}

beforeEach(() => {
  resetLinearClientForTests()
  process.env.LINEAR_API_KEY = "lin_api_test_key"
  process.env.TRACKERCTL_MAX_WRITES = ""
  vi.useFakeTimers()
})

afterEach(() => {
  vi.useRealTimers()
  vi.restoreAllMocks()
  if (ORIGINAL_KEY === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = ORIGINAL_KEY
  if (ORIGINAL_HOME === undefined) delete process.env.HOME
  else process.env.HOME = ORIGINAL_HOME
})

describe("loadLinearKey", () => {
  it("prefers the environment", () => {
    expect(loadLinearKey()).toBe("lin_api_test_key")
  })

  it("throws a message that does NOT contain a key when nothing is set", () => {
    delete process.env.LINEAR_API_KEY
    process.env.HOME = "/nonexistent-home-for-this-test"
    expect(() => loadLinearKey()).toThrowError(/LINEAR_API_KEY/)
    // The message names the file, never a value.
    expect(() => loadLinearKey()).toThrowError(/\.config\/linear\/\.env/)
  })
})

describe("linearRequest", () => {
  it("posts to the Linear endpoint with the key as a bare Authorization header", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    const result = await linearRequest<{ ok: boolean }>("{ ok }")

    expect(result).toEqual({ ok: true })
    expect(fetchMock).toHaveBeenCalledTimes(1)
    const [url, init] = fetchMock.mock.calls[0]
    expect(url).toBe(LINEAR_ENDPOINT)
    expect(init.method).toBe("POST")
    // Linear personal API keys go in Authorization WITHOUT a Bearer prefix.
    expect(init.headers.Authorization).toBe("lin_api_test_key")
    expect(JSON.parse(init.body)).toEqual({ query: "{ ok }", variables: {} })
  })

  it("retries a 429 and succeeds", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 429))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 1 } }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest<{ ok: number }>("{ ok }")
    await vi.runAllTimersAsync()

    expect(await promise).toEqual({ ok: 1 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("retries a TRANSIENT GraphQL error returned over HTTP 200", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({ errors: [{ message: "Internal server error" }] }))
      .mockResolvedValueOnce(jsonResponse({ data: { ok: 2 } }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest<{ ok: number }>("{ ok }")
    await vi.runAllTimersAsync()

    expect(await promise).toEqual({ ok: 2 })
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("does NOT retry a real refusal — it throws at once", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: "Entity not found: Issue" }] }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest("{ issue { id } }")
    await expect(promise).rejects.toThrowError(/Entity not found/)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("throttles consecutive calls to one per 1500 ms", async () => {
    // mockImplementation (not mockResolvedValue) so each fetch() call gets its
    // own Response instance — a Response body can only be read once, and this
    // test drives two real fetch calls through the same mock.
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    await linearRequest("{ a }")
    expect(fetchMock).toHaveBeenCalledTimes(1)

    const second = linearRequest("{ b }")
    // Still inside the window: the second call has not gone out.
    await vi.advanceTimersByTimeAsync(500)
    expect(fetchMock).toHaveBeenCalledTimes(1)

    await vi.advanceTimersByTimeAsync(1100)
    await second
    expect(fetchMock).toHaveBeenCalledTimes(2)
  })

  it("enforces TRACKERCTL_MAX_WRITES on mutations only", async () => {
    process.env.TRACKERCTL_MAX_WRITES = "1"
    // Same fresh-Response-per-call reasoning as the throttle test above: this
    // test drives two real fetch calls (the first write, then the read).
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    const first = linearRequest("mutation { issueCreate { success } }")
    await vi.runAllTimersAsync()
    await first

    const second = linearRequest("mutation { issueCreate { success } }")
    await expect(second).rejects.toThrowError(/TRACKERCTL_MAX_WRITES/)

    // Reads are never capped.
    const read = linearRequest("query { issue { id } }")
    await vi.runAllTimersAsync()
    await expect(read).resolves.toBeDefined()
  })

  it("fails closed on a non-numeric TRACKERCTL_MAX_WRITES", async () => {
    process.env.TRACKERCTL_MAX_WRITES = "abc"
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      linearRequest("mutation { issueCreate { success } }"),
    ).rejects.toThrowError(/TRACKERCTL_MAX_WRITES/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("fails closed on a negative TRACKERCTL_MAX_WRITES", async () => {
    process.env.TRACKERCTL_MAX_WRITES = "-1"
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    await expect(
      linearRequest("mutation { issueCreate { success } }"),
    ).rejects.toThrowError(/TRACKERCTL_MAX_WRITES/)
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it("still allows reads under a malformed TRACKERCTL_MAX_WRITES", async () => {
    process.env.TRACKERCTL_MAX_WRITES = "abc"
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({ data: { ok: true } }))
    vi.stubGlobal("fetch", fetchMock)

    const read = linearRequest("query { issue { id } }")
    await vi.runAllTimersAsync()
    await expect(read).resolves.toBeDefined()
  })

  it("gives up after MAX_ATTEMPTS on a persistent 503 without sleeping on the last attempt, reporting the last status", async () => {
    // mockImplementation so every fetch() call gets its own Response — six
    // real calls are driven through this mock.
    const fetchMock = vi.fn().mockImplementation(async () => jsonResponse({}, 503))
    vi.stubGlobal("fetch", fetchMock)

    // .catch attached synchronously (before the fake-timer advance below) so
    // there's no gap where the rejection is momentarily unhandled.
    const settled = linearRequest("{ a }").catch((e: unknown) => e as Error)
    await vi.runAllTimersAsync()
    const err = await settled

    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/gave up after 6 attempts/)
    expect(err.message).toMatch(/503/)
    expect(fetchMock).toHaveBeenCalledTimes(6)
  })

  it("never puts the key in a thrown message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "Bad" }] }))
    vi.stubGlobal("fetch", fetchMock)
    const err = await linearRequest("{ a }").catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/Bad/)
    expect(err.message).not.toContain("lin_api_test_key")
  })
})

describe("mutation retries", () => {
  // A 5xx does not say whether the write landed. The adapter sends its own
  // UUID on every create, so a retry names the SAME entity; Linear then
  // refuses the second insert instead of making a duplicate.
  const CREATE = "mutation($input: IssueCreateInput!) { issueCreate(input: $input) { issue { id } } }"
  const ID = "3f2b8c1e-6d4a-4f0b-9c2e-7a1d5e8b4c6f"
  const VARIABLES = { input: { id: ID, teamId: "team-uuid", title: "x" } }

  it("resends the identical body, client id included, after a 5xx", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 502))
      .mockResolvedValueOnce(jsonResponse({ data: { issueCreate: { issue: { id: ID } } } }))
    vi.stubGlobal("fetch", fetchMock)

    const promise = linearRequest(CREATE, VARIABLES)
    await vi.runAllTimersAsync()
    await promise

    const [first, second] = fetchMock.mock.calls.map(([, init]) => init.body as string)
    expect(second).toBe(first)
    expect(JSON.parse(second).variables.input.id).toBe(ID)
  })

  it("raises LinearCreateConflictError when a RETRY is refused as already existing", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(jsonResponse({}, 503))
      .mockResolvedValueOnce(
        jsonResponse({ errors: [{ message: `Entity Issue with id ${ID} already exists` }] }),
      )
    vi.stubGlobal("fetch", fetchMock)

    const settled = linearRequest(CREATE, VARIABLES).catch((e: unknown) => e as Error)
    await vi.runAllTimersAsync()
    const err = await settled

    // Its own class, so the adapter can read the id back and decide whether
    // the first attempt landed. It is still an Error with Linear's message.
    expect(err).toBeInstanceOf(LinearCreateConflictError)
    expect(err.message).toMatch(/already exists/)
  })

  it("treats 'already exists' on the FIRST attempt as a plain refusal", async () => {
    // No earlier attempt of ours could have landed, so there is nothing to
    // settle: the id really is taken.
    const fetchMock = vi
      .fn()
      .mockResolvedValue(jsonResponse({ errors: [{ message: `Entity Issue with id ${ID} already exists` }] }))
    vi.stubGlobal("fetch", fetchMock)

    const err = await linearRequest(CREATE, VARIABLES).catch((e: unknown) => e as Error)

    expect(err).toBeInstanceOf(Error)
    expect(err).not.toBeInstanceOf(LinearCreateConflictError)
    expect(fetchMock).toHaveBeenCalledTimes(1)
  })

  it("leaves exactly one issue when a 5xx hid a create that landed (adapter and transport together)", async () => {
    // A fake Linear that stores the FIRST create and then answers 502, the
    // way a gateway timeout in front of a finished write does. Like the real
    // one, it mints an id when the input carries none.
    const stored = new Map<string, Record<string, unknown>>()
    let creates = 0
    const fetchMock = vi.fn().mockImplementation(async (_url: string, init: { body: string }) => {
      const { query, variables } = JSON.parse(init.body)
      if (/teams\(/.test(query)) {
        const team = {
          id: "team-uuid",
          key: "STEP",
          name: "STEP",
          states: { nodes: [] },
          labels: { nodes: [], pageInfo: { hasNextPage: false, endCursor: null } },
        }
        return jsonResponse({ data: { teams: { nodes: [team] } } })
      }
      if (/issueCreate/.test(query)) {
        creates += 1
        const id: string = variables.input.id ?? randomUUID()
        if (stored.has(id)) {
          return jsonResponse({ errors: [{ message: `Entity Issue with id ${id} already exists` }] })
        }
        const issue = {
          id,
          identifier: `STEP-${900 + stored.size}`,
          title: variables.input.title,
          description: null,
          url: "https://linear.app/step/issue/STEP-900",
          priority: 0,
          updatedAt: "2026-09-23T00:00:00.000Z",
          state: { name: "Ready" },
          labels: { nodes: [] },
        }
        stored.set(id, issue)
        return creates === 1 ? jsonResponse({}, 502) : jsonResponse({ data: { issueCreate: { issue } } })
      }
      if (/issue\(id:/.test(query)) {
        return jsonResponse({ data: { issue: stored.get(variables.id) ?? null } })
      }
      throw new Error(`unexpected query: ${query}`)
    })
    vi.stubGlobal("fetch", fetchMock)

    const promise = createLinearTracker().createIssue({ title: "Ship the thing" })
    await vi.runAllTimersAsync()
    const issue = await promise

    expect(creates).toBe(2)
    expect(stored.size).toBe(1)
    expect(issue.id).toBe("STEP-900")
  })
})
