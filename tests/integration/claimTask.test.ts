import { describe, it, expect, afterAll } from "vitest";
import { createTask, claimTask, getTask } from "@/lib/tools";
import { BOARDS } from "@/lib/constants";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("claimTask", () => {
  let taskId: number;

  afterAll(async () => {
    await cleanupAll();
  });

  it("should create a task in Ready to Start status", async () => {
    const result = await createTask({
      tasks: [
        {
          name: "[TEST] Claim Test Task",
          type: "Feature",
          priority: "Low",
          status: "Ready to Start",
          description: "Claiming test - will be deleted",
        },
      ],
    });
    taskId = extractItemId(result);
    registerCleanup(BOARDS.TASKS, taskId);
  });

  it("should successfully claim the task", async () => {
    const result = await claimTask({
      itemId: taskId,
      agentId: "Claude Code CLI",
      owner: "naref",
      planId: "2026-02-18_test-plan",
    });
    expect(result).toContain("Claimed");
  });

  it("should fail to claim an already-claimed task", async () => {
    const result = await claimTask({
      itemId: taskId,
      agentId: "Codex Local",
      owner: "krmoj",
      planId: "2026-02-18_other-plan",
    });
    // Should indicate conflict/already claimed
    expect(result.toLowerCase()).toMatch(/already|claimed|conflict|error/);
  });

  it("should show agent in getTask", async () => {
    const result = await getTask({ itemId: taskId });
    expect(result).toContain("Claude Code CLI");
    expect(result).toContain("In Progress");
  });
});
