import { mkdtempSync, readFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it } from "vitest"
import { agentPaths } from "../config.ts"
import { appendLedger, createLogger, redact } from "../log.ts"

describe("redact", () => {
  it("hides Slack, Linear and Claude tokens wherever they appear", () => {
    expect(redact("bot xoxb-1-2-abc and app xapp-1-A-2-def and lin_api_Zz09 and sk-ant-oat01-x_y")).toBe("bot [redacted] and app [redacted] and [redacted] and [redacted]")
  })

  it("hides GitHub tokens too, bare or inside a remote URL", () => {
    // Built at run time, so no secret scanner mistakes the fixtures for real tokens.
    const classic = ["ghp", "a1B2".repeat(9)].join("_")
    const fine = ["github", "pat", "11AAAAAAA0", "x9Y8".repeat(14)].join("_")
    expect(redact(`push to https://x-access-token:${classic}@github.com/STEP-Network/x.git failed`)).toBe("push to https://x-access-token:[redacted]@github.com/STEP-Network/x.git failed")
    expect(redact(`token ${fine}`)).toBe("token [redacted]")
  })
})

describe("createLogger and appendLedger", () => {
  it("write JSON lines, redacted, with the process name and a timestamp", () => {
    const paths = agentPaths(mkdtempSync(join(tmpdir(), "agentd-log-")))
    const now = () => new Date("2026-09-24T08:00:00.000Z")
    createLogger(paths, "agentd", now).warn("bridge said", { reply: "token xoxb-9-9-leak" })
    appendLedger(paths, { type: "claimed", issue: "STEP-7" }, now())
    const line = JSON.parse(readFileSync(join(paths.logs, "agentd.log"), "utf8").trim())
    expect(line).toEqual({ at: "2026-09-24T08:00:00.000Z", level: "warn", proc: "agentd", msg: "bridge said", reply: "token [redacted]" })
    const ledger = JSON.parse(readFileSync(join(paths.logs, "ledger.jsonl"), "utf8").trim())
    expect(ledger).toEqual({ at: "2026-09-24T08:00:00.000Z", type: "claimed", issue: "STEP-7" })
  })
})
