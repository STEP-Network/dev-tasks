/**
 * Where a person's words on the Monday board go (STEP-3289). This is the one
 * place they are routed, so they can later go the way Slack replies go once
 * those reach the front door (STEP-3293) by changing this alone.
 *
 * They are an instruction for agentd (the STEP-3285 verbs, slack/instruction.ts)
 * only where this mini has work of its own on the issue: a PR it opened and
 * still watches, an open question it asked, or its most recent job there
 * ended blocked. A request is never one. Either way the words are added to
 * the issue under "## Answers from Monday", so the issue keeps them, through
 * the one answer recorder Slack uses too (answer.ts): a plain yes to a
 * question that recommended something is recorded as that recommendation,
 * never a bare "yes" (STEP-3293 review). Only an answer moves a parked issue
 * on: an instruction is agentd's to act on. So "fix the date" on a request,
 * or "hold off" on another mini's issue, reaches the issue as words and moves
 * nothing on this mini.
 */

import type { AgentPaths } from "../config.ts"
import { putOnce } from "../fsq.ts"
import { listJobs, readWatchedPrs } from "../jobs.ts"
import { appendLedger } from "../log.ts"
import { openDecisions } from "../agentd/decisions.ts"
import { agreedTo, recordAnswer } from "../answer.ts"
import { lastQuestion } from "../outbox.ts"
import { instructionFor, type Action, type MondayInstructionEntry } from "../slack/instruction.ts"
import type { Tracker } from "../tracker.ts"

/** A person's words on an item: an update, a reply under one, or the Answer column (no update to reply under or like). */
export interface Words {
  id: string
  /** Redacted and trimmed already. */
  text: string
  updateId: string | null
  threadId: string | null
  permalink: string | null
}

export type Routed = { to: "agentd"; actions: Action[] } | { to: "issue"; movedTo: string | null }

/** Whether the issue's most recent job on this mini, running, queued or done, is one that ended blocked. */
function blockedNow(paths: AgentPaths, issue: string): boolean {
  const jobs = (["running", "pending", "done"] as const).flatMap((state) => listJobs(paths, state)).filter((j) => j.issue === issue)
  const latest = jobs.sort((a, b) => a.submittedAt.localeCompare(b.submittedAt)).at(-1)
  return latest?.result?.status === "blocked"
}

/** Whether this mini has work of its own on the issue that the fixed verbs act on. */
export function ownsWork(paths: AgentPaths, issue: string): boolean {
  return readWatchedPrs(paths).some((p) => p.issue === issue) || openDecisions(paths, issue).length > 0 || blockedNow(paths, issue)
}

export async function routeWords(
  deps: { paths: AgentPaths; tracker: Tracker },
  input: { issue: string; request: boolean; itemId: string; who: { id: string; name: string }; words: Words; now: Date },
): Promise<Routed> {
  const { paths, tracker } = deps
  const { issue, words, who, now } = input
  const current = await tracker.readIssue(issue)
  const said = !input.request && ownsWork(paths, issue) ? instructionFor(words.text, current) : null
  // A plain yes to a question that recommended something is that recommendation, as in Slack (STEP-3293 review).
  const decided = said ? null : agreedTo(words.text, lastQuestion(paths, issue)?.text, current)
  // One recorder for Slack and Monday (answer.ts). An instruction leaves the issue where it is: agentd acts on it.
  const { movedTo } = await recordAnswer(
    { paths, tracker },
    { issue, who: who.name, words: words.text, ts: words.id, permalink: words.permalink, source: "monday", ...(decided ? { decided } : {}) },
    { current, move: !said },
  )
  if (said) {
    const key = `instr:monday:${words.id}`
    const entry: MondayInstructionEntry = {
      type: "instruction", key, issue, user: who.id, userName: who.name, text: words.text, actions: said.actions, target: said.target,
      receivedAt: now.toISOString(), monday: { itemId: input.itemId, updateId: words.updateId, threadId: words.threadId },
    }
    // agentd acts on it within seconds and answers on the item (agentd/instructions.ts).
    if (putOnce(paths.inbox, key, entry)) appendLedger(paths, { type: "instruction.received", issue, actions: said.actions, via: "monday" }, now)
    return { to: "agentd", actions: said.actions }
  }
  appendLedger(paths, { type: "answer.applied", issue, movedTo, via: "monday", ...(decided ? { decided: true } : {}) }, now)
  return { to: "issue", movedTo }
}
