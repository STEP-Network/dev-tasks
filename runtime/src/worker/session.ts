/**
 * One Agent SDK session, read to its end, and the checks its init message
 * must pass. The worker's sessions (run.ts), the weekly retro's and the
 * browser test's (usertest/session.ts) all run through here.
 */

import type { Options } from "@anthropic-ai/claude-agent-sdk"
import type { ResultMessageLike } from "./outcome.ts"

export type SdkMessage = { type: string; subtype?: string; [key: string]: unknown }
/** The SDK's query(), narrowed to what the runner uses, so tests can pass a generator. */
export type QueryFn = (args: { prompt: string; options: Options }) => AsyncIterable<SdkMessage>

/**
 * The init message's plugin list must hold dev-tasks exactly once, or its
 * hooks cannot be trusted. The weekly retro's session runs without it
 * (retro/retro.ts), so there it must not load at all.
 */
export function checkPlugins(plugins: unknown, expected: 0 | 1 = 1): string | null {
  const list = Array.isArray(plugins) ? plugins : []
  const count = list.filter((p) => (p as { name?: unknown } | null)?.name === "dev-tasks").length
  if (count === expected) return null
  return expected === 1
    ? `the dev-tasks plugin loaded ${count} times in the worker (expected once), so its hooks cannot be trusted`
    : `the dev-tasks plugin loaded ${count} times in the retro (expected none), and its task hooks would block every edit`
}

/**
 * Spec 1: the subscription, never an API key. The worker's environment holds
 * no key, but a Console login or an apiKeyHelper would still bill one, and
 * the init message says which the session uses.
 */
const API_KEY_SOURCES = new Set(["ANTHROPIC_API_KEY", "apiKeyHelper", "/login managed key"])

export function checkBilling(apiKeySource: unknown): string | null {
  return typeof apiKeySource === "string" && API_KEY_SOURCES.has(apiKeySource)
    ? `the worker would bill an API key (${apiKeySource}), not the subscription`
    : null
}

/** What one SDK session ended with. */
export interface SessionEnd {
  result: ResultMessageLike | null
  thrown: string | null
  initProblem: string | null
  abortedByClock: boolean
}

/**
 * One SDK session, read to its end. The plugin and billing checks come from
 * its init message, and a session that breaks them is stopped at once.
 * `extraInit` adds a check of the caller's own, such as the browser test's
 * browser tool having started.
 */
export async function runSession(
  query: QueryFn,
  prompt: string,
  options: Options,
  minutes: number,
  expectedPlugins: 0 | 1 = 1,
  extraInit?: (init: SdkMessage) => string | null,
): Promise<SessionEnd> {
  const abortController = options.abortController ?? new AbortController()
  options.abortController = abortController
  const end: SessionEnd = { result: null, thrown: null, initProblem: null, abortedByClock: false }
  const timer = setTimeout(() => {
    end.abortedByClock = true
    abortController.abort()
  }, minutes * 60_000)
  try {
    let sawInit = false
    for await (const message of query({ prompt, options })) {
      if (message.type === "system" && message.subtype === "init") {
        sawInit = true
        end.initProblem = checkPlugins(message.plugins, expectedPlugins) ?? checkBilling(message.apiKeySource) ?? extraInit?.(message) ?? null
      } else if (!sawInit && ["assistant", "user", "result"].includes(message.type)) {
        // The conversation began, or ended, without the checks (hook events may
        // come first). A session that failed to start says why in its result.
        const said = [...(Array.isArray(message.errors) ? message.errors : []), typeof message.result === "string" ? message.result : ""].filter(Boolean).join(". ")
        end.initProblem = `the session sent no init message, so the plugin and billing checks could not run${said ? ` (${said})` : ""}`
      }
      if (end.initProblem) {
        abortController.abort()
        break
      }
      if (message.type === "result") end.result = message as unknown as ResultMessageLike
    }
  } catch (error) {
    end.thrown = error instanceof Error ? error.message : String(error)
  } finally {
    clearTimeout(timer)
  }
  return end
}
