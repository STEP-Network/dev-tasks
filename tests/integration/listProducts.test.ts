import { describe, it, expect } from "vitest";
import { listProducts } from "@/lib/tools/listProducts";

describe("listProducts", () => {
  it("returns a list of products", async () => {
    const result = await listProducts({});

    expect(result).toBeTruthy();
    expect(result).toContain("# Products");
    // Should have at least one product
    expect(result).toMatch(/\(#\d+\)/);
    // Should show status and counts
    expect(result).toContain("Status:");
    expect(result).toContain("Epics:");
    expect(result).toContain("Bugs:");
    expect(result).toContain("Versions:");
  });

  it("filters by search text", async () => {
    // First get all products to find a name to search for
    const allResult = await listProducts({});

    if (allResult.includes("# Error")) return;

    // Extract first product name
    const nameMatch = allResult.match(/\*\*(.+?)\*\* \(#\d+\)/);
    if (!nameMatch) return;

    const searchTerm = nameMatch[1].split(" ")[0];
    const searchResult = await listProducts({ search: searchTerm });

    expect(searchResult).toBeTruthy();
    expect(searchResult).toContain("# Products");
    expect(searchResult.toLowerCase()).toContain(searchTerm.toLowerCase());
  });

  it("returns error for search with no matches", async () => {
    const result = await listProducts({ search: "zzz_nonexistent_product_zzz" });

    expect(result).toContain("# Error");
    expect(result).toContain("No products found");
  });
});
