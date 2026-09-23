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
import {
  linearRequest,
  loadLinearKey,
  resetLinearClientForTests,
  LINEAR_ENDPOINT,
} from "../linear-client.ts"

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

  it("never puts the key in a thrown message", async () => {
    const fetchMock = vi.fn().mockResolvedValue(jsonResponse({ errors: [{ message: "Bad" }] }))
    vi.stubGlobal("fetch", fetchMock)
    const err = await linearRequest("{ a }").catch((e: unknown) => e as Error)
    expect(err).toBeInstanceOf(Error)
    expect(err.message).toMatch(/Bad/)
    expect(err.message).not.toContain("lin_api_test_key")
  })
})
