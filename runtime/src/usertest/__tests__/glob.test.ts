import { describe, expect, it } from "vitest"
import { globToRegExp, matchesAny } from "../glob.ts"

describe("globToRegExp", () => {
  it("reads ** across folders, * within one, and brackets literally", () => {
    expect(globToRegExp("components/**").test("components/ui/button.tsx")).toBe(true)
    expect(globToRegExp("lib/*.ts").test("lib/a/b.ts")).toBe(false)
    expect(globToRegExp("app/[locale]/admin/**").test("app/[locale]/admin/page.tsx")).toBe(true)
    expect(globToRegExp("app/[locale]/admin/**").test("app/l/admin/page.tsx")).toBe(false)
    expect(globToRegExp("**/__tests__/**").test("lib/x/__tests__/a.test.ts")).toBe(true)
  })

  it("matches any of several globs", () => {
    expect(matchesAny("docs/a.md", ["lib/**", "docs/**"])).toBe(true)
  })
})
