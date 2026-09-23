#!/usr/bin/env -S npx tsx
/**
 * trackerctl — the one way a skill reaches the tracker adapter.
 *
 * Every subcommand prints exactly ONE line of JSON to stdout and nothing
 * else, so a skill can pipe it through `jq -r`. Diagnostics go to stderr.
 * Exit 0 on success, 1 on a tracker error, 64 on a usage error.
 *
 *   trackerctl read STEP-123
 *   trackerctl branch STEP-123
 *   trackerctl create --title "Fix the thing" --description "$BODY" --label chore
 *   trackerctl comment STEP-123 --body "opened PR #42"
 *   trackerctl attach STEP-123 --url https://github.com/... --title "PR #42"
 *   trackerctl ready --limit 10
 *   trackerctl claim STEP-123 --as bob
 *
 * The provider comes from .claude/project-config.json `tracker.provider`
 * (default monday), overridable with DEV_TASKS_TRACKER.
 */

import { resolveTracker } from "../src/tracker/index.ts"
import { branchNameFor } from "../src/tracker/types.ts"

export interface ParsedArgs {
  command: string
  positional: string[]
  flags: Record<string, string | string[] | true>
}

const USAGE = `usage: trackerctl <read|branch|create|comment|attach|ready|claim> [args]`

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv.length === 0) throw new Error(USAGE)
  const [command, ...rest] = argv
  if (command.startsWith("-")) throw new Error(USAGE)

  const positional: string[] = []
  const flags: Record<string, string | string[] | true> = {}

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

    const existing = flags[name]
    if (existing === undefined) {
      flags[name] = value
    } else if (Array.isArray(existing)) {
      existing.push(String(value))
    } else {
      flags[name] = [String(existing), String(value)]
    }
  }

  return { command, positional, flags }
}

function str(flags: ParsedArgs["flags"], name: string): string | undefined {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  return Array.isArray(v) ? v[0] : v
}

function list(flags: ParsedArgs["flags"], name: string): string[] | undefined {
  const v = flags[name]
  if (v === undefined || v === true) return undefined
  return Array.isArray(v) ? v : [v]
}

function requireArg(value: string | undefined, name: string): string {
  if (!value) throw new Error(`${USAGE}\nmissing required --${name}`)
  return value
}

async function main(): Promise<void> {
  const parsed = parseArgs(process.argv.slice(2))
  const tracker = resolveTracker()
  const { command, positional, flags } = parsed

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
        title: requireArg(str(flags, "title"), "title"),
        description: str(flags, "description"),
        labels: list(flags, "label"),
        state: str(flags, "state"),
      })
      process.stdout.write(JSON.stringify(issue) + "\n")
      return
    }
    case "comment": {
      await tracker.comment(
        requireArg(positional[0], "ref (positional)"),
        requireArg(str(flags, "body"), "body"),
      )
      process.stdout.write(JSON.stringify({ ok: true }) + "\n")
      return
    }
    case "attach": {
      await tracker.attachLink(
        requireArg(positional[0], "ref (positional)"),
        requireArg(str(flags, "url"), "url"),
        requireArg(str(flags, "title"), "title"),
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
      const issue = await tracker.claimIssue(
        requireArg(positional[0], "ref (positional)"),
        requireArg(str(flags, "as"), "as"),
      )
      process.stdout.write(JSON.stringify(issue) + "\n")
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
