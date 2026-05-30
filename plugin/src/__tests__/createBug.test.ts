import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the monday-client so no real API calls are made. createBug issues a
// single create_item mutation when no productId is passed (no maintenance-epic
// resolution), so the captured mutation string is the unit under test.
vi.mock("../monday-client.ts", () => ({
  executeMondayQuery: vi.fn(),
  mondayAuthContext: { getStore: () => undefined },
  DOC_API_VERSION: "2025-10",
}));

import { executeMondayQuery } from "../monday-client.ts";
import { createBug } from "../tools/createBug.ts";
import { BUG_COLUMNS } from "../constants.ts";

const mockedQuery = vi.mocked(executeMondayQuery);

beforeEach(() => {
  mockedQuery.mockReset();
  mockedQuery.mockResolvedValue({ create_item: { id: "123", name: "Test bug" } } as any);
});

describe("createBug — filedByAgent attribution", () => {
  it("writes the Filed By Agent dropdown + create_labels_if_missing when filedByAgent is provided", async () => {
    await createBug({
      name: "Test bug",
      description: "repro steps",
      priority: "High",
      filedByAgent: "Claude Code CLI",
    } as any);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const mutation = mockedQuery.mock.calls[0][0] as string;

    // The Filed By Agent column id appears in the serialized column_values...
    expect(mutation).toContain(BUG_COLUMNS.filedByAgent);
    // ...carrying the agent label as a label-based write...
    expect(mutation).toContain("Claude Code CLI");
    // ...and the mutation enables label auto-creation.
    expect(mutation).toContain("create_labels_if_missing: true");
  });

  it("does NOT write the Filed By Agent column when filedByAgent is omitted", async () => {
    await createBug({
      name: "Test bug",
      description: "repro steps",
      priority: "High",
    } as any);

    expect(mockedQuery).toHaveBeenCalledTimes(1);
    const mutation = mockedQuery.mock.calls[0][0] as string;

    // No Filed By Agent column in the payload when the param is absent.
    expect(mutation).not.toContain(BUG_COLUMNS.filedByAgent);
  });

  it("never writes the Source Tool column (owned by the observability bridge)", async () => {
    await createBug({
      name: "Test bug",
      description: "repro steps",
      priority: "High",
      filedByAgent: "Codex Local",
    } as any);

    const mutation = mockedQuery.mock.calls[0][0] as string;
    // color_mm3bqre is the Source Tool column — createBug must leave it alone.
    expect(mutation).not.toContain("color_mm3bqre");
  });
});
