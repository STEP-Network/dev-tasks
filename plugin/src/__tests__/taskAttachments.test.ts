import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as os from "node:os";
import * as path from "node:path";

// Mock the filesystem: realpath is identity (so the allowlist roots — tmpdir/cwd
// — resolve to themselves), mkdir + writeFile are no-ops, readFile returns fake
// bytes. The pure asset helpers + URL/size/dir logic are the units under test.
vi.mock("node:fs/promises", () => ({
  readFile: vi.fn(async () => Buffer.from([0x89, 0x50, 0x4e, 0x47])),
  realpath: vi.fn(async (p: string) => p),
  mkdir: vi.fn(async () => undefined),
  writeFile: vi.fn(async () => undefined),
}));

import {
  ASSET_FIELDS,
  buildSafeAssetFileName,
  isAllowedMondayAssetUrl,
  normalizeItemAssetsPayload,
  selectAssetDownloadUrl,
  type RawMondayAsset,
} from "../monday-assets.ts";
import {
  downloadMondayAsset,
  fetchTaskAssets,
  resolveDownloadDir,
  type DownloadedAsset,
} from "../monday-client.ts";

// -----------------------------------------------------------------------------
// Pure helpers — no network, no fs.
// -----------------------------------------------------------------------------

describe("normalizeItemAssetsPayload", () => {
  const itemAsset: RawMondayAsset = {
    id: 111,
    name: "spec.pdf",
    url: "https://stepas.monday.com/protected_static/1/resources/111/spec.pdf",
    public_url: "https://files.monday.com/signed/spec.pdf?sig=abc",
    file_extension: ".pdf",
    file_size: 2048,
  };
  const updateAsset: RawMondayAsset = {
    id: 222,
    name: "screenshot.png",
    url: "",
    public_url: "https://files.monday.com/signed/screenshot.png?sig=def",
    file_extension: "png",
    file_size: "4096",
  };

  it("flattens item file-column assets + update assets tagged with source", () => {
    const assets = normalizeItemAssetsPayload(
      { name: "Task", assets: [itemAsset], updates: [{ id: 900, assets: [updateAsset] }] },
      { includeUpdates: true },
    );
    expect(assets).toHaveLength(2);
    expect(assets[0]).toMatchObject({
      assetId: "111",
      name: "spec.pdf",
      fileExtension: "pdf",
      fileSizeBytes: 2048,
      source: "task-file-column",
    });
    expect(assets[1]).toMatchObject({
      assetId: "222",
      fileExtension: "png",
      fileSizeBytes: 4096, // coerced from string
      source: "update-900",
    });
  });

  it("excludes update assets when includeUpdates=false", () => {
    const assets = normalizeItemAssetsPayload(
      { assets: [itemAsset], updates: [{ id: 900, assets: [updateAsset] }] },
      { includeUpdates: false },
    );
    expect(assets).toHaveLength(1);
    expect(assets[0].source).toBe("task-file-column");
  });

  it("returns [] for an item with no attachments and for null", () => {
    expect(normalizeItemAssetsPayload({ assets: [], updates: [] }, { includeUpdates: true })).toEqual([]);
    expect(normalizeItemAssetsPayload(null, { includeUpdates: true })).toEqual([]);
    expect(
      normalizeItemAssetsPayload({ assets: null, updates: null }, { includeUpdates: true }),
    ).toEqual([]);
  });

  it("skips entries with no id and updates with null assets", () => {
    const assets = normalizeItemAssetsPayload(
      {
        assets: [{ id: "", name: "ghost" } as unknown as RawMondayAsset, itemAsset],
        updates: [{ id: 5, assets: null }, { id: 6, assets: [updateAsset] }],
      },
      { includeUpdates: true },
    );
    // "ghost" (empty id) dropped; item asset + one update asset kept.
    expect(assets.map((a) => a.assetId)).toEqual(["111", "222"]);
  });

  it("falls back to asset-<id> when Monday reports no name", () => {
    const [a] = normalizeItemAssetsPayload(
      { assets: [{ id: 77 }], updates: [] },
      { includeUpdates: false },
    );
    expect(a.name).toBe("asset-77");
  });
});

