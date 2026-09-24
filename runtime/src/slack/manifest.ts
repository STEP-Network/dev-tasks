/**
 * The Slack app manifest for one agent. Every agent has its own Slack app
 * (decision 3, 2026-09-24): Socket Mode hands each event to only one of an
 * app's open connections, so two minis on one app would each miss part of
 * the traffic. runtime/slack/app-manifest.json is the template every agent's
 * app shares, and this fills in the one thing that differs, the name:
 *
 *   cd runtime && npx tsx src/slack/manifest.ts eve > eve-manifest.json
 *
 * prints the app "PolAds Eve" with the bot user @eve, for Slack's
 * "Create New App" > "From a manifest" (runtime/slack/README.md).
 */

import { readFileSync } from "node:fs"
import { MINI_RE } from "../config.ts"

export interface SlackManifest {
  display_information: { name: string } & Record<string, unknown>
  features: { bot_user: { display_name: string } & Record<string, unknown> } & Record<string, unknown>
  [section: string]: unknown
}

export const TEMPLATE_PATH = new URL("../../slack/app-manifest.json", import.meta.url)

/** Slack refuses an app name longer than this. */
const MAX_APP_NAME = 35

export function agentManifest(mini: string, template: SlackManifest = JSON.parse(readFileSync(TEMPLATE_PATH, "utf8"))): SlackManifest {
  if (!MINI_RE.test(mini)) {
    throw new Error(`manifest: ${JSON.stringify(mini)} is not a mini's name: lowercase letters, digits and dashes, starting with a letter`)
  }
  const name = `PolAds ${mini[0].toUpperCase()}${mini.slice(1)}`
  if (name.length > MAX_APP_NAME) throw new Error(`manifest: the app name ${JSON.stringify(name)} is longer than Slack's ${MAX_APP_NAME} characters`)
  return {
    ...template,
    display_information: { ...template.display_information, name },
    features: { ...template.features, bot_user: { ...template.features.bot_user, display_name: mini } },
  }
}

if (process.argv[1]?.endsWith("manifest.ts")) {
  try {
    process.stdout.write(JSON.stringify(agentManifest(process.argv[2] ?? ""), null, 2) + "\n")
  } catch (error) {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\nusage: npx tsx src/slack/manifest.ts <mini>\n`)
    process.exit(64)
  }
}
