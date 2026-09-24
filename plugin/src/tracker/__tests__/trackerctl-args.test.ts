/**
 * Argument parsing for trackerctl. The subcommands themselves are covered by
 * the adapter tests; what is worth pinning here is the parsing, because the
 * callers are MARKDOWN SKILLS — a mis-parsed flag surfaces as a skill that
 * quietly does the wrong thing rather than as a type error.
 *
 * The --description case is the one that bites: an issue description is
 * multi-line prose containing spaces, quotes and newlines.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join, resolve } from "node:path"
import { fileURLToPath } from "node:url"
import { buildPatch, claimantFor, parseArgs, readProfileMini, textFlag } from "../../../scripts/trackerctl.ts"

const PLUGIN_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "../../..")

describe("parseArgs", () => {
  it("reads a subcommand and its positional", () => {
    expect(parseArgs(["read", "STEP-123"])).toMatchObject({
      command: "read",
      positional: ["STEP-123"],
    })
  })

  it("collects repeated --label into an array", () => {
    const parsed = parseArgs(["create", "--title", "T", "--label", "type/chore", "--label", "product/polads"])
    expect(parsed.flags.label).toEqual(["type/chore", "product/polads"])
  })

  it("keeps a single-valued flag as a string", () => {
    expect(parseArgs(["create", "--title", "Fix the thing"]).flags.title).toBe("Fix the thing")
  })

  it("keeps newlines and quotes inside a flag value intact", () => {
    const body = 'Line one\n\n## Acceptance criteria\n\n- [ ] the "thing" works'
    expect(parseArgs(["create", "--title", "T", "--description", body]).flags.description).toBe(body)
  })

  it("treats a bare --flag with no value as the boolean true", () => {
    expect(parseArgs(["ready", "--json"]).flags.json).toBe(true)
  })

  it("does not mistake a negative number for a flag", () => {
    expect(parseArgs(["ready", "--limit", "-1"]).flags.limit).toBe("-1")
  })

  it("keeps a bare flag's true when the flag repeats, rather than the string \"true\"", () => {
    // "true" would pass for a label name, and a check for a missing value
    // would never see it.
    expect(parseArgs(["update", "STEP-1", "--add-label", "--add-label", "x"]).flags["add-label"]).toEqual([true, "x"])
    expect(parseArgs(["update", "STEP-1", "--state", "A", "--state"]).flags.state).toEqual(["A", true])
  })

  it("throws a usage error on no subcommand at all", () => {
    expect(() => parseArgs([])).toThrowError(/usage/i)
  })
})

describe("textFlag", () => {
  // An agent mini's skills pass people's words through a file, where no shell expands them.
  const read = (path: string) => `contents of ${path}`

  it("takes the text inline or from a file, never both", () => {
    expect(textFlag(parseArgs(["create", "--description", "inline"]).flags, "description", read)).toBe("inline")
    expect(textFlag(parseArgs(["create", "--description-file", "/tmp/r.md"]).flags, "description", read)).toBe("contents of /tmp/r.md")
    expect(textFlag(parseArgs(["create"]).flags, "description", read)).toBeUndefined()
    expect(() => textFlag(parseArgs(["create", "--description", "x", "--description-file", "/tmp/r.md"]).flags, "description", read)).toThrow(/^usage:/)
  })

  it("refuses text that carries a key, inline or from a file", () => {
    expect(() => textFlag(parseArgs(["comment", "STEP-1", "--body", "the key is lin_api_abcdefghij"]).flags, "body", read)).toThrow(/^usage: --body looks like it carries a key/)
    expect(() => textFlag(parseArgs(["create", "--description-file", "/tmp/r.md"]).flags, "description", () => "LINEAR_API_KEY=x")).toThrow(/carries a key/)
  })
})

describe("buildPatch", () => {
  const read = (path: string) => `contents of ${path}`

  it("maps every flag onto the patch", () => {
    const { flags } = parseArgs([
      "update", "STEP-1",
      "--state", "On hold",
      "--add-label", "awaiting-answer",
      "--remove-label", "agent-ready",
      "--remove-label", "chore",
      "--description-file", "/tmp/brief.md",
      "--assign", "me",
    ])
    expect(buildPatch(flags, read)).toEqual({
      state: "On hold",
      addLabels: ["awaiting-answer"],
      removeLabels: ["agent-ready", "chore"],
      description: "contents of /tmp/brief.md",
      assignee: "me",
    })
  })

  it("reads --assign none as unassign", () => {
    expect(buildPatch(parseArgs(["update", "STEP-1", "--assign", "none"]).flags, read)).toEqual({ assignee: null })
  })

  it("refuses an unknown assignee and an empty update as usage errors", () => {
    expect(() => buildPatch(parseArgs(["update", "STEP-1", "--assign", "alice"]).flags, read)).toThrow(/^usage:/)
    expect(() => buildPatch(parseArgs(["update", "STEP-1"]).flags, read)).toThrow(/^usage:/)
  })

  it("refuses an empty description file rather than blank the issue", () => {
    // /refine writes the brief to a file first. An empty file means that
    // write failed, and sending it would wipe the issue's description.
    const flags = parseArgs(["update", "STEP-1", "--description-file", "/tmp/brief.md"]).flags
    expect(() => buildPatch(flags, () => " \n")).toThrow(/^usage:[\s\S]*empty/)
  })

  it.each([
    [["--state", "--add-label", "awaiting-answer"]],
    [["--state", "", "--add-label", "awaiting-answer"]],
    [["--assign", "--state", "Ready"]],
    [["--add-label", " ", "--state", "Ready"]],
    [["--description-file", "", "--state", "Ready"]],
    [["--add-label", "--add-label", "awaiting-answer", "--state", "Ready"]],
  ])("refuses %j, a flag with no value, rather than write the rest", (args) => {
    // `--state "$STATE" --add-label awaiting-answer` with STATE empty would
    // add the label and skip the move: a park that silently did less.
    expect(() => buildPatch(parseArgs(["update", "STEP-1", ...args]).flags, read)).toThrow(/^usage:[\s\S]*needs a value/)
  })

  it("refuses a flag update does not know, rather than drop it", () => {
    const flags = parseArgs(["update", "STEP-1", "--add-labels", "awaiting-answer", "--state", "On hold"]).flags
    expect(() => buildPatch(flags, read)).toThrow(/^usage:[\s\S]*--add-labels/)
  })

  it.each([
    ["state", ["--state", "On hold", "--state", "Ready"]],
    ["assign", ["--assign", "me", "--assign", "none"]],
    ["description-file", ["--description-file", "/tmp/a.md", "--description-file", "/tmp/b.md"]],
  ])("refuses --%s given twice, rather than keep one of them", (name, args) => {
    const flags = parseArgs(["update", "STEP-1", ...args]).flags
    expect(() => buildPatch(flags, read)).toThrow(new RegExp(`^usage:[\\s\\S]*--${name} is given more than once`))
  })
})

describe("the claimant is this machine's mini", () => {
  let home: string

  const writeProfile = (body: string) => writeFileSync(join(home, ".claude", "dev-tasks-profile.json"), body)

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "trackerctl-home-"))
    mkdirSync(join(home, ".claude"))
  })

  afterEach(() => {
    rmSync(home, { recursive: true, force: true })
  })

  it("asks hooks/lib/profile.sh for the mini, and gets null wherever it reports none", () => {
    // The phase 0 rule: exactly one profile reader, the bash one the hooks
    // consult. trackerctl takes its answer as it is, spaces and all.
    const env = { ...process.env, HOME: home }
    expect(readProfileMini(env)).toBeNull()
    writeProfile('{ "profile": "human", "devSurface": "localhost", "mini": null }')
    expect(readProfileMini(env)).toBeNull()
    writeProfile('{ "profile": "agent", "devSurface": "preview", "mini": "" }')
    expect(readProfileMini(env)).toBeNull()
    writeProfile("{ this is not json")
    expect(readProfileMini(env)).toBeNull()
    writeProfile('{ "profile": "agent", "devSurface": "preview", "mini": "eve" }')
    expect(readProfileMini(env)).toBe("eve")
    writeProfile('{ "profile": "agent", "devSurface": "preview", "mini": "bob" }')
    expect(readProfileMini(env)).toBe("bob")
    writeProfile('{ "profile": "agent", "devSurface": "preview", "mini": " eve " }')
    expect(readProfileMini(env)).toBe(" eve ")
  })

  it("throws on anything but a clean answer, rather than read a broken reader as a laptop", () => {
    // Only a clean exit with no output means "no mini". A missing bash, a
    // moved profile.sh or a failing one is an error to report.
    writeProfile('{ "profile": "agent", "devSurface": "preview", "mini": "eve" }')
    const env = { ...process.env, HOME: home }
    expect(() => readProfileMini({ ...env, PATH: join(home, "no-such-dir") })).toThrow()
    expect(() => readProfileMini(env, join(home, "no-such-profile.sh"))).toThrow()
    const failing = join(home, "failing-profile.sh")
    writeFileSync(failing, "echo eve\nexit 64\n")
    expect(() => readProfileMini(env, failing)).toThrow()
  })

  it("claims as the profile's mini, whichever mini that is", () => {
    expect(claimantFor({}, "eve")).toBe("eve")
    expect(claimantFor({}, "bob")).toBe("bob")
  })

  it("refuses on a machine with no mini: only minis claim", () => {
    // Not a usage error: the command was right, the machine is not a mini.
    expect(() => claimantFor({}, null)).toThrow(/^only an agent mini claims/)
  })

  it("takes --as only when it names this machine's mini", () => {
    expect(claimantFor(parseArgs(["claim", "STEP-1", "--as", "eve"]).flags, "eve")).toBe("eve")
    expect(() => claimantFor(parseArgs(["claim", "STEP-1", "--as", "bob"]).flags, "eve")).toThrow(/^usage:[\s\S]*eve/)
  })

  it("refuses a mini name a claim comment could not carry", () => {
    // parseClaim reads the claimant up to the first space, so "eve mini"
    // would claim issues the heartbeat and the sweeper then never find.
    expect(() => claimantFor({}, "eve mini")).toThrow(/eve mini/)
    expect(() => claimantFor({}, " eve ")).toThrow(/" eve "/)
    expect(() => claimantFor({}, "Eve")).toThrow(/Eve/)
  })

  it.each([
    [["create", "--title", "key lin_api_abcdefghijkl"], "--title"],
    [["attach", "STEP-1", "--url", "https://x.example/?t=lin_api_abcdefghijkl", "--title", "PR"], "--url"],
    [["attach", "STEP-1", "--url", "https://x.example/", "--title", "xoxb-1234-abcdefghijkl"], "--title"],
    [["release", "STEP-1", "--reason", "SLACK_BOT_TOKEN=abcdefghijkl"], "--reason"],
  ])("refuses %j before it reaches the tracker: the text carries a key", (args, flag) => {
    const run = spawnSync(join(PLUGIN_ROOT, "node_modules", ".bin", "tsx"), [join(PLUGIN_ROOT, "scripts", "trackerctl.ts"), ...args], {
      cwd: home,
      // Should the refusal ever go, Linear is still out of reach: a dead loopback port.
      env: { PATH: process.env.PATH ?? "", HOME: home, DEV_TASKS_TRACKER: "linear", TRACKERCTL_MAX_WRITES: "0", LINEAR_API_KEY: "lin_api_notreal", DEV_TASKS_LINEAR_ENDPOINT: "http://127.0.0.1:9/graphql" },
      encoding: "utf8",
    })
    expect(run.stderr).toMatch(new RegExp(`^usage: ${flag} looks like it carries a key or a token`))
    expect(run.stderr).not.toContain("abcdefghijkl")
    expect(run.status).toBe(64)
  }, 30_000)

  it.each([[["claim", "STEP-1"]], [["heartbeat", "STEP-1"]], [["claims"]]])("%j on the command line stops on a laptop before it reaches the tracker", (args) => {
    // The whole CLI, as a skill runs it, with no profile and no Linear key
    // in reach: a run that got past the refusal would fail on the key instead.
    // `claims` too: on a person's key it would list that person's own issues
    // that carry an old agent claim comment, one `release` from unassigning them.
    const run = spawnSync(join(PLUGIN_ROOT, "node_modules", ".bin", "tsx"), [join(PLUGIN_ROOT, "scripts", "trackerctl.ts"), ...args], {
      cwd: home,
      env: { PATH: process.env.PATH ?? "", HOME: home, DEV_TASKS_TRACKER: "linear", TRACKERCTL_MAX_WRITES: "0" },
      encoding: "utf8",
    })
    expect(run.stderr).toMatch(/only an agent mini claims/)
    expect(run.status).toBe(1)
    expect(run.stdout).toBe("")
  }, 30_000)
})
