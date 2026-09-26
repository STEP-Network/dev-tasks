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

const LOOPBACK = new Set(["127.0.0.1", "localhost", "[::1]"])

/**
 * Where requests go: Linear, or, for a test that runs the real Claude Code
 * binary end to end, a server on this machine named by
 * DEV_TASKS_LINEAR_ENDPOINT. The key travels with every request, so the
 * override needs the test's own key in LINEAR_API_KEY (never the key file's)
 * and names a loopback http server, or it is refused.
 */
export function linearEndpoint(env: NodeJS.ProcessEnv = process.env): string {
  const override = env.DEV_TASKS_LINEAR_ENDPOINT
  if (!override) return LINEAR_ENDPOINT
  if (!env.LINEAR_API_KEY?.trim()) {
    throw new Error("DEV_TASKS_LINEAR_ENDPOINT is for tests, with their own LINEAR_API_KEY in the environment: never with the key file")
  }
  let url: URL
  try {
    url = new URL(override)
  } catch {
    throw new Error("DEV_TASKS_LINEAR_ENDPOINT is not a URL")
  }
  if (url.protocol !== "http:" || !LOOPBACK.has(url.hostname)) {
    throw new Error("DEV_TASKS_LINEAR_ENDPOINT may only name an http server on this machine's loopback (for tests): the Linear key travels with every request")
  }
  return url.toString()
}

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

/**
 * `opts.key` sends another account's key for this one request: the answer
 * recorder's, which the runtime's agentd alone reads (runtime/src/lower.ts).
 * Without it, the agent's own key.
 */
export async function linearRequest<T>(
  query: string,
  variables: Record<string, unknown> = {},
  opts: { key?: string } = {},
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

  const key = opts.key ?? loadLinearKey()
  const endpoint = linearEndpoint()

  let lastStatus: number | undefined

  for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
    const wait = lastCall + MIN_INTERVAL_MS - Date.now()
    if (wait > 0) await sleep(wait)
    lastCall = Date.now()

    const res = await fetch(endpoint, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: key },
      body: JSON.stringify({ query, variables }),
      // Linear answers GraphQL without redirects. One would be followed with the key.
      redirect: "error",
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
      throw new Error(`Linear: ${message}`)
    }
    return json.data as T
  }

  throw new Error(
    `Linear: gave up after ${MAX_ATTEMPTS} attempts` +
      (lastStatus !== undefined ? ` (last status ${lastStatus})` : ""),
  )
}
