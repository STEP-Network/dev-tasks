/**
 * The Monday bridge's own state (STEP-3289), under ~/.agentd/state/monday:
 *
 *   items/<key>.json   one per item the bridge keeps: which Linear issue it
 *                      stands for, the State it last wrote, and the people's
 *                      words it has already acted on. One small file per item,
 *                      as threads/ keeps one per issue.
 *   cursor.json        from when the Answer column's history was last read
 *   outbox/            replies for the board, as fsq entries: agentd's answers
 *                      to an instruction (agentd/instructions.ts), and the
 *                      bridge's own. The bridge posts them.
 *   migration-*.json   a migration's snapshots, chmod 600: the way back (migrate.ts)
 *   migrating          there while agentctl monday migrate runs
 *   syncing            there while the bridge polls or posts
 */

import { existsSync, readdirSync, rmSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { join } from "node:path"
import type { AgentPaths } from "../config.ts"
import { putOnce, readJson, safeKey, writeJsonAtomic } from "../fsq.ts"
import { redact } from "../log.ts"
import type { Stage } from "./stage.ts"

/** The State column's labels. */
export type MondayState = "Needs you" | "Waiting on agent" | "Done" | "Blocked"

export interface ItemRecord {
  /**
   * needs-STEP-7, uat-STEP-7, or request-<item id>: one item per Linear id and
   * purpose. Test day's (Wave 3): testday-item, the week's Test day item, and
   * testday-decision-<run>-<n>, a failed checkpoint's decision.
   */
  key: string
  /** testday and testday-decision items are the test-day controller's: the needs pass never touches them. */
  kind: "needs" | "uat" | "request" | "testday" | "testday-decision"
  issue: string
  itemId: string
  /** The State this bridge last wrote. It writes again only when that changes, so a person's own edit stands. */
  state: MondayState
  /** What the item's text last said, so a new question posts a new update and an unchanged one nothing. */
  bodyHash: string | null
  createdAt: string
  doneAt: string | null
  /** Update ids and Answer column changes (log:<id>) already acted on. */
  handled: string[]
  /** When the item last asked (its body posted, or a second answer asked back): the first answer after it counts (spec 6). */
  askedAt?: string
  /** The request item its Request column links to (Wave 2): written once, and again only when it changes. */
  requestItem?: string
  /**
   * Its Slack thread (spec 6): wanted until the Monday link is said there,
   * then posted. permalink: the thread's link, once known, as the Slack
   * thread column shows it. Absent on an item made before Wave 2 (the
   * bridge gives an open one outside Test day its thread).
   */
  thread?: { state: "wanted" | "posted"; permalink?: string }
  /** Settled on this board since it last asked: the other door is told here, so this one needs no note from it. */
  answeredHere?: boolean
  /** Words Linear keeps refusing, by id: when it first did. After a day the bridge gives up and says so. */
  failing?: Record<string, string>
  /**
   * Answer column changes Linear refused, kept whole: the board's activity
   * log is read a few minutes back only, so a longer outage would lose them.
   * An update needs no copy: it is on the item, read again every poll.
   */
  retry?: Record<string, { userId: string; text: string; at?: string }>
  /** A request whose Linear link, State and group are written to the board. */
  linked?: boolean
  /** A request's Stage when the bridge last wrote it (Requests board): a change is said once. */
  stage?: Stage
  /** Each Requests board column the bridge last wrote, as JSON: written again only when Linear changes it, so a person's edit stands. */
  written?: Record<string, string>
  /** The request's own Slack thread, when it came from Slack (Task 8). */
  slack?: { permalink: string }
  /** A Slack request's item, not yet linked from Linear and told to its thread: false until the poll after it is made. */
  announced?: boolean
  /** When the last Class change settled was made (D1): one made at or before it, read again, is never acted on. */
  classAt?: string
  /**
   * A person's Class change Linear could not take yet, kept whole, as `retry`
   * keeps the Answer column's: the log is read a few minutes back only.
   */
  classRetry?: { id: string; userId: string; text: string; at: string }
  /** An item someone else made, which the bridge took over for a Slack ask (adopt): the way back of a migration never archives it. */
  takenOver?: boolean
}

const root = (paths: AgentPaths) => join(paths.state, "monday")
const itemsDir = (paths: AgentPaths) => join(root(paths), "items")
const itemFile = (paths: AgentPaths, key: string) => join(itemsDir(paths), `${safeKey(key)}.json`)

const digestFile = (paths: AgentPaths) => join(root(paths), "digest.json")

/** The local day the last morning digest was posted for. */
export function readDigestDay(paths: AgentPaths): string | null {
  return readJson<{ day: string }>(digestFile(paths))?.day ?? null
}

export function writeDigestDay(paths: AgentPaths, day: string): void {
  writeJsonAtomic(digestFile(paths), { day })
}

export function readRecords(paths: AgentPaths): ItemRecord[] {
  if (!existsSync(itemsDir(paths))) return []
  return readdirSync(itemsDir(paths))
    .filter((f) => f.endsWith(".json"))
    .map((f) => readJson<ItemRecord>(join(itemsDir(paths), f)))
    .filter((r): r is ItemRecord => r !== null)
}

/** How many handled ids a record keeps: an item's updates are read 25 at a time, so older ids are never seen again. */
const HANDLED_KEPT = 200

export function saveRecord(paths: AgentPaths, record: ItemRecord): void {
  writeJsonAtomic(itemFile(paths, record.key), { ...record, handled: record.handled.slice(-HANDLED_KEPT) })
}

export function dropRecord(paths: AgentPaths, key: string): void {
  rmSync(itemFile(paths, key), { force: true })
}

const cursorFile = (paths: AgentPaths) => join(root(paths), "cursor.json")

export function readCursor(paths: AgentPaths): Date | null {
  const at = readJson<{ answersReadAt?: string }>(cursorFile(paths))?.answersReadAt
  return at ? new Date(at) : null
}

export function writeCursor(paths: AgentPaths, at: Date): void {
  writeJsonAtomic(cursorFile(paths), { answersReadAt: at.toISOString() })
}

export const mondayOutbox = (paths: AgentPaths) => join(root(paths), "outbox")

/** Held while agentctl monday migrate runs (migrate.ts): the bridge does not poll or post while it is there. */
export const migratingPath = (paths: AgentPaths) => join(root(paths), "migrating")
/** There while the bridge polls or posts, with agentd's pid: a migration does not start under it. */
export const syncingPath = (paths: AgentPaths) => join(root(paths), "syncing")
/** Where a migration keeps its snapshots: the way back. */
export const migrationsDir = root

export interface MondayReply {
  itemId: string
  /** The update to reply under, or null for a new update on the item. */
  threadId: string | null
  text: string
  /** A person's update to like: the board's ✅, only ever beside words. */
  like: string | null
}

let sequence = 0

/**
 * Queues a reply for the board, in order, as the Slack outbox queues its
 * messages. Token-shaped strings are redacted before they reach the disk.
 */
export function enqueueMonday(paths: AgentPaths, reply: MondayReply, now: Date): string {
  sequence = (sequence + 1) % 1_000_000
  const key = `${String(now.getTime()).padStart(15, "0")}-${String(sequence).padStart(6, "0")}-${randomUUID()}`
  putOnce(mondayOutbox(paths), key, { ...reply, text: redact(reply.text), queuedAt: now.toISOString() })
  return key
}
