import { describe, expect, it } from "vitest"
import { classify, type ClassifyContext, type SlackEnvelope } from "../classify.ts"

const CTX: ClassifyContext = {
  teamId: "T1",
  botUserId: "UBOT",
  otherAgentBots: ["UOTHER"],
  allowedUsers: ["UNATE"],
  channels: { agents: "CAG", questions: "CQ", intake: "CIN", releases: "CREL" },
  issueForThread: (channel, ts) => (channel === "CQ" && ts === "1700.1" ? "STEP-7" : null),
}

const envelope = (event: Record<string, unknown>, team = "T1"): SlackEnvelope => ({
  team_id: team,
  event: { user: "UNATE", ...event } as SlackEnvelope["event"],
})

describe("classify", () => {
  it("reads a top-level mention in #polads-intake as intake", () => {
    expect(classify(envelope({ type: "app_mention", channel: "CIN", ts: "1800.1", text: "<@UBOT> fix the date" }), CTX)).toMatchObject({
      type: "intake",
      key: "msg:CIN:1800.1",
      text: "<@UBOT> fix the date",
    })
  })

  it("gives both copies of one mentioning message the same key and meaning", () => {
    const a = classify(envelope({ type: "app_mention", channel: "CIN", ts: "1800.1", text: "<@UBOT> x" }), CTX)
    const b = classify(envelope({ type: "message", channel: "CIN", ts: "1800.1", text: "<@UBOT> x" }), CTX)
    expect(a.type).toBe("intake")
    expect(b).toEqual(a)
  })

  it("reads a reply in an issue's thread as an answer, mention or not", () => {
    expect(classify(envelope({ type: "message", channel: "CQ", ts: "1700.5", thread_ts: "1700.1", text: "Use the publication date" }), CTX)).toMatchObject({
      type: "answer",
      issue: "STEP-7",
      key: "msg:CQ:1700.5",
    })
    expect(classify(envelope({ type: "app_mention", channel: "CQ", ts: "1700.6", thread_ts: "1700.1", text: "<@UBOT> also" }), CTX)).toMatchObject({
      type: "answer",
      issue: "STEP-7",
    })
  })

  it("treats any other mention as one to answer in its own thread", () => {
    expect(classify(envelope({ type: "app_mention", channel: "CAG", ts: "1900.1", text: "<@UBOT> status?" }), CTX)).toMatchObject({ type: "mention", threadTs: "1900.1" })
    expect(classify(envelope({ type: "app_mention", channel: "CIN", ts: "1900.3", thread_ts: "1900.2", text: "<@UBOT> and?" }), CTX)).toMatchObject({ type: "mention", threadTs: "1900.2" })
  })

  it("ignores our own bot, other bots, edits and joins", () => {
    expect(classify(envelope({ type: "message", channel: "CQ", ts: "1", thread_ts: "1700.1", user: "UBOT", text: "eve: a question" }), CTX).type).toBe("ignore")
    expect(classify(envelope({ type: "message", channel: "CQ", ts: "1", thread_ts: "1700.1", bot_id: "B9", text: "hi" }), CTX).type).toBe("ignore")
    expect(classify(envelope({ type: "message", subtype: "message_changed", channel: "CQ", ts: "1", thread_ts: "1700.1" }), CTX).type).toBe("ignore")
    expect(classify(envelope({ type: "message", subtype: "channel_join", channel: "CIN", ts: "1" }), CTX).type).toBe("ignore")
  })

  it("ignores people not on the allowlist and other workspaces, even inside an issue's thread", () => {
    expect(classify(envelope({ type: "message", channel: "CQ", ts: "2", thread_ts: "1700.1", user: "USTRANGER", text: "approve it" }), CTX)).toEqual({
      type: "ignore",
      reason: "sender not on the allowlist",
    })
    expect(classify(envelope({ type: "app_mention", channel: "CIN", ts: "3", text: "<@UBOT> x" }, "TOTHER"), CTX)).toEqual({
      type: "ignore",
      reason: "another workspace",
    })
  })

  it("reads a private channel's messages (channel_type group) as it reads a public channel's", () => {
    expect(classify(envelope({ type: "message", channel_type: "group", channel: "CIN", ts: "1800.1", text: "<@UBOT> fix the date" }), CTX)).toMatchObject({ type: "intake" })
    expect(classify(envelope({ type: "message", channel_type: "group", channel: "CQ", ts: "1700.5", thread_ts: "1700.1", text: "Use the publication date" }), CTX)).toMatchObject({
      type: "answer",
      issue: "STEP-7",
    })
    expect(classify(envelope({ type: "message", channel_type: "group", channel: "CAG", ts: "1900.1", text: "<@UBOT> status?" }), CTX)).toMatchObject({ type: "mention" })
  })

  it("ignores chatter that is neither a mention nor in an issue's thread", () => {
    expect(classify(envelope({ type: "message", channel: "CIN", ts: "4", text: "morning all" }), CTX).type).toBe("ignore")
  })

  it("keeps reactions in our channels only", () => {
    expect(classify(envelope({ type: "reaction_added", reaction: "hand", item: { type: "message", channel: "CREL", ts: "1950.1" } }), CTX)).toMatchObject({
      type: "reaction",
      key: "reaction:CREL:1950.1:UNATE:hand",
    })
    expect(classify(envelope({ type: "reaction_added", reaction: "hand", item: { type: "message", channel: "CX", ts: "1" } }), CTX).type).toBe("ignore")
  })
})

