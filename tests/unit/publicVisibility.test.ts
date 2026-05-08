import { describe, it, expect } from "vitest";
import { evaluatePublicVisibility } from "@/lib/tools/utils";
import { TASK_COLUMNS } from "@/lib/constants";

function makeColMap(opts: { publicName?: string; epicCount?: number; sprintCount?: number }): Map<string, unknown> {
  const m = new Map<string, unknown>();
  if (opts.publicName !== undefined) m.set(TASK_COLUMNS.publicTaskName, { text: opts.publicName });
  if (opts.epicCount !== undefined) {
    m.set(TASK_COLUMNS.epic, { linked_items: Array.from({ length: opts.epicCount }, (_, i) => ({ id: String(i + 1), name: `Epic ${i + 1}` })) });
  }
  if (opts.sprintCount !== undefined) {
    m.set(TASK_COLUMNS.sprint, { linked_items: Array.from({ length: opts.sprintCount }, (_, i) => ({ id: String(i + 1), name: `Sprint ${i + 1}` })) });
  }
  return m;
}

describe("evaluatePublicVisibility", () => {
  it("is public when public name + epic + sprint are all present", () => {
    const result = evaluatePublicVisibility(makeColMap({ publicName: "Foo", epicCount: 1, sprintCount: 1 }));
    expect(result.isPublic).toBe(true);
    expect(result.publicName).toBe("Foo");
    expect(result.reasons).toEqual([]);
  });

  it("is private with no public name", () => {
    const result = evaluatePublicVisibility(makeColMap({ publicName: "", epicCount: 1, sprintCount: 1 }));
    expect(result.isPublic).toBe(false);
    expect(result.reasons).toContain("no public name");
  });

  it("is private with no epic", () => {
    const result = evaluatePublicVisibility(makeColMap({ publicName: "Foo", epicCount: 0, sprintCount: 1 }));
    expect(result.isPublic).toBe(false);
    expect(result.reasons).toContain("not linked to an epic");
  });

  it("is private with no sprint", () => {
    const result = evaluatePublicVisibility(makeColMap({ publicName: "Foo", epicCount: 1, sprintCount: 0 }));
    expect(result.isPublic).toBe(false);
    expect(result.reasons).toContain("not assigned to a sprint");
  });

  it("lists every reason when multiple conditions fail", () => {
    const result = evaluatePublicVisibility(makeColMap({ epicCount: 0, sprintCount: 0 }));
    expect(result.isPublic).toBe(false);
    expect(result.reasons).toEqual(expect.arrayContaining(["no public name", "not linked to an epic", "not assigned to a sprint"]));
    expect(result.reasons).toHaveLength(3);
  });

  it("treats whitespace-only public name as private", () => {
    const result = evaluatePublicVisibility(makeColMap({ publicName: "   ", epicCount: 1, sprintCount: 1 }));
    expect(result.isPublic).toBe(false);
    expect(result.reasons).toContain("no public name");
  });
});
