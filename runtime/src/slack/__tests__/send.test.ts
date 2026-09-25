import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../../config.ts"
import { countIn, listNew, putOnce } from "../../fsq.ts"
import type { Logger } from "../../log.ts"
import { enqueueSlack } from "../../outbox.ts"
import { threadFor } from "../../threads.ts"
import { drainOutbox, sendOutboxMessage, SlackAccessRefused, startOutbox, type SendContext, type SlackWeb } from "../send.ts"

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

  it("keeps the last question it asked in a thread, which a reply of yes agrees to (STEP-3293), and a notice leaves it be", async () => {
    const { ctx } = context()
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "Which date?\n\nMy recommendation: the publication date. Reply yes to go with it, or tell me what you want instead.", question: true })
    expect(threadFor(ctx.paths, "STEP-7")?.lastQuestion).toMatch(/^Which date\?\n\nMy recommendation: the publication date\./)
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "I started on it.", question: false })
    expect(threadFor(ctx.paths, "STEP-7")?.lastQuestion).toMatch(/^Which date\?/)
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "And the label?\n\nMy recommendation: keep it. Reply yes to go with it, or tell me what you want instead.", question: true })
    expect(threadFor(ctx.paths, "STEP-7")?.lastQuestion).toMatch(/^And the label\?/)
  })

  it("fetches and stores a thread's link on its next message when it had none", async () => {
    const { ctx, attached } = context()
    let calls = 0
    const permalink = ctx.web.permalink
    ctx.web.permalink = async (channel, ts) => (++calls === 1 ? null : permalink(channel, ts))
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    expect(threadFor(ctx.paths, "STEP-7")?.permalink).toBeNull()
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "And the label?", question: true })
    expect(threadFor(ctx.paths, "STEP-7")?.permalink).toBe("https://step.slack.com/archives/CQ/p90011")
    expect(attached).toEqual([["STEP-7", "https://step.slack.com/archives/CQ/p90011"]])
  })

  it("tries the Linear link again with the thread's next message when it failed", async () => {
    let attempts = 0
    const { ctx } = context({
      attachThread: async () => {
        if (++attempts === 1) throw new Error("Linear: down")
      },
    })
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    expect(threadFor(ctx.paths, "STEP-7")?.permalink).toBeNull()
    await sendOutboxMessage(ctx, { kind: "issue", issue: "STEP-7", text: "And the label?", question: true })
    expect(attempts).toBe(2)
    expect(threadFor(ctx.paths, "STEP-7")?.permalink).toBe("https://step.slack.com/archives/CQ/p90011")
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

  it.each(["internal_error", "rate_limited", "team_added_to_org"])("waits, as for the network, when Slack reports trouble of its own (%s)", async (code) => {
    const trouble = Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } })
    const { ctx } = context({}, [trouble])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    expect(await drainOutbox(ctx, quiet)).toBe(0)
    expect(countIn(ctx.paths.outbox, "new")).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(0)
  })

  it.each(["token_revoked", "invalid_auth", "missing_scope", "access_denied"])("stops with every message kept, in order, when Slack refuses the app itself (%s)", async (code) => {
    // Not this message's fault: moving each to failed would empty the queue while nobody notices.
    const refused = Object.assign(new Error(`An API error occurred: ${code}`), { data: { error: code } })
    const { ctx, posts } = context({}, [refused])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "two" }, new Date(2))
    await expect(drainOutbox(ctx, quiet)).rejects.toThrow(SlackAccessRefused)
    await expect(drainOutbox(ctx, quiet)).resolves.toBe(2)
    expect(posts.map((p) => p.text)).toEqual(["eve: one", "eve: two"])
    expect(countIn(ctx.paths.outbox, "failed")).toBe(0)
  })

  it("stops, as for the app, when the bot is out of one of its own four channels", async () => {
    // Every later message for that channel would fail too: a person must invite it back.
    const outOf = Object.assign(new Error("An API error occurred: not_in_channel"), { data: { error: "not_in_channel" } })
    const { ctx } = context({}, [outOf])
    const key = enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "claimed STEP-7" }, new Date(1))
    // The reason names the entry that met the refusal, for the person who reads bridge.json.
    await expect(drainOutbox(ctx, quiet)).rejects.toThrow(new RegExp(`agents channel \\(CAG\\).*not_in_channel.*outbox entry ${key}`))
    expect(countIn(ctx.paths.outbox, "new")).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(0)
  })

  it("takes a message off the queue as soon as Slack has it, before the calls that follow", async () => {
    // A crash while the permalink or the Linear link is pending must not post the question again.
    const { ctx } = context()
    ctx.web.permalink = () => new Promise(() => {})
    enqueueSlack(ctx.paths, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    void drainOutbox(ctx, quiet)
    await new Promise((resolve) => setTimeout(resolve, 20))
    expect(countIn(ctx.paths.outbox, "new")).toBe(0)
    expect(countIn(ctx.paths.outbox, "done")).toBe(1)
  })

  it("never posts a token-shaped string", async () => {
    // Worker and git error text reach Slack through the outbox.
    const { ctx, posts } = context()
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "push failed: https://x-access-token:xoxb-1-2-abc@github.com" })
    await drainOutbox(ctx, quiet)
    expect(posts[0].text).toBe("eve: push failed: https://x-access-token:[redacted]@github.com")
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

  it("keeps draining through the network's trouble", async () => {
    const { ctx, posts } = context({}, [Object.assign(new Error("fetch failed"), { code: "slack_webapi_request_error" })])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    const stop = startOutbox(ctx, quiet, () => {}, 5)
    await new Promise((resolve) => setTimeout(resolve, 60))
    stop()
    expect(posts.map((p) => p.text)).toEqual(["eve: one"])
  })

  it("pauses when Slack refuses the app, keeps every message, tries again after the pause, and says why once", async () => {
    let tries = 0
    const { ctx } = context()
    ctx.web.postMessage = async () => {
      tries++
      throw Object.assign(new Error("An API error occurred: token_revoked"), { data: { error: "token_revoked" } })
    }
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "two" }, new Date(2))
    const reasons: Array<string | null> = []
    const stop = startOutbox(ctx, quiet, (reason) => void reasons.push(reason), 5, 30)
    await new Promise((resolve) => setTimeout(resolve, 100))
    stop()
    expect(tries).toBeGreaterThanOrEqual(2)
    expect(tries).toBeLessThanOrEqual(4)
    expect(reasons).toEqual([expect.stringMatching(/token_revoked/)])
    expect(countIn(ctx.paths.outbox, "new")).toBe(2)
  })

  it("goes on, and clears the reason, once Slack takes a message again: a re-invited bot needs no restart", async () => {
    const outOf = Object.assign(new Error("An API error occurred: not_in_channel"), { data: { error: "not_in_channel" } })
    const { ctx, posts } = context({}, [outOf])
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "one" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "two" }, new Date(2))
    const reasons: Array<string | null> = []
    const stop = startOutbox(ctx, quiet, (reason) => void reasons.push(reason), 5, 20)
    await new Promise((resolve) => setTimeout(resolve, 100))
    stop()
    expect(posts.map((p) => p.text)).toEqual(["eve: one", "eve: two"])
    expect(reasons).toEqual([expect.stringMatching(/not_in_channel/), null])
  })

  it("takes every kind of message off the queue once it is sent", async () => {
    // A kind that forgot to say it was posted would go out again every 2 seconds.
    const { ctx } = context()
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "claimed STEP-7" }, new Date(1))
    enqueueSlack(ctx.paths, { kind: "reply", channelId: "CIN", threadTs: "1800.1", text: "filed STEP-7" }, new Date(2))
    enqueueSlack(ctx.paths, { kind: "react", channelId: "CQ", ts: "1700.5", name: "white_check_mark" }, new Date(3))
    enqueueSlack(ctx.paths, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true }, new Date(4))
    enqueueSlack(ctx.paths, { kind: "issue", issue: "STEP-7", text: "And the label?", question: true }, new Date(5))
    expect(await drainOutbox(ctx, quiet)).toBe(5)
    expect(countIn(ctx.paths.outbox, "new")).toBe(0)
    expect(countIn(ctx.paths.outbox, "done")).toBe(5)
  })

  it("moves an entry it cannot read as a message to failed, rather than let it hold up the queue", async () => {
    // A hand-written entry, or one from another version of agentctl.
    const { ctx, posts } = context()
    putOnce(ctx.paths.outbox, "000000000000001-000001-a", { kind: "shout", text: "?" })
    putOnce(ctx.paths.outbox, "000000000000002-000001-b", { kind: "post", channel: "alerts", text: "?" })
    putOnce(ctx.paths.outbox, "000000000000003-000001-c", { kind: "reply", channelId: "CIN", text: "no thread" })
    enqueueSlack(ctx.paths, { kind: "post", channel: "agents", text: "kept" }, new Date(4))
    expect(await drainOutbox(ctx, quiet)).toBe(1)
    expect(countIn(ctx.paths.outbox, "failed")).toBe(3)
    expect(posts.map((p) => p.text)).toEqual(["eve: kept"])
  })

  it("records each posted question in the ledger", async () => {
    const { ctx } = context()
    enqueueSlack(ctx.paths, { kind: "issue", issue: "STEP-7", text: "Which date?", question: true })
    await drainOutbox(ctx, quiet)
    const ledger = readFileSync(join(ctx.paths.logs, "ledger.jsonl"), "utf8")
    expect(JSON.parse(ledger.trim())).toMatchObject({ type: "question.asked", issue: "STEP-7" })
  })
})
