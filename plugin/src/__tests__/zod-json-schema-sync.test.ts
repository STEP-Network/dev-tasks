/**
 * Sync test — keeps Zod ↔ JSON Schema in lockstep.
 *
 * The Zod schema (hooks/lib/reviews-schema.ts) is the source of truth.
 * The JSON Schema (schemas/reviews.schema.json) is a derived artifact
 * regenerated via scripts/generate-reviews-schema.ts.
 *
 * This test re-derives the JSON schema in-memory from the same generator
 * and asserts byte-equality with the committed file. If you edit the Zod
 * schema and forget to regenerate, this fails with a diff that tells you
 * to run `pnpm generate:schema`.
 */

import { readFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { describe, it, expect } from "vitest"
import { generate } from "../../scripts/generate-reviews-schema.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const SCHEMA_PATH = resolve(__dirname, "..", "..", "schemas", "reviews.schema.json")

describe("Zod ↔ JSON Schema sync", () => {
  it("committed schemas/reviews.schema.json matches output of zod-to-json-schema on the current Zod schema", () => {
    const committed = readFileSync(SCHEMA_PATH, "utf-8")
    const regenerated = generate()

    if (committed !== regenerated) {
      const message = [
        "schemas/reviews.schema.json is out of sync with hooks/lib/reviews-schema.ts.",
        "",
        "Run `pnpm generate:schema` and commit the updated JSON.",
        "",
        "First diverging line:",
      ]
      const committedLines = committed.split("\n")
      const regeneratedLines = regenerated.split("\n")
      for (let i = 0; i < Math.max(committedLines.length, regeneratedLines.length); i++) {
        if (committedLines[i] !== regeneratedLines[i]) {
          message.push(`  Line ${i + 1}:`)
          message.push(`    committed:    ${committedLines[i] ?? "(end of file)"}`)
          message.push(`    regenerated:  ${regeneratedLines[i] ?? "(end of file)"}`)
          break
        }
      }
      throw new Error(message.join("\n"))
    }

    expect(committed).toBe(regenerated)
  })
})
