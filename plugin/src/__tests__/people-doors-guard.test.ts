/**
 * The people-doors guard (STEP-3330). The Monday bridge takes a Monday
 * user's update or Answer column as that person's words, the Slack bridge a
 * Slack member's message, and the answer recorder the answer entries on a
 * Linear issue. The connectors write as the person whose account they use,
 * so an agent session must never write through them on the people's boards,
 * in their channels, or as the recorder, and the guard must leave everything
 * else alone. Made-up ids only: the real list is root's on each machine,
 * never in this public repo.
 */
import { mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, describe, expect, it, vi } from "vitest"
import { boardsOf, descriptionOf, guardOff, hook, labelNamesOf, linearKey, LIST_FILE, OFF_FILE, readDoors, rootOwned } from "../../hooks/people-doors-guard.mjs"
import { answerBlocks, applyPatch, decide, isRead, serviceOf } from "../../hooks/people-doors-rules.mjs"

const PEOPLE = "1111111111"
const PEOPLE_2 = "2222222222"
const OTHER = "9999999999"
const DOORS = { mondayBoards: [PEOPLE, PEOPLE_2], slackChannels: ["CINTAKE01", "CQUESTION1", "polads-questions"], agentBots: ["UEVE00001", "UBOB00001"] }
/** Where each made-up item and update is: the lookup the hook makes with the person's key. */
const ON = new Map<string, string[]>([
  ["7000000001", [PEOPLE]], // an item on the Needs-you board
  ["7000000002", [OTHER]], // an item on someone else's board
  ["7000000003", ["5555555555", PEOPLE_2]], // a subitem of a people's item
  ["8000000001", [PEOPLE]], // an update on a people's item
  ["8000000002", [OTHER]], // an update elsewhere
])
const LABELS = new Map([["aaaaaaaa-0000-4000-8000-000000000001", "plan-approved"], ["aaaaaaaa-0000-4000-8000-000000000002", "polads"]])
const DESCRIPTION = [
  "## Context",
  "The export needs a date.",
  "",
  "## Answers",
  "",
  "<!-- slack:1790000000.000100 -->",
  "**Ada** (Slack): use the publication date",
  "",
  "<!-- monday:9100000001 -->",
  "",
  "<!-- slack-user:UADA00001 -->",
  "",
  "## Plan",
  "Ship it.",
].join("\n")

const lookups = {
  boardsOf: vi.fn(async (ids: string[]) => new Map(ids.filter((id) => ON.has(id)).map((id) => [id, ON.get(id)!]))),
  descriptionOf: vi.fn(async (_issue: string) => DESCRIPTION),
  labelNamesOf: vi.fn(async (ids: string[]) => ids.map((id) => LABELS.get(id) ?? "unknown")),
}
const failing = {
  boardsOf: vi.fn(async () => { throw new Error("no MONDAY_API_KEY") }),
  descriptionOf: vi.fn(async () => { throw new Error("no Linear key") }),
  labelNamesOf: vi.fn(async () => { throw new Error("no Linear key") }),
}
const ctx = (doors: typeof DOORS | null = DOORS, with_ = lookups) => ({ doors, listFile: LIST_FILE, ...with_ })
const denial = async (tool_name: string, tool_input: unknown, c = ctx()) => (await decide({ tool_name, tool_input }, c))?.deny ?? null
const denied = async (tool_name: string, tool_input: unknown, c = ctx()) => (await denial(tool_name, tool_input, c)) !== null

const M = (tool: string) => `mcp__claude_ai_monday_com__${tool}`
const S = (tool: string) => `mcp__claude_ai_Slack__${tool}`
const L = (tool: string) => `mcp__linear-server__${tool}`
const HOSTED_LINEAR = (tool: string) => `mcp__claude_ai_Linear__${tool}`
const DEV = (tool: string) => `mcp__plugin_dev-tasks_dev-tasks__${tool}`
const HOSTED_DEV = (tool: string) => `mcp__claude_ai_Dev_Tasks__${tool}`

afterEach(() => vi.clearAllMocks())

