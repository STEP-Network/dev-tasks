import { describe, it, expect } from "vitest";
import { getEpic } from "@/lib/tools/getEpic";
import { executeMondayQuery } from "@/lib/monday-client";
import { BOARDS, EPIC_GROUPS } from "@/lib/constants";

// Helper to fetch a valid epic ID from the board
async function getFirstEpicId(): Promise<number | null> {
  const query = `
    query {
      boards(ids: [${BOARDS.EPICS}]) {
        groups(ids: ["${EPIC_GROUPS.ACTIVE}"]) {
          items_page(limit: 1) {
            items {
              id
            }
          }
        }
      }
    }
  `;

  const response = await executeMondayQuery<any>(query);
  const item = response.boards?.[0]?.groups?.[0]?.items_page?.items?.[0];
  return item ? Number(item.id) : null;
}

describe("getEpic", () => {
  let epicId: number | null = null;

  // Fetch a valid epic ID before running tests
  it("can find a valid epic ID from the board", async () => {
    epicId = await getFirstEpicId();
    // There should be at least one active epic on the board
    expect(epicId).toBeTruthy();
    expect(typeof epicId).toBe("number");
  });

  it("returns epic details for a valid epic ID", async () => {
    if (!epicId) return;

    const result = await getEpic({ epicId });

    expect(result).toBeTruthy();
    expect(typeof result).toBe("string");
    // Should contain epic heading
    expect(result).toContain("# Epic:");
    // Should contain the epic ID
    expect(result).toContain(`#${epicId}`);
  });

  it("contains description, tasks, and progress stats", async () => {
    if (!epicId) return;

    const result = await getEpic({ epicId });

    // Overview section
    expect(result).toContain("## Overview");
    expect(result).toContain("**Status:**");
    expect(result).toContain("**Priority:**");
    expect(result).toContain("**Owner:**");

    // Progress section
    expect(result).toContain("## Progress");
    expect(result).toContain("**Tasks:**");
    expect(result).toMatch(/\d+\/\d+ complete \(\d+%\)/);
    expect(result).toContain("**Estimated Hours:**");
  });

  it("returns an error for a non-existent epic ID", async () => {
    const result = await getEpic({ epicId: 999999999 });

    expect(result).toBeTruthy();
    expect(result).toContain("# Error");
    expect(result).toContain("not found");
  });
});
