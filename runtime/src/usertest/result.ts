/**
 * The browser session's report (WS5): parsed, judged, and written up for the
 * PR and the Linear issue. Its text comes from a model that read untrusted
 * pages, so neutralise() runs over every piece of it before it is posted.
 */
import { z } from "zod"

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

/** What the revise loop acts on: blockers and major findings. Minor ones are reported, never sent back. */
export function verdictOf(result: UserTestResult | null): "pass" | "findings" | "error" {
  if (!result || result.status === "blocked") return "error"
  return result.findings.some((f) => f.severity !== "minor") ? "findings" : "pass"
}

export function findingLines(result: UserTestResult | null): string[] {
  return (result?.findings ?? []).filter((f) => f.severity !== "minor").map((f) => `${f.severity}: ${neutralise(f.title)} (${neutralise(f.where)})`)
}

/** No @-mention reaches a person, and no HTML closes the report's markup. */
export function neutralise(text: string): string {
  // Semicolons first: the entities below end in one.
  return text.replace(/;/g, ",").replace(/@(?=[\w-])/g, "@\u200b").replace(/</g, "&lt;").replace(/>/g, "&gt;")
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
}

const HEADLINE = { pass: "Passed", findings: "Found problems", skipped: "Did not run", error: "Could not finish" } as const

export function reportMarkdown(o: ReportInput): string {
  const r = o.result
  const lines = [`## Browser test by ${o.mini}: ${HEADLINE[o.verdict]}`, ""]
  if (o.reason) lines.push(neutralise(o.reason), "")
  if (r) lines.push(neutralise(r.summary), "")
  if (o.site) lines.push(`Site: ${o.site}. ${o.personaNote[0].toUpperCase()}${o.personaNote.slice(1)}.`, "")
  if (r?.journeys.length) {
    lines.push("### Journeys", "", "| Journey | Result | Note |", "|---|---|---|")
    for (const j of r.journeys) lines.push(`| ${neutralise(j.name)} | ${j.result} | ${neutralise(j.note ?? "")} |`)
    lines.push("")
  }
  if (r?.findings.length) {
    lines.push("### Problems found", "")
    r.findings.forEach((f, n) => {
      lines.push(`${n + 1}. **${f.severity[0].toUpperCase()}${f.severity.slice(1)}**: ${neutralise(f.title)}, at \`${neutralise(f.where)}\``)
      lines.push(`   Steps: ${neutralise(f.steps)}`, `   Expected: ${neutralise(f.expected)}`, `   Actual: ${neutralise(f.actual)}`)
      const shot = f.screenshot ? o.images.find((i) => i.file === f.screenshot) : undefined
      if (shot) lines.push(`   ![${neutralise(f.title)}](${shot.url})`)
    })
    lines.push("")
  }
  for (const [title, items] of [
    ["Console and network", [...(r?.console ?? []), ...(r?.network ?? [])]],
    ["Accessibility", r?.accessibility ?? []],
    ["Not walked", r?.notWalked ?? []],
  ] as const) {
    if (items.length) lines.push(`### ${title}`, "", ...items.map((i) => `- ${neutralise(i)}`), "")
  }
  if (o.gifUrl) lines.push("### The main journey", "", `![The main journey](${o.gifUrl})`, "")
  if (o.images.length) {
    lines.push("### Screenshots", "")
    for (const image of o.images) lines.push(`![${neutralise(image.caption)}](${image.url})`)
    lines.push("")
  }
  if (o.keptLocal) lines.push(`${o.keptLocal} screenshots stay on the mini, because the pages they show hold real people's data.`)
  return lines.join("\n").trim()
}
