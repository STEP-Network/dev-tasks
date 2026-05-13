import { describe, it, expect } from "vitest";
import { getBacklog } from "@/lib/tools/getBacklog";

describe("getBacklog", () => {
  it("returns a markdown string with tasks when called with no filters", async () => {
    const result = await getBacklog({});

    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result).toContain("# Backlog");
    // Default filter shows Needs Refinement + Ready to Start
    expect(result).toContain("Needs Refinement");
    expect(result).toMatch(/tasks/);
  });

  it("filters tasks by a specific status", async () => {
    const result = await getBacklog({ statuses: ["Ready to Start"] });

    expect(result).toBeTruthy();
    expect(result).toContain("# Backlog");
    expect(result).toContain("Ready to Start");
    if (!result.includes("No tasks found")) {
      expect(result).toContain("Status: Ready to Start");
    }
  });

  it("filters to unclaimed tasks only", async () => {
    const result = await getBacklog({ unclaimedOnly: true });

    expect(result).toBeTruthy();
    expect(result).toContain("# Backlog");
    expect(result).toContain("unclaimedOnly");
    if (!result.includes("No tasks found")) {
      const agentMatches = result.match(/Agent: .+/g) || [];
      for (const match of agentMatches) {
        expect(match).toBe("Agent: —");
      }
    }
  });

  it("filters tasks by product (STEPhie)", async () => {
    const result = await getBacklog({ product: "STEPhie" });

    expect(result).toBeTruthy();
    expect(result).toContain("# Backlog");
    expect(result).toContain("product: STEPhie");
    if (!result.includes("No tasks found") && !result.includes("No epics found")) {
      expect(result).toContain("Product:");
    }
  });

  it("returns JSON shape when format='json'", async () => {
    const result = await getBacklog({ limit: 3, format: "json" });
    const parsed = JSON.parse(result);
    expect(parsed.tasks).toBeInstanceOf(Array);
    expect(parsed).toHaveProperty("nextCursor");
    expect(parsed).toHaveProperty("filters");
    if (parsed.tasks.length > 0) {
      const t = parsed.tasks[0];
      expect(typeof t.id).toBe("number");
      expect(typeof t.url).toBe("string");
      expect(t.url).toMatch(/stepas\.monday\.com\/boards/);
    }
  });

  it("contains expected markdown formatting", async () => {
    const result = await getBacklog({ limit: 5 });

    expect(result).toBeTruthy();
    expect(result).toMatch(/^# Backlog/);
    if (!result.includes("No tasks found")) {
      expect(result).toMatch(/\(#\d+\)/);
      expect(result).toContain("Status:");
      expect(result).toContain("Priority:");
      expect(result).toContain("Type:");
      expect(result).toContain("Product:");
      expect(result).toContain("Epic:");
      expect(result).toContain("Agent:");
      expect(result).toContain("URL:");
    }
  });
});
