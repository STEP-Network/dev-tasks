/**
 * The answer recorder's marks on a Linear issue (Wave 2, spec 6): the answer
 * entries it writes, the asker of a Slack request, and the two plan labels.
 * They decide which answer counts first and whether a Try plan was approved,
 * so only the recorder writes them (runtime/src/answer.ts). trackerctl keeps
 * them through any other edit (scripts/trackerctl.ts), and the people-doors
 * guard's answerBlocks (hooks/people-doors-rules.mjs) reads the same three
 * markers: a new marker goes into both.
 */

/** An answer from Slack or Monday, and the Slack member who asked for a request (Task 8). */
export const RECORDER_MARKERS = ["slack", "monday", "slack-user"] as const

export const RECORDER_LABELS = ["plan-to-approve", "plan-approved"]
/** The recommendation a Try plan's question carries: agreeing to it approves the plan. */
export const PLAN_RECOMMENDATION = "Build it as planned"

export interface AnswerEntry {
  source: (typeof RECORDER_MARKERS)[number]
  id: string
  at: string | null
  by: string | null
  /** null for a bare marker: no answer's words behind it. */
  who: string | null
  text: string
  /** The entry as it stands in the description: marker, and the words after it. */
  raw: string
  /** The `## ` heading it sits under, or "" before the first. */
  heading: string
}

// A marker, then (for an answer) "**Who** ([Door](link)): ", then the words up to the next marker or heading.
const ENTRY = /<!-- (slack-user|slack|monday):(\S+?)(?: at=(\S+?))?(?: by=(\S+?))? -->(?:\n\*\*(.+?)\*\*(?: \(\[[^\]]*\]\([^)]*\)\))?: )?([\s\S]*?)(?=\n+<!-- (?:slack-user|slack|monday):|\n+## |\s*$)/g

/** Every recorder's marker in a description, a bare one and the asker's included, in the order they stand. */
export function answerEntries(description: string): AnswerEntry[] {
  return [...description.matchAll(ENTRY)].map((m) => ({
    source: m[1] as AnswerEntry["source"],
    id: m[2],
    at: m[3] ?? null,
    by: m[4] ?? null,
    who: m[5] ?? null,
    text: m[6].trim(),
    raw: m[0].trimEnd(),
    heading: [...description.slice(0, m.index).matchAll(/^## .*$/gm)].at(-1)?.[0] ?? "",
  }))
}

/**
 * A block at the end of its heading's own section; before the first heading
 * when it has none; the heading and the block at the end when the heading is
 * gone. Never under whichever heading happens to be last.
 */
export function insertUnder(text: string, heading: string, block: string): string {
  const base = text.trimEnd()
  const escaped = heading.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
  const at = heading ? (new RegExp(`^${escaped}$`, "m").exec(base)?.index ?? -1) : 0
  if (at === -1) return `${base}\n\n${heading}\n\n${block}`
  const next = heading ? base.indexOf("\n## ", at + heading.length) : base.startsWith("## ") ? 0 : base.indexOf("\n## ")
  if (next === -1) return `${base}\n\n${block}`
  if (next === 0) return `${block}\n\n${base}`
  return `${base.slice(0, next).trimEnd()}\n\n${block}\n${base.slice(next)}`
}

const NOT_YOURS = "Answers on an issue are the answer recorder's to write: keep them as they are (trackerctl puts back any you leave out)"
const key = (e: AnswerEntry) => `${e.source}:${e.id}`

/**
 * An edit to a description keeps every entry the recorder wrote, as it was
 * (review, 2026-09-25: a forged entry would count as the first answer, a
 * forged asker as the Requester). One the edit leaves out is put back where
 * the recorder wrote it.
 */
export function keepAnswers(current: string, next: string): { description: string } | { refused: string } {
  const before = answerEntries(current)
  const after = answerEntries(next)
  const known = new Map(before.map((e) => [key(e), e.raw]))
  for (const e of after) {
    const was = known.get(key(e))
    if (was === undefined) return { refused: `${NOT_YOURS}. The edit adds one (${key(e)}).` }
    if (was !== e.raw) return { refused: `${NOT_YOURS}. The edit changes one (${key(e)}).` }
  }
  const kept = new Set(after.map(key))
  let description = next.trimEnd()
  for (const e of before.filter((e) => !kept.has(key(e)))) description = insertUnder(description, e.heading, e.raw)
  return { description }
}
