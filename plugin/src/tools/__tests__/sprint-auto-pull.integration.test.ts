/**
 * Integration tests for the sprint auto-pull feature.
 *
 * Verifies that planActiveSprintPull's columnsToWrite actually lands inside
 * the change_multiple_column_values mutation that updateTask/claimTask issue —
 * the helper unit tests in planActiveSprintPull.test.ts only cover the helper
 * in isolation. These tests are the regression net for the wire-up:
 *
 *   - if a future refactor in claimTask.ts drops the `...pull.columnsToWrite`
 *     spread, this test catches it.
 *   - if a future refactor in updateTask.ts drops the `Object.assign` of
 *     pull.columnsToWrite, this test catches it.
 *
 * The tests spy on the mutation string that's passed to executeMondayQuery and
 * assert that it contains the expected column values. We can't easily decode
 * the buildColumnValues output back into JSON, so the assertions are on
 * substrings — that's fragile to formatting changes, but the formatting comes
 * from a stable helper and gives us coverage we wouldn't otherwise have.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMondayQueryMock = vi.fn();
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
}));

// People lookup is needed by claimTask for owner assignment.
vi.mock("../../services/people.ts", () => ({
  getPersonByUsername: vi.fn().mockResolvedValue(48307552),
}));

// Auto-version + version-state-machine are best-effort side effects in
// updateTask; mock to no-ops so they don't perturb our mutation assertions.
vi.mock("../../services/auto-version.ts", () => ({
  autoAssignVersionForTask: vi.fn().mockResolvedValue(null),
}));
vi.mock("../../services/version-state-machine.ts", () => ({
  maybeHandleBounceback: vi.fn().mockResolvedValue(null),
  recomputeAggregateForTaskVersion: vi.fn().mockResolvedValue(null),
}));

import { claimTask } from "../claimTask.ts";
import { updateTask } from "../updateTask.ts";
import { TASK_COLUMNS } from "../../constants.ts";

function activeSprintsResponse(ids: number[]) {
  return {
    boards: [
      {
        items_page: {
          items: ids.map((id) => ({ id: String(id) })),
        },
      },
    ],
  };
}

function taskWithSprintsResponse(itemId: number, linkedSprintIds: number[], status = "Ready to Start") {
  return {
    items: [
      {
        id: String(itemId),
        name: "Test Task",
        column_values: [
          { id: TASK_COLUMNS.status, text: status, value: null },
          { id: TASK_COLUMNS.agentId, text: "", value: '{"ids":[]}' },
          {
            id: TASK_COLUMNS.sprint,
            linked_items: linkedSprintIds.map((id) => ({ id: String(id), name: `Sprint ${id}` })),
          },
        ],
      },
    ],
  };
}

describe("claimTask auto-pull integration", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("merges sprint+unplanned column writes into the claim mutation when task is not in active sprint", async () => {
    // 1st query: fetch task (status, agentId, sprint columns) — task has no sprint
    executeMondayQueryMock.mockResolvedValueOnce(taskWithSprintsResponse(12345, []));
    // 2nd query: getActiveSprintIds — returns one active sprint
    executeMondayQueryMock.mockResolvedValueOnce(activeSprintsResponse([9001]));
    // 3rd query: the claim mutation (we only need it to not throw)
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "12345" } });

    const result = await claimTask({
      itemId: 12345,
      agentId: "Claude Code CLI",
      owner: "naref",
    });

    // Last call's mutation string should contain both sprint and unplanned writes
    const mutationArgs = executeMondayQueryMock.mock.calls[2][0] as string;
    expect(mutationArgs).toContain("change_multiple_column_values");
    expect(mutationArgs).toContain(TASK_COLUMNS.sprint);
    expect(mutationArgs).toContain("9001"); // active sprint id
    expect(mutationArgs).toContain(TASK_COLUMNS.unplanned);
    expect(mutationArgs).toContain("true"); // unplanned checked
    // Status to In Progress should also be in the same mutation
    expect(mutationArgs).toContain(TASK_COLUMNS.status);

    // Response should surface the auto-pull
    expect(result).toContain("Auto-pulled into active sprint:");
    expect(result).toContain("#9001");
    expect(result).toContain("Unplanned flag set:");
    expect(result).toMatch(/Unplanned flag set:\*\*\s+true/);
  });

  it("does NOT add sprint/unplanned writes when task is already in active sprint", async () => {
    executeMondayQueryMock.mockResolvedValueOnce(taskWithSprintsResponse(12345, [9001]));
    executeMondayQueryMock.mockResolvedValueOnce(activeSprintsResponse([9001]));
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "12345" } });

    const result = await claimTask({
      itemId: 12345,
      agentId: "Claude Code CLI",
      owner: "naref",
    });

    const mutationArgs = executeMondayQueryMock.mock.calls[2][0] as string;
    // The auto-pull columns must NOT appear in the mutation
    expect(mutationArgs).not.toContain(TASK_COLUMNS.sprint);
    expect(mutationArgs).not.toContain(TASK_COLUMNS.unplanned);
    // Status flip should still be present
    expect(mutationArgs).toContain(TASK_COLUMNS.status);

    expect(result).not.toContain("Auto-pulled into active sprint:");
  });

  it("hard-errors and skips the mutation when there is no active sprint at all", async () => {
    executeMondayQueryMock.mockResolvedValueOnce(taskWithSprintsResponse(12345, []));
    executeMondayQueryMock.mockResolvedValueOnce(activeSprintsResponse([])); // zero active sprints

    const result = await claimTask({
      itemId: 12345,
      agentId: "Claude Code CLI",
      owner: "naref",
    });

    // Only 2 queries should have fired — fetch + active-sprint check.
    // The claim mutation should NOT have been called.
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);
    expect(result).toContain("Error");
    expect(result).toContain("No active sprint found");
  });
});

describe("updateTask auto-pull integration", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("merges sprint+unplanned column writes into the updateTask mutation when transitioning to In Progress on out-of-sprint task", async () => {
    // 1st query: fetch task's current sprint links (the inline sprint query in updateTask) — empty
    executeMondayQueryMock.mockResolvedValueOnce({
      items: [
        {
          column_values: [
            {
              id: TASK_COLUMNS.sprint,
              linked_items: [],
            },
          ],
        },
      ],
    });
    // 2nd query: getActiveSprintIds
    executeMondayQueryMock.mockResolvedValueOnce(activeSprintsResponse([9001]));
    // 3rd query: the column-update mutation
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "12345" } });

    const result = await updateTask({
      itemId: 12345,
      status: "In Progress",
    });

    const mutationArgs = executeMondayQueryMock.mock.calls[2][0] as string;
    expect(mutationArgs).toContain("change_multiple_column_values");
    expect(mutationArgs).toContain(TASK_COLUMNS.sprint);
    expect(mutationArgs).toContain("9001");
    expect(mutationArgs).toContain(TASK_COLUMNS.unplanned);
    expect(mutationArgs).toContain(TASK_COLUMNS.status);

    expect(result).toContain("auto-pulled into active sprint");
  });

  it("respects caller-provided sprintId and does NOT auto-pull when sprint is set explicitly to active", async () => {
    // No "fetch current sprint" query happens when sprintId is set explicitly.
    // The validator path calls getActiveSprintIds directly.
    executeMondayQueryMock.mockResolvedValueOnce(activeSprintsResponse([9001]));
    // Then the mutation
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "12345" } });

    const result = await updateTask({
      itemId: 12345,
      status: "In Progress",
      sprintId: 9001,
    });

    const mutationArgs = executeMondayQueryMock.mock.calls[1][0] as string;
    // sprint should be written but unplanned should NOT (caller wasn't asked to auto-pull)
    expect(mutationArgs).toContain(TASK_COLUMNS.sprint);
    expect(mutationArgs).toContain("9001");
    expect(mutationArgs).not.toContain(TASK_COLUMNS.unplanned);
    // The response should reflect a normal sprint write, not an auto-pull
    expect(result).toContain("Sprint -> #9001");
    expect(result).not.toContain("auto-pulled");
  });

  it("does NOT trigger auto-pull when transitioning to Ready to Start (refinement phase)", async () => {
    // updateTask("Ready to Start") goes through the ready-gate, not the sprint gate.
    // We provide enough state for the gate to pass.
    executeMondayQueryMock.mockResolvedValueOnce({
      items: [
        {
          id: "12345",
          column_values: [
            { id: TASK_COLUMNS.type, text: "Feature" },
            { id: TASK_COLUMNS.priority, text: "Medium" },
            { id: TASK_COLUMNS.epic, linked_items: [{ id: "1", name: "Epic" }] },
            { id: TASK_COLUMNS.description, text: "A description" },
            { id: "long_text_mm0pqaxy", text: "Acceptance criteria" },
          ],
          subitems: [
            {
              id: "sub1",
              name: "Subtask 1",
              column_values: [
                { id: "status", text: "Needs Refinement" },
                { id: "long_text", text: "Description" },
                { id: "color_mks8t60f", text: "To Do" },
                { id: "numeric_mks8a3kf", text: "2" },
              ],
            },
          ],
        },
      ],
    });
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "12345" } });

    await updateTask({
      itemId: 12345,
      status: "Ready to Start",
    });

    // No call to getActiveSprintIds should have happened.
    const callsContainSprintActivation = executeMondayQueryMock.mock.calls.some(
      (call) => typeof call[0] === "string" && call[0].includes("sprint_activation"),
    );
    expect(callsContainSprintActivation).toBe(false);
  });
});
