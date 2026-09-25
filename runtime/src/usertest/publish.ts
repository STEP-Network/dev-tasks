/**
 * Where the report's images go (WS5). On GitHub: one parentless commit per
 * PR head, kept alive by a ref under refs/agent-usertest/ (outside heads/, so
 * Vercel never builds it and no clone fetches it), and embedded by commit,
 * which renders for anyone who can read the private repository. The same
 * pattern as PolAds's PR screenshots (lib/ci/screenshot-refs.ts). This PR's
 * older heads' refs are pruned on each publish. In Linear: uploaded, so
 * people need no GitHub access.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { basename, join } from "node:path"
import type { linearRequest } from "../tracker.ts"
import { must, type Exec } from "../worker/git.ts"

export const USERTEST_REF_NAMESPACE = "agent-usertest"

export function usertestRef(prNumber: number, sha: string): string {
  return `refs/${USERTEST_REF_NAMESPACE}/pr-${prNumber}/${sha.slice(0, 12).toLowerCase()}`
}

const VERCEL_JSON = `${JSON.stringify({ git: { deploymentEnabled: false } }, null, 2)}\n`

export async function publishImagesToGitHub(o: { exec: Exec; slug: string; prNumber: number; sha: string; files: readonly string[]; workDir: string }): Promise<Map<string, string>> {
  let n = 0
  const api = async (method: string, path: string, body?: unknown): Promise<unknown> => {
    const args = ["api", "-X", method, `repos/${o.slug}/${path}`]
    if (body !== undefined) {
      const file = join(o.workDir, `gh-body-${n++}.json`)
      writeFileSync(file, JSON.stringify(body))
      args.push("--input", file)
    }
    const out = await must(o.exec, "gh", args, { timeoutMs: 120_000 })
    return out.trim() ? JSON.parse(out) : null
  }
  const tree: Array<Record<string, string>> = []
  for (const file of o.files) {
    const blob = (await api("POST", "git/blobs", { content: readFileSync(file).toString("base64"), encoding: "base64" })) as { sha: string }
    tree.push({ path: basename(file), mode: "100644", type: "blob", sha: blob.sha })
  }
  tree.push({ path: "vercel.json", mode: "100644", type: "blob", content: VERCEL_JSON })
  const t = (await api("POST", "git/trees", { tree })) as { sha: string }
  const commit = (await api("POST", "git/commits", { message: `Browser test images for PR #${o.prNumber} at ${o.sha.slice(0, 12)}`, tree: t.sha, parents: [] })) as { sha: string }
  const ref = usertestRef(o.prNumber, o.sha)
  const existing = await o.exec("gh", ["api", `repos/${o.slug}/git/ref/${ref.replace(/^refs\//, "")}`], { timeoutMs: 60_000 })
  if (existing.code === 0) await api("PATCH", `git/${ref}`, { sha: commit.sha, force: true })
  else await api("POST", "git/refs", { ref, sha: commit.sha })
  const older = (await api("GET", `git/matching-refs/${USERTEST_REF_NAMESPACE}/pr-${o.prNumber}/`)) as Array<{ ref: string }> | null
  for (const r of older ?? []) {
    if (r.ref !== ref) await o.exec("gh", ["api", "-X", "DELETE", `repos/${o.slug}/git/${r.ref}`], { timeoutMs: 60_000 })
  }
  return new Map(o.files.map((file) => [file, `https://github.com/${o.slug}/blob/${commit.sha}/${encodeURIComponent(basename(file))}?raw=true`]))
}

type LinearUpload = { fileUpload: { success: boolean; uploadFile: { uploadUrl: string; assetUrl: string; headers: Array<{ key: string; value: string }> } | null } }

/** Linear's documented upload: ask for a signed URL, then PUT the bytes with the headers it returned. */
export async function uploadToLinear(file: string, o: { request: typeof linearRequest; fetchImpl: typeof fetch }): Promise<string | null> {
  const bytes = readFileSync(file)
  const contentType = file.endsWith(".gif") ? "image/gif" : "image/png"
  const { fileUpload } = await o.request<LinearUpload>(
    `mutation($contentType: String!, $filename: String!, $size: Int!) {
       fileUpload(contentType: $contentType, filename: $filename, size: $size) { success uploadFile { uploadUrl assetUrl headers { key value } } }
     }`,
    { contentType, filename: basename(file), size: bytes.length },
  )
  const target = fileUpload.uploadFile
  if (!fileUpload.success || !target) return null
  const headers: Record<string, string> = { "Content-Type": contentType, "Cache-Control": "public, max-age=31536000" }
  for (const { key, value } of target.headers) headers[key] = value
  const put = await o.fetchImpl(target.uploadUrl, { method: "PUT", headers, body: bytes, signal: AbortSignal.timeout(60_000) })
  return put.ok ? target.assetUrl : null
}
