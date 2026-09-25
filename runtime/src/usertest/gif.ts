/**
 * The main journey as a GIF (WS5, spec 5: "a GIF of the main journey for
 * Look and Try work"): the desktop screenshots the session saved at each
 * step, one frame each, scaled down to `width`. Pure JavaScript (pngjs and
 * gifenc), so the minis need no ffmpeg.
 */
import { readFileSync, writeFileSync } from "node:fs"
import { applyPalette, GIFEncoder, quantize } from "gifenc"
import { PNG } from "pngjs"

export function gifFromPngs(files: readonly string[], outFile: string, o: { width?: number; delayMs?: number; maxFrames?: number } = {}): string | null {
  const frames = files.slice(0, o.maxFrames ?? 12)
  if (frames.length < 2) return null
  const width = o.width ?? 960
  const gif = GIFEncoder()
  let height: number | null = null
  for (const file of frames) {
    const png = PNG.sync.read(readFileSync(file))
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
  writeFileSync(outFile, gif.bytes())
  return outFile
}
