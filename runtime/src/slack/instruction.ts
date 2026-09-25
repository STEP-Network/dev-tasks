/**
 * What a person asks the mini to do, in a Slack reply or mention (STEP-3285):
 * Nate answered Eve's "a person needs to look" with "then make it green and
 * merge", "fix it and merge" and "take care of it", and got a ✅ and nothing
 * else. A reply like that is an instruction: agentd acts on it now
 * (agentd/instructions.ts) and says in words what it did. Pure.
 *
 *   revise  fix it, make it green, take care of it, address, resolve
 *   rerun   re-run, run it again, retry the checks
 *   merge   merge (auto-merge, where the mini and the project allow it)
 *   retry   retry, try again, carry on (a blocked job, on its branch)
 *   pause   pause, hold off, stop working (never a resume: only a person on the mini lifts a pause)
 *   leave   leave it, I'll take it: the answer to one of the mini's questions
 * "don't merge" and the like name no action.
 */

export type Action = "revise" | "rerun" | "merge" | "retry" | "pause" | "leave"

export interface Instruction {
  actions: Action[]
  /** What the words name: an issue id, a PR by number or URL. A thread reply's issue comes from its thread. */
  target: { issue?: string; pr?: number; url?: string }
}

const PATTERNS: Array<[Action, RegExp]> = [
  ["rerun", /\b(re-?run|run (it |them |ci |the checks |the tests )?again|retry (the )?(ci|checks|tests|build))\b/i],
  ["revise", /\b(fix(es)?|make (it |them |this |that )?green|take care of|address|resolve|revise|sort (it|this|that) out)\b/i],
  ["merge", /\bmerge\b/i],
  ["retry", /\b(retry|try (it |that |this )?again|carry on)\b/i],
  ["pause", /\b(pause|hold off|stop (working|everything|all work))\b/i],
  ["leave", /\b(leave (it|this|that)|i'?ll (take|handle) (it|this|that))\b/i],
]
/** "don't merge", "no need to re-run", "never fix": a negation just before the words. */
const NEGATED = /\b(don'?t|do not|never|not|no need to|no)\s+(\w+\s+){0,2}$/i

interface InstructionBase {
  type: "instruction"
  key: string
  /** The thread's issue, or null for a mention that names its target. */
  issue: string | null
  user: string
  userName: string
  text: string
  actions: Action[]
  target: Instruction["target"]
  receivedAt: string
}

/** An instruction as the Slack bridge files it in the inbox, for agentd (agentd/instructions.ts). */
export interface InstructionEntry extends InstructionBase {
  channel: string
  ts: string
  /** Where agentd answers: the reply's thread, or the mention itself. */
  threadTs: string
  monday?: undefined
}

/**
 * One the Monday bridge files (STEP-3289): a person's update on an item, or
 * their Answer column. agentd answers on the item: under the update's thread,
 * with a like on the update itself. Both are null for the Answer column,
 * which has neither.
 */
export interface MondayInstructionEntry extends InstructionBase {
  monday: { itemId: string; updateId: string | null; threadId: string | null }
}

/** Every instruction agentd acts on, wherever the words were said. */
export type AnyInstructionEntry = InstructionEntry | MondayInstructionEntry

/**
 * What a person's words on an issue are: an instruction when they name an
 * action, or null for an answer. A reply to a question the issue waits on
 * (awaiting-answer), or to a person's to-do (human-todo), stays an answer
 * whatever words it uses. The Slack bridge's applyAnswer applies the same
 * rule in place, and the Monday bridge through this (monday/route.ts).
 */
export function instructionFor(text: string, issue: { labels: readonly string[] }): Instruction | null {
  const said = parseInstruction(text)
  const waits = issue.labels.includes("awaiting-answer") || issue.labels.includes("human-todo")
  return said.actions.length && !waits ? said : null
}

export function parseInstruction(text: string): Instruction {
  // Mentions (<@U123>) and links in Slack's markup, as plain words.
  const plain = text.replace(/<@[A-Z0-9]+(\|[^>]*)?>/g, " ").replace(/<(https?:\/\/[^|>]+)(\|[^>]*)?>/g, "$1")
  const actions: Action[] = []
  for (const [action, re] of PATTERNS) {
    const m = re.exec(plain)
    if (!m || NEGATED.test(plain.slice(0, m.index))) continue
    // "retry the checks" is a re-run, not a job retry.
    if (action === "retry" && actions.includes("rerun") && /\bretry (the )?(ci|checks|tests|build)\b/i.test(plain)) continue
    actions.push(action)
  }
  const target: Instruction["target"] = {}
  const issue = /\bSTEP-\d+\b/.exec(plain)
  if (issue) target.issue = issue[0]
  const url = /https:\/\/github\.com\/[\w.-]+\/[\w.-]+\/pull\/(\d+)/.exec(plain)
  if (url) {
    target.url = url[0]
    target.pr = Number(url[1])
  } else {
    const number = /(?:^|[\s(])(?:PR\s*)?#(\d{2,6})\b|\bPR\s+(\d{2,6})\b/i.exec(plain)
    if (number) target.pr = Number(number[1] ?? number[2])
  }
  return { actions, target }
}
