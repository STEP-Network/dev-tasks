#!/usr/bin/env -S npx tsx
/**
 * trackerctl — the one way a skill reaches the tracker adapter.
 *
 * Every subcommand prints exactly ONE line of JSON to stdout and nothing
 * else, so a skill can pipe it through `jq -r`. Diagnostics go to stderr.
 * Exit 0 on success, 1 on a tracker error or a refused claim, 64 on a
 * usage error.
 *
 *   trackerctl read STEP-123
 *   trackerctl branch STEP-123
 *   trackerctl create --title "Fix the thing" --description "$BODY" --label chore
 *   trackerctl create --title "Fix the thing" --description-file request.md --label polads --state Triage
 *   trackerctl comment STEP-123 --body "opened PR #42"
 *   trackerctl comment STEP-123 --body-file note.md
 *   trackerctl attach STEP-123 --url https://github.com/... --title "PR #42"
 *   trackerctl ready --limit 10
 *   trackerctl claim STEP-123
 *   trackerctl whoami
 *   trackerctl update STEP-123 --state "On hold" --add-label awaiting-answer --description-file brief.md
 *   trackerctl heartbeat STEP-123
 *   trackerctl release STEP-123 --reason "claim expired"
 *   trackerctl claims
 *   trackerctl list --state Triage --limit 20
 *
 * The provider comes from `tracker.provider` in the .claude/project-config.json
 * at the git toplevel (default monday), overridable with DEV_TASKS_TRACKER. A
 * missing or unparseable file or an unknown value still means monday, with a
 * warning on stderr.
 *
 * `claim` and `heartbeat` act as this machine's mini: the `mini` field of
 * ~/.claude/dev-tasks-profile.json, as hooks/lib/profile.sh reads it. Only a
 * mini claims, so a machine without one (a laptop) is refused before the
 * tracker is touched, and so is `claims`. `--as`, if given, must name that
 * same mini.
 */

import { execFileSync } from "node:child_process"
import { fileURLToPath } from "node:url"
import { resolveTracker } from "../src/tracker/index.ts"
import { assertNoSecretText, readTextFile } from "../src/tracker/secrets-guard.ts"
import { approvalPatch, touchesApproval } from "../src/tracker/approval.ts"
import { branchNameFor, type IssuePatch, type Tracker, type TrackerIssue } from "../src/tracker/types.ts"

export interface ParsedArgs {
  command: string
  positional: string[]
  /** A bare `--flag` is `true`, also inside a repeated flag's array. */
  flags: Record<string, string | true | Array<string | true>>
}

const USAGE = `usage: trackerctl <read|branch|create|comment|attach|ready|claim|whoami|update|heartbeat|release|claims|list> [args]`

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) throw new Error(USAGE)
  const [command, ...rest] = argv
  if (command.startsWith("-")) throw new Error(USAGE)

  const positional: string[] = []
  const flags: ParsedArgs["flags"] = {}

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]
    if (!token.startsWith("--")) {
      positional.push(token)
      continue
    }
    const name = token.slice(2)
    const next = rest[i + 1]
    // A value is anything that follows and is not itself a --flag. "-1" is a
    // value, not a flag: only a DOUBLE dash introduces one here.
    const hasValue = next !== undefined && !next.startsWith("--")
    const value: string | true = hasValue ? next : true
    if (hasValue) i++

    // A bare flag stays `true` when it repeats: the string "true" would pass
    // for a label name, and a missing-value check would never see it.
    const existing = flags[name]
    if (existing === undefined) {
      flags[name] = value
    } else if (Array.isArray(existing)) {
      existing.push(value)
    } else {
      flags[name] = [existing, value]
    }
  }

  return { command, positional, flags }
}

function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name]
  const first = Array.isArray(v) ? v[0] : v
  return first === undefined || first === true ? undefined : first
}

