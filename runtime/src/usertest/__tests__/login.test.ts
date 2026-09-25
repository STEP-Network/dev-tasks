import { describe, expect, it, vi } from "vitest"
import { bypassCookies, cookiesFromSetCookie, personaCookies, signInOrigins } from "../login.ts"

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

  it("leaves out a cookie the site deletes: Max-Age of 0 or less, or an Expires in the past, with Max-Age first", () => {
    const now = Date.parse("2026-09-25T12:00:00Z") / 1000
    const got = cookiesFromSetCookie(
      [
        "gone=; Path=/; Expires=Thu, 01 Jan 1970 00:00:00 GMT",
        "zero=x; Max-Age=0",
        "negative=x; Max-Age=-1",
        "stale=x; Max-Age=-1; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
        "later=x; Expires=Fri, 01 Jan 2100 00:00:00 GMT",
        "fresh=x; Expires=Thu, 01 Jan 1970 00:00:00 GMT; Max-Age=60",
        "odd=x; Expires=not a date",
      ],
      ORIGIN,
      now,
    )
    expect(got.map((c) => [c.name, c.expires])).toEqual([
      ["later", Date.parse("2100-01-01T00:00:00Z") / 1000],
      ["fresh", now + 60],
      ["odd", undefined],
    ])
  })
})

describe("signInOrigins", () => {
  it("is staging, and the release candidate once it is set up: never a preview", () => {
    expect(signInOrigins({ stagingOrigin: ORIGIN })).toEqual([ORIGIN])
    expect(signInOrigins({ stagingOrigin: ORIGIN, rcOrigin: "https://rc.example.com" })).toEqual([ORIGIN, "https://rc.example.com"])
    expect(signInOrigins({})).toEqual([])
  })
})

describe("personaCookies", () => {
  it("posts the persona with the secret in a header, and returns its session", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(200, ["stack-access=s; Path=/; SameSite=Lax"]))
    const r = await personaCookies({ origin: ORIGIN, signInOrigins: [ORIGIN], persona, secret: "s3cret", extraCookies: [], fetchImpl, nowSeconds: 0 })
    expect(r).toMatchObject({ ok: true })
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe(`${ORIGIN}/api/dev/test-login`)
    expect(init.headers["x-test-login-secret"]).toBe("s3cret")
    expect(JSON.parse(init.body)).toEqual({ mode: "existing", email: "customer@example.test", admin: false })
  })

  it("says in plain words why a site refuses, never with the secret", async () => {
    for (const [status, words] of [
      [500, "failed on the site's side (HTTP 500)"],
      [401, "refused this mini's secret"],
      [404, "no test sign-in"],
      [422, "persona does not exist"],
    ] as const) {
      const r = await personaCookies({ origin: ORIGIN, signInOrigins: [ORIGIN], persona, secret: "s3cret", extraCookies: [], fetchImpl: vi.fn().mockResolvedValue(response(status)), nowSeconds: 0 })
      expect(r.ok).toBe(false)
      if (!r.ok) {
        expect(r.why).toContain(words)
        expect(r.why).not.toContain("s3cret")
      }
    }
  })

  it("turns a network error into a reason", async () => {
    const r = await personaCookies({ origin: ORIGIN, signInOrigins: [ORIGIN], persona, secret: "x", extraCookies: [], fetchImpl: vi.fn().mockRejectedValue(new Error("ECONNRESET")), nowSeconds: 0 })
    expect(r).toEqual({ ok: false, why: "the test sign-in could not be reached" })
  })

  it("never sends the secret to a preview: it runs code nobody has reviewed, which could keep it", async () => {
    const fetchImpl = vi.fn()
    for (const origin of ["https://app-git-x.vercel.app", `${ORIGIN}/`, "https://STAGING.example.com"]) {
      const r = await personaCookies({ origin, signInOrigins: [ORIGIN, "https://rc.example.com"], persona, secret: "s3cret", extraCookies: [], fetchImpl, nowSeconds: 0 })
      expect(r).toEqual({ ok: false, why: "a persona signs in only on staging or the release candidate, never on a preview" })
    }
    expect(fetchImpl).not.toHaveBeenCalled()
    fetchImpl.mockResolvedValue(response(200, ["s=1"]))
    expect(await personaCookies({ origin: "https://rc.example.com", signInOrigins: [ORIGIN, "https://rc.example.com"], persona, secret: "s3cret", extraCookies: [], fetchImpl, nowSeconds: 0 })).toMatchObject({ ok: true })
  })
})

describe("bypassCookies", () => {
  it("asks for Vercel's bypass cookie once", async () => {
    const fetchImpl = vi.fn().mockResolvedValue(response(307, ["_vercel_jwt=j; Path=/; SameSite=None"]))
    const r = await bypassCookies("https://app-x.vercel.app", "b", fetchImpl, 0)
    expect(r).toMatchObject({ ok: true })
    expect(fetchImpl.mock.calls[0][1].headers).toEqual({ "x-vercel-protection-bypass": "b", "x-vercel-set-bypass-cookie": "samesitenone" })
  })

  it("says why when the preview sets no cookie, or cannot be reached", async () => {
    expect(await bypassCookies("https://app-x.vercel.app", "b", vi.fn().mockResolvedValue(response(401)), 0)).toEqual({ ok: false, why: "the preview set no bypass cookie (HTTP 401)" })
    expect(await bypassCookies("https://app-x.vercel.app", "b", vi.fn().mockRejectedValue(new Error("ENOTFOUND")), 0)).toEqual({ ok: false, why: "the preview could not be reached" })
  })
})
