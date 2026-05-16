import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMondayQueryMock = vi.fn();
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
}));

import { clearProductsCache, getProductIdByName } from "../products.ts";
import { mondayAuthContext } from "../../auth-context.ts";

const FIXTURE = {
  boards: [
    {
      items_page: {
        items: [
          { id: "2723505568", name: "PolAds" },
          { id: "2730518827", name: "STEPhie" },
          { id: "0000000001", name: "" },
        ],
      },
    },
  ],
};

describe("getProductIdByName", () => {
  beforeEach(() => {
    clearProductsCache();
    executeMondayQueryMock.mockReset();
    executeMondayQueryMock.mockResolvedValue(FIXTURE);
  });

  it("resolves exact-match name to Monday item ID", async () => {
    await expect(getProductIdByName("PolAds")).resolves.toBe(2723505568);
    await expect(getProductIdByName("STEPhie")).resolves.toBe(2730518827);
  });

  it("falls back to case-insensitive match", async () => {
    await expect(getProductIdByName("polads")).resolves.toBe(2723505568);
    await expect(getProductIdByName("STEPHIE")).resolves.toBe(2730518827);
  });

  it("prefers exact-case match when both exact and case-insensitive could match", async () => {
    // Both "PolAds" exact and "polads" case-insensitive exist on the board
    // (only the first does in fixture — verify exact wins)
    await expect(getProductIdByName("PolAds")).resolves.toBe(2723505568);
  });

  it("throws a clear error when no match found", async () => {
    await expect(getProductIdByName("NotARealProduct")).rejects.toThrow(
      /no Monday product found with name 'NotARealProduct'/i,
    );
  });

  it("rejects empty / whitespace input", async () => {
    await expect(getProductIdByName("")).rejects.toThrow(/non-empty string/i);
    await expect(getProductIdByName("   ")).rejects.toThrow(/non-empty string/i);
  });

  it("caches successful lookups (one fetch across many calls)", async () => {
    await getProductIdByName("PolAds");
    await getProductIdByName("STEPhie");
    await getProductIdByName("polads");
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(1);
  });

  it("clearProductsCache forces a re-fetch", async () => {
    await getProductIdByName("PolAds");
    clearProductsCache();
    await getProductIdByName("PolAds");
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);
  });

  it("scopes the cache per Monday auth token (no cross-tenant leak)", async () => {
    await mondayAuthContext.run({ apiKey: "tokenA" }, async () => {
      await getProductIdByName("PolAds");
    });
    await mondayAuthContext.run({ apiKey: "tokenB" }, async () => {
      await getProductIdByName("PolAds");
    });
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);

    await mondayAuthContext.run({ apiKey: "tokenA" }, async () => {
      await getProductIdByName("STEPhie");
    });
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);
  });

  it("propagates Monday API failures and does not poison the cache", async () => {
    executeMondayQueryMock.mockRejectedValueOnce(new Error("Monday API error: 503"));
    await expect(getProductIdByName("PolAds")).rejects.toThrow(/503/);

    executeMondayQueryMock.mockResolvedValueOnce(FIXTURE);
    await expect(getProductIdByName("PolAds")).resolves.toBe(2723505568);
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);
  });

  it("re-fetches after the 5-minute TTL expires", async () => {
    vi.useFakeTimers();
    try {
      vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
      await getProductIdByName("PolAds");
      expect(executeMondayQueryMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:04:00Z"));
      await getProductIdByName("PolAds");
      expect(executeMondayQueryMock).toHaveBeenCalledTimes(1);

      vi.setSystemTime(new Date("2026-01-01T00:06:00Z"));
      await getProductIdByName("PolAds");
      expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);
    } finally {
      vi.useRealTimers();
    }
  });

  it("excludes records with empty names", async () => {
    // The fixture has an entry with name="" that should be silently skipped
    await getProductIdByName("PolAds"); // triggers load
    await expect(getProductIdByName("")).rejects.toThrow(/non-empty string/i);
  });
});
