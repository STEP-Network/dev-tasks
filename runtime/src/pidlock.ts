/**
 * One process of a kind per mini. A second slack-bridge beside launchd's (a
 * manual `npx tsx src/slack/bridge.ts`, say) would drain the same outbox and
 * post every message twice. The lock is a file holding the holder's pid,
 * created with O_EXCL. A lock is stale when its process is gone, or when it
 * was written before this boot: after a power cut its pid can belong to any
 * process.
 */

import { closeSync, openSync, readFileSync, rmSync, statSync, writeSync } from "node:fs"
import { uptime } from "node:os"

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    // EPERM: the process exists, it is only someone else's.
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

/** The pid holding `path`, or null when nobody live holds it. */
function holderOf(path: string, pid: number): number | null {
  let text: string
  let written: number
  try {
    text = readFileSync(path, "utf8")
    written = statSync(path).mtimeMs
  } catch {
    return null
  }
  const holder = Number.parseInt(text, 10)
  const bootedAt = Date.now() - uptime() * 1000
  if (!Number.isInteger(holder) || holder === pid || written < bootedAt || !alive(holder)) return null
  return holder
}

export function takePidLock(path: string, pid: number = process.pid): { ok: true } | { ok: false; holder: number } {
  // A stale lock is removed and the create tried again. A process that wins
  // the race to re-create it in between is a live holder like any other.
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      const fd = openSync(path, "wx")
      try {
        writeSync(fd, String(pid))
      } finally {
        closeSync(fd)
      }
      return { ok: true }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
      const holder = holderOf(path, pid)
      if (holder !== null) return { ok: false, holder }
      rmSync(path, { force: true })
    }
  }
  throw new Error(`pidlock: ${path} keeps changing hands`)
}

/** Removes the lock if `pid` holds it. Never throws: it runs on the way out. */
export function releasePidLock(path: string, pid: number = process.pid): void {
  try {
    if (Number.parseInt(readFileSync(path, "utf8"), 10) === pid) rmSync(path, { force: true })
  } catch {
    // Gone already, or never ours.
  }
}
