import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { countIn, listNew } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import { enqueueSlack } from "../../outbox.ts"
import { threadFor } from "../../threads.ts"
import { drainOutbox, sendOutboxMessage, SlackTokenRefused, type SendContext, type SlackWeb } from "../send.ts"

const quiet: Logger = { info() {}, warn() {}, error() {} }

function context(overrides: Partial<SendContext> = {}, failWith: unknown[] = []) {
  const posts: Array<{ channel: string; text: string; thread_ts?: string }> = []
  const web: SlackWeb = {
    async postMessage(args) {
      const next = failWith.shift()
      if (next) throw next
      posts.push(args)
      return { ts: `900${posts.length}.1` }
    },
    async permalink(channel, ts) {
      return `https://step.slack.com/archives/${channel}/p${ts.replace(".", "")}`
    },
    async react() {},
  }
  const attached: Array<[string, string]> = []
  const ctx: SendContext = {
    paths: agentPaths(mkdtempSync(join(tmpdir(), "agentd-send-"))),
    mini: "eve",
    channelIds: { agents: "CAG", questions: "CQ", intake: "CIN", releases: "CREL" },
    web,
    describeIssue: async (id) => ({ title: "Fix the date", url: `https://linear.app/step/issue/${id}` }),
    attachThread: async (id, permalink) => {
      attached.push([id, permalink])
    },
    now: () => new Date("2026-09-24T08:00:00.000Z"),
    ...overrides,
  }
  return { ctx, posts, attached }
}

describe("sendOutboxMessage", () => {
  it("posts a notice to the channel id with the mini's name first", async () => {
    const { ctx, posts } = context()
    await sendOutboxMessage(ctx, { kind: "post", channel: "agents", text: "claimed STEP-7" })
    expect(posts).toEqual([{ channel: "CAG", text: "eve: claimed STEP-7" }])
  })

  it("opens the issue's thread in #polads-questions with title and link, stores it on the issue, then replies in it", async () => {
    const { ctx, posts, attached } = context()
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "And the label?", question: true })
    expect(posts[0]).toEqual({ channel: "CQ", text: "eve: STEP-7 Fix the date\nhttps://linear.app/step/issue/STEP-7\n\nWhich date?" })
    expect(posts[1]).toEqual({ channel: "CQ", thread_ts: "9001.1", text: "eve: And the label?" })
    expect(threadFor(ctx.paths, "STEP-7")).toMatchObject({ channelId: "CQ", ts: "9001.1", lastQuestionAt: "2026-09-24T08:00:00.000Z" })
    expect(attached).toEqual([["STEP-7", "https://step.slack.com/archives/CQ/p90011"]])
  })

  it("posts with just the id when Linear cannot describe the issue", async () => {
    const { ctx, posts } = context({ describeIssue: async () => null })
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "blocked", question: false })
    expect(posts[0].text).toBe("eve: STEP-7\n\nblocked")
  })

  it("records a new thread as soon as it is posted, so a restart replies in it rather than open a second", async () => {
    const { ctx, posts } = context()
    let calls = 0
    ctx.web = {
      async postMessage(args) {
        posts.push(args)
        return { ts: `900${++calls}.1` }
      },
      // Slack posted the message, then never says where it is: the drain dies here.
      permalink: () => new Promise(() => {}),
      async react() {},
    }
    void sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(threadFor(ctx.paths, "STEP-7")).toMatchObject({ channelId: "CQ", ts: "9001.1", permalink: null })
    await Promise.race([sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true }), new Promise((resolve) => setTimeout(resolve, 20))])
    expect(posts.map((p) => p.thread_ts ?? "new thread")).toEqual(["new thread", "9001.1"])
  })

  it("returns a warning, not an error, when the link cannot be stored, so the message is not posted twice", async () => {
    const { ctx } = context({
      attachThread: async () => {
        throw new Error("Linear: down")
      },
    })
    expect(await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "q", question: true })).toEqual({
      warning: "could not attach the Slack thread to STEP-7: Linear: down",
    })
  })
})

describe("drainOutbox", () => {
  it("stops at a transient error and keeps that message and the ones after it, in order", async () => {
    const transient = Object.assign(new Error("fetch failed"), { code: "slack_webapi_request_error" })
    const { ctx, posts } = context({}, [undefined, transient])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "two" }, new Date(2))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "three" }, new Date(3))
    expect(await drainOutbox(ctx, quiet)).toBe(1)
    expect(listNew<{ text: string }>(ctx.paths.outbox).map((e) => e.payload.text)).toEqual(["two", "three"])
    expect(await drainOutbox(ctx, quiet)).toBe(2)
    expect(posts.map((p) => p.text)).toEqual(["eve: one", "eve: two", "eve: three"])
  })

  it("moves a message Slack refuses for good to failed and carries on", async () => {
    const refused = Object.assign(new Error("An API error occurred: channel_not_found"), { data: { error: "channel_not_found" } })
    const { ctx, posts } = context({}, [refused])
    enqueueSlack(ctx.paths, { kind: "reply", channelId: "CGONE", threadTs: "1.1", text: "lost" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "kept" }, new Date(2))
    expect(await drainOutbox(ctx, quiet)).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(1)
    expect(posts.map((p) => p.text)).toEqual(["eve: kept"])
  })

  it("moves a message refused for a reason it does not know to failed, rather than let it hold up the queue", async () => {
    const refused = Object.assign(new Error("An API error occurred: restricted_action_read_only_channel"), { data: { error: "restricted_action_read_only_channel" } })
    const { ctx, posts } = context({}, [refused])
    enqueueSlack(ctx.paths, { kind: "post", channel: "releases", text: "released" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "claimed STEP-7" }, new Date(2))
    expect(await drainOutbox(ctx, quiet)).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(1)
    expect(posts.map((p) => p.text)).toEqual(["eve: claimed STEP-7"])
  })

  it("waits, as for the network, when Slack reports trouble of its own", async () => {
    const trouble = Object.assign(new Error("An API error occurred: internal_error"), { data: { error: "internal_error" } })
    const { ctx } = context({}, [trouble])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    expect(await drainOutbox(ctx, quiet)).toBe(0)
    expect(countIn(ctx.paths.outbox, "new")).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(0)
  })

  it("stops with every message kept, in order, when Slack refuses the token itself", async () => {
    // A revoked token is not this message's fault: moving each to failed would empty the queue.
    const revoked = Object.assign(new Error("An API error occurred: token_revoked"), { data: { error: "token_revoked" } })
    const { ctx } = context({}, [revoked])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "two" }, new Date(2))
    await expect(drainOutbox(ctx, quiet)).rejects.toThrow(SlackTokenRefused)
    await expect(drainOutbox(ctx, quiet)).resolves.toBe(2)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(0)
  })

  it("counts a reaction that is already there as sent", async () => {
    const { ctx } = context()
    ctx.web.react = async () => {
      throw Object.assign(new Error("An API error occurred: already_reacted"), { data: { error: "already_reacted" } })
    }
    enqueueSlack(ctx.paths, { kind: "react", channelId: "CQ", ts: "1700.5", name: "white_check_mark" })
    expect(await drainOutbox(ctx, quiet)).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(0)
  })

  it("records each posted question in the ledger", async () => {
    const { ctx } = context()
    enqueueSlack(ctx.paths, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    await drainOutbox(ctx, quiet)
    const ledger = readFileSync(join(ctx.paths.logs, "ledger.jsonl"), "utf8")
    expect(JSON.parse(ledger.trim())).toMatchObject({ type: "question.asked", issue: "STEP-7" })
  })
})
