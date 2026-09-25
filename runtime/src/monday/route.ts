/**
 * Where a person's words on the Monday board go (STEP-3289). This is the one
 * place they are routed, so they can later go the way Slack replies go once
 * those reach the front door (STEP-3293) by changing this alone.
 *
 * They are an instruction for agentd (the STEP-3285 verbs, slack/instruction.ts)
 * only where this mini has work of its own on the issue: a PR it opened and
 * still watches, an open question it asked, or its last job there ended
 * blocked. A request is never one. Everything else is an answer, added to the
 * issue under "## Answers from Monday", and a parked issue moves on. So "fix
 * the date" on a request, or "hold off" on another mini's issue, reaches the
 * issue as words and moves nothing on this mini.
 */

import type { AgentPaths } from "../config.ts"
import { putOnce } from "../fsq.ts"
import { readWatchedPrs } from "../jobs.ts"
import { appendLedger } from "../log.ts"
import { openDecisions } from "../agentd/decisions.ts"
import { lastBlocked } from "../agentd/instructions.ts"
import { instructionFor, type Action, type MondayInstructionEntry } from "../slack/instruction.ts"
import { answerTransition, appendAnswer } from "../slack/text.ts"
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

/** Whether this mini has work of its own on the issue that the fixed verbs act on. */
export function ownsWork(paths: AgentPaths, issue: string): boolean {
  return readWatchedPrs(paths).some((p) => p.issue === issue) || openDecisions(paths, issue).length > 0 || lastBlocked(paths, issue) !== null
}

export async function routeWords(
  deps: { paths: AgentPaths; tracker: Tracker },
  input: { issue: string; request: boolean; itemId: string; who: { id: string; name: string }; words: Words; now: Date },
): Promise<Routed> {
  const { paths, tracker } = deps
  const { issue, words, who, now } = input
  const current = await tracker.readIssue(issue)
  const said = !input.request && ownsWork(paths, issue) ? instructionFor(words.text, current) : null
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
  const description = appendAnswer(current.description, { ts: words.id, userName: who.name, text: words.text, permalink: words.permalink }, "monday")
  const move = answerTransition(current)
  await tracker.updateIssue(issue, { ...(description !== current.description ? { description } : {}), ...move })
  appendLedger(paths, { type: "answer.applied", issue, movedTo: move.state ?? null, via: "monday" }, now)
  return { to: "issue", movedTo: move.state ?? null }
}
