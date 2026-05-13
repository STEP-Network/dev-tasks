import { describe, it, expect } from "vitest";
import {
  classifyReadyToStartBlockers,
  classifyWaitingForUATIssues,
  hasDocColumn,
  type ReadyToStartSnapshot,
  type WaitingForUATSnapshot,
  type SubitemSnapshot,
} from "@/lib/tools/utils";

function readySnapshot(overrides: Partial<ReadyToStartSnapshot> = {}): ReadyToStartSnapshot {
  return {
    type: "Feature",
    priority: "Medium",
    epicCount: 1,
    description: "Build the thing",
    acceptanceCriteria: "Thing must work",
    subitems: [
      { name: "Backend work", description: "Implement endpoint", type: "Backend", estimatedHours: 4 },
    ],
    ...overrides,
  };
}

describe("classifyReadyToStartBlockers", () => {
  it("returns no blockers when everything is set", () => {
    expect(classifyReadyToStartBlockers(readySnapshot())).toEqual([]);
  });

  it("blocks when type is missing or 'Not Set'", () => {
    expect(classifyReadyToStartBlockers(readySnapshot({ type: undefined }))).toContain("type not set");
    expect(classifyReadyToStartBlockers(readySnapshot({ type: "Not Set" }))).toContain("type not set");
  });

  it("blocks when priority is missing or 'Missing'", () => {
    expect(classifyReadyToStartBlockers(readySnapshot({ priority: undefined })))
      .toContain("priority not set (Missing)");
    expect(classifyReadyToStartBlockers(readySnapshot({ priority: "Missing" })))
      .toContain("priority not set (Missing)");
  });

  it("blocks when not linked to an epic", () => {
    expect(classifyReadyToStartBlockers(readySnapshot({ epicCount: 0 })))
      .toContain("not linked to an epic");
  });

  it("blocks when description or acceptance criteria is empty/whitespace", () => {
    expect(classifyReadyToStartBlockers(readySnapshot({ description: "" })))
      .toContain("description is empty");
    expect(classifyReadyToStartBlockers(readySnapshot({ description: "   " })))
      .toContain("description is empty");
    expect(classifyReadyToStartBlockers(readySnapshot({ acceptanceCriteria: undefined })))
      .toContain("acceptance criteria is empty");
  });

  it("blocks when there are zero subtasks", () => {
    const blockers = classifyReadyToStartBlockers(readySnapshot({ subitems: [] }));
    expect(blockers.some(b => b.startsWith("no subtasks"))).toBe(true);
  });

  it("blocks subtasks that are missing name/description/type/estimate", () => {
    const sub: SubitemSnapshot = { name: "Foo", description: undefined, type: undefined, estimatedHours: 0 };
    const blockers = classifyReadyToStartBlockers(readySnapshot({ subitems: [sub] }));
    const blockerForSub = blockers.find(b => b.includes('"Foo"'));
    expect(blockerForSub).toBeDefined();
    expect(blockerForSub).toContain("description");
    expect(blockerForSub).toContain("type");
    expect(blockerForSub).toContain("estimate");
    expect(blockerForSub).not.toContain("name"); // name IS set
  });

  it("treats subtask type 'Missing Status' as not set", () => {
    const sub: SubitemSnapshot = { name: "Foo", description: "x", type: "Missing Status", estimatedHours: 1 };
    const blockers = classifyReadyToStartBlockers(readySnapshot({ subitems: [sub] }));
    expect(blockers.find(b => b.includes('"Foo"'))).toContain("type");
  });

  it("falls back to '#index' label when subtask has no name", () => {
    const sub: SubitemSnapshot = { description: "x", type: "Backend", estimatedHours: 1 };
    const blockers = classifyReadyToStartBlockers(readySnapshot({ subitems: [sub] }));
    expect(blockers.find(b => b.includes('"#1"'))).toBeDefined();
  });
});

function uatSnapshot(overrides: Partial<WaitingForUATSnapshot> = {}): WaitingForUATSnapshot {
  return {
    subitems: [{ name: "Backend", status: "Done" }],
    hasUatDoc: true,
    hasGitHubLink: true,
    hasBranch: true,
    hasDemoUrl: true,
    hasPrLink: true,
    ...overrides,
  };
}

describe("classifyWaitingForUATIssues", () => {
  it("passes cleanly when everything is in place", () => {
    const r = classifyWaitingForUATIssues(uatSnapshot());
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual([]);
  });

  it("blocks on unfinished subtasks", () => {
    const r = classifyWaitingForUATIssues(uatSnapshot({
      subitems: [{ name: "A", status: "Done" }, { name: "B", status: "In Progress" }],
    }));
    expect(r.blockers[0]).toMatch(/1 subtask\(s\) not Done/);
    expect(r.blockers[0]).toContain('"B"');
  });

  it("blocks when there are no subtasks at all", () => {
    const r = classifyWaitingForUATIssues(uatSnapshot({ subitems: [] }));
    expect(r.blockers.some(b => b.startsWith("no subtasks"))).toBe(true);
  });

  it("blocks when the UAT doc is missing", () => {
    const r = classifyWaitingForUATIssues(uatSnapshot({ hasUatDoc: false }));
    expect(r.blockers.some(b => b.includes("UAT testing doc"))).toBe(true);
  });

  it("warns (does not block) on missing GitHub/branch/demo/PR links", () => {
    const r = classifyWaitingForUATIssues(uatSnapshot({
      hasGitHubLink: false,
      hasBranch: false,
      hasDemoUrl: false,
      hasPrLink: false,
    }));
    expect(r.blockers).toEqual([]);
    expect(r.warnings).toEqual(expect.arrayContaining([
      "GitHub link not set",
      "Branch name not set",
      "Demo URL not set",
      "PR link not set",
    ]));
  });
});

describe("hasDocColumn", () => {
  function colMap(value: unknown): Map<string, unknown> {
    return new Map([["doc_col", { value: typeof value === "string" ? value : JSON.stringify(value) }]]);
  }

  it("detects a doc via doc_id (number or string)", () => {
    expect(hasDocColumn(colMap({ doc_id: 12345 }), "doc_col")).toBe(true);
    expect(hasDocColumn(colMap({ doc_id: "12345" }), "doc_col")).toBe(true);
  });

  it("detects a doc via files[0].fileId", () => {
    expect(hasDocColumn(colMap({ files: [{ fileId: 999 }] }), "doc_col")).toBe(true);
  });

  it("detects a doc via files[0].objectId (Monday's real shape: uuid fileId + numeric objectId)", () => {
    expect(hasDocColumn(colMap({
      files: [{ fileId: "40527c4d-ba99-4830-af20-4bb190e88a5a", objectId: 5096385810 }],
    }), "doc_col")).toBe(true);
  });

  it("returns false for empty/missing values", () => {
    expect(hasDocColumn(new Map(), "doc_col")).toBe(false);
    expect(hasDocColumn(colMap(""), "doc_col")).toBe(false);
    expect(hasDocColumn(colMap({}), "doc_col")).toBe(false);
    expect(hasDocColumn(colMap({ files: [] }), "doc_col")).toBe(false);
  });
});
