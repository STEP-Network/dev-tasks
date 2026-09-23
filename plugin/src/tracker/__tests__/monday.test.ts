/**
 * The Monday tracker's six network methods, mocked at the `executeMondayQuery`
 * and `getTaskDescriptionDoc` boundary. No network.
 *
 * Fix round 1: covers the two plan-mandated defects a review caught with zero
 * coverage — listReady filtering the status column by label text instead of
 * index (monday.ts previously wrote `compare_value: ["Ready to Start"]`; every
 * other status-column filter in this codebase — getBacklog.ts, getBugs.ts,
 * listFeedback.ts, listRetros.ts — filters by numeric index), and
 * claimIssue's status write using `{ label: "In Progress" }` instead of
 * `{ index: TASK_STATUS["In Progress"] }` (the form claimTask.ts and
 * updateTask.ts use for this exact column).
 */

import { describe, it, expect, vi, beforeEach } from "vitest"
import { BOARDS, TASK_COLUMNS, TASK_STATUS } from "../../constants.ts"

const executeMondayQuery = vi.fn()
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQuery(...args),
}))

const getTaskDescriptionDoc = vi.fn()
vi.mock("../../tools/taskDescriptionDoc.ts", () => ({
  getTaskDescriptionDoc: (...args: unknown[]) => getTaskDescriptionDoc(...args),
}))

import { createMondayTracker } from "../monday.ts"

const RAW_ITEM = {
  id: "123",
  name: "Some task",
  url: "https://example.monday.com/boards/1/pulses/123",
  updated_at: "2026-09-01T00:00:00Z",
  column_values: [
    { id: TASK_COLUMNS.status, text: "Ready to Start" },
    { id: TASK_COLUMNS.type, text: "Feature" },
  ],
}

const DESCRIPTION_DOC_RAW =
  "# Description Doc — Task #123 (doc 456)\n\nThe body.\n\n## Acceptance criteria\n\n- [ ] one"

beforeEach(() => {
  executeMondayQuery.mockReset()
  getTaskDescriptionDoc.mockReset()
  getTaskDescriptionDoc.mockResolvedValue(DESCRIPTION_DOC_RAW)
})

describe("createMondayTracker", () => {
  it("readIssue maps an item to a TrackerIssue, description stripped of the doc header, AC extracted", async () => {
    executeMondayQuery.mockResolvedValueOnce({ items: [RAW_ITEM] })

    const tracker = createMondayTracker()
    const issue = await tracker.readIssue("123")

    expect(issue.id).toBe("123")
    expect(issue.uuid).toBe("123")
    expect(issue.title).toBe("Some task")
    expect(issue.description).toBe("The body.\n\n## Acceptance criteria\n\n- [ ] one")
    expect(issue.acceptanceCriteria).toBe("- [ ] one")
    expect(issue.state).toBe("Ready to Start")
    expect(issue.labels).toEqual(["Feature"])
    expect(issue.priority).toBe(0)
    expect(getTaskDescriptionDoc).toHaveBeenCalledWith({ taskId: 123 })
  })

  it("listReady filters the status column by the Ready-to-Start INDEX, not the label text", async () => {
    executeMondayQuery.mockResolvedValueOnce({
      boards: [{ items_page: { items: [RAW_ITEM] } }],
    })

    const tracker = createMondayTracker()
    await tracker.listReady()

    expect(executeMondayQuery).toHaveBeenCalledTimes(1)
    const [query, variables] = executeMondayQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(query).toContain(`compare_value: [${TASK_STATUS["Ready to Start"]}]`)
    expect(query).not.toContain("Ready to Start") // never a label-text filter
    expect(variables).toMatchObject({ board: String(BOARDS.TASKS), column: TASK_COLUMNS.status })
  })

  it("claimIssue writes the status column by INDEX and posts a claim comment", async () => {
    executeMondayQuery.mockImplementation(async (query: string) => {
      if (query.includes("items(ids:")) return { items: [RAW_ITEM] }
      return { id: "ok" } // change_column_value / create_update — unused return
    })

    const tracker = createMondayTracker()
    await tracker.claimIssue("123", "nate")

    expect(executeMondayQuery).toHaveBeenCalledTimes(3)

    const [changeQuery, changeVars] = executeMondayQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(changeQuery).toContain("change_column_value")
    expect(changeVars.column).toBe(TASK_COLUMNS.status)
    expect(JSON.parse(changeVars.value as string)).toEqual({ index: TASK_STATUS["In Progress"] })

    const [commentQuery, commentVars] = executeMondayQuery.mock.calls[1] as [string, Record<string, unknown>]
    expect(commentQuery).toContain("create_update")
    expect(commentVars.body).toContain("claimed by nate")
  })

  it("createIssue creates the item then posts the description as an update", async () => {
    executeMondayQuery.mockImplementation(async (query: string) => {
      if (query.includes("create_item")) return { create_item: { id: "999" } }
      if (query.includes("items(ids:")) return { items: [{ ...RAW_ITEM, id: "999" }] }
      return { id: "ok" } // create_update — unused return
    })

    const tracker = createMondayTracker()
    await tracker.createIssue({ title: "New thing", description: "Do the thing" })

    expect(executeMondayQuery).toHaveBeenCalledTimes(3)

    const [createQuery, createVars] = executeMondayQuery.mock.calls[0] as [string, Record<string, unknown>]
    expect(createQuery).toContain("create_item")
    expect(createVars).toMatchObject({ board: String(BOARDS.TASKS), name: "New thing" })

    const [updateQuery, updateVars] = executeMondayQuery.mock.calls[1] as [string, Record<string, unknown>]
    expect(updateQuery).toContain("create_update")
    expect(updateVars).toMatchObject({ item: "999", body: "Do the thing" })
  })
})
