import { describe, it, expect } from "vitest";
import {
  emptyChangelog,
  serializeForStorage,
  parseRawChangelog,
  migrateChangelog,
  type StructuredChangelog,
} from "@/lib/tools/structuredChangelog";

describe("serializeForStorage", () => {
  it("renders entries as bare strings with public name + (#id) suffix", () => {
    const cl: StructuredChangelog = {
      version: 1,
      tasks: {
        Feature: [
          { id: 12345, name: "Internal name", publicName: "Public Name" },
          { id: 67890, name: "Internal only" },
          { name: "Manual entry" },
        ],
        Fix: [],
        Improvement: [],
      },
    };
    const out = serializeForStorage(cl) as { tasks: { Feature: unknown[] } };
    expect(out.tasks.Feature).toEqual([
      "Public Name (#12345)",
      "Internal only (#67890)",
      "Manual entry",
    ]);
  });

  it("preserves summary, highlights, breakingChanges, knownIssues", () => {
    const cl: StructuredChangelog = {
      version: 1,
      summary: "v1.0",
      highlights: ["First"],
      breakingChanges: ["Removed legacy API"],
      knownIssues: ["Login flake"],
      tasks: { Feature: [], Fix: [], Improvement: [] },
    };
    const out = serializeForStorage(cl) as Record<string, unknown>;
    expect(out.summary).toBe("v1.0");
    expect(out.highlights).toEqual(["First"]);
    expect(out.breakingChanges).toEqual(["Removed legacy API"]);
    expect(out.knownIssues).toEqual(["Login flake"]);
  });

  it("produces output ~3x smaller than the object envelope", () => {
    const objectShape = {
      version: 1,
      tasks: {
        Feature: Array.from({ length: 30 }, (_, i) => ({
          id: 1000000 + i,
          name: `Task ${i}`,
          publicName: `Public ${i}`,
        })),
        Fix: [],
        Improvement: [],
      },
    };
    const stringShape = serializeForStorage(objectShape as StructuredChangelog);
    const objLen = JSON.stringify(objectShape).length;
    const strLen = JSON.stringify(stringShape).length;
    expect(strLen).toBeLessThan(objLen / 2);
  });
});

describe("round-trip: serialize → parse → migrate", () => {
  it("preserves task ids through serialization", () => {
    const original: StructuredChangelog = {
      version: 1,
      summary: "Test summary",
      tasks: {
        Feature: [{ id: 999, name: "Foo", publicName: "Public Foo" }],
        Fix: [{ id: 111, name: "Bar" }],
        Improvement: [{ name: "Manual improvement" }],
      },
    };
    const stored = JSON.stringify(serializeForStorage(original));
    const parsed = parseRawChangelog(stored);
    const round = migrateChangelog(parsed);

    expect(round.summary).toBe("Test summary");
    expect(round.tasks.Feature).toHaveLength(1);
    expect(round.tasks.Feature[0]).toMatchObject({ name: "Public Foo", id: 999 });
    expect(round.tasks.Fix[0]).toMatchObject({ name: "Bar", id: 111 });
    expect(round.tasks.Improvement[0].name).toBe("Manual improvement");
    expect(round.tasks.Improvement[0].id).toBeUndefined();
  });
});

describe("migrateChangelog — legacy shapes", () => {
  it("handles 4-cat under categories wrapper with lowercase keys", () => {
    const legacy = {
      categories: {
        added: ["Auth flow", "User dashboard (#12)"],
        fixed: ["Crash on logout"],
        changed: ["Updated copy"],
        documentation: ["Onboarding guide"],
      },
    };
    const migrated = migrateChangelog(legacy);
    expect(migrated.tasks.Feature.map(e => e.name)).toEqual(["Auth flow", "User dashboard"]);
    expect(migrated.tasks.Feature[1].id).toBe(12);
    expect(migrated.tasks.Fix.map(e => e.name)).toEqual(["Crash on logout"]);
    expect(migrated.tasks.Improvement.map(e => e.name)).toEqual(["Updated copy", "Onboarding guide"]);
  });

  it("handles PR #148 lowercase 3-cat under categories wrapper", () => {
    const legacy = {
      categories: {
        feature: ["Public Roadmap (#999)"],
        improvement: ["Faster build"],
        fix: ["Auth race"],
      },
    };
    const migrated = migrateChangelog(legacy);
    expect(migrated.tasks.Feature).toHaveLength(1);
    expect(migrated.tasks.Feature[0]).toMatchObject({ name: "Public Roadmap", id: 999 });
    expect(migrated.tasks.Improvement[0].name).toBe("Faster build");
    expect(migrated.tasks.Fix[0].name).toBe("Auth race");
  });

  it("returns empty changelog for empty / nullish input", () => {
    expect(migrateChangelog(undefined)).toEqual(emptyChangelog());
    expect(migrateChangelog(null)).toEqual(emptyChangelog());
    expect(migrateChangelog({})).toEqual(emptyChangelog());
  });
});

describe("parseRawChangelog", () => {
  it("strips marker wrappers", () => {
    const raw = `<!-- changelog-json -->{"version":1,"tasks":{"Feature":["A"],"Fix":[],"Improvement":[]}}<!-- /changelog-json -->`;
    const parsed = parseRawChangelog(raw) as { version: number };
    expect(parsed?.version).toBe(1);
  });

  it("strips fenced code blocks", () => {
    const raw = "```json\n{\"version\":1,\"tasks\":{\"Feature\":[],\"Fix\":[],\"Improvement\":[]}}\n```";
    const parsed = parseRawChangelog(raw) as { version: number };
    expect(parsed?.version).toBe(1);
  });

  it("falls back to brace-walker for surrounding noise", () => {
    const raw = `prefix garbage {"version":1,"tasks":{"Feature":[],"Fix":[],"Improvement":[]}} trailing junk`;
    const parsed = parseRawChangelog(raw) as { version: number };
    expect(parsed?.version).toBe(1);
  });

  it("returns undefined for empty / non-JSON input", () => {
    expect(parseRawChangelog("")).toBeUndefined();
    expect(parseRawChangelog("   ")).toBeUndefined();
    expect(parseRawChangelog("not json at all")).toBeUndefined();
  });
});
