/**
 * The people-doors guard's rules (STEP-3330): what the hook refuses, given
 * the call, the list of the people's doors, and the lookups the hook makes
 * when a rule needs them. The Monday bridge takes a Monday user's update or
 * Answer column as that person's words, the Slack bridge a Slack member's
 * message, and the answer recorder trusts the answer entries on a Linear
 * issue. The connectors write as the person whose account they use.
 *
 * - Monday and dev-tasks servers: reads pass. Anything else passes only when
 *   it touches none of the people's boards: every id in it is looked up, and
 *   a people's board, an item or update on one, or a lookup that cannot
 *   answer is refused. Code that can build any call (execute_code) is refused
 *   outright.
 * - Slack servers: reads pass. Anything else is refused when it names a
 *   people's channel or an agent's bot anywhere in its input.
 * - Linear servers: no answer entry and no recorder label, ever; an edit to
 *   an existing issue's description passes only when its answer entries come
 *   out exactly as they were.
 * - Bash: no call to the Monday or Linear API at all, no write to Slack's,
 *   and no sudo on the guard's own list. A script that calls them from a
 *   file (python, node) is not seen.
 *
 * It stops a misled session, not a determined one: a session set on it can
 * still find another way. The detection layer is the #polads-agents notice of
 * every plan approval and every lowering, with who and where.
 */

/** Which guarded service a tool's server is, by name: any server whose name says monday, slack, linear or dev-tasks. */
export function serviceOf(tool) {
  const m = /^mcp__(.+?)__(.+)$/.exec(String(tool))
  if (!m) return null
  const server = m[1].toLowerCase()
  const kind = /dev[-_]?tasks/.test(server) ? "devtasks" : /monday/.test(server) ? "monday" : /slack/.test(server) ? "slack" : /linear/.test(server) ? "linear" : null
  return kind ? { kind, name: m[2] } : null
}

/** Reads whose names start with no read verb: named one by one, since a last word like `status` can end a write too (`update_status`). */
const READS_BY_NAME = new Set(["all_api_read", "board_insights", "workspace_info", "agent_catalog", "all_widgets_schema"])

/** A tool that only reads, by its name's first verb. Everything else counts as a write. */
export function isRead(name) {
  // slack_read_channel reads as read_channel: a tool may carry its service's name first.
  const n = String(name).replace(/([a-z])([A-Z])/g, "$1_$2").replace(/-/g, "_").toLowerCase().replace(/^(slack|monday|linear|dev_tasks)_/, "")
  return READS_BY_NAME.has(n) || /^(get|list|read|search|fetch|find|query|describe|view|explore|lookup|show)(_|$)/.test(n)
}

/** Every string (and number, as a string) anywhere in a tool's input. */
export function values(input, out = []) {
  if (typeof input === "string") out.push(input)
  else if (typeof input === "number") out.push(String(input))
  else if (Array.isArray(input)) for (const v of input) values(v, out)
  else if (input && typeof input === "object") for (const v of Object.values(input)) values(v, out)
  return out
}

/** An id as Monday reads it: `07000000001` is item 7000000001. */
export const normId = (id) => String(id).trim().replace(/^0+(?=\d)/, "")

/** The ids a Monday or dev-tasks call could touch: every run of six or more digits in its input, as Monday reads it. */
export function mondayIds(input) {
  const ids = new Set()
  for (const v of values(input)) for (const m of v.matchAll(/(?<!\d)\d{6,}(?!\d)/g)) ids.add(normId(m[0]))
  return [...ids]
}

