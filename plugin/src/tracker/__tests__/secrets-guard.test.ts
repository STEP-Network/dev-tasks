/**
 * On an agent mini trackerctl and agentctl run outside the front door's
 * sandbox and can read the Linear key, so they themselves keep secrets out of
 * what they send.
 */

import { linkSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assertNoSecretText, readTextFile } from "../secrets-guard.ts"

let dir = ""
let home = ""
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "secrets-guard-"))
  home = join(dir, "home")
  mkdirSync(join(home, ".config", "linear"), { recursive: true })
  writeFileSync(join(home, ".config", "linear", ".env"), "LINEAR_API_KEY=lin_api_testtesttest\n")
  writeFileSync(join(dir, "brief.md"), "## Goal\nA brief.\n")
})
afterEach(() => rmSync(dir, { recursive: true, force: true }))

describe("readTextFile", () => {
  it("reads a brief", () => {
    expect(readTextFile(join(dir, "brief.md"), "--description-file", home)).toBe("## Goal\nA brief.\n")
  })

  it("refuses anything under ~/.config, however it is spelt", () => {
    symlinkSync(join(home, ".config", "linear", ".env"), join(dir, "innocent.md"))
    for (const path of [join(home, ".config", "linear", ".env"), join(home, "x", "..", ".config", "linear", ".env"), join(dir, "innocent.md")]) {
      expect(() => readTextFile(path, "--description-file", home), path).toThrow(/^usage: --description-file .* looks like a secrets file/)
    }
  })

  it("refuses the other places credentials live under the home directory", () => {
    for (const rel of [".ssh/id_ed25519", ".npmrc", ".netrc", ".git-credentials", ".vercel/auth.json", "Library/Application Support/com.vercel.cli/auth.json", ".config/gh/hosts.yml"]) {
      const file = join(home, rel)
      mkdirSync(join(file, ".."), { recursive: true })
      writeFileSync(file, "harmless-looking\n")
      expect(() => readTextFile(file, "--text-file", home), rel).toThrow(/looks like a secrets file/)
    }
  })

  it("refuses a file named .env anything, anywhere", () => {
    writeFileSync(join(dir, ".env.local"), "X=1\n")
    expect(() => readTextFile(join(dir, ".env.local"), "--text-file", home)).toThrow(/secrets file/)
  })

  it("refuses a key that reached a harmless name, as a hard link or a copy", () => {
    linkSync(join(home, ".config", "linear", ".env"), join(dir, "linked.md"))
    writeFileSync(join(dir, "copied.md"), "notes\nLINEAR_API_KEY=lin_api_testtesttest\n")
    for (const name of ["linked.md", "copied.md"]) {
      expect(() => readTextFile(join(dir, name), "--description-file", home), name).toThrow(/carries a key or a token/)
    }
  })
})

describe("assertNoSecretText", () => {
  it("refuses key and token shapes and the secrets files' lines, and says nothing of the text", () => {
    for (const text of [
      "lin_api_abcdefghijkl",
      "xoxb-1234-5678-abcdef",
      "xapp-1-A0-123-abcdef",
      "sk-ant-oat01-abcdefghij",
      "ghp_abcdefghijklmnopqrstuvwxyz0123",
      "SLACK_BOT_TOKEN=anything",
      "SENTRY_CRON_URL = https://example",
      "npm_abcdefghijklmnopqrstuvwxyz0123456789",
      "//registry.npmjs.org/:_authToken=abc",
      "-----BEGIN OPENSSH PRIVATE KEY-----",
      '{"token": "AbCdEfGhIjKlMnOpQrStUvWx"}',
      "machine github.com login eve password hunter2hunter2",
    ]) {
      let message = ""
      try {
        assertNoSecretText(`before ${text} after`, "--text")
      } catch (error) {
        message = (error as Error).message
      }
      expect(message, text).toMatch(/^usage: --text looks like it carries a key or a token/)
      expect(message).not.toContain(text)
    }
  })

  it("lets ordinary text through, words that mention keys included", () => {
    for (const text of ["Add the Linear key to the runbook", "LINEAR_API_KEY lives in ~/.config/linear/.env", "see xapp tokens in Slack"]) {
      expect(() => assertNoSecretText(text, "--text"), text).not.toThrow()
    }
  })
})