describe("selectAssetDownloadUrl", () => {
  it("prefers public_url (no auth needed)", () => {
    expect(
      selectAssetDownloadUrl({ url: "https://a/auth", publicUrl: "https://a/public" }),
    ).toEqual({ url: "https://a/public", needsAuth: false });
  });
  it("falls back to the authenticated url", () => {
    expect(selectAssetDownloadUrl({ url: "https://a/auth", publicUrl: "" })).toEqual({
      url: "https://a/auth",
      needsAuth: true,
    });
  });
  it("returns null when neither URL is present", () => {
    expect(selectAssetDownloadUrl({ url: "", publicUrl: "" })).toBeNull();
  });
});

describe("isAllowedMondayAssetUrl (SSRF allowlist)", () => {
  it("allows Monday + Monday-S3 https hosts", () => {
    expect(isAllowedMondayAssetUrl("https://files.monday.com/x.png?sig=1")).toBe(true);
    expect(isAllowedMondayAssetUrl("https://stepas.monday.com/protected_static/x")).toBe(true);
    expect(isAllowedMondayAssetUrl("https://files-monday-com.s3.amazonaws.com/x?sig=1")).toBe(true);
  });
  it("allows a path-style Monday S3 bucket", () => {
    expect(isAllowedMondayAssetUrl("https://s3.amazonaws.com/files-monday-com/x?sig=1")).toBe(true);
  });
  it("rejects non-Monday hosts, non-https, and garbage", () => {
    expect(isAllowedMondayAssetUrl("https://evil.example.com/x")).toBe(false);
    expect(isAllowedMondayAssetUrl("http://files.monday.com/x")).toBe(false); // not https
    expect(isAllowedMondayAssetUrl("https://attacker.s3.amazonaws.com/x")).toBe(false); // no "monday-com"
    expect(isAllowedMondayAssetUrl("https://hackmonday123.s3.amazonaws.com/x")).toBe(false); // "monday" but not "monday-com"
    expect(isAllowedMondayAssetUrl("not a url")).toBe(false);
  });
});

describe("buildSafeAssetFileName (collision + traversal safety)", () => {
  it("keeps a clean name and reserves it", () => {
    const taken = new Set<string>();
    expect(buildSafeAssetFileName({ assetId: "1", name: "spec.pdf", fileExtension: "pdf" }, taken)).toBe(
      "spec.pdf",
    );
    expect(taken.has("spec.pdf")).toBe(true);
  });

  it("appends -1/-2 on collisions", () => {
    const taken = new Set<string>();
    const a = buildSafeAssetFileName({ assetId: "1", name: "shot.png", fileExtension: "png" }, taken);
    const b = buildSafeAssetFileName({ assetId: "2", name: "shot.png", fileExtension: "png" }, taken);
    const c = buildSafeAssetFileName({ assetId: "3", name: "shot.png", fileExtension: "png" }, taken);
    expect([a, b, c]).toEqual(["shot.png", "shot-1.png", "shot-2.png"]);
  });

  it("strips path traversal to a single safe segment", () => {
    const name = buildSafeAssetFileName(
      { assetId: "9", name: "../../etc/passwd", fileExtension: "" },
      new Set(),
    );
    expect(name).not.toContain("/");
    expect(name).not.toContain("..");
    expect(name).toBe("passwd");
  });

  it("adds the file extension when the name lacks one", () => {
    const name = buildSafeAssetFileName(
      { assetId: "9", name: "screenshot", fileExtension: "png" },
      new Set(),
    );
    expect(name).toBe("screenshot.png");
  });

  it("synthesizes a name when sanitization empties it", () => {
    const name = buildSafeAssetFileName({ assetId: "42", name: "///", fileExtension: "log" }, new Set());
    expect(name).toBe("asset-42.log");
  });
});

// -----------------------------------------------------------------------------
// Network + fs — mocked fetch.
// -----------------------------------------------------------------------------

const okJson = (data: unknown) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  json: async () => ({ data }),
});

const binaryResponse = (
  bytes: Uint8Array,
  headers: Record<string, string> = {},
) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  body: null, // force the arrayBuffer fallback path
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  arrayBuffer: async () => bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.byteLength),
});

