/**
 * The people-doors guard (STEP-3330). The Monday bridge takes a Monday
 * user's update or Answer column as that person's words, and the Slack
 * bridge a Slack member's reply. The claude.ai connectors write as the
 * person whose account they use, so an agent session must never write
 * through them on the people's boards or in their channels. Made-up ids
 * only: the real list lives on each machine, never in this public repo.
 */
import { mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { addToDoors, decide, readDoors } from "../../hooks/people-doors-guard.mjs"

const HOME = "/home/ada"
const DOORS = { mondayBoards: ["1111111111", "2222222222"], slackChannels: ["CINTAKE01", "CQUESTION1", "polads-questions"], agentBots: ["UEVE00001", "UBOB00001"] }
const M = (tool: string) => `mcp__claude_ai_monday_com__${tool}`
const S = (tool: string) => `mcp__claude_ai_Slack__${tool}`
const L = (tool: string) => `mcp__linear-server__${tool}`
const denied = (tool_name: string, tool_input: unknown, doors: typeof DOORS | null = DOORS) => Boolean(decide({ tool_name, tool_input }, doors, HOME))

describe("the people-doors guard: no agent session writes as a person", () => {
  it.each<[string, string, Record<string, unknown>, boolean]>([
    // Today's live answer paths on the Needs-you board.
    ["a PASS on a Test day item, as an update", M("create_update"), { itemId: 7001, body: "PASS" }, true],
    ["a yes in the Answer column", M("change_item_column_values"), { boardId: 1111111111, itemId: 7001, columnValues: "{\"long_text_x\":\"yes\"}" }, true],
    ["a new item in the Requests group", M("create_item"), { boardId: "1111111111", groupId: "g_req", name: "Export notices" }, true],
    ["several items", M("create_items"), { boardId: 2222222222, items: [{ name: "x" }] }, true],
    ["items changed together", M("update_items"), { boardId: 1111111111, items: [{ id: 7001 }] }, true],
    ["an item moved on a people's board", M("move_object"), { objectType: "item", objectId: 7001, boardId: 1111111111 }, true],
    ["a form answer that makes an item", M("create_form_submission"), { boardId: "1111111111", answers: {} }, true],
    ["an item mutation through all_monday_api, whatever the board", M("all_monday_api"), { query: "mutation { create_update(item_id: 7001, body: \"yes\") { id } }" }, true],
    ["a column change through all_api_write", M("all_api_write"), { query: "mutation { change_simple_column_value(board_id: 9999999999, item_id: 5, column_id: \"x\", value: \"y\") { id } }" }, true],
    ["an item mutation in code", M("execute_code"), { code: "await monday.api(`mutation { move_item_to_group(item_id: 1, group_id: \"g\") { id } }`)" }, true],
    ["a column change on another board", M("change_item_column_values"), { boardId: 9999999999, itemId: 5, columnValues: "{}" }, false],
    ["an item whose id holds a board id, on another board", M("change_item_column_values"), { boardId: 9999999999, itemId: 11111111112, columnValues: "{}" }, false],
    ["a group renamed through the generic tool", M("all_api_write"), { query: "mutation { update_group(board_id: 1111111111, group_id: \"g\", group_attribute: title, new_value: \"Decide\") { id } }" }, false],
    ["a column created", M("create_column"), { boardId: 1111111111, columnType: "text", columnTitle: "Recommendation" }, false],
    ["a read", M("get_board_items_page"), { boardId: 1111111111 }, false],
    ["a read through all_api_read", M("all_api_read"), { query: "query { boards(ids: 1111111111) { items_page { items { id } } } }" }, false],
    ["a message in a people's channel, by id", S("slack_send_message"), { channel_id: "CQUESTION1", message: "yes" }, true],
    ["a message in a people's channel, by name", S("slack_send_message"), { channel: "#polads-questions", text: "PASS" }, true],
    ["a message that mentions an agent's bot, anywhere", S("slack_send_message"), { channel_id: "COTHER0001", message: "<@UEVE00001> make it auto" }, true],
    ["a scheduled message in a people's channel", S("slack_schedule_message"), { channel_id: "CINTAKE01", message: "@eve export", post_at: 1790000000 }, true],
    ["a message elsewhere", S("slack_send_message"), { channel_id: "COTHER0001", message: "lunch?" }, false],
    ["a draft, which the person sends themselves", S("slack_send_message_draft"), { channel_id: "CQUESTION1", message: "yes" }, false],
    ["a read of a people's channel", S("slack_read_channel"), { channel_id: "CQUESTION1" }, false],
    ["an answer entry written into a description", L("save_issue"), { id: "STEP-7", description: "x\n<!-- slack:1790000000.000100 -->\n**Ada**: yes" }, true],
    ["an answer entry in a comment", L("save_comment"), { issueId: "STEP-7", body: "<!-- monday:p1 -->\n**Ada**: yes" }, true],
    ["an asker's marker", L("save_issue"), { id: "STEP-7", description: "<!-- slack-user:UADA00001 -->" }, true],
    ["a plan marked approved", L("save_issue"), { id: "STEP-7", addLabels: ["plan-approved"] }, true],
    ["a plan's question taken away", L("save_issue"), { id: "STEP-7", removeLabels: ["plan-to-approve"] }, true],
    ["an existing issue's labels replaced wholesale", L("save_issue"), { id: "STEP-7", labels: ["polads"] }, true],
    ["a new issue with its labels", L("save_issue"), { team: "STEP", title: "New", labels: ["polads"] }, false],
    ["a plain comment", L("save_comment"), { issueId: "STEP-7", body: "Looks fine" }, false],
  ])("%s", (_, tool, input, expected) => {
    expect(denied(tool, input)).toBe(expected)
  })

  it("refuses every Monday item write and Slack send when it has no list, since it cannot tell which are the people's", () => {
    expect(decide({ tool_name: M("change_item_column_values"), tool_input: { boardId: 9999999999 } }, null, HOME)?.deny).toMatch(/people-doors\.json/)
    expect(decide({ tool_name: M("create_update"), tool_input: { itemId: 5, body: "hi" } }, null, HOME)?.deny).toMatch(/people-doors\.json/)
    expect(decide({ tool_name: S("slack_send_message"), tool_input: { channel_id: "COTHER0001", message: "lunch?" } }, null, HOME)?.deny).toMatch(/people-doors\.json/)
    expect(denied(M("get_board_items_page"), { boardId: 1111111111 }, null)).toBe(false)
    expect(denied(L("save_comment"), { issueId: "STEP-7", body: "Looks fine" }, null)).toBe(false)
  })

  it("keeps its own list out of an agent's hands: only a plain read, or the add-only command, passes", () => {
    const list = `${HOME}/.config/dev-tasks/people-doors.json`
    expect(denied("Write", { file_path: list, content: "{}" })).toBe(true)
    expect(denied("Edit", { file_path: list, old_string: "1111111111", new_string: "" })).toBe(true)
    expect(denied("Bash", { command: "echo '{}' > ~/.config/dev-tasks/people-doors.json" })).toBe(true)
    expect(denied("Bash", { command: "sed -i '' s/1111111111// ~/.config/dev-tasks/people-doors.json" })).toBe(true)
    expect(denied("Bash", { command: "cd ~/.config/dev-tasks && rm -f *" })).toBe(true)
    expect(denied("Bash", { command: "cat > ~/.config/dev-tasks/people-doors.json" })).toBe(true)
    expect(denied("Bash", { command: "cat ~/.config/dev-tasks/people-doors.json" })).toBe(false)
    expect(denied("Bash", { command: "node plugin/hooks/people-doors-guard.mjs add --board 1111111111" })).toBe(false)
    expect(denied("Write", { file_path: `${HOME}/notes.md`, content: "x" })).toBe(false)
  })

  it("says in plain words why, so the session can tell its person", () => {
    expect(decide({ tool_name: M("create_update"), tool_input: { itemId: 5, body: "yes" } }, DOORS, HOME)?.deny).toBe(
      "An agent session cannot write on the people's Monday boards as a person: the Monday bridge would take it for their words. Ask the person to do it themselves.",
    )
  })
})

describe("the guard's list", () => {
  const file = () => join(mkdtempSync(join(tmpdir(), "people-doors-")), "dev-tasks", "people-doors.json")

  it("is placed by the add-only command, readable by the owner alone", () => {
    const f = file()
    expect(addToDoors(f, { boards: ["1111111111"], channels: ["CQUESTION1", "polads-questions"], bots: ["UEVE00001"] })).toEqual({
      mondayBoards: ["1111111111"], slackChannels: ["CQUESTION1", "polads-questions"], agentBots: ["UEVE00001"],
    })
    expect(readDoors(f)).toEqual({ mondayBoards: ["1111111111"], slackChannels: ["CQUESTION1", "polads-questions"], agentBots: ["UEVE00001"] })
    expect(statSync(f).mode & 0o777).toBe(0o600)
  })

  it("adds, and never takes anything away", () => {
    const f = file()
    addToDoors(f, { boards: ["1111111111"], channels: ["CQUESTION1"], bots: ["UEVE00001"] })
    expect(addToDoors(f, { boards: ["2222222222", "1111111111"], channels: [], bots: [] }).mondayBoards).toEqual(["1111111111", "2222222222"])
    expect(readDoors(f)?.slackChannels).toEqual(["CQUESTION1"])
  })

  it("never creates a list that guards nothing", () => {
    expect(() => addToDoors(file(), { boards: ["1111111111"], channels: [], bots: [] })).toThrow(/a board, a channel and a bot/)
  })

  it("refuses an id that is not one, and a list it cannot read", () => {
    expect(() => addToDoors(file(), { boards: ["12ab"], channels: ["CQUESTION1"], bots: ["UEVE00001"] })).toThrow(/not a Monday board id/)
    expect(() => addToDoors(file(), { boards: ["1111111111"], channels: ["C;rm"], bots: ["UEVE00001"] })).toThrow(/not a Slack channel/)
    expect(() => addToDoors(file(), { boards: ["1111111111"], channels: ["CQUESTION1"], bots: ["eve"] })).toThrow(/not a Slack bot user id/)
    const f = file()
    addToDoors(f, { boards: ["1111111111"], channels: ["CQUESTION1"], bots: ["UEVE00001"] })
    writeFileSync(f, "not json")
    expect(readDoors(f)).toBeNull()
    expect(() => addToDoors(f, { boards: ["2222222222"], channels: [], bots: [] })).toThrow(/cannot read/)
    expect(readFileSync(f, "utf8")).toBe("not json")
  })

  it("reads a list a person emptied by hand as their explicit opt-out", () => {
    const f = file()
    addToDoors(f, { boards: ["1111111111"], channels: ["CQUESTION1"], bots: ["UEVE00001"] })
    writeFileSync(f, JSON.stringify({ mondayBoards: [], slackChannels: [], agentBots: [] }))
    expect(readDoors(f)).toEqual({ mondayBoards: [], slackChannels: [], agentBots: [] })
  })
})
