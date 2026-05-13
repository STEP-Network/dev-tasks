import { describe, it, expect, afterAll } from "vitest";
import { createTask, getTask, manageSubtasks } from "@/lib/tools";
import { BOARDS } from "@/lib/constants";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("manageSubtasks", () => {
  let parentId: number;

  afterAll(async () => {
    await cleanupAll();
  });

  it("should create a parent task", async () => {
    const result = await createTask({
      tasks: [
        {
          name: "[TEST] Subtask Parent",
          type: "Feature",
          priority: "Low",
        },
      ],
    });
    parentId = extractItemId(result);
    registerCleanup(BOARDS.TASKS, parentId);
  });

  it("should create subtasks", async () => {
    const result = await manageSubtasks({
      parentItemId: parentId,
      operations: [
        { action: "create", name: "Backend implementation", type: "Backend", estimatedHours: 2 },
        { action: "create", name: "Write tests", type: "Test", estimatedHours: 1 },
        { action: "create", name: "Write docs", type: "Documentation", estimatedHours: 0.5 },
      ],
    });
    expect(result).toContain("Backend implementation");
    expect(result).toContain("Write tests");
    expect(result).toContain("Write docs");
  });

  it("should show subtasks in getTask", async () => {
    const result = await getTask({ itemId: parentId });
    expect(result).toContain("Backend implementation");
    expect(result).toContain("Write tests");
    expect(result).toContain("Write docs");
  });

  it("should update a subtask by name", async () => {
    const result = await manageSubtasks({
      parentItemId: parentId,
      operations: [
        { action: "update", subtaskName: "Backend implementation", status: "In Progress", actualHours: 1.5 },
      ],
    });
    expect(result).toContain("Backend implementation");
  });

  it("should delete a subtask by name", async () => {
    const result = await manageSubtasks({
      parentItemId: parentId,
      operations: [
        { action: "delete", subtaskName: "Write docs" },
      ],
    });
    expect(result.toLowerCase()).toContain("delet");
  });

  it("should show only 2 subtasks remaining", async () => {
    const result = await getTask({ itemId: parentId });
    expect(result).toContain("Backend implementation");
    expect(result).toContain("Write tests");
    expect(result).not.toContain("Write docs");
  });
});
