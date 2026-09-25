/**
 * The Slack channel's own record (STEP-3293), state/slack-channel.json: which
 * inbox entries it pushed into the front door's session and when, and its
 * heartbeat. Only the channel server (channel/server.ts) writes it, and it
 * reads it back to push a message again. agentctl status shows the heartbeat.
 * Nothing else trusts it: Claude Code never says whether it registered the
 * channel, so a push is no proof of delivery.
 */

import { join } from "node:path"
import type { AgentPaths } from "../config.ts"
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
