import { describe, it, expect, beforeEach, vi } from "vitest";

const executeMondayQueryMock = vi.fn();
vi.mock("../../monday-client.ts", () => ({
  executeMondayQuery: (...args: unknown[]) => executeMondayQueryMock(...args),
}));

import { clearPeopleCache, getPersonByUsername } from "../people.ts";

const FIXTURE = {
  boards: [
    {
      items_page: {
        items: [
          {
            id: "1612666062",
            name: "Nathaniel Refslund",
            column_values: [
              { id: "person", text: "Nate", value: null },
              { id: "email__1", text: "naref@stepnetwork.dk", value: null },
              { id: "text6__1", text: "103752074", value: null },
              { id: "status", text: "Active", value: null },
            ],
          },
          {
            id: "2920351784",
            name: "Kristoffer Møller Jensen",
            column_values: [
              { id: "person", text: "Kristoffer Møller Nielsen", value: null },
              { id: "email__1", text: "krmoj@stepnetwork.dk", value: null },
              { id: "text6__1", text: "38667531", value: null },
              { id: "status", text: "Active", value: null },
            ],
          },
          {
            id: "1632010056",
            name: "Petar Sant",
            column_values: [
              { id: "person", text: "Petar Sant", value: null },
              { id: "email__1", text: "pesvr@stepnetwork.dk", value: null },
              { id: "text6__1", text: "43875136", value: null },
              { id: "status", text: "Past", value: null },
            ],
          },
          {
            id: "0000000001",
            name: "Missing PeopleID",
            column_values: [
              { id: "person", text: "No ID Person", value: null },
              { id: "email__1", text: "noid@stepnetwork.dk", value: null },
              { id: "text6__1", text: null, value: null },
              { id: "status", text: "Active", value: null },
            ],
          },
        ],
      },
    },
  ],
};

describe("getPersonByUsername", () => {
  beforeEach(() => {
    clearPeopleCache();
    executeMondayQueryMock.mockReset();
    executeMondayQueryMock.mockResolvedValue(FIXTURE);
  });

  it("resolves by email local-part (naref → 103752074)", async () => {
    await expect(getPersonByUsername("naref")).resolves.toBe(103752074);
  });

  it("resolves by lowercased person display name (nate → 103752074)", async () => {
    await expect(getPersonByUsername("nate")).resolves.toBe(103752074);
  });

  it("resolves by email local-part for krmoj → 38667531", async () => {
    await expect(getPersonByUsername("krmoj")).resolves.toBe(38667531);
  });

  it("treats a numeric input as a Monday person ID directly (no board lookup)", async () => {
    await expect(getPersonByUsername("12345678")).resolves.toBe(12345678);
    expect(executeMondayQueryMock).not.toHaveBeenCalled();
  });

  it("excludes Past-status records (pesvr should not resolve)", async () => {
    await expect(getPersonByUsername("pesvr")).rejects.toThrow(/no Monday user found/i);
  });

  it("excludes records with missing text6__1 People ID", async () => {
    await expect(getPersonByUsername("noid")).rejects.toThrow(/no Monday user found/i);
  });

  it("throws a clear error when no match found", async () => {
    await expect(getPersonByUsername("unknown-user")).rejects.toThrow(
      /no Monday user found for username 'unknown-user'/i,
    );
  });

  it("rejects empty / whitespace usernames", async () => {
    await expect(getPersonByUsername("")).rejects.toThrow(/non-empty string/i);
    await expect(getPersonByUsername("   ")).rejects.toThrow(/non-empty string/i);
  });

  it("is case-insensitive on display-name match", async () => {
    await expect(getPersonByUsername("NATE")).resolves.toBe(103752074);
    await expect(getPersonByUsername("Nate")).resolves.toBe(103752074);
  });

  it("caches successful lookups (only one board fetch across multiple calls)", async () => {
    await getPersonByUsername("naref");
    await getPersonByUsername("nate");
    await getPersonByUsername("krmoj");
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(1);
  });

  it("clearPeopleCache forces a re-fetch", async () => {
    await getPersonByUsername("naref");
    clearPeopleCache();
    await getPersonByUsername("naref");
    expect(executeMondayQueryMock).toHaveBeenCalledTimes(2);
  });

  it("supports overriding the board ID per call", async () => {
    await getPersonByUsername("naref", { boardId: 999999 });
    const queryArg = executeMondayQueryMock.mock.calls[0][0];
    expect(queryArg).toContain("boards(ids: [999999])");
  });
});
