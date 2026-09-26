/** Test helpers shared by the runtime's tests. Not a test file (no .test.ts). */

import type { IssuePatch, Tracker, TrackerIssue, TrackerUser } from "../tracker.ts"
import type { Exec, ExecResult } from "../worker/git.ts"

export const EVE: TrackerUser = { id: "user-eve", name: "Eve", email: "eve@polads.eu" }

export function issue(over: Partial<TrackerIssue> & { id: string }): TrackerIssue {
  return {
    uuid: `uuid-${over.id}`,
    title: "An issue",
    description: "",
    acceptanceCriteria: "",
    state: "Ready",
    labels: [],
    url: `https://linear.app/step/issue/${over.id}`,
    priority: 3,
    updatedAt: "2026-09-24T08:00:00.000Z",
    assigneeId: null,
    ...over,
  }
}

/** A client-chosen issue id Linear accepts: a v4 UUID, with its variant bits (STEP-3323). */
export const LINEAR_CLIENT_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

/** Throws what Linear answers for any other client id, so a fake refuses what the real API refuses. */
export function assertLinearClientId(clientId: string | undefined): void {
  if (clientId !== undefined && !LINEAR_CLIENT_ID.test(clientId)) throw new Error("Linear: Argument Validation Error: id must be a UUID")
}

/** An in-memory tracker that records every call. `failOn` makes named methods throw. */
export function fakeTracker(seed: TrackerIssue[] = [], me: TrackerUser = EVE, failOn: string[] = []) {
  const issues = new Map(seed.map((i) => [i.id, i]))
  const calls: Array<{ method: string; args: unknown[] }> = []
  const record = (method: string, args: unknown[]) => {
    calls.push({ method, args })
    if (failOn.includes(method)) throw new Error(`Linear: ${method} failed (fake)`)
  }
  const find = (ref: string): TrackerIssue => {
    const hit = issues.get(ref) ?? [...issues.values()].find((i) => i.uuid === ref)
    if (!hit) throw new Error(`Linear: no issue ${ref}`)
    return hit
  }
  const apply = (ref: string, patch: IssuePatch): TrackerIssue => {
    const cur = find(ref)
    const next: TrackerIssue = {
      ...cur,
      ...(patch.description !== undefined ? { description: patch.description } : {}),
      ...(patch.state !== undefined ? { state: patch.state } : {}),
      labels: [...cur.labels.filter((l) => !(patch.removeLabels ?? []).includes(l)), ...(patch.addLabels ?? [])],
      ...(patch.assignee !== undefined ? { assigneeId: patch.assignee === "me" ? me.id : null } : {}),
    }
    issues.set(cur.id, next)
    return next
  }
  const tracker: Tracker = {
    kind: "linear",
    async readIssue(ref) {
      record("readIssue", [ref])
      return find(ref)
    },
    async claimIssue(ref, claimant) {
      record("claimIssue", [ref, claimant])
      // As the real adapter: an issue someone else holds is refused.
      const cur = find(ref)
      if (cur.assigneeId && cur.assigneeId !== me.id) throw new Error(`Linear: ${cur.id} is assigned to someone else; not claiming it`)
      return apply(ref, { state: "In Progress", assignee: "me" })
    },
    async createIssue(input) {
      record("createIssue", [input])
      // As Linear itself: a client id that is not a v4 UUID is refused (STEP-3323).
      assertLinearClientId(input.clientId)
      // As the real adapter since dev-tasks #96: a create whose client id is taken reads that issue back.
      const taken = input.clientId ? [...issues.values()].find((i) => i.uuid === input.clientId) : undefined
      if (taken) return taken
      const id = `STEP-${900 + issues.size}`
      const created = issue({ id, uuid: input.clientId ?? `uuid-${id}`, title: input.title, description: input.description ?? "", state: input.state ?? "Backlog", labels: input.labels ?? [] })
      issues.set(id, created)
      return created
    },
    async comment(ref, body) {
      record("comment", [ref, body])
    },
    async attachLink(ref, url, title) {
      record("attachLink", [ref, url, title])
    },
    // As Linear does: `only` filters the state, and the cut to `limit` comes after (STEP-3368).
    async listReady(limit = 25, only) {
      record("listReady", only ? [limit, only] : [limit])
      return [...issues.values()].filter((i) => i.state === "Ready" && (!only || only.includes(i.id))).slice(0, limit)
    },
    async whoami() {
      record("whoami", [])
      return me
    },
    async updateIssue(ref, patch) {
      record("updateIssue", [ref, patch])
      return apply(ref, patch)
    },
    async touchClaim(ref, claimant) {
      record("touchClaim", [ref, claimant])
      return true
    },
    async releaseIssue(ref, reason) {
      record("releaseIssue", [ref, reason])
      apply(ref, { state: "Ready", assignee: null })
    },
    async listClaims() {
      record("listClaims", [])
      return []
    },
    async listByState(state, limit = 50, only) {
      record("listByState", only ? [state, limit, only] : [state, limit])
      return [...issues.values()].filter((i) => i.state === state && (!only || only.includes(i.id))).slice(0, limit)
    },
  }
  return { tracker, calls, issues, called: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args) }
}

/** Records every command, and answers from the first matching pattern, else with success and no output. */
export function fakeExec(responses: Array<[RegExp, Partial<ExecResult>]> = []) {
  const calls: Array<{ line: string; cwd?: string }> = []
  const exec: Exec = async (cmd, args, opts = {}) => {
    const line = `${cmd} ${args.join(" ")}`
    calls.push({ line, cwd: opts.cwd })
    for (const [re, r] of responses) if (re.test(line)) return { code: 0, stdout: "", stderr: "", ...r }
    return { code: 0, stdout: "", stderr: "" }
  }
  return { exec, calls, lines: () => calls.map((c) => c.line) }
}

/** A done report's one-hop sweep, answered in full (STEP-3284), for tests whose report must pass the runner's self-check. */
export const SWEEP = {
  siblings: "rg -n 'createdAt' lib app: one other reader, lib/feed.ts, changed too",
  publicOutputs: "the notice page and its PDF, both through the same helper",
  caches: "none: the notice cache keys on the id, and its output keeps its meaning",
  coupled: "none: no cron, reminder or email reads the date",
  docs: "rg -n 'createdAt' API_DOCUMENTATION.md .claude/reference: one line updated",
  translations: "none: no messages changed",
}
