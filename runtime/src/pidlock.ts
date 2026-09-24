/**
 * One process of a kind per mini. A second slack-bridge beside launchd's (a
 * manual `npx tsx src/slack/bridge.ts`, say) would drain the same outbox and
 * post every message twice. The lock is a file holding the holder's pid. It
 * counts only while that pid is alive AND its command line still names the
 * holder's kind (`marker`): after a crash or a power cut the old pid can
 * belong to any process, and no clock is involved in telling.
 */

import { execFileSync } from "node:child_process"
import { randomUUID } from "node:crypto"
import { linkSync, readFileSync, rmSync, writeFileSync } from "node:fs"

/** A live process's command line, or null when there is no such process. agentd asks it of its workers too. */
export function commandOf(pid: number): string | null {
  try {
    return execFileSync("ps", ["-p", String(pid), "-o", "command="], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] })
  } catch {
    return null // ps exits 1 when there is no such process
  }
}

/** The pid holding `path`, or null when no live process of the marker's kind does. */
function holderOf(path: string, marker: string, pid: number): number | null {
  let holder: number
  try {
    holder = Number.parseInt(readFileSync(path, "utf8"), 10)
  } catch {
    return null
  }
  if (!Number.isInteger(holder) || holder <= 0 || holder === pid) return null
  return commandOf(holder)?.includes(marker) ? holder : null
}

export function takePidLock(path: string, marker: string, pid: number = process.pid): { ok: true } | { ok: false; holder: number } {
  // The pid is written first and linked into place, so no reader ever sees
  // an empty lock. A stale lock is removed and the link tried again; a
  // process that wins the race to re-create it in between is a live holder.
  const tmp = `${path}.${pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, String(pid))
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        linkSync(tmp, path)
        return { ok: true }
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error
        const holder = holderOf(path, marker, pid)
        if (holder !== null) return { ok: false, holder }
        rmSync(path, { force: true })
      }
    }
    throw new Error(`pidlock: ${path} keeps changing hands`)
  } finally {
    rmSync(tmp, { force: true })
  }
}

/** Removes the lock if `pid` holds it. Never throws: it runs on the way out. */
export function releasePidLock(path: string, pid: number = process.pid): void {
  try {
    if (Number.parseInt(readFileSync(path, "utf8"), 10) === pid) rmSync(path, { force: true })
  } catch {
    // Gone already, or never ours.
  }
}