const MONDAY_NO = "An agent session cannot write on the people's Monday boards as a person: the Monday bridge would take it for their words. Ask the person to do it themselves."
const UNSURE_NO = "The people-doors guard could not tell which board this touches (no MONDAY_API_KEY, a key that cannot see the people's boards, or Monday did not answer), so it refused it. Ask the person to do it themselves, or try again."
const CODE_NO = "Monday code execution can reach any board, so the people-doors guard refuses it. Use the typed Monday tools, which it can check."
const SLACK_NO = "An agent session cannot write in the people's Slack channels, or to the agents, as a person: the Slack bridge would take it for their words. Ask the person to do it themselves."
const LINEAR_NO = "Answers on an issue and a plan's approval are the answer recorder's to write, never an agent session's."
const DESCRIPTION_NO = "This edit would add, change or take out an answer the recorder wrote on the issue, so the people-doors guard refused it. Keep the answer entries exactly as they are."
const DESCRIPTION_UNSURE = "The people-doors guard could not read the issue's description (no Linear key, or Linear did not answer), so it cannot check this edit keeps the recorder's answers. Edit it with trackerctl, which keeps them."
const PATCH_UNSURE = "This patch would not apply to the issue's description as it stands, so the people-doors guard cannot check it keeps the recorder's answers. Read the issue again and patch what is there."
const LABEL_UNSURE = "The people-doors guard could not read which labels these ids are (no Linear key, or Linear did not answer), so it refused the call. Name the labels instead of their ids."
const GRAPHQL_NO = "An agent session does not call the Monday or Linear API from the shell, reads included: a write there would pass for a person or for the answer recorder, and the guard cannot see what a shell command sends. Use the Monday and Linear tools, or trackerctl, which the guard can check. (Searching code for the host name: use the Grep tool.)"
const SLACK_API_NO = "An agent session cannot write to the Slack API from the shell: that would pass for a person. Use the Slack tools, which the people-doors guard can check."
const LIST_NO = "The people-doors guard's list is root's, set once by a person with sudo. An agent session never changes it."
export const NO_LIST = (file) =>
  `${file} is missing, not root's, or has an empty list, so this session cannot tell which Monday boards and Slack channels are the people's, and writes on none of them as a person. A person sets it once with sudo (runbook, The Monday board).`

