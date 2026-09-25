import { describe, expect, it } from "vitest"
import { allowedOrigins, allowedUrlPatterns, isAllowedNavigation, isBrowserVisible, personaFor } from "../target.ts"

const PREVIEW = "https://app-git-feature-team.vercel.app"
const STAGING = "https://staging.example.com"
const origins = allowedOrigins(PREVIEW, STAGING)

describe("isAllowedNavigation", () => {
  it("allows the site under test and staging, on any path", () => {
    expect(isAllowedNavigation(`${PREVIEW}/en/account?tab=1`, origins)).toBe(true)
    expect(isAllowedNavigation(`${STAGING}/da`, origins)).toBe(true)
  })

  it("refuses look-alike hosts, plain http, credentials in the URL, production and non-URLs", () => {
    for (const url of [
      "https://staging.example.com.evil.example/",
      "http://staging.example.com/",
      "https://staging.example.com@evil.example/",
      "https://example.com/",
      "javascript:alert(1)",
      "file:///etc/passwd",
      "not a url",
      42,
      undefined,
    ]) {
      expect(isAllowedNavigation(url, origins)).toBe(false)
    }
  })

  it("refuses credentials even on an allowed host, and plain http even for an origin listed that way", () => {
    expect(isAllowedNavigation("https://someone:secret@staging.example.com/da", origins)).toBe(false)
    expect(isAllowedNavigation("http://staging.example.com/da", ["http://staging.example.com"])).toBe(false)
  })
})

describe("allowedUrlPatterns", () => {
  it("gives each origin its paths, with and without a query, and appends the extra patterns", () => {
    expect(allowedUrlPatterns([STAGING], ["https://api.example.com/*"])).toEqual([`${STAGING}/*`, `${STAGING}/*?*`, "https://api.example.com/*"])
  })
})

describe("personaFor and isBrowserVisible", () => {
  const personas = [
    { id: "admin", email: "admin@example.test", admin: true, publishScreenshots: false, paths: ["app/[locale]/admin/**"] },
    { id: "customer", email: "customer@example.test", admin: false, publishScreenshots: true, paths: ["app/[locale]/account/**", "components/account/**"] },
  ]

  it("picks the first persona whose paths match, else none", () => {
    expect(personaFor(["components/account/x.tsx"], personas)?.id).toBe("customer")
    expect(personaFor(["app/[locale]/admin/page.tsx", "components/account/x.tsx"], personas)?.id).toBe("admin")
    expect(personaFor(["lib/x.ts"], personas)).toBeNull()
  })

  it("skips a change no user can see", () => {
    const skip = [".claude/**", "docs/**", "**/__tests__/**"]
    expect(isBrowserVisible(["docs/a.md", "lib/x/__tests__/a.test.ts"], skip)).toBe(false)
    expect(isBrowserVisible(["docs/a.md", "lib/x.ts"], skip)).toBe(true)
  })
})
