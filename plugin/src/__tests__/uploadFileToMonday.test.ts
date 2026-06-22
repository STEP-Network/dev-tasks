import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Mock the filesystem so no real file is read. realpath is identity (so the
// allowlist roots — tmpdir/cwd — resolve to themselves), readFile returns fake
// bytes. The path-allowlist logic in uploadFileToMonday is the unit under test.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  realpath: vi.fn(async (p: string) => p),
}));

import { uploadFileToMonday } from "../monday-client.ts";

const okResponse = (data: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ data }),
});

beforeEach(() => {
  process.env.MONDAY_API_KEY = "test-key";
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => okResponse({ add_file_to_column: { id: "999", public_url: "https://x/y.png" } })),
  );
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadFileToMonday — path allowlist (security)", () => {
  it("rejects a non-absolute path", async () => {
    await expect(uploadFileToMonday(1, "file_col", "relative/shot.png")).rejects.toThrow(/absolute/i);
  });

  it("rejects a non-image extension", async () => {
    const p = path.join(os.tmpdir(), "secrets.txt");
    await expect(uploadFileToMonday(1, "file_col", p)).rejects.toThrow(/non-image/i);
  });

  it("rejects an image path outside the allowed roots", async () => {
    await expect(
      uploadFileToMonday(1, "file_col", "/totally/outside/shot.png"),
    ).rejects.toThrow(/outside allowed roots/i);
  });

  it("never calls fetch when the path is rejected", async () => {
    await expect(uploadFileToMonday(1, "file_col", "/totally/outside/shot.png")).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
});

describe("uploadFileToMonday — happy path", () => {
  it("uploads a tmpdir PNG and returns the permanent asset id", async () => {
    const p = path.join(os.tmpdir(), "shot.png");
    const result = await uploadFileToMonday(42, "file_mm0m4xde", p, "named.png");

    expect(result.assetId).toBe("999");
    expect(result.publicUrl).toBe("https://x/y.png");

    // Posts multipart to the dedicated /v2/file endpoint with the mutation +
    // file part, authenticated with the resolved key.
    const [url, init] = (fetch as any).mock.calls[0];
    expect(url).toBe("https://api.monday.com/v2/file");
    expect(init.method).toBe("POST");
    expect(init.headers.Authorization).toBe("test-key");
    expect(init.body).toBeInstanceOf(FormData);
    const query = (init.body as FormData).get("query");
    expect(query).toContain("add_file_to_column");
    expect(query).toContain("file_mm0m4xde");
    expect((init.body as FormData).get("variables[file]")).toBeInstanceOf(Blob);
  });

  it("throws when Monday returns no asset id", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okResponse({ add_file_to_column: null })));
    const p = path.join(os.tmpdir(), "shot.png");
    await expect(uploadFileToMonday(1, "file_col", p)).rejects.toThrow(/no asset id/i);
  });
});
