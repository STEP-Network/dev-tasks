/**
 * The commands the Slack and Monday bridges file for test day, in agentd's
 * inbox as fsq entries of type "testday": one per press or message, so a
 * redelivery or a second poll files nothing twice. The controller (Task 13)
 * drains them, oldest first by when the person acted, and answers at the door
 * each came from. No other inbox reader takes an entry of this type.
 */
import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { listNew, putOnce } from "../fsq.ts"
import { enqueueMonday } from "../monday/store.ts"
import { enqueueSlack } from "../outbox.ts"
import { testDayRoot } from "./store.ts"
import type { Door, TestDayCommand } from "./types.ts"

/** What the test day thread and the Test day item read, said to a person who wrote something else there. */
export const TESTDAY_HELP =
  'Here I read one checkpoint at a time: its number with pass or fail, for example "4 pass" or "4 fail the price shows 0". For a failed checkpoint, answer "fix before release" or "next week" where I asked about it. Anything else, write in the change\'s own thread.'

/** What a failed checkpoint's decision item reads, said to a person who wrote something else there. */
export const DECISION_HELP = 'Here I read "fix before release" or "next week" for this failed checkpoint. Anything else, write in the change\'s own thread.'

/** Said to a person who sent several checkpoints in one message: none of them was recorded. */
export const ONE_AT_A_TIME =
  'I read one checkpoint per message, so I recorded nothing from this one. Please send each on its own, for example "5 pass", then "6 fail the price shows 0". If this was one checkpoint, write what you saw without a number right before pass or fail.'

/** A command as a bridge files it: each verb's own fields, without what filing adds. */
type Filed<C> = C extends unknown ? Omit<C, "type" | "receivedAt"> : never

export function fileTestDayCommand(paths: AgentPaths, c: Filed<TestDayCommand>, now: Date): boolean {
  return putOnce(paths.inbox, c.key, { ...c, type: "testday", receivedAt: now.toISOString() })
}

/** Oldest first by when the person acted, whichever door: one poll files several at once, and a file name orders nothing. */
export function pendingCommands(paths: AgentPaths): Array<{ key: string; payload: TestDayCommand }> {
  return listNew<TestDayCommand>(paths.inbox)
    .filter((e) => e.payload.type === "testday")
    .sort((a, b) => byCode(a.payload.at ?? a.payload.receivedAt, b.payload.at ?? b.payload.receivedAt) || byCode(a.payload.key, b.payload.key))
}

/** Plain code-point order: the same on every mini, whatever its locale. */
const byCode = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0)

/** A Slack message's ts as the time it was written, ISO. */
export const slackTime = (ts: string): string => new Date(Math.round(Number(ts) * 1000)).toISOString()

/** A time Monday gave, as full ISO so times compare in order ("…09:00:00Z" and "…09:00:00.000Z" alike). `now` when it gave none. */
export function actedAt(value: string | null | undefined, now: Date): string {
  const t = Date.parse(value ?? "")
  return new Date(Number.isFinite(t) ? t : now.getTime()).toISOString()
}

/**
 * A Slack person's name from this mini's config (bridges.monday.people, by
 * slackId): no network before the command is on disk. Their id when config
 * does not name them.
 */
export function slackName(config: AgentConfig, userId: string): string {
  return config.bridges.monday?.people.find((p) => p.slackId === userId)?.name ?? userId
}

/**
 * The first time this Slack message is heard, true: Slack sends a mention
 * twice (app_mention and message), and each copy would otherwise answer.
 * Kept 14 days (agentd/health.ts).
 */
export function heardOnce(paths: AgentPaths, key: string): boolean {
  return putOnce(heardDir(paths), key, { key })
}

export const heardDir = (paths: AgentPaths) => join(testDayRoot(paths), "heard")

/** The answer at the door the command came from: its Slack thread, or the Monday item with a like. */
export function tellDoor(paths: AgentPaths, door: Door, text: string, now: Date): void {
  if (door.kind === "slack") enqueueSlack(paths, { kind: "reply", channelId: door.channel, threadTs: door.threadTs, text }, now)
  else if (door.kind === "monday") enqueueMonday(paths, { itemId: door.itemId, threadId: door.threadId, text, like: door.updateId }, now)
}
