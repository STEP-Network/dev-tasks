import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { afterEach, beforeEach, describe, expect, it } from "vitest"
import { assertLinearKeyFile, claudeTokenPath, linearKeyPath, loadClaudeOauthToken, loadSentryCronUrl, loadSlackSecrets, readSecretsFile, slackSecretsPath } from "../secrets.ts"

const BOT = "xoxb-1111-2222-abcdefghijkl"
const APP = "xapp-1-A1-3333-mnopqrstuv"

function write(path: string, text: string, mode: number) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, text)
  chmodSync(path, mode)
}

const home = () => mkdtempSync(join(tmpdir(), "agentd-secrets-"))

// A key exported in the shell that runs the tests would skip the file check.
const inherited = process.env.LINEAR_API_KEY

beforeEach(() => {
  delete process.env.LINEAR_API_KEY
})

afterEach(() => {
  if (inherited === undefined) delete process.env.LINEAR_API_KEY
  else process.env.LINEAR_API_KEY = inherited
})

describe("readSecretsFile", () => {
  it("refuses a file other users can read, and never quotes its contents", () => {
    const h = home()
    write(slackSecretsPath(h), `SLACK_BOT_TOKEN=${BOT}\n`, 0o644)
    let message = ""
    try {
      readSecretsFile(slackSecretsPath(h))
    } catch (error) {
      message = (error as Error).message
    }
    expect(message).toMatch(/chmod 600/)
    expect(message).not.toContain(BOT)
  })

  it("reads KEY=value lines, strips matching quotes, and ignores comments", () => {
    const h = home()
    write(slackSecretsPath(h), `# tokens\nSLACK_BOT_TOKEN="${BOT}"\nSLACK_APP_TOKEN=${APP}\n`, 0o600)
    expect(readSecretsFile(slackSecretsPath(h))).toEqual({ SLACK_BOT_TOKEN: BOT, SLACK_APP_TOKEN: APP })
  })

  it("names the missing file", () => {
    expect(() => readSecretsFile("/nowhere/slack.env")).toThrow(/\/nowhere\/slack\.env is missing/)
  })
})

describe("loadSlackSecrets", () => {
  it("returns both tokens", () => {
    const h = home()
    write(slackSecretsPath(h), `SLACK_BOT_TOKEN=${BOT}\nSLACK_APP_TOKEN=${APP}\n`, 0o600)
    expect(loadSlackSecrets(h)).toEqual({ botToken: BOT, appToken: APP })
  })

  it("refuses a token of the wrong kind without printing it", () => {
    const h = home()
    write(slackSecretsPath(h), `SLACK_BOT_TOKEN=${APP}\nSLACK_APP_TOKEN=${APP}\n`, 0o600)
    expect(() => loadSlackSecrets(h)).toThrow(/SLACK_BOT_TOKEN .* is not a xoxb- token/)
    try {
      loadSlackSecrets(h)
    } catch (error) {
      expect((error as Error).message).not.toContain(APP)
    }
  })
})

describe("the optional and the checked files", () => {
  it("reads no Sentry URL when agentd.env does not exist", () => {
    expect(loadSentryCronUrl(home())).toBeNull()
  })

  it("checks the Linear key file's mode, unless the key comes from the environment", () => {
    const h = home()
    write(linearKeyPath(h), "LINEAR_API_KEY=lin_api_test\n", 0o644)
    expect(() => assertLinearKeyFile(h)).toThrow(/chmod 600/)
    process.env.LINEAR_API_KEY = "lin_api_env"
    expect(() => assertLinearKeyFile(h)).not.toThrow()
  })

  it("reads the worker's optional Claude token, and refuses it from a readable file", () => {
    const h = home()
    expect(loadClaudeOauthToken(h)).toBeNull()
    write(claudeTokenPath(h), "CLAUDE_CODE_OAUTH_TOKEN=sk-ant-oat01-test\n", 0o600)
    expect(loadClaudeOauthToken(h)).toBe("sk-ant-oat01-test")
    chmodSync(claudeTokenPath(h), 0o644)
    expect(() => loadClaudeOauthToken(h)).toThrow(/chmod 600/)
  })
})
