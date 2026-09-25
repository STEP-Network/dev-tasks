import { spawnSync } from "node:child_process"
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { PNG } from "pngjs"
import { describe, expect, it } from "vitest"
import { gifFromPngs, readablePng } from "../gif.ts"

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

  it("leaves out a frame far taller than it is wide, which would need gigabytes", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    const tall = join(dir, "tall.png")
    writeFileSync(tall, PNG.sync.write(new PNG({ width: 1, height: 20000 })))
    // First, it would set the GIF's height: 200,000 rows at this width, 19 million at the default.
    const out = gifFromPngs([tall, png(dir, "a.png", 0), png(dir, "b.png", 255)], join(dir, "main.gif"), { width: 10 })
    expect(out).toBe(join(dir, "main.gif"))
    expect(readFileSync(out!).readUInt16LE(8)).toBe(5)
    expect(gifFromPngs([tall, png(dir, "c.png", 0)], join(dir, "one.gif"), { width: 10 })).toBeNull()
  })

  it("reads no more frames than it uses", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    const cut = join(dir, "cut.png")
    writeFileSync(cut, "not a png")
    // Two good frames make the GIF: the third is never read.
    expect(gifFromPngs([png(dir, "a.png", 0), png(dir, "b.png", 9), cut], join(dir, "main.gif"), { width: 10, maxFrames: 2 })).toBe(join(dir, "main.gif"))
    const out = gifFromPngs([png(dir, "c.png", 0), png(dir, "d.png", 9), png(dir, "e.png", 200)], join(dir, "two.gif"), { width: 10, maxFrames: 2 })
    // One graphic control extension (0x21 0xF9) per frame.
    const bytes = readFileSync(out!)
    const frames = bytes.reduce((n, b, i) => n + (b === 0x21 && bytes[i + 1] === 0xf9 ? 1 : 0), 0)
    expect(frames).toBe(2)
    expect(readablePng(cut)).toBe(false)
    expect(readablePng(join(dir, "a.png"))).toBe(true)
    // A whole screenshot counts whatever its shape: only the GIF leaves a tall one out.
    const tall = join(dir, "tall.png")
    writeFileSync(tall, PNG.sync.write(new PNG({ width: 1, height: 20000 })))
    expect(readablePng(tall)).toBe(true)
    const cutOff = join(dir, "cut-off.png")
    writeFileSync(cutOff, readFileSync(join(dir, "a.png")).subarray(0, -12))
    expect(readablePng(cutOff)).toBe(false)
  })

  it("makes none from a single frame", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    expect(gifFromPngs([png(dir, "a.png", 0)], join(dir, "main.gif"))).toBeNull()
  })
})
