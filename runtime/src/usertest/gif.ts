/**
 * The main journey as a GIF (WS5, spec 5: "a GIF of the main journey for
 * Look and Try work"): the desktop screenshots the session saved at each
 * step, one frame each, scaled down to `width`. Pure JavaScript (pngjs and
 * gifenc), so the minis need no ffmpeg.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { createRequire } from "node:module"
import { PNG } from "pngjs"

// Required, not imported: Node cannot name the exports of gifenc's CommonJS
// build, and vitest would load its ESM build instead. Both read this one.
const { applyPalette, GIFEncoder, quantize } = createRequire(import.meta.url)("gifenc") as typeof import("gifenc")

/** A screenshot shape a GIF can hold: no taller than four times its width, and no more than 40 million pixels. */
const MAX_ASPECT = 4
const MAX_PIXELS = 40_000_000

/** The PNG, or null when it is not a whole PNG of a shape a GIF can hold. Its size is read from the header before anything is decoded. */
function readFrame(file: string) {
  try {
    const bytes = readFileSync(file)
    if (bytes.length < 24) return null
    const w = bytes.readUInt32BE(16)
    const h = bytes.readUInt32BE(20)
    if (!w || !h || h > MAX_ASPECT * w || w * h > MAX_PIXELS) return null
    return PNG.sync.read(bytes)
  } catch {
    return null
  }
}

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])

/**
 * Whether a file is a whole PNG, whatever its shape: what the browser test
 * counts as a screenshot it really saved. It starts with the PNG signature
 * and ends with the IEND chunk, which a screenshot cut off never reaches.
 * Nothing is decoded.
 */
export function readablePng(file: string): boolean {
  try {
    const bytes = readFileSync(file)
    return bytes.length > 20 && bytes.subarray(0, 8).equals(PNG_SIGNATURE) && bytes.subarray(-8, -4).toString("latin1") === "IEND"
  } catch {
    return false
  }
}

/**
 * Never throws: a frame that is not a whole PNG (a screenshot cut off by the
 * time limit), or one far taller than it is wide, is left out, and fewer
 * than two frames make no GIF. It reads no more frames than it uses.
 */
export function gifFromPngs(files: readonly string[], outFile: string, o: { width?: number; delayMs?: number; maxFrames?: number } = {}): string | null {
  const frames: Array<NonNullable<ReturnType<typeof readFrame>>> = []
  for (const file of files) {
    if (frames.length >= (o.maxFrames ?? 12)) break
    const png = readFrame(file)
    if (png) frames.push(png)
  }
  if (frames.length < 2) return null
  const width = o.width ?? 960
  const gif = GIFEncoder()
  let height: number | null = null
  for (const png of frames) {
    const scale = width / png.width
    const h: number = height ?? Math.max(1, Math.round(png.height * scale))
    height = h
    const rgba = new Uint8Array(width * h * 4)
    for (let y = 0; y < h; y++) {
      const sy = Math.min(png.height - 1, Math.floor(y / scale))
      for (let x = 0; x < width; x++) {
        const sx = Math.min(png.width - 1, Math.floor(x / scale))
        const s = (sy * png.width + sx) * 4
        const d = (y * width + x) * 4
        rgba[d] = png.data[s]
        rgba[d + 1] = png.data[s + 1]
        rgba[d + 2] = png.data[s + 2]
        rgba[d + 3] = 255
      }
    }
    const palette = quantize(rgba, 256)
    gif.writeFrame(applyPalette(rgba, palette), width, h, { palette, delay: o.delayMs ?? 1500 })
  }
  gif.finish()
  try {
    writeFileSync(outFile, gif.bytes())
    return outFile
  } catch {
    return null
  }
}
