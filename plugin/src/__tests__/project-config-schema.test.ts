/**
 * Schema-validation test for the e2e.fullSuite block (v0.34.0) in
 * schemas/project-config.schema.json.
 *
 * The schema description fields ARE the spec, so this pins the load-bearing
 * contract: on-by-default / opt-out posture, the advisory-only `onRed` enum
 * (no "block" value), and additionalProperties:false. It validates a minimal
 * VALID config fixture (the committed starter intentionally carries
 * fill-me-in placeholders like a non-numeric productId, so it is not a valid
 * instance as-shipped); it also asserts the starter's fullSuite example
 * mirrors the schema defaults so the two can't drift apart.
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import Ajv from "ajv"
import addFormats from "ajv-formats"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(__dirname, "..", "..", "schemas", "project-config.schema.json")
const STARTER_PATH = resolve(__dirname, "..", "..", "templates", "starter-project-config.json")

const schema = JSON.parse(readFileSync(SCHEMA_PATH, "utf-8"))
const starter = JSON.parse(readFileSync(STARTER_PATH, "utf-8"))

function makeValidator() {
  const ajv = new Ajv({ allErrors: true, strict: false })
  addFormats(ajv)
  // Drop the $schema meta-annotation: it points at the https draft-07 meta URI,
  // which Ajv registers under the http form — compiling with it set throws
  // "no schema with key or ref". Ajv defaults to draft-07 semantics anyway.
  const { $schema: _ignored, ...compilable } = schema
  return ajv.compile(compilable)
}

// Minimal VALID instance exercising the new e2e.fullSuite block.
function validConfig() {
  return {
    version: "1",
    monday: { productId: "2924964797" },
    environments: { uat: { url: "https://test.example.com" } },
    e2e: {
      fullSuite: {
        enabled: true,
        target: "staging",
        command: "pnpm test:e2e",
        workers: "50%",
        recordTo: ["uatDoc", "mondayUpdate"],
        onRed: "record",
      },
    },
  }
}

describe("project-config schema — e2e.fullSuite", () => {
  it("accepts a valid config carrying the e2e.fullSuite block", () => {
    const validate = makeValidator()
    const ok = validate(validConfig())
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2))
    expect(ok).toBe(true)
  })

  it("accepts a numeric (count) workers value", () => {
    const validate = makeValidator()
    const cfg = validConfig()
    cfg.e2e.fullSuite.workers = 4
    expect(validate(cfg)).toBe(true)
  })

  it("defines e2e.fullSuite as on-by-default (opt-out)", () => {
    const fullSuite = schema.properties.e2e.properties.fullSuite
    expect(fullSuite).toBeDefined()
    expect(fullSuite.additionalProperties).toBe(false)
    expect(fullSuite.properties.enabled.default).toBe(true)
    expect(fullSuite.properties.target.enum).toEqual(["staging"])
    expect(fullSuite.properties.workers.default).toBe("50%")
    expect(fullSuite.properties.onRed.default).toBe("record")
    // onRed must NEVER offer a blocking value — this step is advisory only.
    expect(fullSuite.properties.onRed.enum).not.toContain("block")
  })

  it("starter e2e.fullSuite mirrors the schema's opt-out defaults", () => {
    expect(starter.e2e.fullSuite.enabled).toBe(true)
    expect(starter.e2e.fullSuite.target).toBe("staging")
    expect(starter.e2e.fullSuite.onRed).toBe("record")
  })

  it("rejects an unknown e2e.fullSuite property (additionalProperties:false)", () => {
    const validate = makeValidator()
    const cfg: any = validConfig()
    cfg.e2e.fullSuite.bogusField = true
    expect(validate(cfg)).toBe(false)
  })

  it("rejects a blocking onRed value", () => {
    const validate = makeValidator()
    const cfg: any = validConfig()
    cfg.e2e.fullSuite.onRed = "block"
    expect(validate(cfg)).toBe(false)
  })
})

// Minimal VALID instance exercising the v0.37.0 visualDiff capture-contract keys.
function validVisualDiffConfig() {
  return {
    version: "1",
    monday: { productId: "2924964797" },
    environments: { uat: { url: "https://test.example.com" } },
    e2e: {
      personas: [
        { id: "public-visitor", storageState: null },
        { id: "advertiser", storageState: ".playwright/auth-state.json" },
        { id: "super-admin", storageState: ".playwright/admin-auth-state.json" },
      ],
    },
    visualDiff: {
      authPersona: "super-admin",
      loginUrl: "https://test.example.com/api/dev/test-login?persona={persona}&secret={secret}",
      loginSecretEnv: "TEST_LOGIN_SECRET",
      routeMap: [
        { glob: "components/admin/**", routes: ["/en/admin"], persona: "super-admin" },
        { glob: "components/registration/**", routes: ["/en/register"], persona: "advertiser" },
        { glob: "app/[locale]/page.tsx", routes: ["/en"] },
      ],
    },
  }
}

describe("project-config schema — visualDiff capture contract (v0.37.0)", () => {
  it("accepts authPersona + loginUrl + loginSecretEnv + per-route personas", () => {
    const validate = makeValidator()
    const ok = validate(validVisualDiffConfig())
    if (!ok) throw new Error(JSON.stringify(validate.errors, null, 2))
    expect(ok).toBe(true)
  })

  it("accepts null loginUrl/loginSecretEnv (the defaults) and persona-less routeMap entries", () => {
    const validate = makeValidator()
    const cfg: any = validVisualDiffConfig()
    cfg.visualDiff.loginUrl = null
    cfg.visualDiff.loginSecretEnv = null
    cfg.visualDiff.routeMap = [{ glob: "components/**", routes: ["/en"] }]
    expect(validate(cfg)).toBe(true)
  })

  it("declares loginUrl/loginSecretEnv as nullable strings defaulting to null", () => {
    const vd = schema.properties.visualDiff
    expect(vd.additionalProperties).toBe(false)
    expect(vd.properties.loginUrl.type).toEqual(["string", "null"])
    expect(vd.properties.loginUrl.default).toBeNull()
    expect(vd.properties.loginSecretEnv.type).toEqual(["string", "null"])
    expect(vd.properties.loginSecretEnv.default).toBeNull()
  })

  it("routeMap entries accept an optional persona but no unknown keys", () => {
    const validate = makeValidator()
    const item = schema.properties.visualDiff.properties.routeMap.items
    expect(item.properties.persona.type).toBe("string")
    expect(item.required).toEqual(["glob", "routes"]) // persona stays optional

    const cfg: any = validVisualDiffConfig()
    cfg.visualDiff.routeMap[0].bogus = true
    expect(validate(cfg)).toBe(false)
  })

  it("rejects a non-string routeMap persona and an unknown visualDiff key", () => {
    const validate = makeValidator()
    const badPersona: any = validVisualDiffConfig()
    badPersona.visualDiff.routeMap[0].persona = 42
    expect(validate(badPersona)).toBe(false)

    const badKey: any = validVisualDiffConfig()
    badKey.visualDiff.bogusField = true
    expect(validate(badKey)).toBe(false)
  })

  it("starter template carries the new keys with null defaults", () => {
    expect(starter.visualDiff.loginUrl).toBeNull()
    expect(starter.visualDiff.loginSecretEnv).toBeNull()
    expect(starter.visualDiff.routeMap).toEqual([])
  })
})

// Docs-lockstep guard: the capture contract lives in skill prose — these greps
// keep the retired claude-in-chrome-as-upload-capture instruction from silently
// reappearing, and pin the file-producing contract across the three skills.
describe("visualDiff capture contract — docs lockstep (v0.37.0)", () => {
  const shipPr = readFileSync(
    resolve(__dirname, "..", "..", "skills", "ship-pr", "SKILL.md"),
    "utf-8",
  )
  const visualDiff = readFileSync(
    resolve(__dirname, "..", "..", "skills", "visual-diff", "SKILL.md"),
    "utf-8",
  )
  const doctor = readFileSync(
    resolve(__dirname, "..", "..", "skills", "doctor", "SKILL.md"),
    "utf-8",
  )

  it("ship-pr no longer offers MCP browsers as the primary upload capture", () => {
    // The retired v0.33 instruction listed the MCP browsers first with
    // Playwright as an afterthought — its exact phrasing must not return.
    expect(shipPr).not.toContain(
      "via `mcp__claude-in-chrome__*` / `chrome-devtools-mcp` `take_screenshot` (Playwright fallback)",
    )
    expect(shipPr).toContain("npx playwright screenshot")
    expect(shipPr).toContain("--load-storage")
    expect(shipPr).toContain("file-producing")
  })

  it("ship-pr wires the loginUrl fallback with the SSRF origin constraint", () => {
    expect(shipPr).toContain("visualDiff.loginUrl")
    expect(shipPr).toContain("loginSecretEnv")
    expect(shipPr).toMatch(/loginUrl[\s\S]{0,700}origin EQUALS the `environments\.uat\.url` origin/)
  })

  it("visual-diff skill puts the file-producing Playwright path first", () => {
    expect(visualDiff).toContain("npx playwright screenshot")
    const playwrightIdx = visualDiff.indexOf("npx playwright screenshot")
    const claudeInChromeIdx = visualDiff.indexOf("mcp__claude-in-chrome__")
    expect(playwrightIdx).toBeGreaterThan(-1)
    expect(claudeInChromeIdx).toBeGreaterThan(playwrightIdx)
  })

  it("doctor audits the visual-diff wiring", () => {
    expect(doctor).toContain("Visual-diff wiring")
    expect(doctor).toContain("stop-visual-diff-check")
    expect(doctor).toContain("storageState")
  })
})