describe("which servers it guards, and which tools only read", () => {
  it.each([
    ["mcp__claude_ai_monday_com__create_update", "monday"],
    ["mcp__monday__create_update", "monday"],
    ["mcp__claude_ai_Slack__slack_send_message", "slack"],
    ["mcp__slack__post_message", "slack"],
    ["mcp__linear-server__save_issue", "linear"],
    ["mcp__claude_ai_Linear__save_issue", "linear"],
    ["mcp__plugin_dev-tasks_dev-tasks__createUpdate", "devtasks"],
    ["mcp__claude_ai_Dev_Tasks__createUpdate", "devtasks"],
  ])("%s is a %s server's", (tool, kind) => {
    expect(serviceOf(tool)?.kind).toBe(kind)
  })

  it("leaves every other tool alone", () => {
    for (const tool of ["Read", "Write", "mcp__github__create_issue", "mcp__claude_ai_Gmail__send_message", "mcp__plugin_github_github__add_issue_comment"]) expect(serviceOf(tool)).toBeNull()
  })

  it.each([
    ["get_board_info", true], ["get_updates", true], ["list_workspaces", true], ["search", true], ["board_insights", true], ["workspace_info", true],
    ["all_api_read", true], ["get_graphql_schema", true], ["show-table", true], ["slack_read_channel", true], ["slack_search_public", true],
    ["slack_read_user_profile", true], ["getTask", true], ["listSprints", true], ["get_issue", true], ["list_issues", true],
    ["create_update", false], ["createUpdate", false], ["all_api_write", false], ["all_monday_api", false], ["execute_code", false], ["run_action", false],
    ["create_automation", false], ["manage_automations", false], ["create_workflow", false], ["publish_workflow", false], ["slack_send_message", false],
    ["slack_send_message_draft", false], ["slack_add_reaction", false], ["save_issue", false], ["save_comment", false], ["updateTask", false],
  ])("%s reads: %s", (name, reads) => {
    expect(isRead(name)).toBe(reads)
  })
})

