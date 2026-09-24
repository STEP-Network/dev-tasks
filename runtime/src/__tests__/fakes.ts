/** Test helpers shared by the runtime's tests. Not a test file (no .test.ts). */

import type { IssuePatch, Tracker, TrackerIssue, TrackerUser } from "../tracker.ts"

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
    async listReady(limit = 25) {
      record("listReady", [limit])
      return [...issues.values()].filter((i) => i.state === "Ready").slice(0, limit)
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
    async listByState(state, limit = 50) {
      record("listByState", [state, limit])
      return [...issues.values()].filter((i) => i.state === state).slice(0, limit)
    },
  }
  return { tracker, calls, issues, called: (method: string) => calls.filter((c) => c.method === method).map((c) => c.args) }
}
