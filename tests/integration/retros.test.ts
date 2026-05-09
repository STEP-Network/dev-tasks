import { describe, it, expect, afterAll } from "vitest";
import { createRetro, listRetros } from "@/lib/tools";
import { BOARDS, RETRO_COLUMNS } from "@/lib/constants";
import { executeMondayQuery } from "@/lib/monday-client";
import { registerCleanup, cleanupAll, extractItemId } from "./setup";

describe("createRetro + listRetros", () => {
  let retroId: number;
  const description = "Long-form context goes here on the Description column.";

  afterAll(async () => {
    await cleanupAll();
  });

  it("creates a retro item with description on the long_text column", async () => {
    const result = await createRetro({
      name: "[TEST] Integration Test Retro",
      type: "Improve",
      description,
      repeating: true,
    });
    expect(result).toContain("[TEST] Integration Test Retro");
    expect(result).toContain("Improve");
    expect(result).toContain("Repeating: Yes");
    retroId = extractItemId(result);
    registerCleanup(BOARDS.RETROS, retroId);
  });

  it("persists the description on the Description column", async () => {
    const query = `
      query {
        items(ids: [${retroId}]) {
          column_values(ids: ["${RETRO_COLUMNS.description}"]) {
            id
            text
          }
        }
      }
    `;
    const response = await executeMondayQuery<any>(query);
    const text = response.items?.[0]?.column_values?.[0]?.text;
    expect(text).toBe(description);
  });

  it("appears in listRetros search filtered by type+repeating", async () => {
    const result = await listRetros({
      type: "Improve",
      repeating: true,
      search: "[TEST] Integration Test Retro",
      limit: 25,
    });
    expect(result).toContain("[TEST] Integration Test Retro");
    expect(result).toContain("Repeating: Yes");
  });

  it("excludes the test item when filtering for non-repeating", async () => {
    const result = await listRetros({
      type: "Improve",
      repeating: false,
      search: "[TEST] Integration Test Retro",
      limit: 25,
    });
    // Result is either the no-match error (which echoes the search term) or a
    // success listing — either way the test item's ID must not appear.
    expect(result).not.toContain(`#${retroId}`);
  });
});
