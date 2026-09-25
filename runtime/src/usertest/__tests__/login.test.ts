import { describe, expect, it, vi } from "vitest"
import { bypassCookies, cookiesFromSetCookie, personaCookies } from "../login.ts"

const ORIGIN = "https://staging.example.com"
const persona = { id: "customer", email: "customer@example.test", admin: false, publishScreenshots: true, paths: [] }
const response = (status: number, setCookies: string[] = []) =>
  ({ status, ok: status === 200, headers: { getSetCookie: () => setCookies } }) as unknown as Response

describe("cookiesFromSetCookie", () => {
  it("reads name, value, SameSite, HttpOnly and Max-Age, scoped to the origin", () => {
    expect(cookiesFromSetCookie(["a=1; Path=/; SameSite=None; Max-Age=60; HttpOnly", "b=x=y"], ORIGIN, 1000)).toEqual([
      { name: "a", value: "1", url: ORIGIN, secure: true, httpOnly: true, sameSite: "None", expires: 1060 },
      { name: "b", value: "x=y", url: ORIGIN, secure: true, httpOnly: false },
    ])
  })
})

describe("personaCookies", () => {
  it("posts the persona with the secret in a header, and returns its session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, ["stack-access=s; Path=/; SameSite=Lax"]))
    const r = await personaCookies({ origin: ORIGIN, persona, secret: "s3cret", extraCookies: [], fetchImpl, nowSeconds: 0 })
    expect(r).toMatchObject({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${ORIGIN}/api/dev/test-login`)
    expect(init.headers["x-test-login-secret"]).toBe("s3cret")
    expect(JSON.parse(init.body)).toEqual({ mode: "existing", email: "customer@example.test", admin: false })
  })

  it("says in plain words why a site refuses, never with the secret", async () => {
    for (const [status, words] of [
      [500, "its sign-in service is the production one"],
      [401, "refused this mini's secret"],
      [404, "no test sign-in"],
      [422, "persona does not exist"],
    ] as const) {
      const r = await personaCookies({ origin: ORIGIN, persona, secret: "s3cret", extraCookies: [], fetchImpl: vi.fn().mockResolvedValue(response(status)), nowSeconds: 0 })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.why).toContain(words)
        expect(r.why).not.toContain("s3cret")
      }
    }
  })

  it("turns a network error into a reason", async () => {
    const r = await personaCookies({ origin: ORIGIN, persona, secret: "x", extraCookies: [], fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNRESET")), nowSeconds: 0 })
    expect(r).toEqual({ ok: false, why: "the test sign-in could not be reached" })
  })
})

describe("bypassCookies", () => {
  it("asks for Vercel's bypass cookie once", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(307, ["_vercel_jwt=j; Path=/; SameSite=None"]))
    const r = await bypassCookies("https://app-x.vercel.app", "b", fetchImpl, 0)
    expect(r).toMatchObject({ ok: true })
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "x-vercel-protection-bypass": "b", "x-vercel-set-bypass-cookie": "samesitenone" })
  })
})
