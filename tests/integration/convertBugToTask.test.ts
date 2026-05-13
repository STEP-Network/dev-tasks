import { describe, it, expect, afterAll } from "vitest";
import { createBug, convertBugToTask, getTask } from "@/lib/tools";
import { BOARDS } from "@/lib/constants";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("convertBugToTask", () => {
  let bugId: number;
  let taskId: number;

  afterAll(async () => {
    await cleanupAll();
  });

  it("should create a test bug", async () => {
    const result = await createBug({
      name: "[TEST] Bug to Convert",
      description: "This bug will be converted to a task",
      priority: "Medium",
    });
    bugId = extractItemId(result);
    registerCleanup(BOARDS.BUGS, bugId);
  });

  it("should convert bug to task", async () => {
    const result = await convertBugToTask({ bugId });
    expect(result).toContain("[TEST] Bug to Convert");
    taskId = extractItemId(result);
    registerCleanup(BOARDS.TASKS, taskId);
  });

  it("should verify the new task has type=Fix", async () => {
    const result = await getTask({ itemId: taskId });
    expect(result).toContain("Fix");
    expect(result).toContain("[TEST] Bug to Convert");
  });
});
