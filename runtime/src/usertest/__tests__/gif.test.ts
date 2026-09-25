import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import { describe, expect, it } from "vitest"
import { gifFromPngs } from "../gif.ts"

const png = (dir: string, name: string, colour: number) => {
  const p = new PNG({ width: 20, height: 10 })
  p.data.fill(colour)
  const file = join(dir, name)
  writeFileSync(file, PNG.sync.write(p))
  return file
}

describe("gifFromPngs", () => {
  it("makes an animated GIF from two frames, scaled to the width", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    const out = gifFromPngs([png(dir, "a.png", 0), png(dir, "b.png", 255)], join(dir, "main.gif"), { width: 10 })
    expect(out).toBe(join(dir, "main.gif"))
    expect(readFileSync(out!).subarray(0, 6).toString()).toBe("GIF89a")
    // The logical screen: 10 wide, and 5 high to keep the frames' shape.
    expect([readFileSync(out!).readUInt16LE(6), readFileSync(out!).readUInt16LE(8)]).toEqual([10, 5])
  })

  it("loads under Node itself, as agentd runs it, not only under vitest's resolver", () => {
    const runtime = join(import.meta.dirname, "..", "..", "..")
    const run = spawnSync(join(runtime, "node_modules", ".bin", "tsx"), ["-e", "import('./src/usertest/gif.ts').then((m) => console.log(typeof m.gifFromPngs))"], { cwd: runtime, encoding: "utf8", timeout: 30_000 })
    expect(run.stderr).toBe("")
    expect(run.stdout.trim()).toBe("function")
  }, 30_000)

  it("leaves out a frame that is not a whole PNG, and never throws", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    const cut = join(dir, "cut.png")
    writeFileSync(cut, readFileSync(png(dir, "whole.png", 9)).subarray(0, 30))
    expect(gifFromPngs([png(dir, "a.png", 0), cut, png(dir, "b.png", 255)], join(dir, "main.gif"), { width: 10 })).toBe(join(dir, "main.gif"))
    expect(gifFromPngs([png(dir, "c.png", 0), cut], join(dir, "one.gif"))).toBeNull()
    expect(gifFromPngs([png(dir, "d.png", 0), png(dir, "e.png", 9)], join(dir, "no-such-folder", "main.gif"))).toBeNull()
  })

  it("makes none from a single frame", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    expect(gifFromPngs([png(dir, "a.png", 0)], join(dir, "main.gif"))).toBeNull()
  })
})
