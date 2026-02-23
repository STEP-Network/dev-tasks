import { describe, it, expect } from "vitest";
import { getBacklog } from "@/lib/tools/getBacklog";

describe("getBacklog", () => {
  it("returns a markdown string with tasks when called with no filters", async () => {
    const result = await getBacklog({});

    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    // Default filter shows Backlog + Ready to Start
    expect(result).toContain("# Backlog");
    expect(result).toContain("status: Backlog + Ready to Start");
    // Should contain task formatting
    expect(result).toMatch(/tasks/);
  });

  it("filters tasks by a specific status", async () => {
    const result = await getBacklog({ status: "Ready to Start" });

    expect(result).toBeTruthy();
    expect(result).toContain("# Backlog");
    expect(result).toContain("status: Ready to Start");
    // If tasks are returned, they should show the status
    if (!result.includes("No tasks found")) {
      expect(result).toContain("Status: Ready to Start");
    }
  });

  it("filters to unclaimed tasks only", async () => {
    const result = await getBacklog({ unclaimedOnly: true });

    expect(result).toBeTruthy();
    expect(result).toContain("# Backlog");
    expect(result).toContain("unclaimed only");
    // Unclaimed tasks should not have an agent assigned (shown as "—")
    if (!result.includes("No tasks found")) {
      // Every listed task should have Agent: —
      const agentMatches = result.match(/Agent: .+/g) || [];
      for (const match of agentMatches) {
        expect(match).toBe("Agent: —");
      }
    }
  });

  it("filters tasks by productId", async () => {
    // STEPhie product
    const result = await getBacklog({ productId: 2730518827 });

    expect(result).toBeTruthy();
    expect(result).toContain("# Backlog");
    expect(result).toContain("product: #2730518827");
    // If tasks are found, they should show Product in output
    if (!result.includes("No tasks found") && !result.includes("No epics found")) {
      expect(result).toContain("Product:");
    }
  });

  it("returns empty when productId has no epics", async () => {
    // Non-existent product ID
    const result = await getBacklog({ productId: 9999999999 });

    expect(result).toBeTruthy();
    expect(result).toContain("No epics found");
  });

  it("contains expected markdown formatting", async () => {
    const result = await getBacklog({ limit: 5 });

    expect(result).toBeTruthy();
    // Should start with a markdown heading
    expect(result).toMatch(/^# Backlog/);
    // If tasks exist, verify markdown structure
    if (!result.includes("No tasks found")) {
      // Tasks are formatted with item ID in parentheses
      expect(result).toMatch(/\(#\d+\)/);
      // Status/Priority/Type/Hours line
      expect(result).toContain("Status:");
      expect(result).toContain("Priority:");
      expect(result).toContain("Type:");
      expect(result).toContain("Hours:");
      // Product/Epic/Agent line
      expect(result).toContain("Product:");
      expect(result).toContain("Epic:");
      expect(result).toContain("Agent:");
    }
  });
});
