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

  it("makes none from a single frame", () => {
    const dir = mkdtempSync(join(tmpdir(), "gif-"))
    expect(gifFromPngs([png(dir, "a.png", 0)], join(dir, "main.gif"))).toBeNull()
  })
})