describe("Monday and dev-tasks: nothing on the people's boards, and no effect anywhere else", () => {
  it.each<[string, string, Record<string, unknown>, boolean]>([
    ["an update on a Needs-you item", M("create_update"), { itemId: 7000000001, body: "PASS" }, true],
    ["a reply to an update on a people's item", M("create_update"), { parentId: "8000000001", body: "yes" }, true],
    ["an update on a subitem of a people's item", M("create_update"), { itemId: 7000000003, body: "yes" }, true],
    ["an update through the dev-tasks plugin", DEV("createUpdate"), { taskId: "7000000001", body: "PASS" }, true],
    ["an update through the hosted dev-tasks server", HOSTED_DEV("createUpdate"), { itemId: "7000000001", body: "PASS" }, true],
    ["a yes in the Answer column", M("change_item_column_values"), { boardId: PEOPLE, itemId: 7000000001, columnValues: '{"long_text_x":"yes"}' }, true],
    ["a new item on a people's board", M("create_item"), { boardId: PEOPLE, name: "Export notices" }, true],
    ["an item moved onto a people's board", M("move_object"), { objectType: "item", objectId: 7000000002, boardId: PEOPLE_2 }, true],
    ["an update through all_monday_api", M("all_monday_api"), { query: "mutation ($i: ID!) { create_update(item_id: $i, body: \"yes\") { id } }", variables: '{"i":"7000000001"}' }, true],
    ["a column change through all_api_write", M("all_api_write"), { query: "mutation { change_simple_column_value(board_id: 9999999999, item_id: 7000000001, column_id: \"x\", value: \"y\") { id } }" }, true],
    ["an automation on a people's board", M("create_automation"), { boardId: PEOPLE, recipe: "when status changes, notify" }, true],
    ["a workflow run on a people's item", M("run_workflow_once"), { itemId: "7000000001" }, true],
    ["an action run against a people's item", M("run_action"), { actionId: "a1", input: { item: 7000000001 } }, true],
    ["code, which can build any id from parts", M("execute_code"), { code: "const id = '70000' + '00001'" }, true],
    // Zero effect outside the people's boards.
    ["an update on someone else's item", M("create_update"), { itemId: 7000000002, body: "Done" }, false],
    ["a reply to an update elsewhere", M("create_update"), { parentId: "8000000002", body: "ok" }, false],
    ["an update through dev-tasks on its own board", DEV("createUpdate"), { taskId: "7000000002", body: "Deployed" }, false],
    ["a column change on another board", M("change_item_column_values"), { boardId: OTHER, itemId: 7000000002, columnValues: "{}" }, false],
    ["an update through all_monday_api elsewhere", M("all_monday_api"), { query: "mutation { create_update(item_id: 7000000002, body: \"ok\") { id } }" }, false],
    ["a new board, which names no board or item", M("create_board"), { boardName: "Launch", boardKind: "public" }, false],
    ["a phone number in a column, which is no item", M("create_item"), { boardId: OTHER, name: "Call", columnValues: '{"phone":"45123456"}' }, false],
    // Reads.
    ["a read of a people's board", M("get_board_items_page"), { boardId: PEOPLE }, false],
    ["a read through all_api_read", M("all_api_read"), { query: `query { boards(ids: ${PEOPLE}) { items_page { items { id } } } }` }, false],
    ["a query through all_monday_api", M("all_monday_api"), { query: `query { items(ids: [7000000001]) { name } }` }, false],
    ["a dev-tasks read", DEV("getTask"), { taskId: "7000000001" }, false],
  ])("%s: refused %s", async (_, tool, input, expected) => {
    expect(await denied(tool, input)).toBe(expected)
  })

  it("names a people's board without a lookup, and makes none for a read or a call with no ids", async () => {
    await denied(M("create_item"), { boardId: PEOPLE, name: "x" })
    await denied(M("get_board_items_page"), { boardId: PEOPLE })
    await denied(M("create_board"), { boardName: "Launch" })
    expect(lookups.boardsOf).not.toHaveBeenCalled()
  })

  it("asks for every id at once, with the people's boards", async () => {
    await denied(M("create_update"), { itemId: 7000000002, body: "ok", parentId: "8000000002" })
    expect(lookups.boardsOf).toHaveBeenCalledWith(["7000000002", "8000000002"], [PEOPLE, PEOPLE_2])
  })

  it("refuses what it cannot check: a lookup that fails refuses, whatever the board", async () => {
    expect(await denial(M("create_update"), { itemId: 7000000002, body: "ok" }, ctx(DOORS, failing))).toMatch(/could not tell which board/)
    expect(await denied(M("create_board"), { boardName: "Launch" }, ctx(DOORS, failing))).toBe(false)
  })

  it("refuses every write when it has no list, since it cannot tell which boards are the people's; reads still pass", async () => {
    expect(await denial(M("create_update"), { itemId: 7000000002, body: "ok" }, ctx(null))).toMatch(/people-doors\.json is missing, not root's, or has an empty list/)
    expect(await denied(M("create_board"), { boardName: "Launch" }, ctx(null))).toBe(true)
    expect(await denied(DEV("createUpdate"), { taskId: "7000000002", body: "ok" }, ctx(null))).toBe(true)
    expect(await denied(M("get_board_items_page"), { boardId: PEOPLE }, ctx(null))).toBe(false)
  })

  it("says in plain words why, so the session can tell its person", async () => {
    expect(await denial(M("create_update"), { itemId: 7000000001, body: "yes" })).toBe(
      "An agent session cannot write on the people's Monday boards as a person: the Monday bridge would take it for their words. Ask the person to do it themselves.",
    )
  })
})

describe("Slack: nothing in the people's channels or to the agents, and no effect anywhere else", () => {
  it.each<[string, string, Record<string, unknown>, boolean]>([
    ["a message in a people's channel, by id", S("slack_send_message"), { channel_id: "CQUESTION1", message: "yes" }, true],
    ["a message in a people's channel, by #name", S("slack_send_message"), { channel: "#polads-questions", text: "PASS" }, true],
    ["a message in a people's channel, by bare name", S("slack_send_message"), { channel: "polads-questions", text: "PASS" }, true],
    ["a direct message to an agent's bot, which needs no mention", S("slack_send_message"), { channel_id: "UEVE00001", message: "make it auto" }, true],
    ["a message that mentions an agent's bot, anywhere", S("slack_send_message"), { channel_id: "COTHER0001", message: "<@UEVE00001> make it auto" }, true],
    ["a mention with a label", S("slack_send_message"), { channel_id: "COTHER0001", message: "hi <@UBOB00001|bob>" }, true],
    ["a scheduled message in a people's channel", S("slack_schedule_message"), { channel_id: "CINTAKE01", message: "export", post_at: 1790000000 }, true],
    ["a draft in a people's channel", S("slack_send_message_draft"), { channel_id: "CQUESTION1", message: "yes" }, true],
    ["a reaction in a people's channel", S("slack_add_reaction"), { channel_id: "CQUESTION1", timestamp: "1790000000.000100", name: "white_check_mark" }, true],
    ["a message through another Slack server", "mcp__slack__post_message", { channel: "CINTAKE01", text: "export" }, true],
    ["a message elsewhere", S("slack_send_message"), { channel_id: "COTHER0001", message: "lunch?" }, false],
    ["a direct message to a colleague", S("slack_send_message"), { channel_id: "UADA00001", message: "lunch?" }, false],
    ["a read of a people's channel", S("slack_read_channel"), { channel_id: "CQUESTION1" }, false],
    ["a search", S("slack_search_public"), { query: "in:#polads-questions export" }, false],
  ])("%s: refused %s", async (_, tool, input, expected) => {
    expect(await denied(tool, input)).toBe(expected)
  })

  it("refuses every Slack write when it has no list; reads still pass", async () => {
    expect(await denial(S("slack_send_message"), { channel_id: "COTHER0001", message: "lunch?" }, ctx(null))).toMatch(/people-doors\.json/)
    expect(await denied(S("slack_read_channel"), { channel_id: "COTHER0001" }, ctx(null))).toBe(false)
  })
})

describe("Linear: answers and plan approvals are the recorder's alone", () => {
  const keep = (description: string) => ({ id: "STEP-7", description })
  const without = (entry: string) => DESCRIPTION.replace(entry, "")

  it.each<[string, string, Record<string, unknown>, boolean]>([
    ["an answer entry written into a description", L("save_issue"), keep(`${DESCRIPTION}\n\n<!-- slack:1790000009.000100 -->\n**Ada**: yes`), true],
    ["an answer entry in a comment", L("save_comment"), { issueId: "STEP-7", body: "<!-- monday:9100000002 -->\n**Ada**: yes" }, true],
    ["an asker's marker in a comment, which would forge the Requester", L("save_comment"), { issueId: "STEP-7", body: "<!-- slack-user:UADA00001 -->" }, true],
    ["an answer entry on a new issue", L("save_issue"), { team: "STEP", title: "New", description: "<!-- slack:1790000000.000100 -->\nyes" }, true],
    ["an answer entry through the hosted Linear server", HOSTED_LINEAR("create_issue"), { teamId: "t", title: "x", description: "<!-- monday:9100000002 -->" }, true],
    ["a plan approved on a new issue", L("save_issue"), { team: "STEP", title: "New", labels: ["plan-approved"] }, true],
    ["a plan's question on a new issue", L("save_issue"), { team: "STEP", title: "New", labels: ["polads", "Plan-To-Approve "] }, true],
    ["a plan marked approved", L("save_issue"), { id: "STEP-7", addLabels: ["plan-approved"] }, true],
    ["a plan's question taken away", L("save_issue"), { id: "STEP-7", removeLabels: ["plan-to-approve"] }, true],
    ["a plan approved by the label's id", L("save_issue"), { id: "STEP-7", addLabels: ["aaaaaaaa-0000-4000-8000-000000000001"] }, true],
    ["another label renamed to the approval", L("save_issue_label"), { id: "aaaaaaaa-0000-4000-8000-000000000002", name: "plan-approved" }, true],
    ["an existing issue's labels replaced wholesale", L("save_issue"), { id: "STEP-7", labels: ["polads"] }, true],
    ["a description that drops an answer", L("save_issue"), keep(without("<!-- slack:1790000000.000100 -->\n**Ada** (Slack): use the publication date\n\n")), true],
    ["a description that changes an answer's words", L("save_issue"), keep(DESCRIPTION.replace("use the publication date", "use today")), true],
    ["a description that drops a bare Monday marker", L("save_issue"), keep(without("<!-- monday:9100000001 -->\n\n")), true],
    ["a description that drops the asker's marker", L("save_issue"), keep(without("<!-- slack-user:UADA00001 -->\n\n")), true],
    ["a patch that deletes an answer", L("save_issue"), { id: "STEP-7", patch: [{ op: "replace", old_string: "**Ada** (Slack): use the publication date", new_string: "" }] }, true],
    ["a patch that cuts a range across the answers", L("save_issue"), { id: "STEP-7", patch: [{ op: "replace_range", from: "## Answers", to: "## Plan", new_string: "" }] }, true],
    ["a patch that would not apply", L("save_issue"), { id: "STEP-7", patch: [{ op: "replace", old_string: "not in it", new_string: "x" }] }, true],
    ["an edit through the hosted Linear server that drops an answer", HOSTED_LINEAR("update_issue"), { issueId: "STEP-7", description: "## Context\nshort" }, true],
    // Everything else passes.
    ["a description that keeps every answer", L("save_issue"), keep(DESCRIPTION.replace("The export needs a date.", "The export needs a date and a time.")), false],
    ["a patch outside the answers", L("save_issue"), { id: "STEP-7", patch: [{ op: "replace", old_string: "Ship it.", new_string: "Ship it on Monday." }] }, false],
    ["a patch that adds a section at the end", L("save_issue"), { id: "STEP-7", patch: [{ op: "append", text: "\n\n## Notes\nnone" }] }, false],
    ["a new issue with its labels", L("save_issue"), { team: "STEP", title: "New", labels: ["polads"], description: "Plain" }, false],
    ["another label by its id", L("save_issue"), { id: "STEP-7", addLabels: ["aaaaaaaa-0000-4000-8000-000000000002"] }, false],
    ["a title change", L("save_issue"), { id: "STEP-7", title: "Better title" }, false],
    ["a plain comment", L("save_comment"), { issueId: "STEP-7", body: "Looks fine" }, false],
    ["a project's labels, which hold no plan", L("save_project"), { id: "p1", labels: ["polads"] }, false],
    ["a read", L("get_issue"), { id: "STEP-7" }, false],
  ])("%s: refused %s", async (_, tool, input, expected) => {
    expect(await denied(tool, input)).toBe(expected)
  })

  it("reads the description only for an edit of it", async () => {
    await denied(L("save_issue"), { id: "STEP-7", title: "Better title" })
    await denied(L("save_issue"), { team: "STEP", title: "New", description: "Plain" })
    expect(lookups.descriptionOf).not.toHaveBeenCalled()
    await denied(L("save_issue"), keep(DESCRIPTION))
    expect(lookups.descriptionOf).toHaveBeenCalledWith("STEP-7")
  })

  it("says a patch that would not apply cannot be checked, rather than blame the answers", async () => {
    expect(await denial(L("save_issue"), { id: "STEP-7", patch: [{ op: "replace", old_string: "not in it", new_string: "x" }] })).toMatch(/would not apply/)
  })

  it("refuses a description edit, or a label by id, it cannot check", async () => {
    expect(await denial(L("save_issue"), keep(DESCRIPTION), ctx(DOORS, failing))).toMatch(/could not read the issue's description/)
    expect(await denial(L("save_issue"), { id: "STEP-7", addLabels: ["aaaaaaaa-0000-4000-8000-000000000002"] }, ctx(DOORS, failing))).toMatch(/could not read which labels/)
    expect(await denied(L("save_issue"), { id: "STEP-7", title: "Better title" }, ctx(DOORS, failing))).toBe(false)
  })

  it("holds with no list: the recorder's entries are the same everywhere", async () => {
    expect(await denied(L("save_issue"), { id: "STEP-7", addLabels: ["plan-approved"] }, ctx(null))).toBe(true)
    expect(await denied(L("save_comment"), { issueId: "STEP-7", body: "Looks fine" }, ctx(null))).toBe(false)
  })

  it("reads each entry whole, a bare marker included, and applies a patch as Linear does", () => {
    expect(answerBlocks(DESCRIPTION)).toEqual([
      "<!-- monday:9100000001 -->",
      "<!-- slack-user:UADA00001 -->",
      "<!-- slack:1790000000.000100 -->\n**Ada** (Slack): use the publication date",
    ])
    expect(applyPatch("a b c", [{ op: "insert_after", anchor: "b", text: "!" }])).toBe("a b! c")
    expect(applyPatch("a b c", [{ op: "insert_before", anchor: "b", text: "!" }])).toBe("a !b c")
    expect(applyPatch("a b c", [{ op: "prepend", text: "> " }, { op: "append", text: "." }])).toBe("> a b c.")
    expect(applyPatch("a b a", [{ op: "replace", old_string: "a", new_string: "x", replace_all: true }])).toBe("x b x")
    expect(applyPatch("a b a", [{ op: "replace", old_string: "a", new_string: "x" }])).toBeNull()
    expect(applyPatch("1 2 3 4", [{ op: "replace_range", from: "2", to: "4", new_string: "" }])).toBe("1 4")
    expect(applyPatch("a", [{ op: "rewrite" }])).toBeNull()
  })
})

describe("Bash: no write to the three APIs, and no sudo on the guard's list", () => {
  it.each<[string, string, boolean]>([
    ["a GraphQL mutation to Monday", `curl -s https://api.monday.com/v2 -H "Authorization: $MONDAY_API_KEY" -d '{"query":"mutation { create_update(item_id: 7000000001, body: \\"yes\\") { id } }"}'`, true],
    ["a mutation to Linear", `curl https://api.linear.app/graphql -d '{"query":"mutation { issueAddLabel(id: \\"x\\", labelId: \\"y\\") { success } }"}'`, true],
    ["a body from a file, which the guard cannot read", "curl -X POST https://api.linear.app/graphql --data @body.json", true],
    ["a body from stdin", "jq -n '{query: $q}' | curl https://api.monday.com/v2 --data-binary @-", true],
    ["a host in capitals", `curl HTTPS://API.MONDAY.COM/v2 -d '{"query":"mutation { x }"}'`, true],
    ["a Slack message", "curl -X POST https://slack.com/api/chat.postMessage -d channel=CQUESTION1 -d text=yes", true],
    ["a Slack reaction", "curl https://slack.com/api/reactions.add -d name=white_check_mark", true],
    ["a Slack message to a host in capitals", "curl -X POST HTTPS://SLACK.COM/API/CHAT.POSTMESSAGE -d text=yes", true],
    ["a direct message opened", "curl https://slack.com/api/conversations.open -d users=UEVE00001", true],
    ["the list written with sudo", "echo '{}' | sudo tee /etc/dev-tasks/people-doors.json", true],
    ["the way out placed with sudo", "sudo touch /etc/dev-tasks/people-doors.off", true],
    ["a read from Monday", `curl https://api.monday.com/v2 -d '{"query":"query { me { id } }"}'`, false],
    ["a Slack history read", "curl https://slack.com/api/conversations.history?channel=CQUESTION1", false],
    ["reading the list", "cat /etc/dev-tasks/people-doors.json", false],
    ["a plain command", "ls -la", false],
  ])("%s: refused %s", async (_, command, expected) => {
    expect(await denied("Bash", { command })).toBe(expected)
  })
})

describe("the guard's list: root's, never the session's", () => {
  const root = (mode = 0o100644) => ({ uid: 0, mode, isFile: () => (mode & 0o170000) === 0o100000 })
  const user = (mode = 0o100644) => ({ uid: 501, mode, isFile: () => true })
  const LIST = JSON.stringify({ mondayBoards: [PEOPLE], slackChannels: ["CQUESTION1", "#polads-questions"], agentBots: ["UEVE00001"] })
  const at = (file: Record<string, unknown>, dir: Record<string, unknown> = root(0o40755)) => (p: string) => (p === LIST_FILE || p === OFF_FILE ? file : dir)
  const read = (text = LIST) => () => text

  it("lives at one absolute path under /etc", () => {
    expect(LIST_FILE).toBe("/etc/dev-tasks/people-doors.json")
    expect(OFF_FILE).toBe("/etc/dev-tasks/people-doors.off")
  })

  it("is read when it and its folder are root's and no one else can write them", () => {
    expect(readDoors({ stat: at(root()), read: read() })).toEqual({ mondayBoards: [PEOPLE], slackChannels: ["CQUESTION1", "polads-questions"], agentBots: ["UEVE00001"] })
  })

  it.each([
    ["a file the person owns", at(user())],
    ["a file others can write", at(root(0o100666))],
    ["a file the group can write", at(root(0o100664))],
    ["a folder the person owns", at(root(), user(0o40755))],
    ["a folder others can write", at(root(), root(0o40777))],
    ["a folder, not a file", at(root(0o40755))],
  ])("is not trusted from %s", (_, stat) => {
    expect(readDoors({ stat, read: read() })).toBeNull()
  })

  it("is no list when it is missing", () => {
    expect(readDoors({ stat: () => { throw new Error("ENOENT") }, read: read() })).toBeNull()
  })

  it.each([
    ["empty lists", { mondayBoards: [], slackChannels: [], agentBots: [] }],
    ["one empty list", { mondayBoards: [PEOPLE], slackChannels: [], agentBots: ["UEVE00001"] }],
    ["a missing list", { mondayBoards: [PEOPLE], slackChannels: ["CQUESTION1"] }],
    ["a blank id", { mondayBoards: [" "], slackChannels: ["CQUESTION1"], agentBots: ["UEVE00001"] }],
  ])("guards as no list at all with %s: an empty list means nothing, never 'guard nothing'", (_, list) => {
    expect(readDoors({ stat: at(root()), read: read(JSON.stringify(list)) })).toBeNull()
  })

  it("is no list when it does not read as JSON", () => {
    expect(readDoors({ stat: at(root()), read: read("not json") })).toBeNull()
  })

  it("is out of the way only when root's own flag says so", () => {
    expect(guardOff({ stat: at(root()) })).toBe(true)
    expect(guardOff({ stat: at(user()) })).toBe(false)
    expect(guardOff({ stat: () => { throw new Error("ENOENT") } })).toBe(false)
  })

  it("checks the real file and folder by default", () => {
    expect(rootOwned(join(mkdtempSync(join(tmpdir(), "people-doors-")), "x.json"))).toBe(false)
  })
})

describe("a $HOME override and an empty list don't disable it", () => {
  const saved = process.env.HOME
  afterEach(() => {
    process.env.HOME = saved
  })

  it("reads neither the list nor the way out from $HOME, however root's it looks", async () => {
    const home = mkdtempSync(join(tmpdir(), "people-doors-home-"))
    mkdirSync(join(home, ".config", "dev-tasks"), { recursive: true })
    writeFileSync(join(home, ".config", "dev-tasks", "people-doors.json"), JSON.stringify({ mondayBoards: [], slackChannels: [], agentBots: [] }))
    writeFileSync(join(home, ".config", "dev-tasks", "people-doors.off"), "")
    process.env.HOME = home
    expect(homedir()).toBe(home)
    const looked: string[] = []
    // Everything under the fake home passes for root's; /etc has no list and no flag.
    const stat = (p: string) => {
      looked.push(p)
      if (p.startsWith(home)) return { uid: 0, mode: 0o100644, isFile: () => true }
      throw new Error("ENOENT")
    }
    const doors = readDoors({ stat, read: (p: string) => readFileSync(p, "utf8") })
    const off = guardOff({ stat })
    expect(doors).toBeNull()
    expect(off).toBe(false)
    expect(looked.some((p) => p.startsWith(home))).toBe(false)
    const verdict = await hook({ tool_name: S("slack_send_message"), tool_input: { channel_id: "COTHER0001", message: "lunch?" } }, { doors, off, lookups })
    expect(verdict?.deny).toMatch(/\/etc\/dev-tasks\/people-doors\.json is missing/)
  })

  it("guards with an empty list in /etc as with none", async () => {
    const doors = readDoors({ stat: () => ({ uid: 0, mode: 0o40755, isFile: () => true }), read: () => JSON.stringify({ mondayBoards: [], slackChannels: [], agentBots: [] }) })
    expect(doors).toBeNull()
    expect(await hook({ tool_name: M("create_update"), tool_input: { itemId: 7000000002, body: "ok" } }, { doors, off: false, lookups })).toMatchObject({ deny: expect.stringMatching(/people-doors\.json/) })
  })
})

describe("the hook", () => {
  it("says nothing at all when root's flag takes the machine out", async () => {
    expect(await hook({ tool_name: M("create_update"), tool_input: { itemId: 7000000001, body: "PASS" } }, { doors: DOORS, off: true, lookups })).toBeNull()
  })

  it("refuses when a rule itself fails, rather than let the call through", async () => {
    const input = {}
    Object.defineProperty(input, "body", { enumerable: true, get: () => { throw new Error("boom") } })
    expect((await hook({ tool_name: M("create_update"), tool_input: input }, { doors: DOORS, off: false, lookups }))?.deny).toMatch(/guard failed \(boom\)/)
  })
})

describe("the lookups", () => {
  const answer = (data: unknown, status = 200) => vi.fn(async (_url: string, _init: RequestInit) => new Response(JSON.stringify(data), { status }))

  it("asks Monday once, with the person's key, for items, updates and the people's boards", async () => {
    const fetchImpl = answer({
      data: {
        items: [{ id: "7000000001", board: { id: PEOPLE }, parent_item: null }, { id: "7000000003", board: { id: "5555555555" }, parent_item: { board: { id: PEOPLE_2 } } }],
        updates: [{ id: "8000000001", item: { board: { id: PEOPLE }, parent_item: null } }],
        boards: [{ id: PEOPLE }, { id: PEOPLE_2 }],
      },
    })
    const boards = await boardsOf(["7000000001", "7000000003", "8000000001", "45123456"], [PEOPLE, PEOPLE_2], { key: " k-1 ", fetchImpl })
    expect(boards).toEqual(new Map([["7000000001", [PEOPLE]], ["7000000003", ["5555555555", PEOPLE_2]], ["8000000001", [PEOPLE]]]))
    expect(fetchImpl).toHaveBeenCalledTimes(1)
    const [url, init] = fetchImpl.mock.calls[0]
    expect(url).toBe("https://api.monday.com/v2")
    expect((init.headers as Record<string, string>).Authorization).toBe("k-1")
    expect(JSON.parse(String(init.body)).variables).toEqual({ ids: ["7000000001", "7000000003", "8000000001", "45123456"], boards: [PEOPLE, PEOPLE_2] })
    expect(init.signal).toBeInstanceOf(AbortSignal)
  })

  it("cannot answer without a key, for a key that cannot see the people's boards, or when Monday fails", async () => {
    await expect(boardsOf(["7000000001"], [PEOPLE], { key: "", fetchImpl: answer({}) })).rejects.toThrow(/no MONDAY_API_KEY/)
    await expect(boardsOf(["7000000001"], [PEOPLE, PEOPLE_2], { key: "k", fetchImpl: answer({ data: { items: [], updates: [], boards: [{ id: PEOPLE }] } }) })).rejects.toThrow(/cannot see/)
    await expect(boardsOf(["7000000001"], [PEOPLE], { key: "k", fetchImpl: answer({ error: "x" }, 500) })).rejects.toThrow(/500/)
    await expect(boardsOf(["7000000001"], [PEOPLE], { key: "k", fetchImpl: answer({ errors: [{ message: "x" }], data: null }) })).rejects.toThrow(/errors/)
    // Monday answers part of a query it could not finish: an item it left out would look like no item at all.
    await expect(boardsOf(["7000000001"], [PEOPLE], { key: "k", fetchImpl: answer({ errors: [{ message: "x" }], data: { items: [], updates: [], boards: [{ id: PEOPLE }] } }) })).rejects.toThrow(/errors/)
    await expect(boardsOf(Array.from({ length: 101 }, (_, i) => String(1000000 + i)), [PEOPLE], { key: "k", fetchImpl: answer({}) })).rejects.toThrow(/more ids/)
  })

  it("reads an issue's description and label names from Linear, and cannot answer for what Linear does not find", async () => {
    expect(await descriptionOf("STEP-7", { key: () => "lin", fetchImpl: answer({ data: { issue: { description: "d" } } }) })).toBe("d")
    expect(await descriptionOf("STEP-7", { key: () => "lin", fetchImpl: answer({ data: { issue: { description: null } } }) })).toBe("")
    await expect(descriptionOf("STEP-7", { key: () => "lin", fetchImpl: answer({ data: { issue: null } }) })).rejects.toThrow(/no such issue/)
    const ids = ["aaaaaaaa-0000-4000-8000-000000000001", "aaaaaaaa-0000-4000-8000-000000000002"]
    expect(await labelNamesOf(ids, { key: () => "lin", fetchImpl: answer({ data: { issueLabels: { nodes: [{ id: ids[0], name: "plan-approved" }, { id: ids[1], name: "polads" }] } } }) })).toEqual(["plan-approved", "polads"])
    await expect(labelNamesOf(ids, { key: () => "lin", fetchImpl: answer({ data: { issueLabels: { nodes: [{ id: ids[1], name: "polads" }] } } }) })).rejects.toThrow(/not every label/)
  })

  it("finds the Linear key where the plugin's Linear client does", () => {
    expect(linearKey({ LINEAR_API_KEY: " lin-1 " }, "/nowhere")).toBe("lin-1")
    const home = mkdtempSync(join(tmpdir(), "people-doors-key-"))
    mkdirSync(join(home, ".config", "linear"), { recursive: true })
    writeFileSync(join(home, ".config", "linear", ".env"), "OTHER=1\nLINEAR_API_KEY=lin-2\n")
    expect(linearKey({}, home)).toBe("lin-2")
    expect(() => linearKey({}, "/nowhere")).toThrow()
    expect(statSync(home).isDirectory()).toBe(true)
  })
})
