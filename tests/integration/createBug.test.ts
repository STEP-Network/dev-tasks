import { describe, it, expect, afterAll } from "vitest";
import { createBug, getBugs } from "@/lib/tools";
import { BOARDS } from "@/lib/constants";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("createBug", () => {
  let bugId: number;

  afterAll(async () => {
    await cleanupAll();
  });

  it("should create a bug", async () => {
    const result = await createBug({
      name: "[TEST] Integration Test Bug",
      description: "Steps to reproduce: This is an integration test bug",
      priority: "Low",
    });
    expect(result).toContain("[TEST] Integration Test Bug");
    bugId = extractItemId(result);
    registerCleanup(BOARDS.BUGS, bugId);
  });

  it("should appear in getBugs search", async () => {
    const result = await getBugs({ search: "[TEST] Integration Test Bug", limit: 25 });
    expect(result).toContain("[TEST] Integration Test Bug");
  });
});
