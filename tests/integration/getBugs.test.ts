import { describe, it, expect } from "vitest";
import { getBugs } from "@/lib/tools/getBugs";

describe("getBugs", () => {
  it("returns a markdown string with bugs when called with no filters", async () => {
    const result = await getBugs({});

    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    expect(result).toContain("# Bugs Queue");
    // Should show the count
    expect(result).toMatch(/# Bugs Queue — \d+ bugs/);
  });

  it("filters bugs by status", async () => {
    const result = await getBugs({ status: "Awaiting Review" });

    expect(result).toBeTruthy();
    expect(result).toContain("# Bugs Queue");
    expect(result).toContain("status: Awaiting Review");
    // If bugs are returned, they should show the filtered status
    if (!result.includes("No bugs found")) {
      expect(result).toContain("Status: Awaiting Review");
    }
  });

  it("contains expected markdown formatting", async () => {
    const result = await getBugs({ limit: 5 });

    expect(result).toBeTruthy();
    // Should start with a markdown heading
    expect(result).toMatch(/^# Bugs Queue/);
    // If bugs exist, verify markdown structure
    if (!result.includes("No bugs found")) {
      // Bugs are formatted as bold BAIT- identifiers
      expect(result).toMatch(/\*\*BAIT-\d+\*\*/);
      // Status and priority lines
      expect(result).toContain("Status:");
      expect(result).toContain("Priority:");
      expect(result).toContain("Product:");
    }
  });
});
