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
 *   usertest/     one folder per browser test (WS5)
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
  /** One folder per browser test (WS5): its screenshots, GIF, report and throwaway Chrome profile. */
  usertest: string
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
    usertest: join(root, "usertest"),
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
 * The morning digest (Wave 2, spec 6, D5): at `at` in queue.timeZone on
 * `days` (1 is Monday), not on `skipDates`, in #polads-questions. Off until
 * go-live turns it on.
 */
const DigestSchema = z
  .object({
    enabled: z.boolean().default(false),
    at: z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, "must be HH:MM").default("08:00"),
    days: z.array(z.number().int().min(1).max(7)).default([1, 2, 3, 4, 5]),
    skipDates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/, "must be YYYY-MM-DD")).default([]),
  })
  .prefault({})

/**
 * The Requests board (Wave 2, spec 6): one item per ask, kept in step with
 * its anchor issue in Linear. Its ids are the board's own, made by a person
 * (N1), so none has a default: without this block the bridge runs on one
 * board, as before.
 */
const RequestsBoardSchema = z.object({
  boardId: MONDAY_ID,
  columns: z.object({
    requester: MONDAY_COLUMN,
    type: MONDAY_COLUMN,
    class: MONDAY_COLUMN,
    size: MONDAY_COLUMN,
    stage: MONDAY_COLUMN,
    progress: MONDAY_COLUMN,
    targetWeek: MONDAY_COLUMN,
    linear: MONDAY_COLUMN,
    slackThread: MONDAY_COLUMN,
  }),
  groups: z
    .object({
      active: z.string().default("Active"),
      released: z.string().default("Released"),
      closed: z.string().default("Declined and on hold"),
    })
    .prefault({}),
  /** How long a released or declined request stays on the board. */
  releasedDays: z.number().positive().default(30),
})

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
        /** Wave 2's three new columns: no defaults, so a board without them runs as before (spec 6). */
        recommendation: MONDAY_COLUMN.optional(),
        request: MONDAY_COLUMN.optional(),
        slackThread: MONDAY_COLUMN.optional(),
      })
      .prefault({}),
    groups: z
      .object({
        needsYou: z.string().default("Needs you"),
        testDay: z.string().default("Test day"),
        requests: z.string().default("Requests"),
        working: z.string().default("Agents working on"),
        /** Wave 2's groups: a need goes to its own only when it is configured (spec 6). */
        approvePlan: z.string().optional(),
        looks: z.string().optional(),
        fyi: z.string().optional(),
        done: z.string().default("Done"),
      })
      .prefault({}),
    /**
     * The people whose updates, answers and requests count, and no one else
     * (Nate, Kristoffer, Tomas: their Monday user ids). linearEmail maps an
     * issue's owner or requester to the item's Person.
     */
    people: z
      .array(
        z.object({
          id: MONDAY_ID,
          name: z.string().min(1),
          linearEmail: z.string().optional(),
          /** Their Slack member id: an answer in Slack and one on Monday are then the same person's (answer.ts personKey). */
          slackId: z.string().regex(/^[UW][A-Z0-9]+$/).optional(),
        }),
      )
      .min(1),
    /** Who an item goes to when its issue names none of the people: Nate. */
    defaultPerson: MONDAY_ID,
    /** This mini in the Agent column's dropdown. Default: its name, capitalised. */
    agentLabel: z.string().optional(),
    /** The dropdown's labels for agents: an issue held by a Linear account of that name shows it. Default: agentLabel alone. */
    agentLabels: z.array(z.string()).optional(),
    /** The label a request from the board gets in Linear. */
    requestLabel: z.string().default("intake/monday"),
    archiveAfterDays: z.number().positive().default(14),
    /** The Requests board (Wave 2). Set, requests live there and the board above keeps no request groups. */
    requests: RequestsBoardSchema.optional(),
    digest: DigestSchema,
  })
  .superRefine((m, ctx) => {
    if (!m.people.some((p) => p.id === m.defaultPerson)) {
      ctx.addIssue({ code: "custom", path: ["defaultPerson"], message: "must be one of bridges.monday.people" })
    }
  })

