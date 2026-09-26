/**
 * A person's answer on an issue, wherever they gave it (STEP-3293): in Slack,
 * where the front door read it and closed it with agentctl decide, or on the
 * Monday board (monday/route.ts). One function records both, so an answer
 * reads the same on the issue and moves it the same way, and a bare "yes" is
 * never recorded bare: it is recorded as the recommendation it agreed to.
 * Words that say the mini got something wrong become a lesson for the weekly
 * retro, from either place (noteCorrection).
 *
 * Wave 2 (spec 6): each answer's marker keeps when it was written and by
 * whom, so the first answer after the question counts. A second person's
 * different answer stays on the issue, marked not applied, and moves
 * nothing. The recorder alone writes the answer entries and the plan labels:
 * a person's agreement to "Build it as planned" approves a Try plan, and
 * every approval is announced in #polads-agents. One answer to an issue is
 * recorded at a time on a mini, so the Slack door and the Monday bridge never
 * both apply one.
 */

import { randomUUID } from "node:crypto"
import { closeSync, mkdirSync, openSync, readFileSync, rmSync, statSync, utimesSync, writeSync } from "node:fs"
import { join } from "node:path"

import type { AgentConfig, AgentPaths } from "./config.ts"
import { safeKey } from "./fsq.ts"
import type { Logger } from "./log.ts"
import { enqueueSlack } from "./outbox.ts"
import { recommendationOf } from "./plain.ts"
import { isCorrection, recordLessons } from "./retro/lessons.ts"
import { answerTransition, appendAnswer, truncateChars } from "./slack/text.ts"
import { threadFor, saveThread } from "./threads.ts"
import { answerEntries, PLAN_RECOMMENDATION, type Tracker, type TrackerIssue } from "./tracker.ts"

const AGREE = "(yes|yep|yeah|y|ok|okay|sure|fine|agreed|agree|go|go ahead|go for it|go with it|go with that|do it|sounds good|lgtm|👍|:\\+1:|:thumbsup:)"
const POLITE = "(please|thanks|thank you)"
/** Words that agree and say nothing else ("yes", "ok, go ahead", "yes please"): a decision needs what was decided. */
export const BARE = new RegExp(`^\\s*(${POLITE}[\\s,.!]+)*${AGREE}([\\s,.!]+(${AGREE}|${POLITE}))*[\\s.!]*$`, "i")

/**
 * Whether a question went out after a person wrote (STEP-3293 final pass):
 * their words never saw it, so a yes in them is not to it. Slack
 * (decide.ts) and the Monday board (monday/route.ts) use this one rule.
 */
export function askedSince(questionAt: string | null | undefined, writtenAt: string | null | undefined): boolean {
  return Boolean(questionAt && writtenAt && Date.parse(questionAt) > Date.parse(writtenAt))
}

/** What a person decided, when it is more than their own words. */
export type Decided = { agreed: true; recommendation: string } | { agreed: false; text: string }

export interface PersonAnswer {
  issue: string
  who: string
  /** Their words, as they wrote them (names for Slack's mention markup). */
  words: string
  /** Where the answer sits in the description: the Slack message ts, or the Monday update id. */
  ts: string
  permalink: string | null
  source: "slack" | "monday"
  /** Absent: their words stand on their own. */
  decided?: Decided
  /** When they wrote it (ISO), and their person key (personKey): so the first answer can count. */
  at?: string
  by?: string
}

/** An answer as the issue keeps it. `applied` is false for one kept beside the first, which counted. */
export interface RecordedAnswer {
  source: "slack" | "monday"
  id: string
  at: string | null
  by: string | null
  who: string
  text: string
  applied: boolean
}

/** Words that follow an answer the recorder kept but did not apply (spec 6: the first counts). */
export const NOT_APPLIED = "(Not applied:"

/** The answers on an issue, oldest entry first: the recorder's entries with words (not the asker's marker, not a bare one). */
export function recordedAnswers(description: string): RecordedAnswer[] {
  return answerEntries(description).flatMap((e) =>
    e.source !== "slack-user" && e.who !== null
      ? [{ source: e.source, id: e.id, at: e.at, by: e.by, who: e.who, text: e.text, applied: !e.text.includes(NOT_APPLIED) }]
      : [],
  )
}

