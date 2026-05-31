import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock monday-client so no real API call fires. With no productId, createBug
// issues exactly one create_item mutation, so the captured query string is the
// unit under test.
vi.mock("../monday-client.ts", () => ({
  executeMondayQuery: vi.fn(),
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

describe("createBug — Source Tool + filedByAgent", () => {
  it("always sets Source Tool = 'agent'", async () => {
    await createBug({ name: "B", description: "d", priority: "High" } as any);
    const mutation = mockedQuery.mock.calls[0][0] as string;
    expect(mutation).toContain(BUG_COLUMNS.sourceTool);
    expect(mutation).toContain("agent");
  });

  it("enables create_labels_if_missing on the mutation", async () => {
    await createBug({ name: "B", description: "d", priority: "High" } as any);
    const mutation = mockedQuery.mock.calls[0][0] as string;
    expect(mutation).toContain("create_labels_if_missing: true");
  });

  it("writes Filed By Agent when filedByAgent is provided", async () => {
    await createBug({
      name: "B", description: "d", priority: "High",
      filedByAgent: "Claude Code CLI",
    } as any);
    const mutation = mockedQuery.mock.calls[0][0] as string;
    expect(mutation).toContain(BUG_COLUMNS.filedByAgent);
    expect(mutation).toContain("Claude Code CLI");
  });

  it("does NOT write Filed By Agent when filedByAgent is omitted", async () => {
    await createBug({ name: "B", description: "d", priority: "High" } as any);
    const mutation = mockedQuery.mock.calls[0][0] as string;
    expect(mutation).not.toContain(BUG_COLUMNS.filedByAgent);
  });
});