/**
 * A persona the browser test signs in as (WS5): one of the staging test-login
 * route's own accounts, never a real person's. Kept in this mini's config
 * only: dev-tasks is public.
 */
const PersonaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/),
  email: z.email(),
  admin: z.boolean().default(false),
  /** false for a persona whose pages show real people's data (an admin): its screenshots stay on the mini. */
  publishScreenshots: z.boolean().default(true),
  /** Changed paths that call for this persona. The first persona whose paths match wins. */
  paths: z.array(z.string().min(1)).default([]),
})

const bareOrigin = (value: string) => {
  try {
    const u = new URL(value)
    return u.protocol === "https:" && u.origin === value
  } catch {
    return false
  }
}
const compiles = (value: string) => {
  try {
    new RegExp(value)
    return true
  } catch {
    return false
  }
}
/** Vercel's bypass secret goes to any host previewHost matches, so it must match whole hostnames. */
const anchored = (value: string) => value.startsWith("^") && value.endsWith("$") && compiles(value)
/** Another site a page may load from, named by its literal https host: no wildcard, port or user before the path. */
const literalHttpsPattern = (value: string) => /^https:\/\/[a-z0-9-]+(\.[a-z0-9-]+)+\/\S*$/.test(value)

/** The agent browser test (WS5): Claude in a real Chrome, on the PR's preview and on staging. */
const UserTestSchema = z
  .object({
    enabled: z.boolean().default(false),
    model: z.string().default("sonnet"),
    maxTurns: z.number().int().positive().default(80),
    maxBudgetUsd: z.number().positive().default(5),
    wallClockMinutes: z.number().int().positive().default(25),
    /** How long a develop or revise job waits for the PR's Vercel preview. */
    previewWaitMinutes: z.number().int().positive().default(20),
    /** The GitHub deployment environment Vercel reports the project's previews in. */
    previewEnvironment: z.string().min(1).optional(),
    /** The preview's hostname, as a regular expression anchored with ^ and $. */
    previewHost: z.string().refine(anchored, "must be a regular expression anchored with ^ and $").optional(),
    stagingOrigin: z.string().refine(bareOrigin, "must be a bare https origin").optional(),
    rcOrigin: z.string().refine(bareOrigin, "must be a bare https origin").optional(),
    /** URL patterns a page may load from besides its own origin, e.g. the app's sign-in API. */
    extraAllowedUrlPatterns: z.array(z.string().refine(literalHttpsPattern, "must be https:// and a literal host, then a path")).default([]),
    chromePath: z.string().default("/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"),
    headless: z.boolean().default(true),
    personas: z.array(PersonaSchema).default([]),
    /** Changed paths no user sees: a diff of only these is not browser-tested. */
    skipPaths: z.array(z.string()).default([".claude/**", ".github/**", "docs/**", "**/__tests__/**", "**/*.test.*", "**/*.spec.*", "e2e/**", "**/*.md"]),
  })
  .superRefine((u, ctx) => {
    if (!u.enabled) return
    for (const key of ["previewEnvironment", "previewHost", "stagingOrigin"] as const) {
      if (!u[key]) ctx.addIssue({ code: "custom", path: [key], message: "is needed when the browser test is on" })
    }
  })

/** Claude's reasoning effort: the Agent SDK's `effort`, the CLI's --effort. Left out, the model's own default. */
const EffortSchema = z.enum(["low", "medium", "high", "xhigh", "max"])

const KeyName = z.string().regex(/^[A-Z][A-Z0-9_]*$/)

/**
 * An MCP server a session may use (STEP-3369): a keyless http one, or a stdio
 * command, pinned to a version, whose `keys` agentd reads from
 * ~/.config/agentd/research.env or neon-staging-ro.env and hands to it alone:
 * a list, each under its own name, or { NAME_IT_READS: "NAME_IN_THE_FILE" }.
 * Strict: no env, header or other field where a key could be written into
 * config.json.
 */
const McpServerSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("http"), url: z.string().url().startsWith("https://") }).strict(),
  z
    .object({
      type: z.literal("stdio"),
      command: z.string().min(1),
      args: z.array(z.string()).default([]),
      keys: z.union([z.array(KeyName), z.record(KeyName, KeyName)]).default([]),
    })
    .strict(),
])
/** By the name its tools carry: mcp__<name>__<tool>. */
const McpServersSchema = z.record(z.string().regex(/^[a-z][a-z0-9-]*$/), McpServerSchema).default({})

/**
 * Hosts where this project's secrets are used: a worker's WebFetch, WebSearch
 * or MCP tool never sends anything there (the exfil guard). `.x` is the
 * domain and its subdomains, `x` that host alone. Their public documentation
 * lives on other hosts.
 */
export const FETCH_DENY_HOSTS = [
  ".aws.neon.tech",
  "console.neon.tech",
  "api.neon.tech",
  "api.stack-auth.com",
  "api.linear.app",
  "api.monday.com",
  "slack.com",
  "hooks.slack.com",
  ".ingest.sentry.io",
  ".ingest.de.sentry.io",
  "api.vercel.com",
  "api.resend.com",
  "api.paddle.com",
  "sandbox-api.paddle.com",
  "api.anthropic.com",
]

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
      /** The front door's claude runs with --effort <this>. */
      effort: EffortSchema.optional(),
      tmuxSession: z.string().default("frontdoor"),
      /** Longer than /loop's longest self-paced wait (60 minutes), so a quiet night is not a hang. */
      staleTickMinutes: z.number().int().positive().default(75),
      /** install.sh writes the absolute path: a LaunchAgent gets no login shell's PATH. */
      claudePath: z.string().default("claude"),
      /** install.sh writes the absolute path, as for claudePath. */
      tmuxPath: z.string().default("tmux"),
      /**
       * The Slack channel into the front door's session (STEP-3293): agentd
       * starts it with --channels for the dev-tasks plugin when the mini's
       * managed settings approve exactly that (channel/managed.ts). false, or
       * not approved: Slack messages wait for its next wakeup.
       */
      channel: z.boolean().default(true),
      /** MCP servers for the front door's claude (--mcp-config), keys from research.env (STEP-3369). */
      mcpServers: McpServersSchema,
    })
    .prefault({}),
  worker: z
    .object({
      defaultModel: z.string().default("sonnet"),
      complexModel: z.string().default("opus"),
      /** Every SDK session this mini runs: develop, revise and merge rounds, the browser test, the retro. */
      effort: EffortSchema.optional(),
      /**
       * A develop or revise worker may split its work over subagents, a
       * dynamic workflow and named teammates, on any model it picks. They run
       * in its process under its own hooks and sandbox (sessions.test.ts
       * proves it on the binary workers run). Off: no fan-out.
       */
      fanOut: z.boolean().default(false),
      /** A develop or revise worker may search and fetch the web (STEP-3369), behind the exfil guard. */
      webTools: z.boolean().default(false),
      /** A develop or revise worker may run skills, but never one that pushes, opens a PR or merges (STEP-3369). */
      skills: z.boolean().default(false),
      /** MCP servers for develop and revise workers, keys from research.env (STEP-3369). strictMcpConfig stays on. */
      mcpServers: McpServersSchema,
      /** Hosts the exfil guard refuses every URL to. Replaces the default list when set. */
      fetchDenyHosts: z.array(z.string().min(1)).default(FETCH_DENY_HOSTS),
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
  /**
   * The weekly retro (STEP-3290, retro/retro.ts): on the coordinator mini
   * only, so it is off unless turned on. Local time, in queue.timeZone.
   */
  retro: z
    .object({
      enabled: z.boolean().default(false),
      /** 1 Monday ... 7 Sunday. */
      weekday: z.number().int().min(1).max(7).default(5),
      hour: z.number().int().min(0).max(23).default(14),
      /** The repository the retro's PR goes to: this runtime's own. */
      slug: z.string().default("STEP-Network/dev-tasks"),
      base: z.string().default("main"),
      model: z.string().default("opus"),
      maxTurns: z.number().int().positive().default(120),
      maxBudgetUsd: z.number().positive().default(10),
      wallClockMinutes: z.number().int().positive().default(60),
    })
    .prefault({}),
  usertest: UserTestSchema.prefault({}),
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
