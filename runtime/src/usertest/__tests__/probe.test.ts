import { describe, expect, it } from "vitest"
import { formatBrowserProbe, judgeNavigation } from "../probe.ts"

describe("judgeNavigation", () => {
  it("counts staging as opened only when the browser tool says it navigated there", () => {
    expect(judgeNavigation("https://staging.example.com", { content: [{ type: "text", text: "Successfully navigated to https://staging.example.com." }] }, "opens")).toEqual({ ok: true, detail: "opened" })
    expect(judgeNavigation("https://staging.example.com", { content: [{ type: "text", text: "Unable to navigate in the selected page: net::ERR_NAME_NOT_RESOLVED." }] }, "opens").ok).toBe(false)
    expect(judgeNavigation("https://staging.example.com", { isError: true, content: [] }, "opens").ok).toBe(false)
    expect(judgeNavigation("https://staging.example.com", { isError: true, content: [{ type: "text", text: "Successfully navigated to https://staging.example.com." }] }, "opens").ok).toBe(false)
  })

  it("counts another site as refused unless the browser tool says it navigated there", () => {
    expect(judgeNavigation("https://example.com/", { content: [{ type: "text", text: "Unable to navigate in the selected page: net::ERR_BLOCKED_BY_CLIENT." }] }, "refused")).toEqual({
      ok: true,
      detail: "refused: Unable to navigate in the selected page: net::ERR_BLOCKED_BY_CLIENT.",
    })
    expect(judgeNavigation("https://example.com/", { isError: true, content: [{ type: "text", text: "not allowed" }] }, "refused").ok).toBe(true)
    expect(judgeNavigation("https://example.com/", { content: [{ type: "text", text: "Successfully navigated to https://example.com/." }] }, "refused")).toEqual({ ok: false, detail: "it opened" })
  })
})

describe("formatBrowserProbe", () => {
  const opens = { name: "staging opens", kind: "opens" as const }
  const refused = { name: "https://example.com/ is refused", kind: "refused" as const }

  it("prints one line per check, and fails when any does", () => {
    expect(formatBrowserProbe([{ ...opens, ok: true, detail: "opened" }, { ...refused, ok: true, detail: "refused: blocked" }])).toEqual({
      ok: true,
      text: "ok   staging opens: opened\nok   https://example.com/ is refused: refused: blocked\nthe browser opens staging and nothing else",
    })
    const bad = formatBrowserProbe([{ ...opens, ok: true, detail: "opened" }, { ...refused, ok: false, detail: "it opened" }])
    expect(bad.ok).toBe(false)
    expect(bad.text).toContain("FAIL https://example.com/ is refused: it opened")
    expect(bad.text.split("\n").at(-1)).toBe("the browser's allowlist does NOT hold: keep the browser test off")
  })

  it("says staging did not open, not that the allowlist failed, when only staging failed", () => {
    const text = formatBrowserProbe([{ ...opens, ok: false, detail: "net::ERR_NAME_NOT_RESOLVED" }, { ...refused, ok: true, detail: "refused: blocked" }]).text
    expect(text.split("\n").at(-1)).toBe("staging did not open, so the allowlist is not proven: keep the browser test off until this passes")
  })
})
