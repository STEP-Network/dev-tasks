/**
 * Tests for recomputeVersionStatus's linked-task read — the Monday
 * `items(ids:)` 100-limit / silent-25-truncation class.
 *
 * The version aggregate used to inline every linked task id into one
 * `items(ids: [...])` with no `limit`. That was wrong twice over:
 *   - past 100 ids Monday rejects the query ("Argument 'ids' exceeding the
 *     100 limit"), so every status transition touching a large version
 *     reported a recompute failure;
 *   - BELOW 100 it was quietly worse — `items(ids:)` defaults to `limit: 25`
 *     however many ids you pass, so a 40-task version computed "all ready"
 *     from 25 tasks and could flip to Release Candidate with 15 still open.
 *
 * These tests assert the SHAPE of the emitted queries (chunk size + explicit
 * limit), not just that the call succeeds — a mock that returns everything
 * would pass against the broken code otherwise.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMondayQueryMock = vi.fn();
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
}));

import { recomputeVersionStatus } from "../version-state-machine.ts";
import { TASK_COLUMNS, VERSION_COLUMNS } from "../../constants.ts";

const VERSION_ID = 999;

/** First query the function issues: the version row + its linked tasks. */
function mockVersionRow(status: string, taskIds: number[]) {
  executeMondayQueryMock.mockResolvedValueOnce({
    items: [
      {
        id: String(VERSION_ID),
        name: "v1.2.3",
        column_values: [
          { id: VERSION_COLUMNS.status, text: status },
          {
            id: VERSION_COLUMNS.connectedTasks,
            text: "",
            linked_items: taskIds.map((id) => ({ id: String(id), name: `task ${id}` })),
          },
        ],
      },
    ],
  });
}

/** Every subsequent query is a chunked task read — answer it from the ids asked for. */
function answerTaskChunksFromQuery(statusFor: (id: number) => string) {
  executeMondayQueryMock.mockImplementation(async (query: string) => {
    const idsMatch = query.match(/items\(ids: \[([^\]]*)\]/);
    if (!idsMatch) return { items: [] };
    const ids = idsMatch[1]
      .split(",")
      .map((s) => Number(s.trim()))
      .filter((n) => Number.isInteger(n) && n > 0);
    return {
      items: ids.map((id) => ({
        id: String(id),
        name: `task ${id}`,
        column_values: [{ id: TASK_COLUMNS.status, text: statusFor(id) }],
      })),
    };
  });
}

function taskQueries(): string[] {
  // Call 0 is the version row; a trailing status-write mutation may follow the
  // task chunks, so select the task READS explicitly rather than by position.
  return executeMondayQueryMock.mock.calls
    .slice(1)
    .map((c) => String(c[0]))
    .filter((q) => q.includes("items(ids:") && !q.includes("mutation"));
}

function statusWrites(): string[] {
  return executeMondayQueryMock.mock.calls
    .map((c) => String(c[0]))
    .filter((q) => q.includes("change_multiple_column_values"));
}

describe("recomputeVersionStatus — linked-task read", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("passes an explicit limit so a sub-100 version is not truncated to 25", async () => {
    const ids = Array.from({ length: 40 }, (_, i) => 1000 + i);
    mockVersionRow("In Development", ids);
    answerTaskChunksFromQuery(() => "Done");

    const note = await recomputeVersionStatus(VERSION_ID);

    const queries = taskQueries();
    expect(queries).toHaveLength(1);
    // The regression: without an explicit limit Monday returns only 25 rows.
    expect(queries[0]).toMatch(/limit:\s*40/);
    // All 40 were read, so the flip is computed from the full set.
    expect(note).toContain("40/40");
  });

  it("chunks at 100 rather than sending 250 ids in one query", async () => {
    const ids = Array.from({ length: 250 }, (_, i) => 2000 + i);
    mockVersionRow("In Development", ids);
    answerTaskChunksFromQuery(() => "Done");

    const note = await recomputeVersionStatus(VERSION_ID);

    const queries = taskQueries();
    expect(queries).toHaveLength(3); // 100 + 100 + 50
    for (const q of queries) {
      const count = (q.match(/items\(ids: \[([^\]]*)\]/)?.[1] ?? "")
        .split(",")
        .filter((s) => s.trim().length > 0).length;
      expect(count).toBeLessThanOrEqual(100);
    }
    expect(note).toContain("250/250");
  });

  it("does not flip to Release Candidate when a task is still open", async () => {
    const ids = Array.from({ length: 120 }, (_, i) => 3000 + i);
    mockVersionRow("In Development", ids);
    // One straggler in the SECOND chunk — invisible to an unchunked read.
    answerTaskChunksFromQuery((id) => (id === 3110 ? "In Progress" : "Done"));

    const note = await recomputeVersionStatus(VERSION_ID);

    expect(note).toContain("119/120");
    expect(note).toContain("stays In Development");
    // No status write was issued.
    expect(statusWrites()).toHaveLength(0);
  });

  it("refuses to recompute from a short read rather than flipping on partial data", async () => {
    const ids = Array.from({ length: 30 }, (_, i) => 4000 + i);
    mockVersionRow("In Development", ids);
    // Simulate Monday returning fewer rows than asked for.
    executeMondayQueryMock.mockResolvedValueOnce({
      items: ids.slice(0, 10).map((id) => ({
        id: String(id),
        name: `task ${id}`,
        column_values: [{ id: TASK_COLUMNS.status, text: "Done" }],
      })),
    });

    const note = await recomputeVersionStatus(VERSION_ID);

    expect(note).toContain("recompute skipped");
    expect(note).toContain("read 10 of 30");
  });

  it("leaves terminal versions alone without reading any task", async () => {
    mockVersionRow("Released", [5000, 5001]);
    const note = await recomputeVersionStatus(VERSION_ID);
    expect(note).toBeNull();
    expect(taskQueries()).toHaveLength(0);
  });
});