/** One key for one person in both doors: their Monday id, found from their Slack id when config knows it. */
export function personKey(config: AgentConfig, who: { monday?: string; slack?: string }): string {
  const people = config.bridges.monday?.people ?? []
  const hit = who.monday ? people.find((p) => p.id === who.monday) : who.slack ? people.find((p) => p.slackId === who.slack) : undefined
  if (hit) return `monday:${hit.id}`
  return who.monday ? `monday:${who.monday}` : `slack:${who.slack ?? "unknown"}`
}

/** What an answer as the issue keeps it decided, in plain words: the recommendation agreed to, the decision, or the words themselves. */
export function answerSaid(text: string): string {
  const said = /agreed with the recommendation: (.+?)\. \(Their words:/.exec(text)?.[1] ?? /decided: (.+?)\. \(Their words:/.exec(text)?.[1] ?? text
  return said.replace(/ \(Not applied:[\s\S]*$/, "").trim()
}

const norm = (text: string) => text.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, " ").trim()
/** answerSaid without case or punctuation: two answers that decided the same thing. */
export const answerCore = (text: string): string => norm(answerSaid(text))

/** How far Slack's clock, Monday's and the mini's may differ: an answer this much before the question still answers it. */
const CLOCK_SKEW_MS = 60_000

/** Whether an answer written at `at` answers a question asked at `since`, give or take the clocks. */
export function answeredSince(at: string, since: string): boolean {
  return Date.parse(at) >= Date.parse(since) - CLOCK_SKEW_MS
}

/** The first applied answer after the question from someone else: the one that counts. */
function firstAnswer(description: string, since: string, by: string): RecordedAnswer | null {
  return (
    recordedAnswers(description)
      .filter((r) => r.applied && r.at && r.by && r.by !== by && answeredSince(r.at, since))
      .sort((a, b) => a.at!.localeCompare(b.at!))[0] ?? null
  )
}

/** What the second person is told, in either door: whose answer counts, and that theirs is kept. */
export function secondAnswerText(first: RecordedAnswer): string {
  const door = first.source === "slack" ? "in Slack" : "on Monday"
  // Their words may end with a stop of their own: one is enough.
  const said = truncateChars(answerSaid(first.text), 300).replace(/[.!?]+$/, "")
  return `${first.who} answered this first ${door}: ${said}. That answer counts, and I kept yours on the issue beside it. If you meant something else, reply with what should happen instead.`
}

/**
 * A Try plan's answer (spec 4). A person's agreement to "Build it as planned"
 * approves it. Any other answer sends it back to be planned again with their
 * words, and approves nothing: only this, never text on the issue, makes
 * /refine build a Try plan.
 */
export function planTransition(issue: Pick<TrackerIssue, "labels">, a: { decided?: Decided; words?: string }): { addLabels?: string[]; removeLabels?: string[] } {
  if (!issue.labels.includes("plan-to-approve")) return {}
  // A yes to it, or the person's own words saying it: never how the front door worded their decision.
  const said = a.decided?.agreed ? a.decided.recommendation : (a.words ?? "")
  const approved = answerCore(said) === answerCore(PLAN_RECOMMENDATION)
  // Anything else sends the plan back: an earlier plan's OK, on a plan asked about again, goes with the question (review).
  return approved
    ? { removeLabels: ["plan-to-approve"], addLabels: ["plan-approved"] }
    : { removeLabels: ["plan-to-approve", ...(issue.labels.includes("plan-approved") ? ["plan-approved"] : [])] }
}

/** The notice of a plan approval in #polads-agents: the detection layer for a session the people-doors guard did not stop. */
export const planApprovedText = (issue: string, who: string, door: string, where: string): string =>
  `${issue}'s plan was approved by ${who} ${door} (${where}). If ${who} did not do this, take plan-approved off in Linear.`

/** The answer as the issue keeps it: whose, what, and their own words beside it. */
export function answerText(a: Pick<PersonAnswer, "who" | "words" | "decided">): string {
  if (!a.decided) return a.words
  const said = `(Their words: "${a.words.replace(/\s+/g, " ").trim()}")`
  return a.decided.agreed ? `${a.who} agreed with the recommendation: ${a.decided.recommendation}. ${said}` : `${a.who} decided: ${a.decided.text}. ${said}`
}

/**
 * Their plain yes to a question that recommended something, as that
 * recommendation. null when the words say more than yes, when the question
 * recommended nothing, or on a person's to-do, where a yes means they will
 * do it.
 */
export function agreedTo(words: string, question: string | null | undefined, issue: Pick<TrackerIssue, "labels">): Decided | null {
  if (!BARE.test(words) || issue.labels.includes("human-todo")) return null
  const recommendation = recommendationOf(question)
  return recommendation ? { agreed: true, recommendation } : null
}

export interface Recorded {
  movedTo: string | null
  recorded: string
  /** recorded: applied as the answer. same: the first answer said the same, nothing written. second: kept, not applied. */
  outcome: "recorded" | "same" | "second"
  /** The answer that counts, for same and second. */
  first?: RecordedAnswer
}

/**
 * The answer lock's timings. waitMs: how long a second answer waits for the
 * first. staleMs: a lock not touched for this long is a holder that died.
 * beatMs: how often a live holder touches its lock, however long Linear
 * takes. Tests shorten them.
 */
export const ANSWER_LOCK = { waitMs: 30_000, staleMs: 120_000, beatMs: 20_000 }

/**
 * Runs `fn` holding the issue's answer lock (state/answer-locks), created
 * with O_EXCL: the Slack door (agentctl decide) and the Monday bridge each
 * read the issue and then write it, so without it both could apply an answer.
 * Throws when another holder keeps it past waitMs: the bridge tries again
 * next poll, and the front door says so. The lock holds this holder's own
 * token: it touches the lock while it works, and removes only its own.
 */
async function oneAnswerAtATime<T>(paths: AgentPaths, issue: string, fn: () => Promise<T>): Promise<T> {
  const dir = join(paths.state, "answer-locks")
  mkdirSync(dir, { recursive: true })
  const lock = join(dir, `${safeKey(issue)}.lock`)
  const token = `${process.pid}:${randomUUID()}`
  const deadline = Date.now() + ANSWER_LOCK.waitMs
  for (;;) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, token)
      closeSync(fd)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > ANSWER_LOCK.staleMs) rmSync(lock, { force: true })
      } catch {
        // Released between the open and the stat.
      }
      if (Date.now() > deadline) throw new Error(`another answer to ${issue} is being recorded on this mini: try again in a minute`)
      await new Promise((resolve) => setTimeout(resolve, 100))
    }
  }
  const beat = setInterval(() => {
    try {
      const now = new Date()
      utimesSync(lock, now, now)
    } catch {
      // Gone: nothing to keep fresh.
    }
  }, ANSWER_LOCK.beatMs)
  beat.unref()
  try {
    return await fn()
  } finally {
    clearInterval(beat)
    try {
      // Only its own: a lock taken over from it is the new holder's.
      if (readFileSync(lock, "utf8") === token) rmSync(lock, { force: true })
    } catch {
      // Gone already.
    }
  }
}

