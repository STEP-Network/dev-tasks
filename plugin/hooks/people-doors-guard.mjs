/**
 * The people-doors guard (STEP-3330). The Monday bridge takes a Monday user's
 * update or Answer column as that person's words, and the Slack bridge a
 * Slack member's reply. The claude.ai connectors write as the person whose
 * account they use. So no agent session writes through them on the people's
 * boards, in their channels or to the agents' bots, none writes an answer
 * entry or a recorder's label through the Linear connector, and none changes
 * this guard's own list. Always on, in every session that has the plugin: it
 * guards people, not a project's workflow.
 *
 * The list is local to each machine, since dev-tasks is public:
 * ~/.config/dev-tasks/people-doors.json, { mondayBoards, slackChannels,
 * agentBots }. With none, every Monday item write and Slack send is refused
 * (fail closed). `node people-doors-guard.mjs add ...` places or extends it,
 * and never takes anything out: only a person does that, by hand.
 *
 * As a hook: the tool call on stdin, a deny on stdout, nothing otherwise.
 * Plain Node, no dependencies.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"

export const doorsFile = (home = homedir()) => join(home, ".config", "dev-tasks", "people-doors.json")

const MONDAY = "mcp__claude_ai_monday_com__"
const SLACK = "mcp__claude_ai_Slack__"
const LINEAR = "mcp__linear-server__"
/** Tools that write items on the board their input names. */
const MONDAY_BOARD_WRITES = new Set(["create_item", "create_items", "update_items", "change_item_column_values", "create_form_submission", "move_object"])
/** Tools that can run any mutation: refused when it touches an item, whose board the hook cannot know. */
const MONDAY_GENERIC = new Set(["all_api_write", "all_monday_api", "execute_code"])
const ITEM_MUTATION = /\b(create_update|create_item|create_subitem|change_column_value|change_simple_column_value|change_multiple_column_values|move_item_to_board|move_item_to_group|archive_item|delete_item|duplicate_item|like_update|delete_update|edit_update)\b/
const SLACK_WRITE = /(send|post|reply|schedule|update|edit)/i
const ANSWER_ENTRY = /<!-- (slack|monday|slack-user):/
const RECORDER_LABELS = ["plan-to-approve", "plan-approved"]

const MONDAY_NO = "An agent session cannot write on the people's Monday boards as a person: the Monday bridge would take it for their words. Ask the person to do it themselves."
const SLACK_NO = "An agent session cannot write in the people's Slack channels, or to the agents, as a person: the Slack bridge would take it for their words. Ask the person to do it themselves."
const LINEAR_NO = "Answers on an issue and a plan's approval are the answer recorder's to write, never an agent session's."
const LIST_NO = "The people-doors guard's list is a person's to change, never an agent session's. Read it with cat, or add to it with: node <dev-tasks>/plugin/hooks/people-doors-guard.mjs add."
const noList = (home) =>
  `${doorsFile(home)} is missing, so this session cannot tell which Monday boards and Slack channels are the people's, and writes on none of them as a person. A person places it with: node <dev-tasks>/plugin/hooks/people-doors-guard.mjs add (runbook, The Monday board).`

/** The list, or null when there is none or it does not read as one. */
export function readDoors(file = doorsFile()) {
  try {
    const d = JSON.parse(readFileSync(file, "utf8"))
    const list = (v) => (Array.isArray(v) && v.every((x) => typeof x === "string" && x) ? v : null)
    const doors = { mondayBoards: list(d?.mondayBoards), slackChannels: list(d?.slackChannels), agentBots: list(d?.agentBots) }
    return doors.mondayBoards && doors.slackChannels && doors.agentBots ? doors : null
  } catch {
    return null
  }
}

/** Every string (and number, as a string) anywhere in a tool's input. */
function values(input, out = []) {
  if (typeof input === "string") out.push(input)
  else if (typeof input === "number") out.push(String(input))
  else if (Array.isArray(input)) for (const v of input) values(v, out)
  else if (input && typeof input === "object") for (const v of Object.values(input)) values(v, out)
  return out
}

const names = (input, id) => values(input).some((v) => v === id || new RegExp(`(^|[^0-9])${id}([^0-9]|$)`).test(v))

function monday(name, input, doors, home) {
  const generic = MONDAY_GENERIC.has(name)
  const writes = MONDAY_BOARD_WRITES.has(name) || name === "create_update" || (generic && values(input).some((v) => ITEM_MUTATION.test(v)))
  if (!writes) return null
  if (!doors) return { deny: noList(home) }
  // An update and a generic item mutation name no board the hook can trust: refused whatever the board.
  if (name === "create_update" || generic) return { deny: MONDAY_NO }
  return doors.mondayBoards.some((b) => names(input, b)) ? { deny: MONDAY_NO } : null
}

