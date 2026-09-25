/**
 * Signing the browser in, from the runtime's own process (WS5). The test-login
 * secret and Vercel's bypass secret go in request headers from here, never
 * into the browser: the model drives the browser and can read its network
 * log, so a secret sent from a page would be a secret shown to the model. The
 * browser gets only the resulting cookies (chrome.ts).
 *
 * PolAds's route: POST /api/dev/test-login with x-test-login-secret and
 * { mode, email, admin } (app/api/dev/test-login/route.ts). "existing" only:
 * the test never creates an account.
 */
import type { Persona } from "./target.ts"

/** A cookie in CDP's Network.CookieParam shape, scoped by url so it is host-only. */
export interface BrowserCookie {
  name: string
  value: string
  url: string
  secure: boolean
  httpOnly: boolean
  sameSite?: "Strict" | "Lax" | "None"
  expires?: number
}

export type LoginResult = { ok: true; cookies: BrowserCookie[] } | { ok: false; why: string }

export function cookiesFromSetCookie(headers: readonly string[], origin: string, nowSeconds: number): BrowserCookie[] {
  const out: BrowserCookie[] = []
  for (const header of headers) {
    const [pair, ...attrs] = header.split(";").map((s) => s.trim())
    const eq = pair.indexOf("=")
    if (eq <= 0) continue
    const cookie: BrowserCookie = { name: pair.slice(0, eq), value: pair.slice(eq + 1), url: origin, secure: origin.startsWith("https:"), httpOnly: false }
    for (const attr of attrs) {
      const at = attr.indexOf("=")
      const key = (at === -1 ? attr : attr.slice(0, at)).toLowerCase()
      const value = at === -1 ? "" : attr.slice(at + 1)
      if (key === "httponly") cookie.httpOnly = true
      else if (key === "samesite") cookie.sameSite = value.toLowerCase() === "none" ? "None" : value.toLowerCase() === "strict" ? "Strict" : "Lax"
      else if (key === "max-age" && /^\d+$/.test(value)) cookie.expires = nowSeconds + Number(value)
    }
    out.push(cookie)
  }
  return out
}

export async function bypassCookies(origin: string, secret: string, fetchImpl: typeof fetch, nowSeconds: number): Promise<LoginResult> {
  try {
    const res = await fetchImpl(`${origin}/`, {
      headers: { "x-vercel-protection-bypass": secret, "x-vercel-set-bypass-cookie": "samesitenone" },
      redirect: "manual",
      signal: AbortSignal.timeout(30_000),
    })
    const cookies = cookiesFromSetCookie(res.headers.getSetCookie(), origin, nowSeconds)
    return cookies.length ? { ok: true, cookies } : { ok: false, why: `the preview set no bypass cookie (HTTP ${res.status})` }
  } catch {
    return { ok: false, why: "the preview could not be reached" }
  }
}

const REFUSED: Record<number, string> = {
  401: "the test sign-in refused this mini's secret",
  404: "this site has no test sign-in",
  422: "the persona does not exist on this site",
  429: "the test sign-in is rate limited",
  500: "this site cannot sign test users in (its sign-in service is the production one)",
}

export async function personaCookies(o: {
  origin: string
  persona: Persona
  secret: string
  extraCookies: readonly BrowserCookie[]
  fetchImpl: typeof fetch
  nowSeconds: number
}): Promise<LoginResult> {
  const cookie = o.extraCookies.map((c) => `${c.name}=${c.value}`).join("; ")
  let res: Response
  try {
    res = await o.fetchImpl(`${o.origin}/api/dev/test-login`, {
      method: "POST",
      headers: { "content-type": "application/json", "x-test-login-secret": o.secret, ...(cookie ? { cookie } : {}) },
      body: JSON.stringify({ mode: "existing", email: o.persona.email, admin: o.persona.admin }),
      redirect: "manual",
      signal: AbortSignal.timeout(60_000),
    })
  } catch {
    return { ok: false, why: "the test sign-in could not be reached" }
  }
  if (res.status !== 200) return { ok: false, why: REFUSED[res.status] ?? `the test sign-in answered HTTP ${res.status}` }
  const cookies = cookiesFromSetCookie(res.headers.getSetCookie(), o.origin, o.nowSeconds)
  return cookies.length ? { ok: true, cookies } : { ok: false, why: "the test sign-in set no session" }
}
