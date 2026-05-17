#!/usr/bin/env tsx
/**
 * Regenerate plugin/schemas/reviews.schema.json from the Zod schema in
 * hooks/lib/reviews-schema.ts.
 *
 * Zod is the source of truth. The JSON Schema is a derived artifact.
 *
 * Manual invocation:
 *   npm run generate:schema
 *
 * CI invocation: the sync test in src/__tests__/zod-json-schema-sync.test.ts
 * regenerates in-memory and asserts byte-equality with the committed file.
 * If you edit the Zod schema, run this script and commit the updated JSON.
 */

import { writeFileSync } from "node:fs"
import { resolve, dirname } from "node:path"
import { fileURLToPath } from "node:url"
import { zodToJsonSchema } from "zod-to-json-schema"
import { rowSchema } from "../hooks/lib/reviews-schema.ts"

const __dirname = dirname(fileURLToPath(import.meta.url))
const OUTPUT_PATH = resolve(__dirname, "..", "schemas", "reviews.schema.json")

export function generate(): string {
  const schema = zodToJsonSchema(rowSchema, {
    name: "ReviewMemoryRow",
    target: "jsonSchema7",
    $refStrategy: "none",
  })
  return JSON.stringify(schema, null, 2) + "\n"
}

function main() {
  const content = generate()
  writeFileSync(OUTPUT_PATH, content, { encoding: "utf-8" })
  process.stdout.write(`Wrote ${OUTPUT_PATH}\n`)
}

// Run when invoked directly (not when imported by the sync test)
if (import.meta.url === `file://${process.argv[1]}`) {
  main()
}
