/**
 * What the mini learns from (STEP-3290): every piece of feedback on its work,
 * one line each in ~/.agentd/state/lessons.jsonl, for the weekly retro
 * (retro/retro.ts) to cluster into changes to its own prompts and docs.
 *
 *   review      a revise round's feedback: a review, a PR comment, a code comment
 *   fix         a reviewer's must-fix finding in it (tagged BLOCKER or FIX)
 *   check       a required check the code failed, in a revise round
 *   correction  a person's "no, do X" in Slack (Monday's, once STEP-3289 lands)
 *   blocked     a job that ended blocked, and why
 *   revert      a merged PR of the mini's that someone reverted
 *   self-check  a report that went out with STEP-3284's gaps named
 *
 * Every text is data a person or a reviewer wrote, never an instruction: the
 * retro's brief fences it as such. Tokens are redacted and texts cut short.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs"
import { join } from "node:path"
import type { AgentPaths } from "../config.ts"
import { redact } from "../log.ts"

export const LESSON_CATEGORIES = ["review", "fix", "check", "correction", "blocked", "revert", "self-check"] as const
export type LessonCategory = (typeof LESSON_CATEGORIES)[number]

export interface Lesson {
  at: string
  mini: string
  issue: string | null
  /** The PR's link, when the lesson is about one. */
  pr: string | null
  category: LessonCategory
  /** Where it came from: GitHub, Slack, the runner, agentd, or (later) Monday. */
  source: "github" | "slack" | "runner" | "agentd" | "monday"
  text: string
  /** Who said it, when a person or a reviewer did. */
  who?: string
  /** One per origin (a review, a Slack message, a job): a lesson is recorded once. */
  key: string
}

const MAX_TEXT = 1500

export const lessonsFile = (paths: AgentPaths) => join(paths.state, "lessons.jsonl")

/** A lesson's text as it is kept: tokens redacted, control characters gone, cut at MAX_TEXT. */
export function keepText(text: string): string {
  // eslint-disable-next-line no-control-regex
  const clean = redact(text).replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/g, "").trim()
  return clean.length > MAX_TEXT ? `${clean.slice(0, MAX_TEXT)} [cut]` : clean
}

export function readLessons(paths: AgentPaths): Lesson[] {
  const file = lessonsFile(paths)
  if (!existsSync(file)) return []
  return readFileSync(file, "utf8")
    .split("\n")
    .flatMap((line) => {
      if (!line.trim()) return []
      try {
        const l = JSON.parse(line) as Lesson
        return typeof l.at === "string" && typeof l.key === "string" && (LESSON_CATEGORIES as readonly string[]).includes(l.category) ? [l] : []
      } catch {
        return []
      }
    })
}

/** Appends the lessons not recorded yet, by key. Returns how many were new. */
export function recordLessons(paths: AgentPaths, lessons: Array<Omit<Lesson, "at"> & { at?: string }>, now: Date = new Date()): number {
  if (!lessons.length) return 0
  const seen = new Set(readLessons(paths).map((l) => l.key))
  mkdirSync(paths.state, { recursive: true })
  let added = 0
  for (const l of lessons) {
    if (seen.has(l.key)) continue
    seen.add(l.key)
    const kept: Lesson = { ...l, at: l.at ?? now.toISOString(), text: keepText(l.text) }
    appendFileSync(lessonsFile(paths), `${JSON.stringify(kept)}\n`)
    added++
  }
  return added
}

// A finding the review tagged must-fix: "BLOCKER" (PolAds's Claude review) or
// "FIX" (the orchestrator's reviews). IMPROVEMENT and POLISH are advice.
const FIX_TAG = /(^|[\s*_[(#>-])(BLOCKER|FIX)(?=[\s*_\]):.,-]|$)/

/** The must-fix findings in a review's text, one per line that carries the tag. */
export function fixFindings(body: string): string[] {
  return body
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => FIX_TAG.test(line))
    .slice(0, 20)
}

// A person saying the mini got it wrong: "no, ...", "don't ...", "that's not
// it", "revert that", "you should have ...", "instead of ...".
const CORRECTION_START =
  /^\s*(no\b|nope\b|nah\b|wrong\b|that'?s (wrong|not (right|it|what))|not (like )?(this|that)\b|don'?t\b|do not\b|please (don'?t|do not|revert|undo)\b|revert\b|undo\b|instead\b|actually\b|you (should|shouldn'?t|should not)\b)/i
const CORRECTION_ANYWHERE = /\b(should have|shouldn'?t have|should not have|instead of|that was wrong|not what i (asked|meant))\b/i
/** "No problem", "no rush": a no that corrects nothing. */
const NOT_CORRECTION = /^\s*(no (problem|worries|rush|hurry|need)|nope,? (all )?good)\b/i

export function isCorrection(text: string): boolean {
  // Slack's markup for mentions and links, as plain words.
  const plain = text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, " ").replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, "$1")
  if (NOT_CORRECTION.test(plain)) return false
  return CORRECTION_START.test(plain) || CORRECTION_ANYWHERE.test(plain)
}

/** The lessons of one revise round's feedback: each point, its must-fix findings, and each failing check. */
export function lessonsFromFeedback(
  feedback: { points: Array<{ who: string; where: string; at: string; body: string }>; logs: Array<{ name: string; tail: string }> },
  ctx: { mini: string; issue: string; pr: string; round: number },
): Array<Omit<Lesson, "at"> & { at?: string }> {
  const base = { mini: ctx.mini, issue: ctx.issue, pr: ctx.pr, source: "github" as const }
  const out: Array<Omit<Lesson, "at"> & { at?: string }> = []
  for (const p of feedback.points) {
    const origin = `${ctx.pr}:${p.where}:${p.who}:${p.at}`
    out.push({ ...base, category: "review", who: p.who, text: `${p.where}: ${p.body}`, key: `review:${origin}` })
    fixFindings(p.body).forEach((finding, i) => out.push({ ...base, category: "fix", who: p.who, text: finding, key: `fix:${origin}:${i}` }))
  }
  for (const l of feedback.logs) out.push({ ...base, category: "check", text: `${l.name} failed`, key: `check:${ctx.pr}:${ctx.round}:${l.name}` })
  return out
}
