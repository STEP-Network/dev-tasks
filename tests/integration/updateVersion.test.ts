import { describe, it, expect, afterAll } from "vitest";
import { createTask, updateVersion } from "@/lib/tools";
import { BOARDS } from "@/lib/constants";
import { executeMondayQuery } from "@/lib/monday-client";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("updateVersion", () => {
  let versionId: number;
  let taskId: number;

  afterAll(async () => {
    await cleanupAll();
  });

  it("should find an existing version", async () => {
    // Query the Versions board to find any existing version
    const query = `query { boards(ids: [${BOARDS.VERSIONS}]) { items_page(limit: 1) { items { id name } } } }`;
    const response = await executeMondayQuery<any>(query);
    const items = response.boards?.[0]?.items_page?.items;
    expect(items?.length).toBeGreaterThan(0);
    versionId = parseInt(items[0].id, 10);
  });

  it("should create a test task to link", async () => {
    const result = await createTask({
      tasks: [
        {
          name: "[TEST] Version Link Task",
          type: "Feature",
          priority: "Low",
        },
      ],
    });
    taskId = extractItemId(result);
    registerCleanup(BOARDS.TASKS, taskId);
  });

  it("should link task to version", async () => {
    const result = await updateVersion({
      versionId,
      linkTaskIds: [taskId],
    });
    expect(result).toBeTruthy();
  });
});
