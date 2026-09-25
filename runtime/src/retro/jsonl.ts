/**
 * The retro's two JSONL files (STEP-3290): state/lessons.jsonl, which every
 * worker, agentd, the Slack bridge and the retro append to, and
 * state/retros.jsonl. A read-then-append (the lessons' dedupe by key) and
 * agentd's daily pruning each hold a lock file beside the file while they
 * run, so neither writes a line twice nor loses another process's line.
 */

import { closeSync, existsSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync, writeSync } from "node:fs"

const WAIT_MS = 15_000
/** Held longer than this, the lock is a holder that died mid-write. The work it guards takes milliseconds. */
const STALE_MS = 10_000
const DAY = 86_400_000

const pause = (ms: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms)

/** Runs `fn` holding `<file>.lock`, created with O_EXCL. Throws when another holder keeps it past WAIT_MS. */
export function withFileLock<T>(file: string, fn: () => T): T {
  const lock = `${file}.lock`
  const deadline = Date.now() + WAIT_MS
  for (;;) {
    try {
      const fd = openSync(lock, "wx")
      writeSync(fd, String(process.pid))
      closeSync(fd)
      break
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      try {
        if (Date.now() - statSync(lock).mtimeMs > STALE_MS) rmSync(lock, { force: true })
      } catch {
        // Released between the open and the stat.
      }
      if (Date.now() > deadline) throw new Error(`${lock} is still held after ${WAIT_MS / 1000} seconds`)
      pause(20)
    }
  }
  try {
    return fn()
  } finally {
    rmSync(lock, { force: true })
  }
}

/**
 * Keeps the lines of the last `days` days, by each line's `at`, and of those
 * at most the last `max`. A line that is not JSON with an `at` goes: the
 * readers skip it anyway. Returns how many lines went.
 */
export function pruneJsonl(file: string, keep: { days: number; max: number }, now: Date): number {
  if (!existsSync(file)) return 0
  return withFileLock(file, () => {
    const lines = readFileSync(file, "utf8").split("\n").filter((line) => line.trim())
    const from = now.getTime() - keep.days * DAY
    const kept = lines
      .filter((line) => {
        try {
          const at = Date.parse((JSON.parse(line) as { at?: unknown }).at as string)
          return Number.isFinite(at) && at >= from
        } catch {
          return false
        }
      })
      .slice(-keep.max)
    if (kept.length === lines.length) return 0
    const tmp = `${file}.${process.pid}.tmp`
    writeFileSync(tmp, kept.length ? `${kept.join("\n")}\n` : "")
    renameSync(tmp, file)
    return lines.length - kept.length
  })
}
