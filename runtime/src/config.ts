/**
 * Where an agent mini keeps its state, and what it is configured to do.
 *
 * Everything lives under ~/.agentd (AGENTD_HOME overrides it, for tests):
 *   config.json   validated below; Nate writes it once from templates/config.example.json
 *   inbox/        Slack events the front door or the bridge has not finished with
 *   outbox/       Slack messages waiting for the bridge to post
 *   jobs/         develop jobs: pending/, running/, done/
 *   state/        small JSON files: threads/, heartbeats, usage, the front door's state,
 *                 and monday/ on the coordinator mini (STEP-3289)
 *   logs/         JSON-lines logs and the ledger
 *   worktrees/    one git worktree per develop job
 *   PAUSE         present = no new jobs; the front door only answers
 */

import { execFileSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import { join } from "node:path"
import { fileURLToPath } from "node:url"
import { z } from "zod"

export interface AgentPaths {
  home: string
  root: string
  config: string
  inbox: string
  outbox: string
  jobs: string
  state: string
  threads: string
  logs: string
  worktrees: string
  pauseFile: string
}

export function agentPaths(home: string = homedir()): AgentPaths {
  const root = process.env.AGENTD_HOME || join(home, ".agentd")
  return {
    home,
    root,
    config: join(root, "config.json"),
    inbox: join(root, "inbox"),
    outbox: join(root, "outbox"),
    jobs: join(root, "jobs"),
    state: join(root, "state"),
    threads: join(root, "state", "threads"),
    logs: join(root, "logs"),
    worktrees: join(root, "worktrees"),
    pauseFile: join(root, "PAUSE"),
  }
}

/**
 * A mini's name: trackerctl's MINI_RE (plugin/scripts/trackerctl.ts), and a
 * test pins the two together. A claim comment's claimant runs to the first
 * space, so no wider name round-trips.
 */
export const MINI_RE = /^[a-z][a-z0-9-]*$/

/**
 * A Slack member id, the one a mention carries (<@U123>). A bot id (B...), an
 * app id (A...) or a name would pass as a string and quietly match nobody.
 */
const MEMBER_ID = z.string().regex(/^[UW][A-Z0-9]+$/, "must be a Slack member id (U...): the person's or bot's profile, More, Copy member ID")

/** A Monday user or board id: digits. Monday's API gives them as strings, and a config may write numbers. */
const MONDAY_ID = z.union([z.string().regex(/^\d+$/, "must be a Monday id (digits)"), z.number().int().positive()]).transform(String)
const MONDAY_COLUMN = z.string().regex(/^[a-z0-9_]+$/, "must be a Monday column id")

/**
 * The Monday bridge (STEP-3289): the people-and-agents board, kept in step
 * with Linear. On exactly one coordinator mini (Eve's first), and off
 * everywhere else. The ids default to the board as it was built on
 * 2026-09-25; the group titles are matched by name, every poll.
 */
const MondayBridgeSchema = z
  .object({
    enabled: z.boolean().default(false),
    boardId: MONDAY_ID.default("5104953028"),
    /** The shortest time between two reads of the board. apiShare can make it longer. */
    pollMinutes: z.number().int().positive().default(2),
    /**
     * The share of the account's daily Monday API calls the board's reads may
     * take: 1,000 a day on Basic and Standard, 10,000 on Pro, 25,000 on
     * Enterprise, shared by everyone's API use (developer.monday.com, Rate
     * limits). The bridge reads the account's own limit and polls no more
     * often than this allows.
     */
    apiShare: z.number().gt(0).max(1).default(0.2),
    columns: z
      .object({
        person: MONDAY_COLUMN.default("multiple_person_mm7hcr31"),
        kind: MONDAY_COLUMN.default("color_mm7hx8zq"),
        state: MONDAY_COLUMN.default("color_mm7hvyyt"),
        agent: MONDAY_COLUMN.default("dropdown_mm7hmyqg"),
        linear: MONDAY_COLUMN.default("link_mm7hz1nj"),
        pr: MONDAY_COLUMN.default("link_mm7h42x"),
        due: MONDAY_COLUMN.default("date_mm7hfrdv"),
        answer: MONDAY_COLUMN.default("long_text_mm7hzj39"),
      })
      .prefault({}),
    groups: z
      .object({
        needsYou: z.string().default("Needs you"),
        testDay: z.string().default("Test day"),
        requests: z.string().default("Requests"),
        working: z.string().default("Agents working on"),
        done: z.string().default("Done"),
      })
      .prefault({}),
    /**
     * The people whose updates, answers and requests count, and no one else
     * (Nate, Kristoffer, Tomas: their Monday user ids). linearEmail maps an
     * issue's owner or requester to the item's Person.
     */
    people: z.array(z.object({ id: MONDAY_ID, name: z.string().min(1), linearEmail: z.string().optional() })).min(1),
    /** Who an item goes to when its issue names none of the people: Nate. */
    defaultPerson: MONDAY_ID,
    /** This mini in the Agent column's dropdown. Default: its name, capitalised. */
    agentLabel: z.string().optional(),
    /** The dropdown's labels for agents: an issue held by a Linear account of that name shows it. Default: agentLabel alone. */
    agentLabels: z.array(z.string()).optional(),
    /** The label a request from the board gets in Linear. */
    requestLabel: z.string().default("intake/monday"),
    archiveAfterDays: z.number().positive().default(14),
  })
  .superRefine((m, ctx) => {
    if (!m.people.some((p) => p.id === m.defaultPerson)) {
      ctx.addIssue({ code: "custom", path: ["defaultPerson"], message: "must be one of bridges.monday.people" })
    }
  })

export const ConfigSchema = z.object({
  /** The mini's name: the claim comment, the Slack prefix, the profile's `mini`. */
  mini: z.string().regex(MINI_RE),
  repo: z.object({
    /** The PolAds main checkout: the front door's cwd, and where worktrees come from. */
    path: z.string().min(1),
    slug: z.string().default("STEP-Network/v0-politiske-annoncer"),
    base: z.string().default("staging"),
    /** The product label this mini develops. */
    product: z.string().default("polads"),
  }),
  /** The dev-tasks plugin in the same checkout as this runtime, e.g. /Users/eve/dev-tasks/plugin. */
  pluginRoot: z.string().min(1),
  slack: z.object({
    channels: z
      .object({
        agents: z.string().default("polads-agents"),
        questions: z.string().default("polads-questions"),
        intake: z.string().default("polads-intake"),
        releases: z.string().default("polads-releases"),
      })
      .prefault({}),
    /** Slack user ids whose messages count. Everyone else is ignored (spec 11). */
    allowedUsers: z.array(MEMBER_ID).min(1),
    /**
     * The bot user ids of the other agents' Slack apps (decision 3: one app
     * per agent). A request that names several agents is filed by the first
     * one it mentions, so each bridge must know the others' bots.
     */
    otherAgentBots: z.array(MEMBER_ID).default([]),
  }),
  frontDoor: z
    .object({
      model: z.string().default("sonnet"),
      tmuxSession: z.string().default("frontdoor"),
      /** Longer than /loop's longest self-paced wait (60 minutes), so a quiet night is not a hang. */
      staleTickMinutes: z.number().int().positive().default(75),
      /** install.sh writes the absolute path: a LaunchAgent gets no login shell's PATH. */
      claudePath: z.string().default("claude"),
      /** install.sh writes the absolute path, as for claudePath. */
      tmuxPath: z.string().default("tmux"),
      /**
       * The Slack channel into the front door's session (STEP-3293): agentd
       * starts it with --channels for the dev-tasks plugin, which the mini's
       * managed settings approve. false: Slack messages wait for its next wakeup.
       */
      channel: z.boolean().default(true),
    })
    .prefault({}),
  worker: z
    .object({
      defaultModel: z.string().default("sonnet"),
      complexModel: z.string().default("opus"),
      maxTurns: z.number().int().positive().default(250),
      maxBudgetUsd: z.number().positive().default(15),
      wallClockMinutes: z.number().int().positive().default(90),
      /** false while a mini is supervised: its worker still opens PRs, and a person merges them. */
      autoMerge: z.boolean().default(true),
    })
    .prefault({}),
  queue: z
    .object({
      /** allowlist: develop and refine only the ids in `allow` (the rehearsal). open: the whole queue. */
      mode: z.enum(["allowlist", "open"]).default("allowlist"),
      allow: z.array(z.string().regex(/^STEP-\d+$/)).default([]),
      refineWhenReadyBelow: z.number().int().nonnegative().default(5),
      /** Spec 6.6: under 20 percent of the weekly window left, only refine and answer. */
      lightModeWeeklyPct: z.number().min(0).max(100).default(80),
      fiveHourStopPct: z.number().min(0).max(100).default(90),
      timeZone: z.string().default("Europe/Copenhagen"),
    })
    .prefault({}),
  claims: z
    .object({
      heartbeatMinutes: z.number().int().positive().default(15),
      ttlHours: z.number().positive().default(6),
    })
    .prefault({}),
  bridges: z.object({ monday: MondayBridgeSchema.optional() }).prefault({}),
})

export type AgentConfig = z.infer<typeof ConfigSchema>
export type MondayBridgeConfig = z.infer<typeof MondayBridgeSchema>

export function loadConfig(paths: AgentPaths): AgentConfig {
  let raw: string
  try {
    raw = readFileSync(paths.config, "utf8")
  } catch {
    throw new Error(`agentd: no config at ${paths.config}. Copy runtime/templates/config.example.json there and edit it.`)
  }
  let json: unknown
  try {
    json = JSON.parse(raw)
  } catch {
    throw new Error(`agentd: ${paths.config} is not valid JSON`)
  }
  const parsed = ConfigSchema.safeParse(json)
  if (!parsed.success) {
    const problems = parsed.error.issues.map((i) => `${i.path.join(".")} ${i.message}`).join("; ")
    throw new Error(`agentd: ${paths.config} is invalid: ${problems}`)
  }
  return parsed.data
}

// The plugin's one profile reader, the bash one the hooks and trackerctl
// consult, in the same checkout. Asked, never re-implemented: a second reader
// of ~/.claude/dev-tasks-profile.json would drift from it.
const PROFILE_SH = fileURLToPath(new URL("../../plugin/hooks/lib/profile.sh", import.meta.url))

/**
 * This machine's mini as hooks/lib/profile.sh reports it (`get mini`), taken
 * as it is, the way trackerctl's readProfileMini takes it (plugin 1.1.1). null
 * only for a clean exit with no answer: no profile, a laptop's `"mini": null`,
 * a file that does not parse, or no jq to read it with (the reader's own
 * fallbacks). Anything else (no bash, a moved or failing reader) throws: a
 * broken reader must not pass for a machine without a mini.
 */
export function readProfileMini(env: NodeJS.ProcessEnv = process.env, script: string = PROFILE_SH): string | null {
  let out: string
  try {
    out = execFileSync("bash", [script, "get", "mini"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] })
  } catch (error) {
    const stderr = String((error as { stderr?: unknown }).stderr ?? "").trim()
    throw new Error(`agentd: ${script} could not report this machine's mini${stderr ? `: ${stderr}` : ""}`)
  }
  // jq -r ends its answer with one newline; nothing else is trimmed.
  const mini = out.replace(/\n$/, "")
  return mini ? mini : null
}

/** This machine's profile as hooks/lib/profile.sh reports it (`get profile`): agent or human. Throws when the reader cannot run. */
export function readProfile(env: NodeJS.ProcessEnv = process.env, script: string = PROFILE_SH): string {
  return execFileSync("bash", [script, "get", "profile"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] }).trim()
}

/**
 * One mini, one name (decision 2, 2026-09-24). trackerctl claims and
 * heartbeats as the profile's mini; the worker, agentd's heartbeat and the
 * Slack prefix use config.json's. Two names would sign claims the heartbeat
 * never finds, so agentd and the bridge refuse to start until they agree.
 */
export function assertProfileMini(config: Pick<AgentConfig, "mini">, profileMini: string | null, configPath: string): void {
  if (profileMini === config.mini) return
  const profile =
    profileMini === null
      ? "no mini (none in the file, a file that does not parse, or no jq to read it with)"
      : `mini ${JSON.stringify(profileMini)}`
  throw new Error(
    `agentd: ${configPath} names mini ${JSON.stringify(config.mini)}, but the machine profile ` +
      `(~/.claude/dev-tasks-profile.json, read by plugin/hooks/lib/profile.sh) has ${profile}. ` +
      `Make both name this mini, then start again.`,
  )
}
