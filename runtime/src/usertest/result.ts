/**
 * The browser session's report (WS5): parsed, judged, and written up for the
 * PR and the Linear issue. Its text comes from a model that read untrusted
 * pages, so neutralise() runs over every piece of it before it is posted.
 */
import { z } from "zod"
import { NOTHING_NEEDED } from "../plain.ts"

const Finding = z.object({
  severity: z.enum(["blocker", "major", "minor"]),
  title: z.string(),
  where: z.string(),
  steps: z.string(),
  expected: z.string(),
  actual: z.string(),
  screenshot: z.string().optional(),
})
const Result = z.object({
  status: z.enum(["pass", "findings", "blocked"]),
  summary: z.string(),
  journeys: z.array(z.object({ name: z.string(), result: z.enum(["ok", "problem", "not walked"]), note: z.string().optional() })),
  findings: z.array(Finding),
  console: z.array(z.string()).optional(),
  network: z.array(z.string()).optional(),
  accessibility: z.array(z.string()).optional(),
  screenshots: z.array(z.object({ file: z.string(), caption: z.string() })),
  notWalked: z.array(z.string()),
})
export type UserTestResult = z.infer<typeof Result>

export function parseUserTestResult(raw: unknown): UserTestResult | null {
  const parsed = Result.safeParse(raw)
  return parsed.success ? parsed.data : null
}

/**
 * What the revise loop acts on: blockers and major findings. Minor ones are
 * reported, never sent back. A report without a screenshot is no evidence:
 * a session whose browser never started can still answer pass.
 */
export function verdictOf(result: UserTestResult | null): "pass" | "findings" | "error" {
  if (!result || result.status === "blocked" || !result.screenshots.length) return "error"
  return result.findings.some((f) => f.severity !== "minor") ? "findings" : "pass"
}

/** One line, cut short: what a model's text may be in a plain-text brief. */
const oneLine = (text: string, max: number) => {
  const line = text.replace(/\s+/g, " ").trim()
  return line.length > max ? `${line.slice(0, max)}…` : line
}

export function findingLines(result: UserTestResult | null): string[] {
  return (result?.findings ?? []).filter((f) => f.severity !== "minor").map((f) => `${f.severity}: ${oneLine(f.title, 300)} (${oneLine(f.where, 100)})`)
}

/**
 * Page and model text as inert markdown: one line (no heading, list item or
 * table row of its own), no link, image, autolink or code span, no HTML, no
 * @-mention, and no Linear profile URL, which would mention its person. Also
 * the report's style: no semicolons and no dashes between clauses.
 */
export function neutralise(text: string, max = 1000): string {
  return oneLine(text, max)
    .replace(/;/g, ",")
    .replace(/[–—]/g, ",")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_[\]()!|#~]/g, "\\$&")
    .replace(/:\/\//g, ":\u200b//")
    .replace(/@(?=[\w-])/g, "@\u200b")
}

export interface ReportInput {
  mini: string
  result: UserTestResult | null
  verdict: "pass" | "findings" | "skipped" | "error"
  /** Why it did not run or did not finish, in plain words. */
  reason: string | null
  site: string | null
  personaNote: string
  images: Array<{ file: string; caption: string; url: string }>
  gifUrl: string | null
  keptLocal: number
  /** Why keptLocal screenshots are not shown, from "because". */
  keptLocalReason?: string
}

const HEADLINE = { pass: "Passed", findings: "Found problems", skipped: "Did not run", error: "Could not finish" } as const
/** GitHub refuses a comment over 65,536 characters: the report stays well inside. */
const MAX_REPORT = 60_000
const MAX_ITEMS = 30

export function reportMarkdown(o: ReportInput): string {
  const r = o.result
  const lines = [`## Browser test by ${o.mini}: ${HEADLINE[o.verdict]}`, ""]
  if (o.reason) lines.push(neutralise(o.reason), "")
  if (r) lines.push(neutralise(r.summary, 2000), "")
  if (o.site) lines.push(`Site: ${o.site}.${o.personaNote ? ` ${o.personaNote[0].toUpperCase()}${o.personaNote.slice(1)}.` : ""}`, "")
  if (r?.journeys.length) {
    lines.push("### Journeys", "", "| Journey | Result | Note |", "|---|---|---|")
    for (const j of r.journeys.slice(0, MAX_ITEMS)) lines.push(`| ${neutralise(j.name, 200)} | ${j.result} | ${neutralise(j.note ?? "", 500)} |`)
    lines.push("")
  }
  if (r?.findings.length) {
    lines.push("### Problems found", "")
    r.findings.slice(0, MAX_ITEMS).forEach((f, n) => {
      lines.push(`${n + 1}. **${f.severity[0].toUpperCase()}${f.severity.slice(1)}**: ${neutralise(f.title, 300)}, at ${neutralise(f.where, 200)}`)
      lines.push(`   Steps: ${neutralise(f.steps)}`, `   Expected: ${neutralise(f.expected)}`, `   Actual: ${neutralise(f.actual)}`)
      const shot = f.screenshot ? o.images.find((i) => i.file === f.screenshot) : undefined
      if (shot) lines.push(`   ![${neutralise(f.title, 100)}](${shot.url})`)
    })
    lines.push("")
  }
  for (const [title, items] of [
    ["Console and network", [...(r?.console ?? []), ...(r?.network ?? [])]],
    ["Accessibility", r?.accessibility ?? []],
    ["Not walked", r?.notWalked ?? []],
  ] as const) {
    if (items.length) lines.push(`### ${title}`, "", ...items.slice(0, MAX_ITEMS).map((i) => `- ${neutralise(i, 300)}`), "")
  }
  if (o.gifUrl) lines.push("### The main journey", "", `![The main journey](${o.gifUrl})`, "")
  if (o.images.length) {
    lines.push("### Screenshots", "")
    for (const image of o.images) lines.push(`![${neutralise(image.caption, 200)}](${image.url})`)
    lines.push("")
  }
  if (o.keptLocal) lines.push(`${o.keptLocal} screenshots stay on the mini, ${o.keptLocalReason ?? "because the pages they show hold real people's data"}.`, "")
  let body = lines.join("\n").trim()
  if (body.length > MAX_REPORT) body = `${body.slice(0, body.lastIndexOf("\n", MAX_REPORT))}\n\nThe report was too long to show in full.`
  return `${body}\n\n${NOTHING_NEEDED}`
}