/**
 * Records the answer on the issue, under "## Answers from Slack" or "from
 * Monday", and moves a parked issue on as an answer always did (unless
 * `move` is false: an instruction leaves the issue for agentd). The issue's
 * Slack thread then has no question left open. Returns where the issue went.
 *
 * With `since` (when the question went out), the first answer after it from
 * someone else counts: the same answer is not written again, and a different
 * one is kept on the issue, marked not applied, and moves nothing. The issue
 * is read under the answer lock, so an answer recorded a moment ago is seen.
 */
export function recordAnswer(deps: { paths: AgentPaths; tracker: Tracker }, a: PersonAnswer, opts: { move?: boolean; since?: string | null } = {}): Promise<Recorded> {
  return oneAnswerAtATime(deps.paths, a.issue, () => recordLocked(deps, a, opts))
}

async function recordLocked(deps: { paths: AgentPaths; tracker: Tracker }, a: PersonAnswer, opts: { move?: boolean; since?: string | null }): Promise<Recorded> {
  const current = await deps.tracker.readIssue(a.issue)
  if (a.decided?.agreed && current.labels.includes("human-todo")) {
    throw new Error(`${a.issue} waits on a person to do something (human-todo), so a yes is not a decision: once they say it is done, record that with --text-file, and otherwise ack it`)
  }
  const first = opts.since && a.by ? firstAnswer(current.description, opts.since, a.by) : null
  if (first) {
    const mine = answerCore(a.decided ? (a.decided.agreed ? a.decided.recommendation : a.decided.text) : a.words)
    if (answerCore(first.text) === mine) return { movedTo: null, recorded: answerText(a), outcome: "same", first }
    // The first answer counts (spec 6). Theirs stays on the issue, marked, and moves nothing.
    const kept = `${answerText(a)} ${NOT_APPLIED} ${first.who} answered first.)`
    const description = appendAnswer(current.description, { ts: a.ts, userName: a.who, text: kept, permalink: a.permalink, at: a.at, by: a.by }, a.source)
    if (description !== current.description) await deps.tracker.updateIssue(a.issue, { description })
    return { movedTo: null, recorded: kept, outcome: "second", first }
  }
  const recorded = answerText(a)
  const description = appendAnswer(current.description, { ts: a.ts, userName: a.who, text: recorded, permalink: a.permalink, at: a.at, by: a.by }, a.source)
  // An instruction moves no label: agentd acts on it.
  const move = opts.move === false ? {} : answerTransition(current)
  const plan = opts.move === false ? {} : planTransition(current, a)
  const removeLabels = [...(move.removeLabels ?? []), ...(plan.removeLabels ?? [])]
  const patch = {
    ...(description !== current.description ? { description } : {}),
    ...(move.state ? { state: move.state } : {}),
    ...(removeLabels.length ? { removeLabels } : {}),
    ...(plan.addLabels ? { addLabels: plan.addLabels } : {}),
  }
  if (Object.keys(patch).length) await deps.tracker.updateIssue(a.issue, patch)
  if (plan.addLabels?.includes("plan-approved")) {
    const door = a.source === "monday" ? "on Monday" : "in Slack"
    enqueueSlack(deps.paths, { kind: "post", channel: "agents", text: planApprovedText(a.issue, a.who, door, a.permalink ?? current.url) })
  }
  const thread = threadFor(deps.paths, a.issue)
  if (thread?.openQuestions) saveThread(deps.paths, { ...thread, openQuestions: 0 })
  return { movedTo: move.state ?? null, recorded, outcome: "recorded" }
}

