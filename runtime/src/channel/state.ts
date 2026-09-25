/**
 * The Slack channel's own record (STEP-3293), state/slack-channel.json: which
 * inbox entries it pushed into the front door's session and when, and its
 * heartbeat. Only the channel server (channel/server.ts) writes it. The digest
 * reads it so a message the channel delivered minutes ago is not offered
 * twice, and the bridge reads it to know whether the front door is there.
 */

import { join } from "node:path"
import type { AgentConfig, AgentPaths } from "../config.ts"
import { readJson, writeJsonAtomic } from "../fsq.ts"

export interface ChannelState {
  pid: number
  /** The heartbeat: written every few seconds while the front door's session holds the channel open. */
  at: string
  connectedAt: string
  /** Inbox keys pushed into the session, with when: acked ones drop out. */
  delivered: Record<string, string>
}

/** A heartbeat older than this: the front door's session, and the channel with it, is gone. */
export const CHANNEL_STALE_MS = 2 * 60_000
/** A pushed message the front door has not acked after this is pushed again: a compaction may have lost it. */
export const REDELIVER_MS = 10 * 60_000

export const channelFile = (paths: AgentPaths) => join(paths.state, "slack-channel.json")

export function readChannelState(paths: AgentPaths): ChannelState | null {
  return readJson<ChannelState>(channelFile(paths))
}

export function writeChannelState(paths: AgentPaths, state: ChannelState): void {
  writeJsonAtomic(channelFile(paths), state)
}

export const channelFresh = (state: ChannelState | null, now: Date) => state !== null && now.getTime() - Date.parse(state.at) < CHANNEL_STALE_MS

/** Whether the channel pushed this entry into a live session recently enough that the front door is on it. */
export function inFlight(state: ChannelState | null, key: string, now: Date): boolean {
  const at = state?.delivered[key]
  return channelFresh(state, now) && at !== undefined && now.getTime() - Date.parse(at) < REDELIVER_MS
}

/**
 * Whether the front door will read a message soon. With the channel ever
 * started, its heartbeat decides: the channel lives in the front door's own
 * session and dies with it. Before that, the front door's last wakeup does.
 */
export function frontDoorUp(paths: AgentPaths, config: Pick<AgentConfig, "frontDoor">, now: Date, lastTickAt: Date | null): boolean {
  const state = readChannelState(paths)
  if (state) return channelFresh(state, now)
  return lastTickAt !== null && now.getTime() - lastTickAt.getTime() < config.frontDoor.staleTickMinutes * 60_000
}
