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
import { answerText, BARE, recordAnswer, type Decided } from "./answer.ts"
import type { AgentPaths } from "./config.ts"
import { ack, entryPath, putOnce, readJson } from "./fsq.ts"
import { readWatchedPrs } from "./jobs.ts"
import { appendLedger } from "./log.ts"
import { enqueueSlack } from "./outbox.ts"
import { NOTHING_NEEDED, recommendationOf } from "./plain.ts"
import { parseInstruction, type Action, type InstructionEntry } from "./slack/instruction.ts"
import { threadFor } from "./threads.ts"
import type { Tracker } from "./tracker.ts"

export { BARE } from "./answer.ts"

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
  /** On a reply: when the front door last wrote in the thread in its own words, as the bridge filed it. */
  lastReplyAt?: string | null
  /** On a reply: the questions left open in the thread when it came. */
  openQuestions?: number
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
  // The front door wrote in the thread after the question: their yes may answer what it said there, a recommendation in other words included.
  const replied = filed ? (entry.lastReplyAt ?? null) : thread?.lastReplyAt && Date.parse(thread.lastReplyAt) <= Date.parse(entry.receivedAt) ? thread.lastReplyAt : null
  if (replied && (answeredAt === null || Date.parse(replied) > answeredAt)) {
    throw new Error(`I wrote in the ${entry.issue} thread after that question, so their yes may answer what I said there: ask it again with agentctl ask and your recommendation`)
  }
  if ((entry.openQuestions ?? 0) > 1) {
    throw new Error(`${entry.openQuestions} questions were open in the ${entry.issue} thread when they replied, so a yes does not say which: ask again, all in one question with one recommendation`)
  }
  return filed ? (entry.lastQuestion ?? null) : (thread?.lastQuestion ?? null)
}

export interface Decision {
  /** What the issue keeps: whose decision, what it is, and their own words beside it. */
  recorded: string
  /** What was decided, as the thanks names it. */
  what: string
  agreed: boolean
  decided: Decided
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
    const decided: Decided = { agreed: true, recommendation: rec }
    return { recorded: answerText({ who: who(entry), words: said, decided }), what: rec, agreed: true, decided }
  }
  const text = how.text.trim().replace(/[\s.]+$/, "")
  if (!text || BARE.test(text)) throw new Error("a decision must say what was decided, not only yes: write it out, or use --agree for the recommendation")
  // Their bare yes with nothing to agree to is not a decision the front door may write for them.
  if (BARE.test(said)) throw new Error(`${who(entry)} said only "${said}", which decides nothing without a recommendation: ask them what they decided`)
  const decided: Decided = { agreed: false, text }
  return { recorded: answerText({ who: who(entry), words: said, decided }), what: text, agreed: false, decided }
}

export interface DecideDeps {
  paths: AgentPaths
  tracker: Tracker
  now: () => Date
}

/**
 * Records the decision on the issue through the one answer recorder Slack and
 * Monday share (answer.ts), moves the issue on as an answer always did, says
 * so in the thread, and acks the message. A yes on a person's to-do is
 * refused there: it means they will do it, not that it is done.
 */
export async function recordDecision(deps: DecideDeps, entry: PersonEntry, decision: Decision): Promise<{ issue: string; movedTo: string | null }> {
  if (!entry.issue) throw new Error(`${entry.key} is not in an issue's thread, so there is no issue to record a decision on`)
  const { movedTo } = await recordAnswer(deps, { issue: entry.issue, who: who(entry), words: words(entry), ts: entry.ts, permalink: entry.permalink ?? null, source: "slack", decided: decision.decided })
  ack(deps.paths.inbox, entry.key)
  const now = deps.now()
  const moved = movedTo ? ` It goes back to ${movedTo}.` : ""
  const threadTs = entry.threadTs ?? entry.ts
  // Words first, and a ✅ beside them: never a bare ✅ (STEP-3285).
  enqueueSlack(deps.paths, { kind: "reply", channelId: entry.channel, threadTs, text: `Thanks, ${who(entry)}. I added your decision to ${entry.issue}: ${decision.what}.${moved} ${NOTHING_NEEDED}` }, now)
  enqueueSlack(deps.paths, { kind: "react", channelId: entry.channel, ts: entry.ts, name: "white_check_mark" }, now)
  appendLedger(deps.paths, { type: "answer.applied", issue: entry.issue, movedTo, decided: true }, now)
  return { issue: entry.issue, movedTo }
}

export const ACTIONS: readonly Action[] = ["revise", "rerun", "merge", "retry", "pause", "leave"]

/**
 * A "yes" to one of agentd's decisions (agentd/decisions.ts): the actions its
 * default reply stands for, which is what the question recommended.
 */
