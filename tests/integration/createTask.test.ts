import { describe, it, expect, afterAll } from "vitest";
import { createTask, getTask, updateTask } from "@/lib/tools";
import { BOARDS } from "@/lib/constants";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("createTask", () => {
  let taskId: number;

  afterAll(async () => {
    await cleanupAll();
  });

  it("should create a task with all fields", async () => {
    const result = await createTask({
      tasks: [
        {
          name: "[TEST] Integration Test Task",
          type: "Development",
          priority: "Low",
          description: "Integration test - will be deleted",
        },
      ],
    });
    expect(result).toContain("[TEST] Integration Test Task");
    taskId = extractItemId(result);
    registerCleanup(BOARDS.TASKS, taskId);
  });

  it("should retrieve the created task with getTask", async () => {
    const result = await getTask({ itemId: taskId });
    expect(result).toContain("[TEST] Integration Test Task");
    expect(result).toContain("Development");
    expect(result).toContain("Low");
  });

  it("should update the task", async () => {
    const result = await updateTask({
      itemId: taskId,
      prLink: "https://github.com/test/pr/1",
      estimatedHours: 2,
    });
    expect(result).toContain("PR");
  });

  it("should verify updates via getTask", async () => {
    const result = await getTask({ itemId: taskId });
    expect(result).toContain("https://github.com/test/pr/1");
  });

  it("should delete the task", async () => {
    const result = await updateTask({ itemId: taskId, delete: true });
    expect(result).toContain("deleted");
  });
});