function slack(name, input, doors, home) {
  // A draft is the person's to send: sending it is their act, not the session's.
  if (!SLACK_WRITE.test(name) || /draft/i.test(name)) return null
  if (!doors) return { deny: noList(home) }
  const said = values(input)
  const inChannel = said.some((v) => doors.slackChannels.includes(v.replace(/^#/, "")))
  const toAgent = said.some((v) => doors.agentBots.some((b) => v.includes(`<@${b}`)))
  return inChannel || toAgent ? { deny: SLACK_NO } : null
}

function linear(name, input) {
  if (name !== "save_issue" && name !== "save_comment") return null
  if (values(input).some((v) => ANSWER_ENTRY.test(v))) return { deny: LINEAR_NO }
  if (name !== "save_issue") return null
  const added = Array.isArray(input?.addLabels) ? input.addLabels : []
  const removed = Array.isArray(input?.removeLabels) ? input.removeLabels : []
  if (added.includes("plan-approved") || removed.some((l) => RECORDER_LABELS.includes(l))) return { deny: LINEAR_NO }
  // A whole new label set on an existing issue could drop a recorder's label unseen: add and remove instead.
  if (input?.id && Array.isArray(input?.labels)) return { deny: `${LINEAR_NO} Change an existing issue's labels with addLabels and removeLabels.` }
  return null
}

/** The guard's own list: a plain read of it passes, any other Edit, Write or command that names it or its folder is refused. */
function ownList(tool, input, home) {
  const folder = dirname(doorsFile(home))
  if (tool === "Bash") {
    const command = String(input?.command ?? "")
    if (!/\.config\/dev-tasks|people-doors\.json/.test(command)) return null
    return /^\s*cat\s+"?[^\s"<>|;&]+"?\s*$/.test(command) ? null : { deny: LIST_NO }
  }
  const path = input?.file_path ?? input?.notebook_path
  if (typeof path !== "string") return null
  const full = resolve(path.replace(/^~(?=\/)/, home))
  return full === folder || full.startsWith(`${folder}/`) ? { deny: LIST_NO } : null
}

export function decide({ tool_name: tool, tool_input: input }, doors, home = homedir()) {
  if (typeof tool !== "string") return null
  if (tool.startsWith(MONDAY)) return monday(tool.slice(MONDAY.length), input, doors, home)
  if (tool.startsWith(SLACK)) return slack(tool.slice(SLACK.length), input, doors, home)
  if (tool.startsWith(LINEAR)) return linear(tool.slice(LINEAR.length), input)
  if (["Bash", "Edit", "Write", "MultiEdit", "NotebookEdit"].includes(tool)) return ownList(tool, input, home)
  return null
}

const BOARD = /^\d+$/
const CHANNEL = /^([CG][A-Z0-9]{6,}|[a-z0-9][a-z0-9._-]{0,79})$/
const BOT = /^[UWB][A-Z0-9]{6,}$/

/**
 * Places the list, or adds to it, never taking anything out: agents may run
 * it, since it can only make the guard hold more. A new list needs a board, a
 * channel and a bot, so it is never one that guards nothing.
 */
export function addToDoors(file, add) {
  for (const b of add.boards) if (!BOARD.test(b)) throw new Error(`${JSON.stringify(b)} is not a Monday board id (digits)`)
  for (const c of add.channels) if (!CHANNEL.test(c.replace(/^#/, ""))) throw new Error(`${JSON.stringify(c)} is not a Slack channel id or name`)
  for (const u of add.bots) if (!BOT.test(u)) throw new Error(`${JSON.stringify(u)} is not a Slack bot user id`)
  let current = { mondayBoards: [], slackChannels: [], agentBots: [] }
  if (existsSync(file)) {
    const read = readDoors(file)
    if (!read) throw new Error(`cannot read ${file} as the guard's list: a person fixes it by hand, and this command changes nothing`)
    current = read
  } else if (!add.boards.length || !add.channels.length || !add.bots.length) {
    throw new Error("a new list needs a board, a channel and a bot, so it never guards nothing")
  }
  const merged = (a, b) => [...new Set([...a, ...b])]
  const next = {
    mondayBoards: merged(current.mondayBoards, add.boards),
    slackChannels: merged(current.slackChannels, add.channels.map((c) => c.replace(/^#/, ""))),
    agentBots: merged(current.agentBots, add.bots),
  }
  mkdirSync(dirname(file), { recursive: true, mode: 0o700 })
  const tmp = `${file}.${process.pid}.tmp`
  writeFileSync(tmp, `${JSON.stringify(next, null, 2)}\n`, { mode: 0o600 })
  chmodSync(tmp, 0o600)
  renameSync(tmp, file)
  return next
}

/** `add --board <id> --channel <id or name> --bot <id>`, each as often as needed. */
function parseAdd(args) {
  const add = { boards: [], channels: [], bots: [] }
  const into = { "--board": add.boards, "--channel": add.channels, "--bot": add.bots }
  for (let i = 0; i < args.length; i += 2) {
    const list = into[args[i]]
    if (!list || args[i + 1] === undefined) throw new Error(`usage: people-doors-guard.mjs add [--board <id>]... [--channel <id or name>]... [--bot <id>]...`)
    list.push(args[i + 1])
  }
  return add
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const [command, ...rest] = process.argv.slice(2)
  if (command === "add") {
    try {
      const doors = addToDoors(doorsFile(), parseAdd(rest))
      process.stdout.write(`${JSON.stringify(doors, null, 2)}\n`)
    } catch (error) {
      process.stderr.write(`people-doors-guard: ${error instanceof Error ? error.message : String(error)}\n`)
      process.exit(1)
    }
  } else {
    let raw = ""
    process.stdin.on("data", (chunk) => (raw += chunk))
    process.stdin.on("end", () => {
      let call
      try {
        call = JSON.parse(raw)
      } catch {
        return
      }
      const verdict = decide(call ?? {}, readDoors())
      if (verdict) process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: verdict.deny } }))
    })
  }
}
