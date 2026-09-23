/**
 * Minimal Linear GraphQL transport for the tracker adapter.
 *
 * This is a deliberate SECOND COPY of scripts/linear/client.ts in the PolAds
 * repo. The two live in different repositories with no package between them;
 * vendoring one into the other would couple a plugin release to a product
 * release. Keep the two in step by hand when either changes, and keep both
 * sets of tests — the properties, not the file, are what must agree.
 *
 * The key is read from LINEAR_API_KEY, else from ~/.config/linear/.env
 * (mode 600). It is never logged, never interpolated into an error message
 * and never passed as an argv element.
 */

import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"

export const LINEAR_ENDPOINT = "https://api.linear.app/graphql"

const MIN_INTERVAL_MS = 1500
const MAX_ATTEMPTS = 6
const MAX_BACKOFF_MS = 60_000

let lastCall = 0
let writesPerformed = 0

/** Test seam. Never called in production. */
export function resetLinearClientForTests(): void {
  lastCall = 0
  writesPerformed = 0
}

export function loadLinearKey(): string {
  const fromEnv = process.env.LINEAR_API_KEY
  if (fromEnv && fromEnv.trim()) return fromEnv.trim()

  const path = join(homedir(), ".config", "linear", ".env")
  let contents: string
  try {
    contents = readFileSync(path, "utf8")
  } catch {
    throw new Error(
      `LINEAR_API_KEY is not set and ${path} could not be read. ` +
        `Put LINEAR_API_KEY=<key> in that file (chmod 600) or export it.`,
    )
  }
  const line = contents.split("\n").find((l) => l.startsWith("LINEAR_API_KEY="))
  if (!line) {
    throw new Error(`LINEAR_API_KEY missing from ${path}`)
  }
  const key = line.slice("LINEAR_API_KEY=".length).trim()
  if (!key) throw new Error(`LINEAR_API_KEY is empty in ${path}`)
  return key
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms))

/**
 * Linear reports some transient failures as GraphQL errors over an HTTP 200.
 * Those get the same backoff as a 5xx; anything else is a real refusal and
 * throws on the first attempt.
 */
const TRANSIENT_RE =
  /internal server error|ratelimited|rate limit|timed? ?out|temporarily unavailable/i

const MUTATION_RE = /^\s*mutation\b/i

/**
 * How Linear refuses a create whose `id` is already taken. The adapter sends
 * its own UUID on every create precisely so that a retry after a lost answer
 * gets this refusal instead of making a duplicate.
 */
const CONFLICT_RE = /already exists|conflict on insert/i

/**
 * A mutation's RETRY was refused because its id already exists. Usually the
 * earlier attempt landed and only its answer was lost, but Linear also
 * reports phantom insert conflicts for ids nothing holds, so this is not
 * proof: the caller settles it by reading the id back.
 */
export class LinearCreateConflictError extends Error {
  constructor(message: string) {
    super(message)
    this.name = "LinearCreateConflictError"
  }
}

/**
 * Unset/empty means "no cap" (open). Anything else must be a base-10
 * non-negative integer or this throws — a typo or a negative value must
 * fail CLOSED, not silently disable the cap on a live run. Never echoes the
 * raw value in the thrown message.
 */
function maxWrites(): number {
  const raw = process.env.TRACKERCTL_MAX_WRITES
  if (raw === undefined) return Number.POSITIVE_INFINITY
  const trimmed = raw.trim()
  if (!trimmed) return Number.POSITIVE_INFINITY
  if (!/^\d+$/.test(trimmed)) {
    throw new Error("TRACKERCTL_MAX_WRITES must be a non-negative integer.")
  }
  return Number.parseInt(trimmed, 10)
}

export async function linearRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const isMutation = MUTATION_RE.test(query)
  if (isMutation) {
    const cap = maxWrites()
    if (writesPerformed >= cap) {
      throw new Error(
        `Refusing the write: TRACKERCTL_MAX_WRITES=${cap} reached. ` +
          `Raise or unset it to continue.`,
      )
    }
    writesPerformed += 1
  }

  const key = loadLinearKey()

  let lastStatus: number | undefined

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()

    const res = await fetch(LINEAR_ENDPOINT, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
    })

    if (res.status === 429 || res.status >= 500) {
      lastStatus = res.status
      // Don't burn the backoff sleep on the final attempt — fall through to
      // the give-up error immediately.
      if (attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** attempt))
      }
      continue
    }

    const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> }
    if (json.errors?.length) {
      const message = json.errors.map((e) => e.message).join("; ")
      if (TRANSIENT_RE.test(message) && attempt < MAX_ATTEMPTS - 1) {
        await sleep(Math.min(MAX_BACKOFF_MS, 2_000 * 2 ** attempt))
        continue
      }
      // Only on a retry: on the first attempt nothing of ours can have landed.
      if (isMutation && attempt > 0 && CONFLICT_RE.test(message)) {
        throw new LinearCreateConflictError(`Linear: ${message}`)
      }
      throw new Error(`Linear: ${message}`)
    }
    return json.data as T
  }

  throw new Error(
    `Linear: gave up after ${MAX_ATTEMPTS} attempts` +
      (lastStatus !== undefined ? ` (last status ${lastStatus})` : ""),
  )
}
