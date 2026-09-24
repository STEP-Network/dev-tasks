import { mkdirSync, mkdtempSync, readdirSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { dirname, join } from "node:path"
import { describe, expect, it } from "vitest"
import { ack, countIn, fail, listNew, putOnce, readJson, safeKey, writeJsonAtomic } from "../fsq.ts"

const dir = () => mkdtempSync(join(tmpdir(), "fsq-"))

describe("putOnce", () => {
  it("takes a key once, whether the first copy is waiting or already handled", () => {
    const q = dir()
    expect(putOnce(q, "msg:C1:1727.001", { n: 1 })).toBe(true)
    expect(putOnce(q, "msg:C1:1727.001", { n: 2 })).toBe(false)
    expect(ack(q, "msg:C1:1727.001")).toBe(true)
    expect(putOnce(q, "msg:C1:1727.001", { n: 3 })).toBe(false)
    expect(listNew(q)).toEqual([])
  })

  it("keeps the first payload, not the second", () => {
    const q = dir()
    putOnce(q, "k", { n: 1 })
    putOnce(q, "k", { n: 2 })
    expect(listNew<{ n: number }>(q)).toEqual([{ key: "k", payload: { n: 1 } }])
  })
})

describe("listNew, ack and fail", () => {
  it("lists in key order, skips a corrupt file, and moves entries on ack and fail", () => {
    const q = dir()
    putOnce(q, "0002", { n: 2 })
    putOnce(q, "0001", { n: 1 })
    mkdirSync(join(q, "new"), { recursive: true })
    writeFileSync(join(q, "new", "0003.json"), "{not json")
    expect(listNew<{ n: number }>(q).map((e) => e.payload.n)).toEqual([1, 2])
    expect(fail(q, "0002")).toBe(true)
    expect(countIn(q, "failed")).toBe(1)
    expect(ack(q, "0001")).toBe(true)
    expect(ack(q, "0001")).toBe(false)
    expect(countIn(q, "done")).toBe(1)
  })

  it("makes any key a safe file name", () => {
    expect(safeKey("msg:C1:1727.001/x y")).toBe("msg_C1_1727.001_x_y")
  })
})

describe("writeJsonAtomic and readJson", () => {
  it("round-trip, create the directory, and read a missing file as null", () => {
    const path = join(dir(), "a", "b", "state.json")
    writeJsonAtomic(path, { ok: true })
    expect(readJson(path)).toEqual({ ok: true })
    expect(readJson(join(dir(), "missing.json"))).toBeNull()
    expect(readdirSync(dirname(path))).toEqual(["state.json"])
  })
})
