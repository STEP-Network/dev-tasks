/**
 * Where the browser test may go, as whom, and whether it runs at all (spec 5).
 * The allowlist is the site under test and staging (for the before pictures),
 * nothing else: chrome-devtools-mcp enforces it in the browser
 * (--allowedUrlPattern), and a PreToolUse hook says so to the model first
 * (session.ts). Pure.
 */
import type { AgentConfig } from "../config.ts"
import { matchesAny } from "./glob.ts"

export type Persona = AgentConfig["usertest"]["personas"][number]

export function allowedOrigins(target: string, stagingOrigin: string): string[] {
  return [...new Set([target, stagingOrigin])]
}

/** chrome-devtools-mcp's --allowedUrlPattern values (URLPattern syntax): each origin's pages, with and without a query, then the extra hosts pages load from. */
export function allowedUrlPatterns(origins: readonly string[], extra: readonly string[]): string[] {
  return [...origins.flatMap((o) => [`${o}/*`, `${o}/*?*`]), ...extra]
}

export function isAllowedNavigation(url: unknown, origins: readonly string[]): boolean {
  if (typeof url !== "string") return false
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return false
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password) return false
  return origins.includes(parsed.origin)
}

/** The first persona whose paths match a changed path. null: the test runs as a visitor who is not signed in. */
export function personaFor(paths: readonly string[], personas: readonly Persona[]): Persona | null {
  return personas.find((p) => p.paths.length > 0 && paths.some((path) => matchesAny(path, p.paths))) ?? null
}

/** Whether any changed path is one a user could see. A change of only docs, tests or agent config is not browser-tested. */
export function isBrowserVisible(paths: readonly string[], skipPaths: readonly string[]): boolean {
  return paths.some((path) => !matchesAny(path, skipPaths))
}
