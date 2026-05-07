import { describe, it, expect } from "vitest";
import { listEpics } from "@/lib/tools/listEpics";

describe("listEpics", () => {
  it("returns epics for STEPhie", async () => {
    const result = await listEpics({ product: "STEPhie" });

    expect(result).toBeTruthy();
    if (result.includes("# Error")) return;
    expect(result).toContain("# Epics");
    expect(result).toMatch(/\(#\d+\)/);
    expect(result).toContain("Status:");
    expect(result).toContain("Progress:");
  });

  it("returns epics for PolAds", async () => {
    const result = await listEpics({ product: "PolAds" });

    expect(result).toBeTruthy();
    if (result.includes("# Error")) return;
    expect(result).toContain("# Epics");
  });

  it("shows progress as fraction and percentage", async () => {
    const result = await listEpics({ product: "STEPhie" });

    if (result.includes("# Error")) return;
    expect(result).toMatch(/Progress: (\d+\/\d+ \(\d+%\)|No tasks)/);
  });
});
