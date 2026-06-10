/**
 * Tests for the per-task CI Gate plumbing (v0.26.0):
 *  - getTask returns ciGate (empty column → "Full")
 *  - updateTask({ ciGate }) writes the column label-based with
 *    create_labels_if_missing
 *  - claimTask surfaces the gate value in the claim response
 *
 * Mocks executeMondayQuery (and the People lookup for claimTask) so each
 * test fully controls Monday-side state.
 */

import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMondayQueryMock = vi.fn();
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
  DOC_API_VERSION: "2026-01",
}));
vi.mock("../../services/people.ts", () => ({
  getPersonByUsername: vi.fn().mockResolvedValue(424242),
}));

import { getTask } from "../getTask.ts";
import { updateTask } from "../updateTask.ts";
import { claimTask } from "../claimTask.ts";
import { TASK_COLUMNS, CI_GATE, isCiGateSkip } from "../../constants.ts";

function taskItemResponse(columnValues: any[]) {
  return {
    items: [
      {
        id: "111",
        name: "Test task",
        created_at: "2026-06-10T00:00:00Z",
        column_values: columnValues,
        subitems: [],
      },
    ],
  };
}

describe("CI Gate constants", () => {
  it("isCiGateSkip matches only the two Skip labels", () => {
    expect(isCiGateSkip(CI_GATE.SKIP_HUMAN)).toBe(true);
    expect(isCiGateSkip(CI_GATE.SKIP_AGENT)).toBe(true);
    expect(isCiGateSkip(CI_GATE.FULL)).toBe(false);
    expect(isCiGateSkip("")).toBe(false);
    expect(isCiGateSkip(undefined)).toBe(false);
  });
});

describe("getTask ciGate", () => {
  beforeEach(() => executeMondayQueryMock.mockReset());

  it("returns Full when the CI Gate column is empty/absent", async () => {
    executeMondayQueryMock.mockResolvedValueOnce(
      taskItemResponse([
        { id: TASK_COLUMNS.status, text: "In Progress", value: null },
      ]),
    );
    const result = await getTask({ itemId: 111, format: "json" });
    const detail = JSON.parse(result);
    expect(detail.ciGate).toBe("Full");
  });

  it("returns the column label when set", async () => {
    executeMondayQueryMock.mockResolvedValueOnce(
      taskItemResponse([
        { id: TASK_COLUMNS.status, text: "In Progress", value: null },
        { id: TASK_COLUMNS.ciGate, text: "Skip (agent)", value: "{}" },
      ]),
    );
    const result = await getTask({ itemId: 111, format: "json" });
    const detail = JSON.parse(result);
    expect(detail.ciGate).toBe("Skip (agent)");
  });

  it("renders the gate in markdown output", async () => {
    executeMondayQueryMock.mockResolvedValueOnce(
      taskItemResponse([
        { id: TASK_COLUMNS.status, text: "In Progress", value: null },
        { id: TASK_COLUMNS.ciGate, text: "Skip (human)", value: "{}" },
      ]),
    );
    const result = await getTask({ itemId: 111 });
    expect(result).toContain("**CI Gate:** Skip (human)");
    expect(result).toContain("RED check still blocks merge");
  });
});

describe("updateTask ciGate", () => {
  beforeEach(() => executeMondayQueryMock.mockReset());

  it("writes the column label-based with create_labels_if_missing", async () => {
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "111" } });
    const result = await updateTask({ itemId: 111, ciGate: "Skip (agent)" } as any);

    expect(result).toContain("CI Gate -> Skip (agent)");
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(1);
    const mutation = executeMondayQueryMock.mock.calls[0][0] as string;
    expect(mutation).toContain("create_labels_if_missing: true");
    // buildColumnValues double-stringifies; assert on the escaped inner JSON.
    expect(mutation).toContain(`\\"${TASK_COLUMNS.ciGate}\\"`);
    expect(mutation).toContain('Skip (agent)');
  });

  it("does not touch the column when ciGate is not passed", async () => {
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "111" } });
    await updateTask({ itemId: 111, priority: "High" } as any);
    const mutation = executeMondayQueryMock.mock.calls[0][0] as string;
    expect(mutation).not.toContain(TASK_COLUMNS.ciGate);
  });
});

describe("claimTask ciGate", () => {
  beforeEach(() => executeMondayQueryMock.mockReset());

  function mockClaimSequence(ciGateText: string | null) {
    // 1. Task fetch
    executeMondayQueryMock.mockResolvedValueOnce({
      items: [
        {
          id: "111",
          name: "Test task",
          column_values: [
            { id: TASK_COLUMNS.status, text: "Ready to Start", value: null },
            { id: TASK_COLUMNS.agentId, text: "", value: null },
            { id: TASK_COLUMNS.sprint, linked_items: [{ id: "9001", name: "Sprint" }] },
            ...(ciGateText !== null
              ? [{ id: TASK_COLUMNS.ciGate, text: ciGateText, value: "{}" }]
              : []),
          ],
        },
      ],
    });
    // 2. planActiveSprintPull — active sprint matches the linked sprint
    executeMondayQueryMock.mockResolvedValueOnce({
      boards: [{ items_page: { items: [{ id: "9001" }] } }],
    });
    // 3. Claim mutation
    executeMondayQueryMock.mockResolvedValueOnce({ change_multiple_column_values: { id: "111" } });
  }

  it("surfaces a Skip gate with the mirror instruction", async () => {
    mockClaimSequence("Skip (human)");
    const result = await claimTask({
      itemId: 111,
      agentId: "Claude Code CLI",
      owner: "nate",
    } as any);
    expect(result).toContain("**CI Gate:** Skip (human)");
    expect(result).toContain("mirror into active-task.json");
  });

  it("reports Full (without mirror instruction) when the column is empty", async () => {
    mockClaimSequence(null);
    const result = await claimTask({
      itemId: 111,
      agentId: "Claude Code CLI",
      owner: "nate",
    } as any);
    expect(result).toContain("**CI Gate:** Full");
    expect(result).not.toContain("mirror into active-task.json");
  });
});
