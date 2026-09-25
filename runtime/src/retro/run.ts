/**
 * The weekly retro's process, which agentd starts on the coordinator mini
 * (agentd/main.ts, retro.enabled): `retro/run.ts <slot>`. Its work is in
 * retro/retro.ts. It records how it ended in state/retro.json, for agentd.
 */

import { agentPaths, assertProfileMini, loadConfig, readProfileMini } from "../config.ts"
import { createLogger } from "../log.ts"
import { enqueueSlack } from "../outbox.ts"
import { loadClaudeOauthToken } from "../secrets.ts"
import { realExec } from "../worker/git.ts"
import type { QueryFn } from "../worker/run.ts"
import { fyiChannel } from "./fyi.ts"
import { readRetroState, runRetro, writeRetroState } from "./retro.ts"

if (process.argv[1]?.endsWith("retro/run.ts")) {
  const slot = process.argv[2] ?? ""
  const paths = agentPaths()
  const log = createLogger(paths, "retro")
  const main = async () => {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(slot)) throw new Error(`usage: retro/run.ts <slot, YYYY-MM-DD>, not ${slot || "nothing"}`)
    const config = loadConfig(paths)
    assertProfileMini(config, readProfileMini(), paths.config)
    const { query } = await import("@anthropic-ai/claude-agent-sdk")
    return runRetro(
      { paths, config, exec: realExec, query: query as unknown as QueryFn, now: () => new Date(), log, fyi: fyiChannel(), claudeToken: loadClaudeOauthToken(paths.home) },
      { slot, dryRun: false },
    )
  }
  main()
    .then((result) => {
      log.info("retro finished", { slot, status: result.status, pr: result.pr, problems: result.problems })
      const state = readRetroState(paths)
      writeRetroState(paths, { slot, startedAt: state?.startedAt ?? new Date().toISOString(), endedAt: new Date().toISOString(), status: result.status === "dry-run" ? "nothing" : result.status, pr: result.pr })
      process.exit(0)
    })
    .catch((error) => {
      log.error("retro crashed", { slot, error: String(error) })
      enqueueSlack(paths, { kind: "post", channel: "agents", text: "My weekly review stopped unexpectedly, so I opened no PR. A person should look at the mini." })
      const state = readRetroState(paths)
      writeRetroState(paths, { slot, startedAt: state?.startedAt ?? new Date().toISOString(), endedAt: new Date().toISOString(), status: "blocked", pr: null })
      process.exit(1)
    })
}
