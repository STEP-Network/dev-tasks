/**
 * The commands the Slack and Monday bridges file for test day, in agentd's
 * inbox as fsq entries of type "testday": one per press or message, so a
 * redelivery or a second poll files nothing twice. The controller (Task 13)
 * drains them and answers at the door each came from. No other inbox reader
 * takes an entry of this type.
 */
import { join } from "node:path"
import type { AgentPaths } from "../config.ts"
import { listNew, putOnce } from "../fsq.ts"
import { enqueueMonday } from "../monday/store.ts"
import { enqueueSlack } from "../outbox.ts"
import { testDayRoot } from "./store.ts"
import type { Door, TestDayCommand } from "./types.ts"

/** What the test day thread and item read, said to a person who wrote something else there. */
export const TESTDAY_HELP =
  'Here I read three things: a checkpoint number with pass or fail, for example "4 pass" or "4 fail the price shows 0", and on a failed checkpoint "fix before release" or "next week". Anything else, write in the change\'s own thread.'

/** A command as a bridge files it: each verb's own fields, without what filing adds. */
type Filed<C> = C extends unknown ? Omit<C, "type" | "receivedAt"> : never

export function fileTestDayCommand(paths: AgentPaths, c: Filed<TestDayCommand>, now: Date): boolean {
  return putOnce(paths.inbox, c.key, { ...c, type: "testday", receivedAt: now.toISOString() })
}

export function pendingCommands(paths: AgentPaths): Array<{ key: string; payload: TestDayCommand }> {
  return listNew<TestDayCommand>(paths.inbox).filter((e) => e.payload.type === "testday")
}

/**
 * The first time this Slack message is heard, true: Slack sends a mention
 * twice (app_mention and message), and each copy would otherwise answer.
 */
export function heardOnce(paths: AgentPaths, key: string): boolean {
  return putOnce(join(testDayRoot(paths), "heard"), key, { key })
}

/** The answer at the door the command came from: its Slack thread, or the Monday item with a like. */
export function tellDoor(paths: AgentPaths, door: Door, text: string, now: Date): void {
  if (door.kind === "slack") enqueueSlack(paths, { kind: "reply", channelId: door.channel, threadTs: door.threadTs, text }, now)
  else if (door.kind === "monday") enqueueMonday(paths, { itemId: door.itemId, threadId: door.threadId, text, like: door.updateId }, now)
}
