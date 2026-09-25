/**
 * The people-doors guard (STEP-3330): no agent session writes as a person
 * through the Monday, Slack, Linear or dev-tasks tools, or the Monday, Slack
 * and Linear APIs from the shell. The rules are in people-doors-rules.mjs;
 * this file finds the list, makes the lookups the rules ask for, and speaks
 * the hook's protocol. Always on, in every session that has the plugin: it
 * guards people, not a project's workflow.
 *
 * The list is root's, since dev-tasks is public and an agent session runs as
 * the person: /etc/dev-tasks/people-doors.json, { mondayBoards,
 * slackChannels, agentBots, agentNames? }, trusted only when it and its folder are owned
 * by root and writable by no one else. It is never read from $HOME, and no
 * environment variable moves it. With no trusted list, or an empty one, every
 * Monday, dev-tasks and Slack write is refused (fail closed). The one way out
 * is root's too: /etc/dev-tasks/people-doors.off, for a machine that never
 * works on PolAds.
 *
 * `node people-doors-guard.mjs check` says whether the list is trusted. As a
 * hook: the tool call on stdin, a deny on stdout, nothing otherwise. Plain
 * Node, no dependencies.
 */
import { readFileSync, statSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { decide } from "./people-doors-rules.mjs"

export const LIST_FILE = "/etc/dev-tasks/people-doors.json"
export const OFF_FILE = "/etc/dev-tasks/people-doors.off"
const MONDAY_API = "https://api.monday.com/v2"
const LINEAR_API = "https://api.linear.app/graphql"
const LOOKUP_MS = 5000

/** Root's, and only root can change it: the file and its folder owned by uid 0 and writable by no one else. */
export function rootOwned(path, stat = statSync) {
  try {
    for (const p of [dirname(path), path]) {
      const s = stat(p)
      if (s.uid !== 0 || (s.mode & 0o022) !== 0) return false
    }
    return stat(path).isFile()
  } catch {
    return false
  }
}

/** The list, or null when it is missing, not root's, does not read as one, or has an empty list in it. */
export function readDoors({ file = LIST_FILE, stat = statSync, read = readFileSync } = {}) {
  if (!rootOwned(file, stat)) return null
  try {
    const d = JSON.parse(read(file, "utf8"))
    const list = (v) => (Array.isArray(v) && v.length && v.every((x) => typeof x === "string" && x.trim()) ? v.map((x) => x.trim().replace(/^[#@]/, "")) : null)
    // The agents' display names are optional ("@eve" typed plainly); given, they must read as a list.
    const names = d?.agentNames === undefined || (Array.isArray(d.agentNames) && !d.agentNames.length) ? [] : list(d.agentNames)
    const doors = { mondayBoards: list(d?.mondayBoards), slackChannels: list(d?.slackChannels), agentBots: list(d?.agentBots), agentNames: names }
    return doors.mondayBoards && doors.slackChannels && doors.agentBots && doors.agentNames ? doors : null
  } catch {
    return null
  }
}

/** The machine is out of the guard only when root says so. */
export const guardOff = ({ file = OFF_FILE, stat = statSync } = {}) => rootOwned(file, stat)

async function graphql(url, key, query, variables, fetchImpl) {
  const res = await fetchImpl(url, {
    method: "POST",
    headers: { Authorization: key, "Content-Type": "application/json", "API-Version": "2025-10" },
    body: JSON.stringify({ query, variables }),
    signal: AbortSignal.timeout(LOOKUP_MS),
  })
  if (!res.ok) throw new Error(`answered ${res.status}`)
  const body = await res.json()
  if (body?.errors?.length || !body?.data) throw new Error("answered with errors")
  return body.data
}

const BOARDS_QUERY = `query ($ids: [ID!], $boards: [ID!]) {
  items(ids: $ids, limit: 100) { id board { id } parent_item { board { id } } }
  updates(ids: $ids, limit: 100) { id item { board { id } parent_item { board { id } } } }
  boards(ids: $boards, limit: 100) { id }
}`

/**
 * The boards each id is on, for the ids that are items or updates (a
 * subitem counts on its parent's board too). One read with the person's
 * MONDAY_API_KEY. Throws when it cannot answer, and when the key cannot see
 * every one of the people's boards, since then an item on one would look
 * like no item at all.
 */
export async function boardsOf(ids, peopleBoards, { key = process.env.MONDAY_API_KEY, fetchImpl = fetch } = {}) {
  if (!key?.trim()) throw new Error("no MONDAY_API_KEY")
  if (ids.length > 100) throw new Error("more ids than one lookup takes")
  const data = await graphql(MONDAY_API, key.trim(), BOARDS_QUERY, { ids, boards: peopleBoards }, fetchImpl)
  const seen = new Set((data.boards ?? []).map((b) => String(b.id)))
  if (!peopleBoards.every((b) => seen.has(b))) throw new Error("the key cannot see the people's boards")
  const on = (item) => [item?.board?.id, item?.parent_item?.board?.id].filter(Boolean).map(String)
  const boards = new Map()
  for (const [id, item] of [...(data.items ?? []).map((i) => [i.id, i]), ...(data.updates ?? []).map((u) => [u.id, u.item])]) {
    boards.set(String(id), [...(boards.get(String(id)) ?? []), ...on(item)])
  }
  return boards
}

/** The person's Linear key, where the plugin's own Linear client finds it. */
export function linearKey(env = process.env, home = homedir()) {
  if (env.LINEAR_API_KEY?.trim()) return env.LINEAR_API_KEY.trim()
  const line = readFileSync(join(home, ".config", "linear", ".env"), "utf8")
    .split("\n")
    .find((l) => l.startsWith("LINEAR_API_KEY="))
  const key = line?.slice("LINEAR_API_KEY=".length).trim()
  if (!key) throw new Error("no Linear key")
  return key
}

/** An issue's description as it stands. Throws when Linear cannot say. */
export async function descriptionOf(issue, { key = () => linearKey(), fetchImpl = fetch } = {}) {
  const data = await graphql(LINEAR_API, key(), "query ($id: String!) { issue(id: $id) { description } }", { id: issue }, fetchImpl)
  if (!data.issue) throw new Error("no such issue")
  return data.issue.description ?? ""
}

/** The names of labels given by id. Throws unless Linear names every one. */
export async function labelNamesOf(ids, { key = () => linearKey(), fetchImpl = fetch } = {}) {
  const data = await graphql(LINEAR_API, key(), "query ($ids: [ID!]) { issueLabels(filter: { id: { in: $ids } }, first: 100) { nodes { id name } } }", { ids }, fetchImpl)
  const nodes = data.issueLabels?.nodes ?? []
  if (new Set(nodes.map((n) => n.id)).size < new Set(ids).size) throw new Error("not every label found")
  return nodes.map((n) => n.name)
}

/** The hook's answer to one tool call: a deny, or null to say nothing. */
export async function hook(call, { doors = readDoors(), off = guardOff(), lookups = { boardsOf, descriptionOf, labelNamesOf } } = {}) {
  if (off) return null
  try {
    return await decide(call ?? {}, { doors, listFile: LIST_FILE, ...lookups })
  } catch (error) {
    return { deny: `The people-doors guard failed (${error instanceof Error ? error.message : String(error)}), so it refused the call.` }
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  if (process.argv[2] === "check") {
    const doors = readDoors()
    if (guardOff()) process.stdout.write(`people-doors guard: off on this machine (${OFF_FILE})\n`)
    else if (doors) process.stdout.write(`people-doors guard: on, ${LIST_FILE} is root's: ${doors.mondayBoards.length} board(s), ${doors.slackChannels.length} channel(s), ${doors.agentBots.length} bot(s)\n`)
    else {
      process.stdout.write(`people-doors guard: on, with NO trusted list: ${LIST_FILE} is missing, not root's, or has an empty list, so every Monday, dev-tasks and Slack write is refused\n`)
      process.exit(1)
    }
  } else {
    let raw = ""
    process.stdin.on("data", (chunk) => (raw += chunk))
    process.stdin.on("end", async () => {
      let call
      try {
        call = JSON.parse(raw)
      } catch {
        call = null
      }
      // A call it cannot read is one it cannot check.
      const verdict = call ? await hook(call) : { deny: "The people-doors guard could not read the tool call, so it refused it." }
      if (verdict) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.deny } }))
    })
  }
}