// Response whose body is a real async-iterable stream — exercises the primary
// streamed-byte-counter path (not the arrayBuffer fallback).
const streamingResponse = (
  chunks: Uint8Array[],
  headers: Record<string, string> = {},
) => ({
  ok: true,
  status: 200,
  statusText: "OK",
  headers: { get: (k: string) => headers[k.toLowerCase()] ?? null },
  body: {
    async *[Symbol.asyncIterator]() {
      for (const c of chunks) yield c;
    },
  },
});

beforeEach(() => {
  process.env.MONDAY_API_KEY = "test-key";
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("fetchTaskAssets", () => {
  it("queries item + updates and returns normalized assets", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () =>
        okJson({
          items: [
            {
              name: "My Task",
              assets: [
                { id: 1, name: "a.png", url: "", public_url: "https://files.monday.com/a.png", file_extension: "png", file_size: 10 },
              ],
              updates: [
                { id: 50, assets: [{ id: 2, name: "b.pdf", url: "", public_url: "https://files.monday.com/b.pdf", file_extension: "pdf", file_size: 20 }] },
              ],
            },
          ],
        }),
      ),
    );
    const result = await fetchTaskAssets(123, { includeUpdates: true });
    expect(result.found).toBe(true);
    expect(result.itemName).toBe("My Task");
    expect(result.assets.map((a) => a.assetId)).toEqual(["1", "2"]);
    expect(result.assets[1].source).toBe("update-50");

    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.query).toContain("assets {");
    expect(body.query).toContain(ASSET_FIELDS);
    expect(body.query).toContain("updates(");
  });

  it("omits the updates selection when includeUpdates=false", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ items: [{ name: "T", assets: [], updates: [] }] })),
    );
    const result = await fetchTaskAssets(123, { includeUpdates: false });
    expect(result.found).toBe(true);
    expect(result.assets).toEqual([]);
    const body = JSON.parse((fetch as any).mock.calls[0][1].body);
    expect(body.query).not.toContain("updates(");
  });

  it("returns found=false when the item does not resolve", async () => {
    vi.stubGlobal("fetch", vi.fn(async () => okJson({ items: [] })));
    const result = await fetchTaskAssets(999, { includeUpdates: true });
    expect(result).toEqual({ found: false, assets: [] });
  });

  it("warns when the Updates page cap is hit (possible truncation)", async () => {
    const updates = Array.from({ length: 100 }, (_, i) => ({ id: i, assets: [] }));
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ items: [{ name: "T", assets: [], updates }] })),
    );
    const result = await fetchTaskAssets(123, { includeUpdates: true });
    expect(result.warning).toMatch(/most recent 100 updates/i);
  });

  it("does not warn when fewer than the cap of updates are returned", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => okJson({ items: [{ name: "T", assets: [], updates: [{ id: 1, assets: [] }] }] })),
    );
    const result = await fetchTaskAssets(123, { includeUpdates: true });
    expect(result.warning).toBeUndefined();
  });
});

