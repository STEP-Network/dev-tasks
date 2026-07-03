import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtemp, writeFile, mkdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

const executeMondayQueryMock = vi.fn();
vi.mock("../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
}));

import {
  resolveProductEpicIds,
  findPendingDeployTasks,
  completeTask,
  run,
  resolveDefaultProductId,
} from "../../scripts/complete-released-tasks.ts";

describe("resolveProductEpicIds", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("queries the Epics board filtered by the product relation column", async () => {
    executeMondayQueryMock.mockResolvedValue({
      boards: [{ items_page: { items: [{ id: "2924897116" }, { id: "2926753018" }] } }],
    });

    const epicIds = await resolveProductEpicIds(2924964797);

    expect(epicIds).toEqual([2924897116, 2926753018]);
    const [query] = executeMondayQueryMock.mock.calls[0];
    expect(query).toContain("5091706354"); // BOARDS.EPICS
    expect(query).toContain("2924964797"); // productId in the filter rule
  });
});

describe("findPendingDeployTasks", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("queries the Tasks board filtered by status=Pending Deploy to Prod scoped to the given epics", async () => {
    executeMondayQueryMock.mockResolvedValue({
      boards: [{ items_page: { items: [{ id: "3000000001", name: "Some shipped task" }] } }],
    });

    const tasks = await findPendingDeployTasks([2924897116]);

    expect(tasks).toEqual([{ id: 3000000001, name: "Some shipped task" }]);
    const [query] = executeMondayQueryMock.mock.calls[0];
    expect(query).toContain("5091706356"); // BOARDS.TASKS
    expect(query).toContain("task_status"); // TASK_COLUMNS.status
    expect(query).toContain("task_epic"); // TASK_COLUMNS.epic
    expect(query).toContain("2924897116"); // epic scoping
  });

  it("returns an empty array when no epics are given (never sweeps the whole board unscoped)", async () => {
    const tasks = await findPendingDeployTasks([]);
    expect(tasks).toEqual([]);
    expect(executeMondayQueryMock).not.toHaveBeenCalled();
  });
});

describe("completeTask", () => {
  beforeEach(() => {
    executeMondayQueryMock.mockReset();
    executeMondayQueryMock.mockResolvedValue({});
  });

  it("flips the task status to Done via a label-based mutation", async () => {
    await completeTask(3000000001, "v0.32.0");

    const statusMutation = executeMondayQueryMock.mock.calls[0][0];
    expect(statusMutation).toContain("change_multiple_column_values");
    expect(statusMutation).toContain("5091706356"); // BOARDS.TASKS
    expect(statusMutation).toContain("3000000001");
    expect(statusMutation).toContain('\\"label\\":\\"Done\\"'); // buildColumnValues double-JSON-encodes
  });

  it("posts an update citing the release identifier", async () => {
    await completeTask(3000000001, "v0.32.0");

    const updateMutation = executeMondayQueryMock.mock.calls[1][0];
    expect(updateMutation).toContain("create_update");
    expect(updateMutation).toContain("3000000001");
    expect(updateMutation).toContain("v0.32.0");
    expect(updateMutation).toContain("release automation");
  });

  it("posts a sensible update when no release identifier is given", async () => {
    await completeTask(3000000001);

    const updateMutation = executeMondayQueryMock.mock.calls[1][0];
    expect(updateMutation).toContain("release automation");
  });

  it("safely escapes a release identifier containing quotes and backslashes", async () => {
    const maliciousReleaseId = 'v1.0.0" } } mutation evil { delete_item(item_id: 1) { id } } query { __typename';

    await expect(completeTask(3000000001, maliciousReleaseId)).resolves.not.toThrow();

    const updateMutation = executeMondayQueryMock.mock.calls[1][0];
    const expectedBody = `<p>Completed by release automation (release ${maliciousReleaseId}).</p>`;
    // The body argument must be the properly JSON-escaped form of the note —
    // every embedded `"` backslash-escaped — so the payload can never
    // terminate the GraphQL string literal early and inject sibling operations.
    expect(updateMutation).toContain(JSON.stringify(expectedBody));
  });
});

describe("run", () => {
  const EPICS_PAGE = { boards: [{ items_page: { items: [{ id: "2924897116" }] } }] };
  const TWO_TASKS_PAGE = {
    boards: [{ items_page: { items: [{ id: "3000000001", name: "Task A" }, { id: "3000000002", name: "Task B" }] } }],
  };
  const NO_TASKS_PAGE = { boards: [{ items_page: { items: [] } }] };

  beforeEach(() => {
    executeMondayQueryMock.mockReset();
  });

  it("completes every candidate task found for the product", async () => {
    executeMondayQueryMock
      .mockResolvedValueOnce(EPICS_PAGE)
      .mockResolvedValueOnce(TWO_TASKS_PAGE)
      .mockResolvedValueOnce({}) // task A status mutation
      .mockResolvedValueOnce({}) // task A update
      .mockResolvedValueOnce({}) // task B status mutation
      .mockResolvedValueOnce({}); // task B update

    const summary = await run({ productId: 2924964797, releaseId: "v0.32.0" });

    expect(summary.candidateCount).toBe(2);
    expect(summary.results).toEqual([
      { taskId: 3000000001, taskName: "Task A", outcome: "completed" },
      { taskId: 3000000002, taskName: "Task B", outcome: "completed" },
    ]);
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(6);
  });

  it("is idempotent — no candidates at Pending Deploy to Prod means nothing is touched", async () => {
    executeMondayQueryMock
      .mockResolvedValueOnce(EPICS_PAGE)
      .mockResolvedValueOnce(NO_TASKS_PAGE);

    const summary = await run({ productId: 2924964797 });

    expect(summary.candidateCount).toBe(0);
    expect(summary.results).toEqual([]);
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2); // just the two read queries, no mutations
  });

  it("is fail-soft — one task's mutation error doesn't stop the rest of the sweep", async () => {
    executeMondayQueryMock
      .mockResolvedValueOnce(EPICS_PAGE)
      .mockResolvedValueOnce(TWO_TASKS_PAGE)
      .mockRejectedValueOnce(new Error("Monday API error: 500")) // task A status mutation fails
      .mockResolvedValueOnce({}) // task B status mutation
      .mockResolvedValueOnce({}); // task B update

    const summary = await run({ productId: 2924964797 });

    expect(summary.candidateCount).toBe(2);
    expect(summary.results).toEqual([
      { taskId: 3000000001, taskName: "Task A", outcome: "failed", error: "Monday API error: 500" },
      { taskId: 3000000002, taskName: "Task B", outcome: "completed" },
    ]);
  });
});

describe("resolveDefaultProductId", () => {
  let dir: string;

  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "complete-released-tasks-test-"));
  });

  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("resolves productId from .claude/project-config.json, coercing a string value to a number", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(
      join(dir, ".claude", "project-config.json"),
      JSON.stringify({ monday: { productId: "2924964797" } }),
    );

    await expect(resolveDefaultProductId(dir)).resolves.toBe(2924964797);
  });

  it("throws a clear error when .claude/project-config.json is missing", async () => {
    await expect(resolveDefaultProductId(dir)).rejects.toThrow(/project-config\.json/i);
  });

  it("throws a clear error when monday.productId is absent from the config", async () => {
    await mkdir(join(dir, ".claude"), { recursive: true });
    await writeFile(join(dir, ".claude", "project-config.json"), JSON.stringify({ monday: {} }));

    await expect(resolveDefaultProductId(dir)).rejects.toThrow(/monday\.productId/i);
  });
});
