import { describe, it, expect } from "vitest";
import { listEpics } from "@/lib/tools/listEpics";

describe("listEpics", () => {
  it("returns a list of epics with no filters", async () => {
    const result = await listEpics({});

    expect(result).toBeTruthy();
    expect(result).toContain("# Epics");
    // Should have at least one epic
    expect(result).toMatch(/\(#\d+\)/);
    // Should show status and progress
    expect(result).toContain("Status:");
    expect(result).toContain("Progress:");
  });

  it("filters by status", async () => {
    const result = await listEpics({ status: "In Progress" });

    expect(result).toBeTruthy();
    // Either has results or reports no epics found
    if (!result.includes("# Error")) {
      expect(result).toContain("# Epics");
      expect(result).toContain("In Progress");
    }
  });

  it("filters by search text", async () => {
    // First get all epics to find a name to search for
    const allResult = await listEpics({});

    if (allResult.includes("# Error")) return;

    // Extract first epic name
    const nameMatch = allResult.match(/\*\*(.+?)\*\* \(#\d+\)/);
    if (!nameMatch) return;

    // Search with a substring of the first epic's name
    const searchTerm = nameMatch[1].split(" ")[0];
    const searchResult = await listEpics({ search: searchTerm });

    expect(searchResult).toBeTruthy();
    expect(searchResult).toContain("# Epics");
    expect(searchResult.toLowerCase()).toContain(searchTerm.toLowerCase());
  });

  it("returns error for search with no matches", async () => {
    const result = await listEpics({ search: "zzz_nonexistent_epic_zzz" });

    expect(result).toContain("# Error");
    expect(result).toContain("No epics found");
  });

  it("respects the limit parameter", async () => {
    const result = await listEpics({ limit: 2 });

    expect(result).toBeTruthy();
    if (result.includes("# Error")) return;

    // Count epic entries (lines starting with "- **")
    const epicEntries = result.split("\n").filter(l => l.startsWith("- **"));
    expect(epicEntries.length).toBeLessThanOrEqual(2);
  });

  it("shows progress as fraction and percentage", async () => {
    const result = await listEpics({});

    if (result.includes("# Error")) return;

    // Should show progress in format "X/Y (Z%)" or "No tasks"
    expect(result).toMatch(/Progress: (\d+\/\d+ \(\d+%\)|No tasks)/);
  });
});