describe("downloadMondayAsset", () => {
  const base = {
    assetId: "1",
    name: "shot.png",
    fileExtension: "png",
    fileSizeBytes: 4,
    source: "task-file-column",
  };

  it("downloads via public_url WITHOUT an Authorization header", async () => {
    const fetchMock = vi.fn(async () => binaryResponse(new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal("fetch", fetchMock);

    const dest = path.join(os.tmpdir(), "shot.png");
    const result: DownloadedAsset = await downloadMondayAsset(
      { ...base, url: "", publicUrl: "https://files.monday.com/shot.png?sig=1" },
      dest,
    );
    expect(result.path).toBe(dest);
    expect(result.bytes).toBe(4);
    const [url, init] = fetchMock.mock.calls[0];
    expect(url).toBe("https://files.monday.com/shot.png?sig=1");
    expect(init.headers.Authorization).toBeUndefined();
    expect(init.signal).toBeDefined();
  });

  it("sends the API token ONLY on the authenticated url variant", async () => {
    const fetchMock = vi.fn(async () => binaryResponse(new Uint8Array([1, 2, 3, 4])));
    vi.stubGlobal("fetch", fetchMock);

    await downloadMondayAsset(
      { ...base, url: "https://stepas.monday.com/protected_static/1/resources/1/shot.png", publicUrl: "" },
      path.join(os.tmpdir(), "shot.png"),
    );
    const init = fetchMock.mock.calls[0][1];
    expect(init.headers.Authorization).toBe("test-key");
  });

  it("rejects a non-Monday host before fetching (SSRF)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadMondayAsset(
        { ...base, url: "", publicUrl: "https://evil.example.com/shot.png" },
        path.join(os.tmpdir(), "shot.png"),
      ),
    ).rejects.toThrow(/non-Monday host/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when the Monday-reported size exceeds the cap (no fetch)", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    await expect(
      downloadMondayAsset(
        { ...base, fileSizeBytes: 999_999, url: "", publicUrl: "https://files.monday.com/big.png" },
        path.join(os.tmpdir(), "big.png"),
        { maxBytes: 100 },
      ),
    ).rejects.toThrow(/over the 100-byte cap/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("rejects when Content-Length exceeds the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => binaryResponse(new Uint8Array([1, 2, 3, 4]), { "content-length": "5000" })),
    );
    await expect(
      downloadMondayAsset(
        { ...base, fileSizeBytes: undefined, url: "", publicUrl: "https://files.monday.com/x.png" },
        path.join(os.tmpdir(), "x.png"),
        { maxBytes: 100 },
      ),
    ).rejects.toThrow(/over the 100-byte cap/i);
  });

  it("has no downloadable URL → throws", async () => {
    vi.stubGlobal("fetch", vi.fn());
    await expect(
      downloadMondayAsset({ ...base, url: "", publicUrl: "" }, path.join(os.tmpdir(), "x.png")),
    ).rejects.toThrow(/no downloadable URL/i);
  });

  it("streams the body and writes bytes when under the cap", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => streamingResponse([new Uint8Array([1, 2]), new Uint8Array([3, 4, 5])])),
    );
    const result = await downloadMondayAsset(
      { ...base, fileSizeBytes: undefined, url: "", publicUrl: "https://files.monday.com/x.png" },
      path.join(os.tmpdir(), "x.png"),
    );
    expect(result.bytes).toBe(5);
  });

  it("aborts mid-stream when the streamed body exceeds the cap (Content-Length lied)", async () => {
    vi.stubGlobal(
      "fetch",
      // No/low Content-Length, but the actual stream overflows the cap.
      vi.fn(async () =>
        streamingResponse([new Uint8Array([1, 2, 3]), new Uint8Array([4, 5, 6, 7])], {}),
      ),
    );
    await expect(
      downloadMondayAsset(
        { ...base, fileSizeBytes: undefined, url: "", publicUrl: "https://files.monday.com/x.png" },
        path.join(os.tmpdir(), "x.png"),
        { maxBytes: 4 },
      ),
    ).rejects.toThrow(/exceeds the 4-byte cap mid-stream/i);
  });
});

describe("resolveDownloadDir (realpath jail)", () => {
  it("defaults to a scratchpad dir under the OS temp dir", async () => {
    const dir = await resolveDownloadDir();
    expect(dir).toBe(path.join(os.tmpdir(), "dev-tasks-attachments"));
  });

  it("namespaces the default dir by the provided leaf (e.g. item id)", async () => {
    const dir = await resolveDownloadDir(undefined, { defaultLeaf: "3050925742" });
    expect(dir).toBe(path.join(os.tmpdir(), "dev-tasks-attachments", "3050925742"));
  });

  it("uses an explicit destDir as-is (never namespaced) inside cwd", async () => {
    const inside = path.join(process.cwd(), "downloads");
    expect(await resolveDownloadDir(inside, { defaultLeaf: "3050925742" })).toBe(inside);
  });

  it("refuses a destDir outside the allowed roots", async () => {
    await expect(resolveDownloadDir("/totally/outside/here")).rejects.toThrow(
      /outside allowed roots/i,
    );
  });
});
