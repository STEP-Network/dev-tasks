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

  it("appears in listRetros when searched by name", async () => {
    const result = await listRetros({
      search: "[TEST] Integration Test Retro",
      limit: 25,
    });
    expect(result).toContain("[TEST] Integration Test Retro");
    expect(result).toContain("Repeating: Yes");
  });

  it("matches search against description text", async () => {
    // Use a unique fragment of the seeded description to prove search hits the
    // long_text column, not just the item name.
    const result = await listRetros({
      search: "Long-form context goes here",
      limit: 25,
    });
    expect(result).toContain(`#${retroId}`);
  });
});