export function defaultActions(paths: AgentPaths, entry: PersonEntry): Action[] {
  const decision = entry.issue ? openDecisions(paths, entry.issue)[0] : undefined
  if (!decision) throw new Error(`${entry.issue ?? "this thread"} waits on no decision of agentd's, so there is no default to take`)
  if (Date.parse(decision.askedAt) > Date.parse(entry.receivedAt)) {
    throw new Error(`agentd asked its question in ${entry.issue} after this reply, so their yes was not to it: ask them`)
  }
  const actions = parseInstruction(decision.defaultReply).actions
  if (!actions.length) throw new Error(`the default "${decision.defaultReply}" names no action`)
  return actions
}

/** The issue or PR a person's words name, if any: a link counts as its PR. */
function wordsTarget(entry: PersonEntry): InstructionEntry["target"] {
  const t = parseInstruction(entry.text).target
  return { ...(t.issue ? { issue: t.issue } : {}), ...(t.pr ? { pr: t.pr } : {}), ...(t.url ? { url: t.url } : {}) }
}

const named = (t: InstructionEntry["target"]) => t.issue ?? (t.pr ? `#${t.pr}` : "nothing")
const prNumber = (url: string) => Number(url.split("/").pop())

/**
 * What instruct may file for a person (STEP-3293 review): the fixed verbs in
 * their own words, or, for a plain yes to agentd's open decision asked before
 * it, the reply that decision recommended. The target comes from their words
 * too: a reply acts on its thread's issue and nothing else they did not name,
 * a mention on what it names, and only a pause, the whole mini's, needs none.
 * A --target must be that same one. So no text the front door reads elsewhere
 * can act in their name.
 */
export function actionsAsked(paths: AgentPaths, entry: PersonEntry, asked: string[], aimed: InstructionEntry["target"]): { actions: Action[]; target: InstructionEntry["target"] } {
  if (!asked.length) throw new Error("name at least one action")
  let actions: Action[]
  if (asked.length === 1 && asked[0] === "default") {
    if (!BARE.test(words(entry))) throw new Error(`${who(entry)} did not just say yes, so their words do not take agentd's default: file the actions they name, or ask them`)
    actions = defaultActions(paths, entry)
  } else {
    for (const a of asked) if (!ACTIONS.includes(a as Action)) throw new Error(`${a} is not an action agentd takes (${ACTIONS.join(", ")})`)
    const said = parseInstruction(entry.text).actions
    // What the bridge read and did (a pause) counts as asked: instruct skips it anyway.
    const extra = asked.filter((a) => !said.includes(a as Action) && !(entry.acted ?? []).includes(a as Action))
    if (extra.length) {
      const what = said.length ? `they asked for ${said.join(", ")}` : "they asked for none of the actions"
      throw new Error(`${who(entry)}'s words do not ask for ${extra.join(" or ")} (${what}): file only what they asked for, or ask them`)
    }
    actions = asked as Action[]
  }
  const target = wordsTarget(entry)
  const gave = Boolean(aimed.issue || aimed.pr)
  if (entry.issue) {
    // A reply: its thread's issue, and a PR only if it is that issue's own.
    const own = readWatchedPrs(paths).find((p) => p.issue === entry.issue)
    const ownPr = own ? prNumber(own.url) : null
    if (target.issue && target.issue !== entry.issue) throw new Error(`${who(entry)} named ${target.issue} in the ${entry.issue} thread: ask them which they mean`)
    if (target.pr && target.pr !== ownPr) throw new Error(`${who(entry)} named #${target.pr}, which is not ${entry.issue}'s PR: ask them which they mean`)
    if (gave && aimed.issue !== entry.issue && !(aimed.pr && aimed.pr === ownPr)) throw new Error(`the target is this thread's, ${entry.issue}: leave --target out`)
    return { actions, target }
  }
  // A mention: only what their words name.
  if (gave && ((aimed.issue ?? null) !== (target.issue ?? null) || (aimed.pr ?? null) !== (target.pr ?? null))) {
    throw new Error(target.issue || target.pr ? `${who(entry)} named ${named(target)}, so the target must be that` : `${who(entry)}'s words name no issue or PR, so there is no target to give: ask them which`)
  }
  if (!target.issue && !target.pr && actions.some((a) => a !== "pause")) {
    throw new Error(`${who(entry)}'s words name no issue or PR for ${actions.filter((a) => a !== "pause").join(", ")}: ask them which (only a pause needs none)`)
  }
  return { actions, target }
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
  // A pause is the whole mini's. Anything else needs the issue or PR it is for.
  if (todo.some((a) => a !== "pause") && !issue && !target.issue && !target.pr && !target.url) throw new Error("a mention names no issue or PR: ask them which")
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
