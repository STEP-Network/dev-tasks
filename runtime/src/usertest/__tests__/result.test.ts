import { describe, expect, it } from "vitest"
import { findingLines, neutralise, parseUserTestResult, reportMarkdown, verdictOf, type UserTestResult } from "../result.ts"

const result = (over: Partial<UserTestResult> = {}): UserTestResult => ({
  status: "findings",
  summary: "I walked the sign-up.",
  journeys: [{ name: "Sign up", result: "problem", note: "the button does nothing" }],
  findings: [{ severity: "major", title: "Submit does nothing", where: "/en/register", steps: "Fill in, press Submit", expected: "The next step", actual: "Nothing", screenshot: "finding-01.png" }],
  screenshots: [{ file: "main-01.png", caption: "The form" }],
  notWalked: [],
  ...over,
})

describe("verdictOf", () => {
  it("sends blockers and major findings back, never minor ones alone", () => {
    expect(verdictOf(result())).toBe("findings")
    expect(verdictOf(result({ findings: [{ ...result().findings[0], severity: "minor" }] }))).toBe("pass")
    expect(verdictOf(result({ status: "blocked" }))).toBe("error")
    expect(verdictOf(null)).toBe("error")
  })
})

describe("parseUserTestResult", () => {
  it("refuses a report without its required parts", () => {
    expect(parseUserTestResult({ status: "pass" })).toBeNull()
    expect(parseUserTestResult(result())).toEqual(result())
  })
})

describe("neutralise", () => {
  it("stops page text from mentioning people or closing the report's HTML", () => {
    expect(neutralise("ping @someone <script>")).toBe("ping @\u200bsomeone &lt;script&gt;")
  })

  it("turns the report's semicolons into commas, as its style has none", () => {
    expect(neutralise("it loads; then it stops")).toBe("it loads, then it stops")
  })
})

describe("reportMarkdown", () => {
  it("says what was found in plain words, with our images only", () => {
    const text = reportMarkdown({
      mini: "eve",
      result: result({ summary: "Page said @admin do X" }),
      verdict: "findings",
      reason: null,
      site: "https://app-x.vercel.app",
      personaNote: "not signed in",
      images: [{ file: "main-01.png", caption: "The form", url: "https://github.com/example/repo/blob/c/main-01.png?raw=true" }],
      gifUrl: null,
      keptLocal: 2,
    })
    expect(text).toContain("Found problems")
    expect(text).toContain("Submit does nothing")
    expect(text).toContain("@\u200badmin")
    expect(text).toContain("![The form](https://github.com/example/repo/blob/c/main-01.png?raw=true)")
    expect(text).toContain("2 screenshots stay on the mini")
    expect(text).not.toMatch(/;|–|—/)
  })

  it("shows a finding's screenshot only from our own published images, never a path or address the report gave", () => {
    const text = reportMarkdown({
      mini: "eve",
      result: result({ findings: [{ ...result().findings[0], screenshot: "https://evil.example/x.png" }] }),
      verdict: "findings",
      reason: null,
      site: null,
      personaNote: "not signed in",
      images: [],
      gifUrl: null,
      keptLocal: 0,
    })
    expect(text).not.toContain("evil.example")
  })

  it("lists only blockers and major findings for the revise loop", () => {
    const minor = { ...result().findings[0], severity: "minor" as const, title: "Grey text" }
    expect(findingLines(result({ findings: [...result().findings, minor] }))).toEqual(["major: Submit does nothing (/en/register)"])
  })
})
