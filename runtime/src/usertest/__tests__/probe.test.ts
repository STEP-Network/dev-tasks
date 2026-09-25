import { ErrorCode, McpError } from "@modelcontextprotocol/sdk/types.js"
import { describe, expect, it } from "vitest"
import { formatBrowserProbe, judgeNavigation, tryNavigation } from "../probe.ts"

describe("judgeNavigation", () => {
  it("counts staging as opened only when the browser tool says it navigated there", () => {
    expect(judgeNavigation("https://staging.example.com", { content: [{ type: "text", text: "Successfully navigated to https://staging.example.com." }] }, "opens")).toEqual({ ok: true, detail: "opened" })
    expect(judgeNavigation("https://staging.example.com", { content: [{ type: "text", text: "Unable to navigate in the selected page: net::ERR_NAME_NOT_RESOLVED." }] }, "opens").ok).toBe(false)
    expect(judgeNavigation("https://staging.example.com", { isError: true, content: [] }, "opens").ok).toBe(false)
    expect(judgeNavigation("https://staging.example.com", { isError: true, content: [{ type: "text", text: "Successfully navigated to https://staging.example.com." }] }, "opens").ok).toBe(false)
  })

  it("counts another site as refused only when the allowlist itself refused it (STEP-3328)", () => {
    const blocked = "Unable to navigate in the selected page: Navigation to https://example.com/ is blocked by blocklist/allowlist rules."
    expect(judgeNavigation("https://example.com/", { content: [{ type: "text", text: blocked }] }, "refused")).toEqual({ ok: true, detail: `refused: ${blocked}` })
    expect(judgeNavigation("https://example.com/", { content: [{ type: "text", text: "Successfully navigated to https://example.com/." }] }, "refused")).toEqual({ ok: false, detail: "it opened" })
    // Any other failure proves nothing about the allowlist: a name that did not resolve, an error, the refusal of another URL.
    for (const result of [
      { content: [{ type: "text", text: "Unable to navigate in the selected page: net::ERR_NAME_NOT_RESOLVED." }] },
      { isError: true, content: [{ type: "text", text: "not allowed" }] },
      { isError: true, content: [{ type: "text", text: "MCP error -32602: Input validation error: Invalid arguments for tool navigate_page: Required at pageId" }] },
      { content: [{ type: "text", text: "Unable to navigate in the selected page: Navigation to https://example.org/ is blocked by blocklist/allowlist rules." }] },
      { content: [] },
    ]) {
      const judged = judgeNavigation("https://example.com/", result, "refused")
      expect(judged.ok).toBe(false)
      expect(judged.detail).toMatch(/^not refused by the allowlist/)
    }
  })
})

describe("tryNavigation", () => {
  it("counts a call the browser tool throws on as neither opened nor refused (STEP-3328)", async () => {
    const schemaError = async () => {
      throw new McpError(ErrorCode.InvalidParams, "Input validation error: Invalid arguments for tool navigate_page: Required at pageId")
    }
    for (const want of ["opens", "refused"] as const) {
      const judged = await tryNavigation("https://example.com/", want, schemaError)
      expect(judged.ok).toBe(false)
      expect(judged.detail).toMatch(/^the browser tool failed: .*Required at pageId/)
    }
  })

  it("judges what the call answered", async () => {
    const opened = async (url: string) => ({ content: [{ type: "text", text: `Successfully navigated to ${url}.` }] })
    expect(await tryNavigation("https://staging.example.com", "opens", opened)).toEqual({ ok: true, detail: "opened" })
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

  it("says the allowlist is not proven, not that it failed, when the other site failed some other way", () => {
    const text = formatBrowserProbe([{ ...opens, ok: true, detail: "opened" }, { ...refused, ok: false, detail: "the browser tool failed: Required at pageId" }]).text
    expect(text.split("\n").at(-1)).toBe("the other site was not refused by the allowlist itself, so the allowlist is not proven: keep the browser test off until this passes")
  })

  it("says staging did not open, not that the allowlist failed, when only staging failed", () => {
    const text = formatBrowserProbe([{ ...opens, ok: false, detail: "net::ERR_NAME_NOT_RESOLVED" }, { ...refused, ok: true, detail: "refused: blocked" }]).text
    expect(text.split("\n").at(-1)).toBe("staging did not open, so the allowlist is not proven: keep the browser test off until this passes")
  })
})
