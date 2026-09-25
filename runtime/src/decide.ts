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
 *             leave) the person's own words ask for, filed for agentd
 *             (agentd/instructions.ts), which acts and replies in words
 *
 * Who said it, and their words, come from the bridge's own inbox entry: the
 * front door names the entry, never the person, and can file nothing their
 * words do not ask for. A question back, or a reply the front door is unsure
 * of, gets an answer in the thread and is acked.
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
  /** On a reply: the last question this mini had asked in the thread when the bridge filed it. Absent on entries filed before. */
  lastQuestion?: string | null
  lastQuestionAt?: string | null
  /** What the bridge did about the words itself (pause, leave). */
  acted?: Action[]
}

const PERSON_TYPES = new Set(["reply", "answer", "mention"])

/** The waiting message `key` names, or why there is none. */
export function personEntry(paths: AgentPaths, key: string): PersonEntry {
  const entry = readJson<PersonEntry>(entryPath(paths.inbox, key))
  if (!entry) throw new Error(`no message ${key} is waiting: it was handled already, or never came`)
  if (!PERSON_TYPES.has(entry.type)) throw new Error(`${key} is not a person's reply or mention`)
  return entry
}

const AGREE = "(yes|yep|yeah|y|ok|okay|sure|fine|agreed|agree|go|go ahead|go for it|go with it|go with that|do it|sounds good|lgtm|👍|:\\+1:|:thumbsup:)"
const POLITE = "(please|thanks|thank you)"
/** Words that agree and say nothing else ("yes", "ok, go ahead", "yes please"): a decision needs what was decided. */
export const BARE = new RegExp(`^\\s*(${POLITE}[\\s,.!]+)*${AGREE}([\\s,.!]+(${AGREE}|${POLITE}))*[\\s.!]*$`, "i")

const words = (entry: PersonEntry) => (entry.readableText ?? entry.text).replace(/\s+/g, " ").trim()
const who = (entry: PersonEntry) => entry.userName || entry.user

/**
 * The question a reply answered: the last one asked before the bridge filed
 * it. A question asked after it is one their "yes" never saw, so agreeing is
 * refused then (STEP-3293 review).
 */
export function questionAnswered(paths: AgentPaths, entry: PersonEntry): string | null {
  const thread = entry.issue ? threadFor(paths, entry.issue) : null
  const latestAt = thread?.lastQuestionAt ? Date.parse(thread.lastQuestionAt) : null
  const filed = entry.lastQuestionAt !== undefined
  const answeredAt = filed ? (entry.lastQuestionAt ? Date.parse(entry.lastQuestionAt) : null) : latestAt
  const later = latestAt !== null && (filed ? answeredAt === null || latestAt > answeredAt : latestAt > Date.parse(entry.receivedAt))
  if (later) {
    throw new Error(`a new question went to the ${entry.issue} thread after this reply, so their yes did not agree to it: ask them again, or record what they decided with --text-file`)
  }
  return filed ? (entry.lastQuestion ?? null) : (thread?.lastQuestion ?? null)
}

export interface Decision {
  /** What the issue keeps: whose decision, what it is, and their own words beside it. */
  recorded: string
  /** What was decided, as the thanks names it. */
  what: string
  agreed: boolean
}

/**
 * The decision as the issue keeps it. `agree` takes the recommendation of
 * the question the reply answered. Written out, it must say more than their
 * words did when they said only yes.
 */
export function decisionText(paths: AgentPaths, entry: PersonEntry, how: { agree: true } | { text: string }): Decision {
  const said = words(entry)
  if ("agree" in how) {
    const rec = recommendationOf(questionAnswered(paths, entry))
    if (!rec) throw new Error(`there is no recommendation in ${entry.issue ?? "this"} thread to agree with: record what they decided with --text-file`)
    return { recorded: `${who(entry)} agreed with the recommendation: ${rec}. (Their words: "${said}")`, what: rec, agreed: true }
  }
  const text = how.text.trim().replace(/[\s.]+$/, "")
  if (!text || BARE.test(text)) throw new Error("a decision must say what was decided, not only yes: write it out, or use --agree for the recommendation")
  // Their bare yes with nothing to agree to is not a decision the front door may write for them.
  if (BARE.test(said)) throw new Error(`${who(entry)} said only "${said}", which decides nothing without a recommendation: ask them what they decided`)
  return { recorded: `${who(entry)} decided: ${text}. (Their words: "${said}")`, what: text, agreed: false }
}

export interface DecideDeps {
  paths: AgentPaths
  tracker: Tracker
  now: () => Date
}

