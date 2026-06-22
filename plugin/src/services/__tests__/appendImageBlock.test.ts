import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the Monday client so no real API call fires — the create_doc_blocks
// mutation + variables that appendImageBlock builds are the unit under test.
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: vi.fn(),
  DOC_API_VERSION: "2025-10",
  DOC_BLOCKS_API_VERSION: "2026-07",
}));

import { executeMondayQuery } from "../../monday-client.ts";
import { appendImageBlock } from "../doc-utils.ts";

const mockedQuery = vi.mocked(executeMondayQuery);

beforeEach(() => {
  mockedQuery.mockReset();
  mockedQuery.mockResolvedValue({ create_doc_blocks: [{ id: "blk_1" }] } as any);
});

describe("appendImageBlock", () => {
  it("appends an image block by asset_id via create_doc_blocks (append-only)", async () => {
    await appendImageBlock(555, "asset-123");

    const [mutation, variables, options] = mockedQuery.mock.calls[0];
    expect(mutation).toContain("create_doc_blocks");
    expect(mutation).toContain("blocksInput");
    // No drain/delete — strictly additive.
    expect(mutation).not.toContain("delete_doc_block");
    expect(variables).toEqual({
      docId: 555,
      blocks: [{ image_block: { asset_id: "asset-123" } }],
    });
    // The typed create_doc_blocks API only exists on 2026-07.
    expect(options).toEqual({ apiVersion: "2026-07" });
  });

  it("includes width when provided", async () => {
    await appendImageBlock(555, "asset-123", { width: 1440 });
    const variables = mockedQuery.mock.calls[0][1] as any;
    expect(variables.blocks[0].image_block).toEqual({ asset_id: "asset-123", width: 1440 });
  });

  it("embeds by asset_id, never a (1h-expiring) public_url", async () => {
    await appendImageBlock(1, "asset-xyz");
    const variables = mockedQuery.mock.calls[0][1] as any;
    expect(variables.blocks[0].image_block).not.toHaveProperty("public_url");
  });
});