async function monday(name, input, ctx) {
  if (isRead(name)) return null
  // The one GraphQL tool that takes both: without a mutation it only reads.
  if (name === "all_monday_api" && !values(input).some((v) => /\bmutation\b/.test(v))) return null
  if (!ctx.doors) return { deny: NO_LIST(ctx.listFile) }
  if (name === "execute_code") return { deny: CODE_NO }
  const ids = mondayIds(input)
  const people = ctx.doors.mondayBoards.map(normId)
  if (ids.some((id) => people.includes(id))) return { deny: MONDAY_NO }
  // Touches no existing board, item or update: a new board, a workspace, a doc of its own.
  if (!ids.length) return null
  let boards
  try {
    boards = await ctx.boardsOf(ids, people)
  } catch {
    return { deny: UNSURE_NO }
  }
  return ids.some((id) => (boards.get(id) ?? []).some((b) => people.includes(normId(b)))) ? { deny: MONDAY_NO } : null
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")

function slack(name, input, doors, listFile) {
  if (isRead(name)) return null
  if (!doors) return { deny: NO_LIST(listFile) }
  const said = values(input)
  const channel = said.some((v) => doors.slackChannels.includes(v.trim().replace(/^#/, "")))
  const agent = said.some((v) => doors.agentBots.some((b) => v.trim() === b || v.includes(`<@${b}`)))
  // "@eve" typed plainly: Slack turns it into a mention when the message is sent with link_names.
  const named = (doors.agentNames ?? []).some((n) => said.some((v) => new RegExp(`(^|[^\\w@])@${escapeRe(n)}(?![\\w-])`, "i").test(v)))
  return channel || agent || named ? { deny: SLACK_NO } : null
}

const ANSWER_MARKER = /<!-- (slack|monday|slack-user):/
const RECORDER_LABELS = ["plan-to-approve", "plan-approved"]
const isRecorderLabel = (v) => RECORDER_LABELS.includes(String(v).trim().toLowerCase())
const LABEL_ID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** The recorder's answer entries in a text, each as its whole block: the marker, and the words after it up to the next entry or heading. */
export function answerBlocks(text) {
  return [...String(text ?? "").matchAll(/<!-- (?:slack|monday|slack-user):[^>]*-->[\s\S]*?(?=\n\n<!-- |\n\n## |\s*$)/g)].map((m) => m[0].trimEnd()).sort()
}

/** A Linear patch applied as the connector applies it, or null when an operation would not apply. */
export function applyPatch(text, ops) {
  let s = String(text ?? "")
  const once = (needle) => Boolean(needle) && s.indexOf(needle) !== -1 && s.indexOf(needle) === s.lastIndexOf(needle)
  for (const op of Array.isArray(ops) ? ops : []) {
    if (op?.op === "replace") {
      if (op.replace_all) {
        if (!op.old_string || !s.includes(op.old_string)) return null
        s = s.split(op.old_string).join(op.new_string ?? "")
      } else {
        if (!once(op.old_string)) return null
        s = s.replace(op.old_string, () => op.new_string ?? "")
      }
    } else if (op?.op === "insert_before" || op?.op === "insert_after") {
      if (!once(op.anchor)) return null
      const at = s.indexOf(op.anchor) + (op.op === "insert_after" ? op.anchor.length : 0)
      s = s.slice(0, at) + (op.text ?? "") + s.slice(at)
    } else if (op?.op === "prepend") s = (op.text ?? "") + s
    else if (op?.op === "append") s = s + (op.text ?? "")
    else if (op?.op === "replace_range") {
      if (!once(op.from) || !op.to) return null
      const start = s.indexOf(op.from)
      const end = s.indexOf(op.to, start + op.from.length)
      if (end === -1) return null
      s = s.slice(0, start) + (op.new_string ?? "") + s.slice(end)
    } else return null
  }
  return s
}

async function linear(name, input, ctx) {
  if (isRead(name)) return null
  // Linear servers name the issue differently: id, issueId, issue_id or identifier.
  const issue = /issue/i.test(name) ? (input?.id ?? input?.issueId ?? input?.issue_id ?? input?.identifier) : undefined
  // An edit of an existing issue's description is checked whole, below: it may carry the entries it keeps.
  const edit = Boolean(issue) && (input.description !== undefined || input.patch !== undefined)
  const rest = edit ? { ...input, description: undefined, patch: undefined } : input
  // An answer anywhere else, or a recorder's label by name anywhere: on an issue, new or not, or a label renamed to one.
  if (values(rest).some((v) => ANSWER_MARKER.test(v) || isRecorderLabel(v))) return { deny: LINEAR_NO }
  const labels = [input?.labels, input?.addLabels, input?.removeLabels].flatMap((l) => (Array.isArray(l) ? l : []))
  const labelIds = labels.filter((l) => LABEL_ID.test(String(l)))
  if (labelIds.length) {
    let names
    try {
      names = await ctx.labelNamesOf(labelIds)
    } catch {
      return { deny: LABEL_UNSURE }
    }
    if (names.some(isRecorderLabel)) return { deny: LINEAR_NO }
  }
  if (!issue) return null
  // A whole new label set could drop a recorder's label unseen: add and remove instead.
  if (Array.isArray(input.labels)) return { deny: `${LINEAR_NO} Change an existing issue's labels with addLabels and removeLabels.` }
  if (!edit) return null
  let current
  try {
    current = await ctx.descriptionOf(String(issue))
  } catch {
    return { deny: DESCRIPTION_UNSURE }
  }
  const next = input.description !== undefined ? String(input.description) : applyPatch(current, input.patch)
  if (next === null) return { deny: PATCH_UNSURE }
  return JSON.stringify(answerBlocks(current)) === JSON.stringify(answerBlocks(next)) ? null : { deny: DESCRIPTION_NO }
}

/**
 * Monday and Linear from the shell at all, reads included (review of #133):
 * the MCP tools cover reads, and no rule on a request's body can see a
 * mutation the shell builds from a file, a variable or a pipe. Hosts match
 * in any case, as curl takes them.
 */
// api.linear.app covers client-api.linear.app too.
const GRAPHQL_HOST = /api\.monday\.com|api\.linear\.app/i
const SLACK_WRITE_METHOD = /slack\.com\/api\/(chat|reactions|pins|files|bookmarks|reminders|usergroups|calls|dnd)\.|slack\.com\/api\/conversations\.(open|join|invite|kick|leave|archive|create|rename|set|mark)/i

function bash(input) {
  const command = String(input?.command ?? "")
  if (/\bsudo\b/.test(command) && /\/etc\/dev-tasks|people-doors/.test(command)) return { deny: LIST_NO }
  if (GRAPHQL_HOST.test(command)) return { deny: GRAPHQL_NO }
  return SLACK_WRITE_METHOD.test(command) ? { deny: SLACK_API_NO } : null
}

/**
 * The verdict on one tool call, or null to let it through. ctx: { doors,
 * listFile, boardsOf(ids, peopleBoards) -> Map<id, boardIds> for the ids that
 * are items or updates, descriptionOf(issueId) -> string,
 * labelNamesOf(labelIds) -> names }. A lookup throws when it cannot answer,
 * and the rule then refuses.
 */
export async function decide(call, ctx) {
  const tool = call?.tool_name
  if (tool === "Bash") return bash(call.tool_input)
  const service = serviceOf(tool)
  if (!service) return null
  const input = call.tool_input
  if (service.kind === "monday" || service.kind === "devtasks") return monday(service.name, input, ctx)
  if (service.kind === "slack") return slack(service.name, input, ctx.doors, ctx.listFile)
  return linear(service.name, input, ctx)
}
