/**
 * The mini's Claude Code managed settings, as far as the Slack channel goes
 * (STEP-3293). A channel of our own is on no list of Anthropic's, so the
 * machine's managed settings approve it: root-owned, written from the admin
 * account (runbook, section 1). agentd opens the channel only when they turn
 * channels on and approve exactly the dev-tasks plugin's, and nothing else:
 * the file applies to every Claude Code session on the mini.
 */

import { readFileSync } from "node:fs"

/** Where Claude Code reads managed settings on macOS. */
export const MANAGED_SETTINGS = "/Library/Application Support/ClaudeCode/managed-settings.json"

/** What the file must hold, as the runbook and doctor print it. */
export const MANAGED_CHANNEL_JSON = '{"channelsEnabled": true, "allowedChannelPlugins": [{"marketplace": "dev-tasks-marketplace", "plugin": "dev-tasks"}]}'

export type ChannelApproval = { ok: true } | { ok: false; why: string }

export function channelApproval(file: string = MANAGED_SETTINGS): ChannelApproval {
  let managed: { channelsEnabled?: unknown; allowedChannelPlugins?: unknown }
  try {
    managed = JSON.parse(readFileSync(file, "utf8"))
  } catch {
    return { ok: false, why: `no readable managed settings at ${file}` }
  }
  if (managed.channelsEnabled !== true) return { ok: false, why: `${file} does not set channelsEnabled: true` }
  const list = managed.allowedChannelPlugins
  const only = Array.isArray(list) && list.length === 1 && (list[0] as { plugin?: unknown })?.plugin === "dev-tasks" && (list[0] as { marketplace?: unknown })?.marketplace === "dev-tasks-marketplace"
  if (!only) return { ok: false, why: `${file} must approve exactly dev-tasks@dev-tasks-marketplace in allowedChannelPlugins, and nothing else` }
  return { ok: true }
}