// The four channels may be Slack Connect channels, hosted in STEP Network or
// shared with it. Slack puts the installation in the envelope (authorizations,
// which team_id mirrors) and the sender's own workspace in the event.
describe("classify in a Slack Connect channel", () => {
  const connect = (event: Record<string, unknown>, over: Partial<SlackEnvelope> = {}): SlackEnvelope => ({
    team_id: "T1",
    authorizations: [{ team_id: "T1" }],
    ...over,
    event: { user: "UNATE", channel_type: "group", ...event } as SlackEnvelope["event"],
  })

  it("hears a member of our workspace in a channel another workspace hosts", () => {
    const e = { type: "message", channel: "CIN", ts: "2100.1", text: "<@UBOT> fix the date", team: "T1", user_team: "T1", source_team: "THOST" }
    expect(classify(connect(e), CTX)).toMatchObject({ type: "intake", user: "UNATE" })
    // Even were Slack to put the host's team in team_id, the authorization is this installation.
    expect(classify(connect(e, { team_id: "THOST" }), CTX)).toMatchObject({ type: "intake" })
  })

  it("lets the allowlist of member ids, not the sender's workspace, decide who is heard", () => {
    const allowed = { ...CTX, allowedUsers: ["UNATE", "UPARTNER"] }
    const fromPartner = { type: "message", channel: "CIN", ts: "2100.2", text: "<@UBOT> the date", user: "UPARTNER", team: "TPARTNER", user_team: "TPARTNER" }
    expect(classify(connect(fromPartner), allowed)).toMatchObject({ type: "intake", user: "UPARTNER" })
    expect(classify(connect({ ...fromPartner, user: "USTRANGER" }), allowed)).toEqual({ type: "ignore", reason: "sender not on the allowlist" })
  })

  it("ignores a delivery for an installation of the app in another workspace", () => {
    const e = { type: "message", channel: "CIN", ts: "2100.3", text: "<@UBOT> x", team: "T1" }
    expect(classify(connect(e, { team_id: "T9", authorizations: [{ team_id: "T9" }] }), CTX)).toEqual({ type: "ignore", reason: "another workspace" })
    expect(classify(connect(e, { team_id: "T1", authorizations: [{ team_id: "T9" }] }), CTX)).toEqual({ type: "ignore", reason: "another workspace" })
    // An enterprise authorization without a team falls back to team_id.
    expect(classify(connect(e, { team_id: "T1", authorizations: [{ team_id: null }] }), CTX)).toMatchObject({ type: "intake" })
  })
})

// Decision 3 (2026-09-24): one Slack app per agent, and the four channels are
// shared, so a bridge acts only on its own bot's mentions and on replies in
// the threads it opened. UOTHER is another agent's bot.
describe("classify beside other agents' bots", () => {
  const ignored = { type: "ignore", reason: "not addressed to the bot" }

  it("ignores a message in #polads-intake that mentions another bot", () => {
    expect(classify(envelope({ type: "message", channel: "CIN", ts: "2000.1", text: "<@UOTHER> the date is wrong" }), CTX)).toEqual(ignored)
  })

  it("ignores an app_mention delivery whose text mentions only another bot", () => {
    expect(classify(envelope({ type: "app_mention", channel: "CIN", ts: "2000.2", text: "<@UOTHER> the date is wrong" }), CTX)).toEqual(ignored)
    expect(classify(envelope({ type: "app_mention", channel: "CAG", ts: "2000.3", text: "<@UOTHER> status?" }), CTX)).toEqual(ignored)
  })

  it("ignores a reply without a mention in a thread this bridge does not own", () => {
    expect(classify(envelope({ type: "message", channel: "CQ", ts: "2000.5", thread_ts: "1600.1", text: "Use the publication date" }), CTX)).toEqual(ignored)
    expect(classify(envelope({ type: "message", channel: "CIN", ts: "2000.6", thread_ts: "2000.1", text: "and the Danish label" }), CTX)).toEqual(ignored)
  })

  it("files a request that names two agents only when this one comes first, and answers it as a mention otherwise", () => {
    // The first agent named files it and owns its thread; the others reply in that thread and take none of its answers.
    expect(classify(envelope({ type: "message", channel: "CIN", ts: "2000.7", text: "<@UBOT> <@UOTHER> the date is wrong" }), CTX)).toMatchObject({ type: "intake" })
    // filedBy tells the front door another agent is filing it, so it files nothing itself.
    expect(classify(envelope({ type: "app_mention", channel: "CIN", ts: "2000.8", text: "<@UOTHER> and <@UBOT|eve>, the date is wrong" }), CTX)).toMatchObject({
      type: "mention",
      threadTs: "2000.8",
      filedBy: "UOTHER",
    })
    expect(classify(envelope({ type: "app_mention", channel: "CAG", ts: "2000.9", text: "<@UBOT> status?" }), CTX)).not.toHaveProperty("filedBy")
  })

  it("counts only agents for who comes first: a person named before this bot does not stop the filing", () => {
    expect(classify(envelope({ type: "message", channel: "CIN", ts: "2000.9", text: "<@UNATE> says <@UBOT> should fix the date" }), CTX)).toMatchObject({ type: "intake" })
  })
})