/** Records the decision on the issue, moves the issue on as an answer always did, says so in the thread, and acks the message. */
export async function recordDecision(deps: DecideDeps, entry: PersonEntry, decision: Decision): Promise<{ issue: string; movedTo: string | null }> {
  if (!entry.issue) throw new Error(`${entry.key} is not in an issue's thread, so there is no issue to record a decision on`)
  const current = await deps.tracker.readIssue(entry.issue)
  // A hand-off asks for a person's hands: their yes there means they will do it, not that it is done (STEP-3293 review).
  if (decision.agreed && current.labels.includes("human-todo")) {
    throw new Error(`${entry.issue} waits on a person to do something (human-todo), so a yes is not a decision: once they say it is done, record that with --text-file, and otherwise ack it`)
  }
  const description = appendAnswer(current.description, { ts: entry.ts, userName: who(entry), text: decision.recorded, permalink: entry.permalink ?? null })
  const move = answerTransition(current)
  await deps.tracker.updateIssue(entry.issue, { ...(description !== current.description ? { description } : {}), ...move })
  ack(deps.paths.inbox, entry.key)
  const now = deps.now()
  const moved = move.state ? ` It goes back to ${move.state}.` : ""
  const threadTs = entry.threadTs ?? entry.ts
  // Words first, and a ✅ beside them: never a bare ✅ (STEP-3285).
  enqueueSlack(deps.paths, { kind: "reply", channelId: entry.channel, threadTs, text: `Thanks, ${who(entry)}. I added your decision to ${entry.issue}: ${decision.what}.${moved} ${NOTHING_NEEDED}` }, now)
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
 * The actions instruct may file for a person (STEP-3293 review): the fixed
 * verbs in their own words, or, for a plain yes to agentd's open decision,
 * the reply it recommended. Nothing their words do not ask for, so no text
 * the front door reads elsewhere can act in their name. A target they named
 * is the one it acts on.
 */
export function actionsAsked(paths: AgentPaths, entry: PersonEntry, named: string[], target: InstructionEntry["target"]): Action[] {
  if (!named.length) throw new Error("name at least one action")
  if (named.length === 1 && named[0] === "default") {
    if (!BARE.test(words(entry))) throw new Error(`${who(entry)} did not just say yes, so their words do not take agentd's default: file the actions they name, or ask them`)
    return defaultActions(paths, entry)
  }
  for (const a of named) if (!ACTIONS.includes(a as Action)) throw new Error(`${a} is not an action agentd takes (${ACTIONS.join(", ")})`)
  const said = parseInstruction(entry.text)
  const extra = named.filter((a) => !said.actions.includes(a as Action))
  if (extra.length) {
    const asked = said.actions.length ? `they asked for ${said.actions.join(", ")}` : "they asked for none of the actions"
    throw new Error(`${who(entry)}'s words do not ask for ${extra.join(" or ")} (${asked}): file only what they asked for, or ask them`)
  }
  if ((said.target.issue && target.issue && said.target.issue !== target.issue) || (said.target.pr && target.pr && said.target.pr !== target.pr)) {
    throw new Error(`${who(entry)} named ${said.target.issue ?? `#${said.target.pr}`}, so the target must be that`)
  }
  return named as Action[]
}

/**
 * The actions a person asked for, filed for agentd with the person and words
 * the bridge recorded, less any the bridge already did (pause, leave). The
 * message itself is acked: agentd replies in its thread. null when the
 * bridge had done them all.
 */
export function fileInstructionFor(paths: AgentPaths, entry: PersonEntry, actions: Action[], target: InstructionEntry["target"], now: Date): InstructionEntry | null {
  const todo = [...new Set(actions)].filter((a) => !(entry.acted ?? []).includes(a))
  const issue = entry.issue ?? null
  if (todo.length && !issue && !target.issue && !target.pr && !target.url) throw new Error("a mention names no issue or PR: pass --target STEP-<n> or --target #<number>")
  if (!todo.length) {
    ack(paths.inbox, entry.key)
    return null
  }
  const key = `instr:${entry.channel}:${entry.ts}`
  const filed: InstructionEntry = {
    type: "instruction",
    key,
    issue,
    channel: entry.channel,
    ts: entry.ts,
    threadTs: entry.threadTs ?? entry.ts,
    user: entry.user,
    userName: who(entry),
    text: entry.text,
    actions: todo,
    target,
    receivedAt: now.toISOString(),
  }
  if (putOnce(paths.inbox, key, filed)) appendLedger(paths, { type: "instruction.received", issue: issue ?? target.issue ?? undefined, actions: filed.actions }, now)
  ack(paths.inbox, entry.key)
  return filed
}
