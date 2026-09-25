/**
 * A person's reply, once the front door has read it (STEP-3293). The bridge
 * no longer decides what a reply means: it files it, and the front door
 * says which it is, through agentctl:
 *
 *   decide    a decision on the question the issue waits on, recorded on the
 *             issue as text that stands on its own ("Nate agreed with the
 *             recommendation: use the publication date", never a bare "yes"),
 *             and the issue moves on as an answer always did
 *   instruct  one of the fixed actions (revise, rerun, merge, retry, pause,
 *             leave), filed for agentd (agentd/instructions.ts), which acts and
 *             replies in words
 *
 * Who said it, and their words, come from the bridge's own inbox entry: the
 * front door names the entry, never the person. A question back, or a reply
 * the front door is unsure of, gets an answer in the thread and is acked.
 */

import { openDecisions } from "./agentd/decisions.ts"
import type { AgentPaths } from "./config.ts"
import { ack, entryPath, putOnce, readJson } from "./fsq.ts"
import { appendLedger } from "./log.ts"
import { enqueueSlack } from "./outbox.ts"
import { NOTHING_NEEDED, recommendationOf } from "./plain.ts"
import { parseInstruction, type Action, type InstructionEntry } from "./slack/instruction.ts"
import { answerTransition, appendAnswer } from "./slack/text.ts"
import { threadFor } from "./threads.ts"
import type { Tracker } from "./tracker.ts"

/** A person's message as the bridge filed it for the front door. */
export interface PersonEntry {
  type: string
  key: string
  issue?: string | null
  channel: string
  ts: string
  threadTs?: string
  user: string
  userName?: string
  text: string
  /** The text with Slack's mention markup as names, which the bridge resolved. */
  readableText?: string
  permalink?: string | null
  receivedAt: string
}

const PERSON_TYPES = new Set(["reply", "answer", "mention"])

/** The waiting message `key` names, or why there is none. */
export function personEntry(paths: AgentPaths, key: string): PersonEntry {
  const entry = readJson<PersonEntry>(entryPath(paths.inbox, key))
  if (!entry) throw new Error(`no message ${key} is waiting: it was handled already, or never came`)
  if (!PERSON_TYPES.has(entry.type)) throw new Error(`${key} is not a person's reply or mention`)
  return entry
}

/** Words that agree and say nothing else: a decision needs what was decided. */
const BARE = /^\s*(yes|yep|yeah|y|ok|okay|sure|fine|agreed|agree|go|go ahead|do it|sounds good|lgtm|👍)[\s.!]*$/i

/**
 * The decision as the issue keeps it: whose it is, what it is, and their own
 * words beside it. `agree` takes the recommendation of the last question
 * this mini asked in the thread.
 */
export function decisionText(paths: AgentPaths, entry: PersonEntry, how: { agree: true } | { text: string }): string {
  const who = entry.userName || entry.user
  const words = (entry.readableText ?? entry.text).replace(/\s+/g, " ").trim()
  let decided: string
  if ("agree" in how) {
    const rec = recommendationOf(entry.issue ? threadFor(paths, entry.issue)?.lastQuestion : null)
    if (!rec) throw new Error(`there is no recommendation in ${entry.issue ?? "this"} thread to agree with: record what they decided with --text-file`)
    decided = `${who} agreed with the recommendation: ${rec}`
  } else {
    const text = how.text.trim()
    if (!text || BARE.test(text)) throw new Error("a decision must say what was decided, not only yes: write it out, or use --agree for the recommendation")
    decided = `${who} decided: ${text.replace(/[\s.]+$/, "")}`
  }
  return `${decided}. (Their words: "${words}")`
}

export interface DecideDeps {
  paths: AgentPaths
  tracker: Tracker
  now: () => Date
}

/** Records the decision on the issue, moves the issue on as an answer always did, says so in the thread, and acks the message. */
export async function recordDecision(deps: DecideDeps, entry: PersonEntry, decision: string): Promise<{ issue: string; movedTo: string | null }> {
  if (!entry.issue) throw new Error(`${entry.key} is not in an issue's thread, so there is no issue to record a decision on`)
  const current = await deps.tracker.readIssue(entry.issue)
  const description = appendAnswer(current.description, { ts: entry.ts, userName: entry.userName || entry.user, text: decision, permalink: entry.permalink ?? null })
  const move = answerTransition(current)
  await deps.tracker.updateIssue(entry.issue, { ...(description !== current.description ? { description } : {}), ...move })
  ack(deps.paths.inbox, entry.key)
  const now = deps.now()
  const moved = move.state ? ` It goes back to ${move.state}.` : ""
  const threadTs = entry.threadTs ?? entry.ts
  // Words first, and a ✅ beside them: never a bare ✅ (STEP-3285).
  enqueueSlack(deps.paths, { kind: "reply", channelId: entry.channel, threadTs, text: `Thanks. I added your decision to ${entry.issue}: ${decision.split(". (Their words")[0]}.${moved} ${NOTHING_NEEDED}` }, now)
  enqueueSlack(deps.paths, { kind: "react", channelId: entry.channel, ts: entry.ts, name: "white_check_mark" }, now)
  appendLedger(deps.paths, { type: "answer.applied", issue: entry.issue, movedTo: move.state ?? null, decided: true }, now)
  return { issue: entry.issue, movedTo: move.state ?? null }
}

export const ACTIONS: readonly Action[] = ["revise", "rerun", "merge", "retry", "pause", "leave"]

/**
 * A "yes" to one of agentd's decisions (agentd/decisions.ts): the actions its
 * default reply stands for, which is what the question recommended.
 */
export function defaultActions(paths: AgentPaths, entry: PersonEntry): Action[] {
  const decision = entry.issue ? openDecisions(paths, entry.issue)[0] : undefined
  if (!decision) throw new Error(`${entry.issue ?? "this thread"} waits on no decision of agentd's, so there is no default to take`)
  const actions = parseInstruction(decision.defaultReply).actions
  if (!actions.length) throw new Error(`the default "${decision.defaultReply}" names no action`)
  return actions
}

/**
 * One of the fixed actions a person asked for, as the front door read it,
 * filed for agentd with the person and words the bridge recorded. The
 * message itself is acked: agentd replies in its thread.
 */
export function fileInstructionFor(paths: AgentPaths, entry: PersonEntry, actions: Action[], target: InstructionEntry["target"], now: Date): InstructionEntry {
  if (!actions.length) throw new Error("name at least one action")
  for (const a of actions) if (!ACTIONS.includes(a)) throw new Error(`${a} is not an action agentd takes (${ACTIONS.join(", ")})`)
  const issue = entry.issue ?? null
  if (!issue && !target.issue && !target.pr && !target.url) throw new Error("a mention names no issue or PR: pass --target STEP-<n> or --target #<number>")
  const key = `instr:${entry.channel}:${entry.ts}`
  const filed: InstructionEntry = {
    type: "instruction",
    key,
    issue,
    channel: entry.channel,
    ts: entry.ts,
    threadTs: entry.threadTs ?? entry.ts,
    user: entry.user,
    userName: entry.userName || entry.user,
    text: entry.text,
    actions: [...new Set(actions)],
    target,
    receivedAt: now.toISOString(),
  }
  if (putOnce(paths.inbox, key, filed)) appendLedger(paths, { type: "instruction.received", issue: issue ?? target.issue ?? undefined, actions: filed.actions }, now)
  ack(paths.inbox, entry.key)
  return filed
}
