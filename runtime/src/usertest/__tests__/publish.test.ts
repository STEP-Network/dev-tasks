import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, expect, it, vi } from "vitest"
import { fakeExec } from "../../__tests__/fakes.ts"
import { publishImagesToGitHub, uploadToLinear, usertestRef } from "../publish.ts"

const SHA = "c".repeat(40)

describe("publishImagesToGitHub", () => {
  it("makes one parentless commit, points this head's ref at it, prunes this PR's older refs, and links by commit", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"))
    const file = join(dir, "main-01.png")
    writeFileSync(file, "png")
    const { exec, lines } = fakeExec([
      [/git\/blobs/, { stdout: '{"sha":"blob1"}' }],
      [/git\/trees/, { stdout: '{"sha":"tree1"}' }],
      [/git\/commits/, { stdout: '{"sha":"commit1"}' }],
      [/api repos\/example\/repo\/git\/ref\/agent-usertest/, { code: 1, stdout: "", stderr: "Not Found" }],
      [/-X POST repos\/example\/repo\/git\/refs /, { stdout: "{}" }],
      [/matching-refs/, { stdout: JSON.stringify([{ ref: usertestRef(7, "d".repeat(40)) }, { ref: usertestRef(7, SHA) }]) }],
    ])
    const urls = await publishImagesToGitHub({ exec, slug: "example/repo", prNumber: 7, sha: SHA, files: [file], workDir: dir })
    expect(urls.get(file)).toBe("https://github.com/example/repo/blob/commit1/main-01.png?raw=true")
    expect(lines().some((l) => l.includes(`-X DELETE repos/example/repo/git/${usertestRef(7, "d".repeat(40))}`))).toBe(true)
    expect(lines().some((l) => l.includes(`git/${usertestRef(7, SHA)}`) && l.includes("DELETE"))).toBe(false)
  })

  it("keeps the images' commit off every branch's history, and tells Vercel not to deploy it", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"))
    const file = join(dir, "main-01.png")
    writeFileSync(file, "png")
    const { exec, lines } = fakeExec([
      [/git\/blobs/, { stdout: '{"sha":"blob1"}' }],
      [/git\/trees/, { stdout: '{"sha":"tree1"}' }],
      [/git\/commits/, { stdout: '{"sha":"commit1"}' }],
      [/matching-refs/, { stdout: "[]" }],
    ])
    await publishImagesToGitHub({ exec, slug: "example/repo", prNumber: 7, sha: SHA, files: [file], workDir: dir })
    const body = (re: RegExp) => JSON.parse(readFileSync(lines().find((l) => re.test(l))!.split("--input ")[1], "utf8"))
    const vercel = body(/git\/trees/).tree.find((t: { path: string }) => t.path === "vercel.json")
    expect(JSON.parse(vercel.content)).toEqual({ git: { deploymentEnabled: false } })
    expect(body(/git\/commits/)).toMatchObject({ tree: "tree1", parents: [] })
    // The ref existed already (gh answered 0): it is moved, not made again.
    expect(lines().some((l) => l.startsWith(`gh api -X PATCH repos/example/repo/git/${usertestRef(7, SHA)} `))).toBe(true)
  })

  it("names a ref outside heads, so Vercel never builds it", () => {
    expect(usertestRef(7, SHA)).toBe(`refs/agent-usertest/pr-7/${SHA.slice(0, 12)}`)
  })
})

describe("uploadToLinear", () => {
  it("asks Linear for an upload URL and puts the bytes there with its headers", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"))
    const file = join(dir, "main.gif")
    writeFileSync(file, "gif")
    const request = vi.fn().mockResolvedValue({ fileUpload: { success: true, uploadFile: { uploadUrl: "https://upload.example.com/x", assetUrl: "https://assets.example.com/x", headers: [{ key: "x-amz", value: "1" }] } } })
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    expect(await uploadToLinear(file, { request, fetchImpl })).toBe("https://assets.example.com/x")
    expect(request.mock.calls[0][1]).toEqual({ contentType: "image/gif", filename: "main.gif", size: 3 })
    expect(fetchImpl.mock.calls[0][1].headers["x-amz"]).toBe("1")
  })

  it("gives no URL when Linear refuses the upload or the bytes do not land", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pub-"))
    const file = join(dir, "main-01.png")
    writeFileSync(file, "png")
    const upload = { uploadUrl: "https://upload.example.com/x", assetUrl: "https://assets.example.com/x", headers: [] }
    const refused = vi.fn().mockResolvedValue({ fileUpload: { success: false, uploadFile: upload } })
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true })
    expect(await uploadToLinear(file, { request: refused, fetchImpl })).toBeNull()
    expect(fetchImpl).not.toHaveBeenCalled()
    const accepted = vi.fn().mockResolvedValue({ fileUpload: { success: true, uploadFile: upload } })
    expect(await uploadToLinear(file, { request: accepted, fetchImpl: vi.fn().mockResolvedValue({ ok: false }) })).toBeNull()
  })
})
