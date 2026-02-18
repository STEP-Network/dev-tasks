import { describe, it, expect } from "vitest";
import { getSprint } from "@/lib/tools/getSprint";

describe("getSprint", () => {
  it("returns the active sprint when called with no args", async () => {
    const result = await getSprint({});

    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");

    // Should either return a sprint or an error about no active sprint
    if (result.includes("# Error")) {
      expect(result).toContain("No active sprint found");
    } else {
      expect(result).toContain("# Sprint:");
      expect(result).toContain("(Active)");
    }
  });

  it("contains sprint name, goals, timeline, and connected tasks", async () => {
    const result = await getSprint({});

    // Skip if no active sprint
    if (result.includes("# Error")) return;

    // Sprint name in heading
    expect(result).toMatch(/# Sprint: .+/);

    // Goals section
    expect(result).toContain("## Goals");

    // Timeline section
    expect(result).toContain("## Timeline");
    expect(result).toContain("**Completion:**");

    // Tasks section (may or may not have tasks)
    expect(result).toContain("## Progress");
    expect(result).toContain("**Total Tasks:**");
  });

  it("contains progress stats", async () => {
    const result = await getSprint({});

    // Skip if no active sprint
    if (result.includes("# Error")) return;

    // Progress section with stats
    expect(result).toContain("## Progress");
    expect(result).toContain("**Total Tasks:**");
    expect(result).toContain("**Estimated Hours:**");
    expect(result).toContain("**Actual Hours:**");

    // If there are tasks, the Tasks section should be present
    const totalMatch = result.match(/\*\*Total Tasks:\*\* (\d+)/);
    if (totalMatch && parseInt(totalMatch[1]) > 0) {
      expect(result).toContain("## Tasks");
      // Each task should have status details
      expect(result).toContain("Status:");
      expect(result).toContain("Priority:");
    }
  });
});