/** Every value given for a repeatable flag. A bare occurrence carries none. */
function list(flags: ParsedArgs["flags"], name: string): string[] | undefined {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  const values = (Array.isArray(v) ? v : [v]).filter((x): x is string => x !== true)
  return values.length ? values : undefined
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${USAGE}\nmissing required --${name}`)
  return value
}

const UPDATE_FLAGS = ["state", "add-label", "remove-label", "description-file", "assign"]
const REPEATABLE_FLAGS = ["add-label", "remove-label"]

/**
 * `update`'s flags as a patch. Throws a usage error for a flag update does
 * not take, a flag with no value, a single-valued flag given twice, a bad
 * --assign, an empty description file or an empty update: dropping one flag
 * and writing the rest is how a park built from an empty shell variable
 * would silently do less.
 */
export function buildPatch(flags: ParsedArgs["flags"], readText: (path: string) => string): IssuePatch {
  for (const [name, value] of Object.entries(flags)) {
    if (!UPDATE_FLAGS.includes(name)) throw new Error(`${USAGE}\nupdate does not take --${name}`)
    if (Array.isArray(value) && !REPEATABLE_FLAGS.includes(name)) throw new Error(`${USAGE}\n--${name} is given more than once`)
    const values = Array.isArray(value) ? value : [value]
    if (values.some((v) => v === true || !v.trim())) throw new Error(`${USAGE}\n--${name} needs a value`)
  }
  const patch: IssuePatch = {}
  const state = str(flags, "state")
  if (state) patch.state = state
  const add = list(flags, "add-label")
  if (add) patch.addLabels = add
  const remove = list(flags, "remove-label")
  if (remove) patch.removeLabels = remove
  const file = str(flags, "description-file")
  if (file) {
    // An empty brief means the write that made it failed. Sent as is, it
    // would blank the issue's description.
    const description = readText(file)
    if (!description.trim()) throw new Error(`${USAGE}\n--description-file ${file} is empty`)
    patch.description = description
  }
  const assign = str(flags, "assign")
  if (assign !== undefined) {
    if (assign === "me") patch.assignee = "me"
    else if (assign === "none") patch.assignee = null
    else throw new Error(`${USAGE}\n--assign takes me or none`)
  }
  if (Object.keys(patch).length === 0) {
    throw new Error(`${USAGE}\nupdate needs one of --state --add-label --remove-label --description-file --assign`)
  }
  return patch
}

/**
 * A text flag, given inline (`--description "..."`) or as a file
 * (`--description-file brief.md`), never both. An agent mini's skills pass
 * people's words through a file, where no shell expands them. Either way,
 * a secrets file and text that carries a key or a token are refused
 * (src/tracker/secrets-guard.ts): on a mini trackerctl runs outside the front
 * door's sandbox and can read the Linear key, so the sandbox cannot be what
 * keeps that key out of an issue.
 */
/**
 * update's patch as it goes to Linear. An agent never lowers an approval class
 * (the human-agent flow spec, section 3), so a patch that touches one is
 * checked against the issue's labels first, and refused rather than written.
 */
export async function guardedPatch(tracker: Pick<Tracker, "readIssue">, ref: string, patch: IssuePatch): Promise<IssuePatch> {
  return touchesApproval(patch) ? approvalPatch((await tracker.readIssue(ref)).labels, patch) : patch
}

/** `trackerctl update`: the flags as a patch, guarded, then written. */
export async function runUpdate(
  tracker: Pick<Tracker, "readIssue" | "updateIssue">,
  ref: string,
  flags: ParsedArgs["flags"],
  readText: (path: string) => string,
): Promise<TrackerIssue> {
  return tracker.updateIssue(ref, await guardedPatch(tracker, ref, buildPatch(flags, readText)))
}

export function textFlag(
  flags: ParsedArgs["flags"],
  name: string,
  readText: (path: string) => string = (path) => readTextFile(path, `--${name}-file`),
): string | undefined {
  const inline = str(flags, name)
  const file = str(flags, `${name}-file`)
  if (inline !== undefined && file !== undefined) throw new Error(`${USAGE}\n--${name} and --${name}-file are two ways to give one text: give one`)
  const text = file !== undefined ? readText(file) : inline
  if (text !== undefined) assertNoSecretText(text, `--${name}`)
  return text
}

// The plugin's one profile reader. The phase 0 rule is exactly one, in bash,
// the one the hooks consult, so trackerctl asks it instead of parsing
// ~/.claude/dev-tasks-profile.json again and drifting from it.
const PROFILE_SH = fileURLToPath(new URL("../hooks/lib/profile.sh", import.meta.url))

/**
 * This machine's mini as hooks/lib/profile.sh reports it (`get mini`), taken
 * as it is. null only for a clean exit with no answer: no profile, a
 * laptop's `"mini": null`, a file that does not parse, or no jq to read it
 * with (the reader's own fallbacks). Anything else (no bash, a moved or
 * failing reader) throws: a broken reader must not pass for a laptop.
 */
export function readProfileMini(env: NodeJS.ProcessEnv = process.env, script: string = PROFILE_SH): string | null {
  const out = execFileSync("bash", [script, "get", "mini"], { encoding: "utf8", env, stdio: ["ignore", "pipe", "pipe"] })
  // jq -r ends its answer with one newline; nothing else is trimmed.
  const mini = out.replace(/\n$/, "")
  return mini ? mini : null
}

// The runtime's config.json holds the same name to the same pattern. A claim
// comment's claimant runs to the first space, so nothing wider round-trips.
const MINI_RE = /^[a-z][a-z0-9-]*$/

/**
 * Who `claim` and `heartbeat` act as: this machine's mini, never a name from
 * the command line. A laptop has no mini and is refused: only minis claim.
 */
export function claimantFor(flags: ParsedArgs["flags"], mini: string | null): string {
  if (!mini) {
    throw new Error(
      `only an agent mini claims: hooks/lib/profile.sh reports no "mini" for this machine ` +
        `(~/.claude/dev-tasks-profile.json has none, or jq is missing). ` +
        `A mini's profile is { "profile": "agent", "devSurface": "preview", "mini": "<name>" }.`,
    )
  }
  if (!MINI_RE.test(mini)) {
    throw new Error(
      `the profile's mini ${JSON.stringify(mini)} is not a name a claim comment can carry: ` +
        `lowercase letters, digits and dashes, starting with a letter.`,
    )
  }
  const as = str(flags, "as")
  if (as !== undefined && as !== mini) {
    throw new Error(`${USAGE}\n--as ${as} is not this machine's mini (${mini}); leave --as out`)
  }
  return mini
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const tracker = resolveTracker()
  const { command, positional, flags } = parsed
  // A required text flag that reaches the tracker: never one that carries a key or a token.
  const sent = (name: string): string => {
    const value = requireArg(str(flags, name), name)
    assertNoSecretText(value, `--${name}`)
    return value
  }

  switch (command) {
    case "read": {
      const issue = await tracker.readIssue(requireArg(positional[0], "ref (positional)"))
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "branch": {
      const issue = await tracker.readIssue(requireArg(positional[0], "ref (positional)"))
      process.stdout.write(
        JSON.stringify({
          branch: branchNameFor(issue.id, issue.title),
          id: issue.id,
          title: issue.title,
        }) + "\n",
      )
      return
    }
    case "create": {
      const issue = await tracker.createIssue({
        title: sent("title"),
        description: textFlag(flags, "description"),
        labels: list(flags, "label"),
        state: str(flags, "state"),
      })
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "comment": {
      await tracker.comment(
        requireArg(positional[0], "ref (positional)"),
        requireArg(textFlag(flags, "body"), "body or --body-file"),
      )
      process.stdout.write(JSON.stringify({ ok: true }) + "\n")
      return
    }
    case "attach": {
      await tracker.attachLink(
        requireArg(positional[0], "ref (positional)"),
        sent("url"),
        sent("title"),
      )
      process.stdout.write(JSON.stringify({ ok: true }) + "\n")
      return
    }
    case "ready": {
      const raw = str(flags, "limit")
      const limit = raw ? Number.parseInt(raw, 10) : 25
      const issues = await tracker.listReady(Number.isFinite(limit) && limit > 0 ? limit : 25)
      process.stdout.write(JSON.stringify(issues) + "\n")
      return
    }
    case "claim": {
      const ref = requireArg(positional[0], "ref (positional)")
      const issue = await tracker.claimIssue(ref, claimantFor(flags, readProfileMini()))
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "whoami": {
      process.stdout.write(JSON.stringify(await tracker.whoami()) + "\n")
      return
    }
    case "update": {
      const issue = await runUpdate(tracker, requireArg(positional[0], "ref (positional)"), flags, (path) => readTextFile(path, "--description-file"))
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "heartbeat": {
      const ref = requireArg(positional[0], "ref (positional)")
      const touched = await tracker.touchClaim(ref, claimantFor(flags, readProfileMini()))
      process.stdout.write(JSON.stringify({ touched }) + "\n")
      return
    }
    case "release": {
      await tracker.releaseIssue(
        requireArg(positional[0], "ref (positional)"),
        sent("reason"),
      )
      process.stdout.write(JSON.stringify({ ok: true }) + "\n")
      return
    }
    case "claims": {
      // What this mini holds. On a person's key the same query would list
      // their own issues that carry an old agent claim comment, and a
      // `release` from that list would unassign them.
      claimantFor(flags, readProfileMini())
      process.stdout.write(JSON.stringify(await tracker.listClaims()) + "\n")
      return
    }
    case "list": {
      const raw = str(flags, "limit")
      const limit = raw ? Number.parseInt(raw, 10) : 50
      const issues = await tracker.listByState(
        requireArg(str(flags, "state"), "state"),
        Number.isFinite(limit) && limit > 0 ? limit : 50,
      )
      process.stdout.write(JSON.stringify(issues) + "\n")
      return
    }
    default:
      throw new Error(`${USAGE}\nunknown subcommand: ${command}`)
  }
}

// Only run when invoked directly, so the test can import parseArgs.
if (process.argv[1] && process.argv[1].endsWith("trackerctl.ts")) {
  main().catch((error: unknown) => {
    const message = error instanceof Error ? error.message : String(error)
    process.stderr.write(message + "\n")
    process.exit(message.startsWith("usage:") ? 64 : 1)
  })
}
