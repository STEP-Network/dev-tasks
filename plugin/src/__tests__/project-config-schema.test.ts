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
