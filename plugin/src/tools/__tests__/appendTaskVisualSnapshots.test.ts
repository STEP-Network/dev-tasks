import { describe, it, expect, vi, beforeEach } from "vitest";

// Mock the doc helpers + the uploader so the tool's orchestration (ensure doc →
// upload PNG → embed by asset_id → note-only handling → failure capture) is the
// unit under test, with no Monday calls.
vi.mock("../../services/doc-utils.ts", () => ({
  ensureItemDoc: vi.fn(async () => 7777),
  appendDocContent: vi.fn(async () => undefined),
  appendImageBlock: vi.fn(async () => undefined),
  fetchItemName: vi.fn(async () => "Sample task"),
}));
vi.mock("../../monday-client.ts", () => ({
  uploadFileToMonday: vi.fn(async () => ({ assetId: "asset-1", publicUrl: "https://x" })),
  executeMondayQuery: vi.fn(),
  DOC_API_VERSION: "2025-10",
}));

import { appendTaskVisualSnapshots } from "../taskVisualDiff.ts";
import { ensureItemDoc, appendImageBlock } from "../../services/doc-utils.ts";
import { uploadFileToMonday } from "../../monday-client.ts";
import { TASK_COLUMNS } from "../../constants.ts";

const mockedEnsure = vi.mocked(ensureItemDoc);
const mockedAppendImage = vi.mocked(appendImageBlock);
const mockedUpload = vi.mocked(uploadFileToMonday);

beforeEach(() => {
  vi.clearAllMocks();
  mockedEnsure.mockResolvedValue(7777 as any);
  mockedUpload.mockResolvedValue({ assetId: "asset-1", publicUrl: "https://x" } as any);
});

describe("appendTaskVisualSnapshots", () => {
  it("ensures the dedicated Visual Changes doc column", async () => {
    await appendTaskVisualSnapshots({
      taskId: 42,
      phase: "before",
      captures: [{ route: "/dashboard", viewport: "desktop", imagePath: "/tmp/a.png" }],
    });
    expect(mockedEnsure).toHaveBeenCalledWith(42, TASK_COLUMNS.visualChangesDoc, expect.stringContaining("Visual Changes"));
  });

  it("uploads each image to the attachments column and embeds it by asset id", async () => {
    const out = await appendTaskVisualSnapshots({
      taskId: 42,
      phase: "after",
      captures: [
        { route: "/dashboard", viewport: "desktop", imagePath: "/tmp/a.png" },
        { route: "/dashboard", viewport: "mobile", imagePath: "/tmp/b.png" },
      ],
    });
    expect(mockedUpload).toHaveBeenCalledTimes(2);
    expect(mockedUpload).toHaveBeenCalledWith(42, TASK_COLUMNS.attachments, "/tmp/a.png", expect.any(String));
    expect(mockedAppendImage).toHaveBeenCalledWith(7777, "asset-1");
    expect(out).toContain("Images embedded:** 2");
  });

  it("handles note-only captures without uploading", async () => {
    const out = await appendTaskVisualSnapshots({
      taskId: 42,
      phase: "before",
      captures: [{ route: "/new", note: "no before state — new route" }],
    });
    expect(mockedUpload).not.toHaveBeenCalled();
    expect(mockedAppendImage).not.toHaveBeenCalled();
    expect(out).toContain("Note-only entries:** 1");
  });

  it("records an upload failure without throwing (non-fatal)", async () => {
    mockedUpload.mockRejectedValueOnce(new Error("boom"));
    const out = await appendTaskVisualSnapshots({
      taskId: 42,
      phase: "before",
      captures: [{ route: "/dashboard", viewport: "desktop", imagePath: "/tmp/a.png" }],
    });
    expect(out).toContain("Upload failures (1)");
    expect(out).toContain("boom");
    // Failure means no image block was embedded.
    expect(mockedAppendImage).not.toHaveBeenCalled();
  });
});
