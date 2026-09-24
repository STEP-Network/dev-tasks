/**
 * A directory queue: one JSON file per entry, keyed so that a second put of
 * the same key is a no-op. Slack redelivers events, and it sends two copies of
 * a message that mentions the bot (app_mention AND message); both get the key
 * `msg:<channel>:<ts>`, so the queue keeps one.
 *
 *   <dir>/new/<key>.json      waiting
 *   <dir>/done/<key>.json     handled (agentd deletes them after 14 days)
 *   <dir>/failed/<key>.json   given up on (kept for a person to read)
 *   <dir>/tmp/                staging, so readers never see half a file
 */

import { existsSync, linkSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs"
import { randomUUID } from "node:crypto"
import { dirname, join } from "node:path"

export function safeKey(key: string): string {
  return key.replace(/[^A-Za-z0-9._-]/g, "_").slice(0, 180)
}

export function writeJsonAtomic(path: string, data: unknown): void {
  mkdirSync(dirname(path), { recursive: true })
  const tmp = `${path}.${process.pid}.${randomUUID()}.tmp`
  writeFileSync(tmp, JSON.stringify(data, null, 1))
  renameSync(tmp, path)
}

export function readJson<T>(path: string): T | null {
  try {
    return JSON.parse(readFileSync(path, "utf8")) as T
  } catch {
    return null
  }
}

export function entryPath(dir: string, key: string, sub: "new" | "done" | "failed" = "new"): string {
  return join(dir, sub, `${safeKey(key)}.json`)
}

/** true when the key is new. false when it is waiting, handled or failed already. */
export function putOnce(dir: string, key: string, payload: unknown): boolean {
  for (const sub of ["new", "done", "failed", "tmp"]) mkdirSync(join(dir, sub), { recursive: true })
  if (existsSync(entryPath(dir, key, "done")) || existsSync(entryPath(dir, key, "failed"))) return false
  const tmp = join(dir, "tmp", `${safeKey(key)}.${process.pid}.${randomUUID()}`)
  writeFileSync(tmp, JSON.stringify(payload, null, 1))
  try {
    // link() fails if the name exists, atomically: two racing puts cannot both win.
    linkSync(tmp, entryPath(dir, key))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") return false
    throw error
  } finally {
    rmSync(tmp, { force: true })
  }
}

export function listNew<T>(dir: string): Array<{ key: string; payload: T }> {
  const newDir = join(dir, "new")
  if (!existsSync(newDir)) return []
  const entries: Array<{ key: string; payload: T }> = []
  for (const name of readdirSync(newDir).filter((f) => f.endsWith(".json")).sort()) {
    const payload = readJson<T>(join(newDir, name))
    if (payload !== null) entries.push({ key: name.slice(0, -".json".length), payload })
  }
  return entries
}

function move(dir: string, key: string, to: "done" | "failed"): boolean {
  mkdirSync(join(dir, to), { recursive: true })
  try {
    renameSync(entryPath(dir, key), entryPath(dir, key, to))
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return false
    throw error
  }
}

export function ack(dir: string, key: string): boolean {
  return move(dir, key, "done")
}

export function fail(dir: string, key: string): boolean {
  return move(dir, key, "failed")
}

export function countIn(dir: string, sub: "new" | "done" | "failed"): number {
  const path = join(dir, sub)
  return existsSync(path) ? readdirSync(path).filter((f) => f.endsWith(".json")).length : 0
}
