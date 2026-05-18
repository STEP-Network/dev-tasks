/**
 * Tests for planActiveSprintPull — the auto-pull-into-active-sprint helper
 * that gates non-refinement status transitions in updateTask/claimTask.
 *
 * Mocks executeMondayQuery so each test fully controls active-sprint state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMondayQueryMock = vi.fn();
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
}));

import { planActiveSprintPull } from "../utils.ts";
import { TASK_COLUMNS } from "../../constants.ts";

function mockActiveSprints(ids: number[]) {
  executeMondayQueryMock.mockResolvedValueOnce({
    boards: [
      {
        items_page: {
          items: ids.map((id) => ({ id: String(id) })),
        },
      },
    ],
  });
}

describe("planActiveSprintPull", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("errors when no active sprint exists", async () => {
    mockActiveSprints([]);
    const plan = await planActiveSprintPull([]);
    expect(plan.error).toMatch(/No active sprint found/);
    expect(plan.wasInActiveSprint).toBe(false);
    expect(plan.columnsToWrite).toEqual({});
  });

  it("returns wasInActiveSprint=true with no column writes when task already in active sprint", async () => {
    mockActiveSprints([9001]);
    const plan = await planActiveSprintPull([9001]);
    expect(plan.wasInActiveSprint).toBe(true);
    expect(plan.markedUnplanned).toBe(false);
    expect(plan.columnsToWrite).toEqual({});
    expect(plan.error).toBeUndefined();
  });

  it("pulls into the active sprint and marks unplanned when task is in a non-active sprint", async () => {
    mockActiveSprints([9001]);
    const plan = await planActiveSprintPull([8999]);
    expect(plan.wasInActiveSprint).toBe(false);
    expect(plan.pulledIntoSprintId).toBe(9001);
    expect(plan.markedUnplanned).toBe(true);
    expect(plan.columnsToWrite[TASK_COLUMNS.sprint]).toEqual({ item_ids: [9001] });
    expect(plan.columnsToWrite[TASK_COLUMNS.unplanned]).toEqual({ checked: "true" });
  });

  it("pulls into the active sprint when task has no sprint at all", async () => {
    mockActiveSprints([9001]);
    const plan = await planActiveSprintPull([]);
    expect(plan.wasInActiveSprint).toBe(false);
    expect(plan.pulledIntoSprintId).toBe(9001);
    expect(plan.markedUnplanned).toBe(true);
  });

  it("picks the first active sprint and warns when multiple are active", async () => {
    mockActiveSprints([9001, 9002, 9003]);
    const plan = await planActiveSprintPull([]);
    expect(plan.pulledIntoSprintId).toBe(9001);
    expect(plan.warning).toMatch(/Multiple active sprints/);
    expect(plan.warning).toMatch(/#9001, #9002, #9003/);
    expect(plan.warning).toMatch(/pulled into #9001/);
  });

  it("does NOT warn when only one active sprint exists", async () => {
    mockActiveSprints([9001]);
    const plan = await planActiveSprintPull([]);
    expect(plan.warning).toBeUndefined();
  });

  it("skips the unplanned column write when skipUnplannedFlag=true (caller is setting unplanned explicitly)", async () => {
    mockActiveSprints([9001]);
    const plan = await planActiveSprintPull([], { skipUnplannedFlag: true });
    expect(plan.pulledIntoSprintId).toBe(9001);
    expect(plan.markedUnplanned).toBe(false);
    expect(plan.columnsToWrite[TASK_COLUMNS.sprint]).toEqual({ item_ids: [9001] });
    expect(plan.columnsToWrite[TASK_COLUMNS.unplanned]).toBeUndefined();
  });

  it("treats any overlap between linked sprints and active sprints as already-in-active (multi-link, multi-active)", async () => {
    mockActiveSprints([9001, 9002]);
    const plan = await planActiveSprintPull([8999, 9002]);
    expect(plan.wasInActiveSprint).toBe(true);
    expect(plan.columnsToWrite).toEqual({});
  });
});
