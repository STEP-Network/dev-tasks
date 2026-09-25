/**
 * The Vercel preview of a PR's head (WS5), found the way PolAds's
 * lib/ci/screenshot-preview.ts finds it: the head sha's deployment in the
 * project's preview environment, a success posted by vercel[bot] (anyone with
 * write access can post a deployment status), and a bare https origin on the
 * project's preview host. That last check is also what keeps the browser off
 * any other host.
 */
import type { Exec } from "../worker/git.ts"

export const VERCEL_BOT_LOGIN = "vercel[bot]"

export interface DeploymentStatus {
  state: string
  environment_url?: string | null
  target_url?: string | null
  created_at: string
  creator?: { login?: string | null } | null
}

export interface DeploymentWithStatuses {
  id: number
  sha: string
  environment: string
  created_at: string
  statuses: DeploymentStatus[]
}

export type PreviewLookup = { state: "ready"; origin: string } | { state: "failed"; detail: string } | { state: "pending" }

export function previewOriginFrom(url: string | null | undefined, hostRe: RegExp): string | null {
  if (!url) return null
  let parsed: URL
  try {
    parsed = new URL(url)
  } catch {
    return null
  }
  if (parsed.protocol !== "https:" || parsed.username || parsed.password || parsed.port) return null
  if (parsed.pathname !== "/" || parsed.search || parsed.hash) return null
  return hostRe.test(parsed.hostname) ? parsed.origin : null
}

export function selectPreview(deployments: readonly DeploymentWithStatuses[], sha: string, environment: string, hostRe: RegExp): PreviewLookup {
  const ours = deployments.filter((d) => d.sha === sha && d.environment === environment).sort((a, b) => b.created_at.localeCompare(a.created_at))
  for (const deployment of ours) {
    const success = deployment.statuses.find((s) => s.state === "success" && s.creator?.login === VERCEL_BOT_LOGIN)
    if (!success) continue
    const origin = previewOriginFrom(success.environment_url || success.target_url, hostRe)
    if (!origin) return { state: "failed", detail: `deployment ${deployment.id} reported a URL that is not this project's preview host` }
    return { state: "ready", origin }
  }
  const latest = [...(ours[0]?.statuses ?? [])].sort((a, b) => b.created_at.localeCompare(a.created_at))[0]
  if (latest && (latest.state === "failure" || latest.state === "error")) return { state: "failed", detail: `the preview deployment ended in ${latest.state}` }
  return { state: "pending" }
}

const SHA_RE = /^[0-9a-f]{40}$/
const GH_MS = 60_000

async function lookup(o: { exec: Exec; slug: string; sha: string; environment: string; hostRe: RegExp }): Promise<PreviewLookup> {
  const list = await o.exec("gh", ["api", `repos/${o.slug}/deployments?sha=${o.sha}&per_page=20`], { timeoutMs: GH_MS })
  if (list.code !== 0) return { state: "pending" }
  try {
    const deployments = JSON.parse(list.stdout) as Array<Omit<DeploymentWithStatuses, "statuses">>
    const full: DeploymentWithStatuses[] = []
    for (const d of deployments.filter((x) => x.environment === o.environment)) {
      const s = await o.exec("gh", ["api", `repos/${o.slug}/deployments/${d.id}/statuses?per_page=20`], { timeoutMs: GH_MS })
      full.push({ ...d, statuses: s.code === 0 ? (JSON.parse(s.stdout) as DeploymentStatus[]) : [] })
    }
    return selectPreview(full, o.sha, o.environment, o.hostRe)
  } catch {
    return { state: "pending" }
  }
}

/** Polls until the preview is ready or failed, or `minutes` pass. */
export async function waitForPreview(o: {
  exec: Exec
  slug: string
  sha: string
  environment: string
  hostRe: RegExp
  minutes: number
  now: () => Date
  sleep: (ms: number) => Promise<void>
  pollMs?: number
}): Promise<PreviewLookup | { state: "timeout" }> {
  if (!SHA_RE.test(o.sha)) return { state: "failed", detail: "the PR's head is not a commit id" }
  const poll = o.pollMs ?? 30_000
  const until = o.now().getTime() + o.minutes * 60_000
  for (;;) {
    const found = await lookup(o)
    if (found.state !== "pending") return found
    if (o.now().getTime() + poll > until) return { state: "timeout" }
    await o.sleep(poll)
  }
}