/**
 * A person's words that say the mini got something wrong ("no, do X"): a
 * lesson for the weekly retro (STEP-3290), from Slack or the Monday board,
 * whatever the words go on to be (an answer, an instruction, a question
 * back). Once per message: `key` names it. Its words are data. A lesson that
 * cannot be written never stops the words' own handling.
 */
export function noteCorrection(
  deps: { paths: AgentPaths; mini: string; now: () => Date; log?: Pick<Logger, "warn"> },
  said: { issue: string | null; source: "slack" | "monday"; key: string; who: string; text: string },
): void {
  if (!isCorrection(said.text)) return
  try {
    recordLessons(deps.paths, [{ mini: deps.mini, issue: said.issue, pr: null, category: "correction", source: said.source, who: said.who, text: said.text, key: said.key }], deps.now())
  } catch (error) {
    deps.log?.warn("lesson not recorded", { issue: said.issue, error: String(error) })
  }
}

/** A test-day phrase (Wave 3, spec 7: "The phrase is a fixed verb for the answer recorder"). */
export type TestDayVerb =
  | { verb: "start" }
  | { verb: "verdict"; n: number; verdict: "pass" | "fail"; note: string }
  | { verb: "decide"; answer: "fix" | "next-week" }

const SLACK_MENTIONS = /<@[A-Z0-9]+(\|[^>]*)?>/g
const START = /^(please[\s,]+)?(begin|start)\s+test\s?day[\s.!]*$/i
const VERDICT = /^#?(\d{1,3})\s*[:.)-]?\s*(pass|fail)\b[\s:,.-]*([\s\S]*)$/i
const FIX = /^(fix (it )?before (the )?release|fix now)[\s.!]*$/i
const NEXT_WEEK = /^(next week|hold (it )?back( to next week)?)[\s.!]*$/i

/**
 * The whole message must be the phrase: "begin testday" starts test day,
 * "when do we begin testday?" does not. Mentions and a "please" are allowed
 * around the start phrase; a verdict carries what the person saw after it.
 */
export function testDayVerb(text: string): TestDayVerb | null {
  const plain = text.replace(SLACK_MENTIONS, " ").trim()
  if (START.test(plain)) return { verb: "start" }
  const v = VERDICT.exec(plain)
  if (v) return { verb: "verdict", n: Number(v[1]), verdict: v[2].toLowerCase() as "pass" | "fail", note: v[3].replace(/\s+/g, " ").trim() }
  if (FIX.test(plain)) return { verb: "decide", answer: "fix" }
  if (NEXT_WEEK.test(plain)) return { verb: "decide", answer: "next-week" }
  return null
}
