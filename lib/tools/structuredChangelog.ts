import { executeMondayQuery } from "../monday-client";
import { BOARDS, VERSION_COLUMNS, TASK_COLUMNS } from "../constants";
import type {
  GetStructuredChangelogInput,
  UpdateStructuredChangelogInput,
  MigrateStructuredChangelogInput,
} from "../schemas";
import { buildColumnValues, getColumnText, formatError } from "./utils";

// =============================================================================
// Canonical shape
// =============================================================================

export type Category = "Feature" | "Fix" | "Improvement";

export interface ChangelogEntry {
  id?: number;
  name: string;
  publicName?: string;
}

export interface StructuredChangelog {
  version: 1;
  summary?: string;
  highlights?: string[];
  breakingChanges?: string[];
  knownIssues?: string[];
  tasks: Record<Category, ChangelogEntry[]>;
}

export function emptyChangelog(): StructuredChangelog {
  return {
    version: 1,
    tasks: { Feature: [], Fix: [], Improvement: [] },
  };
}

// =============================================================================
// Task type → category mapping
// =============================================================================

const TASK_TYPE_TO_CATEGORY: Record<string, Category> = {
  Development: "Feature",
  Bugfix: "Fix",
  Maintenance: "Improvement",
  Refine: "Improvement",
  Documentation: "Improvement",
  "PM-work": "Improvement",
};

export function categoryForTaskType(taskType: string | undefined): Category {
  if (!taskType) return "Improvement";
  return TASK_TYPE_TO_CATEGORY[taskType] ?? "Improvement";
}

// =============================================================================
// Parser — strips markers / fences and extracts JSON
// =============================================================================

function parseRawChangelog(raw: string): unknown | undefined {
  if (!raw || !raw.trim()) return undefined;

  // Strip common wrappers — comment markers, custom delimiters, fenced code blocks
  const text = raw
    .replace(/<!--\s*changelog[-_]json\s*-->/gi, "")
    .replace(/<!--\s*\/changelog[-_]json\s*-->/gi, "")
    .replace(/<<<\s*JSON\s*>>>/gi, "")
    .replace(/<<<\s*END\s*>>>/gi, "")
    .replace(/```(?:json)?\s*/gi, "")
    .replace(/```/g, "")
    .trim();

  // Direct parse
  try {
    return JSON.parse(text);
  } catch {
    // Brace walker — find outermost JSON object
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start >= 0 && end > start) {
      try {
        return JSON.parse(text.slice(start, end + 1));
      } catch {
        return undefined;
      }
    }
    return undefined;
  }
}

// =============================================================================
// Migration — upgrade legacy shapes to canonical 3-cat
// =============================================================================

// Case-insensitive: lookup keys are lowercased before matching.
const LEGACY_CATEGORY_MAP: Record<string, Category> = {
  added: "Feature",
  feature: "Feature",
  features: "Feature",
  new: "Feature",
  fixed: "Fix",
  fix: "Fix",
  fixes: "Fix",
  bugfix: "Fix",
  changed: "Improvement",
  improvement: "Improvement",
  improvements: "Improvement",
  documentation: "Improvement",
  docs: "Improvement",
  maintenance: "Improvement",
  other: "Improvement",
};

function lookupCategory(bucket: string): Category | undefined {
  return LEGACY_CATEGORY_MAP[bucket.toLowerCase()];
}

function migrateChangelog(parsed: unknown): StructuredChangelog {
  if (!parsed || typeof parsed !== "object") return emptyChangelog();
  const obj = parsed as Record<string, unknown>;

  const out = emptyChangelog();
  if (typeof obj.summary === "string") out.summary = obj.summary;
  if (Array.isArray(obj.highlights)) out.highlights = obj.highlights.filter((h): h is string => typeof h === "string");
  if (Array.isArray(obj.breakingChanges)) out.breakingChanges = obj.breakingChanges.filter((h): h is string => typeof h === "string");
  if (Array.isArray(obj.knownIssues)) out.knownIssues = obj.knownIssues.filter((h): h is string => typeof h === "string");

  // Bucket source — canonical wraps tasks under `tasks`, the original 4-cat
  // and the lowercase 3-cat backfill wrap under `categories`, and the very
  // earliest flat shape put bucket keys at the top level.
  const taskBuckets: Record<string, unknown> =
    (obj.tasks && typeof obj.tasks === "object") ? obj.tasks as Record<string, unknown>
    : (obj.categories && typeof obj.categories === "object") ? obj.categories as Record<string, unknown>
    : obj;

  for (const [bucket, value] of Object.entries(taskBuckets)) {
    const target = lookupCategory(bucket);
    if (!target) continue;
    if (!Array.isArray(value)) continue;
    for (const entry of value) {
      const normalized = normalizeEntry(entry);
      if (normalized) out.tasks[target].push(normalized);
    }
  }

  return out;
}

function normalizeEntry(raw: unknown): ChangelogEntry | undefined {
  if (typeof raw === "string") {
    // Legacy bullet-style entry like "- foo (#123)"
    const m = raw.match(/^-?\s*(.+?)\s*(?:\(#(\d+)\))?\s*$/);
    if (!m) return undefined;
    const entry: ChangelogEntry = { name: m[1] };
    if (m[2]) entry.id = Number(m[2]);
    return entry;
  }
  if (raw && typeof raw === "object") {
    const o = raw as Record<string, unknown>;
    const name = typeof o.name === "string" ? o.name : (typeof o.title === "string" ? o.title : undefined);
    if (!name) return undefined;
    const entry: ChangelogEntry = { name };
    if (typeof o.id === "number") entry.id = o.id;
    else if (typeof o.id === "string" && /^\d+$/.test(o.id)) entry.id = Number(o.id);
    if (typeof o.publicName === "string") entry.publicName = o.publicName;
    return entry;
  }
  return undefined;
}

// =============================================================================
// Storage helpers — read & write the JSON column
// =============================================================================

async function readChangelog(versionId: number): Promise<{ raw: string; parsed: StructuredChangelog }> {
  const query = `
    query {
      items(ids: [${versionId}]) {
        column_values(ids: ["${VERSION_COLUMNS.releaseSummary}"]) {
          id
          text
          value
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const cols = response.items?.[0]?.column_values || [];
  const raw = cols[0]?.text || cols[0]?.value || "";
  const cleaned = typeof raw === "string" ? raw : "";
  const parsed = parseRawChangelog(cleaned);
  return { raw: cleaned, parsed: parsed ? migrateChangelog(parsed) : emptyChangelog() };
}

async function writeChangelog(versionId: number, data: StructuredChangelog): Promise<void> {
  const json = JSON.stringify(data);
  const mutation = `
    mutation {
      change_multiple_column_values(
        board_id: ${BOARDS.VERSIONS},
        item_id: ${versionId},
        column_values: ${buildColumnValues({ [VERSION_COLUMNS.releaseSummary]: { text: json } })}
      ) {
        id
      }
    }
  `;
  await executeMondayQuery<unknown>(mutation);
}

async function fetchTaskForChangelog(taskId: number): Promise<{ name: string; publicName?: string; category: Category } | undefined> {
  const query = `
    query {
      items(ids: [${taskId}]) {
        id
        name
        column_values(ids: ["${TASK_COLUMNS.publicTaskName}", "${TASK_COLUMNS.type}"]) {
          id
          text
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const item = response.items?.[0];
  if (!item) return undefined;
  const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
  return {
    name: item.name,
    publicName: getColumnText(colMap, TASK_COLUMNS.publicTaskName),
    category: categoryForTaskType(getColumnText(colMap, TASK_COLUMNS.type)),
  };
}

// =============================================================================
// Tool: getStructuredChangelog
// =============================================================================

export async function getStructuredChangelog(args: GetStructuredChangelogInput): Promise<string> {
  try {
    const { parsed } = await readChangelog(args.versionId);
    return JSON.stringify(parsed, null, 2);
  } catch (error) {
    return formatError(`Failed to read structured changelog: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// Tool: updateStructuredChangelog
// =============================================================================

export async function updateStructuredChangelog(args: UpdateStructuredChangelogInput): Promise<string> {
  try {
    const { versionId, patch } = args;
    const { parsed: current } = await readChangelog(versionId);

    const applied: string[] = [];

    for (const op of patch) {
      switch (op.op) {
        case "addTask": {
          if (op.taskId) {
            const fetched = await fetchTaskForChangelog(op.taskId);
            if (!fetched) {
              return formatError(`Task #${op.taskId} not found.`);
            }
            current.tasks[fetched.category].push({
              id: op.taskId,
              name: fetched.name,
              publicName: fetched.publicName,
            });
            applied.push(`addTask: #${op.taskId} → ${fetched.category} (${fetched.publicName || fetched.name})`);
          } else {
            if (!op.name || !op.category) {
              return formatError(`addTask op without taskId requires both 'name' and 'category'.`);
            }
            current.tasks[op.category].push({ name: op.name });
            applied.push(`addTask: manual entry → ${op.category} (${op.name})`);
          }
          break;
        }
        case "removeTask": {
          let removed = 0;
          if (op.taskId) {
            for (const cat of ["Feature", "Fix", "Improvement"] as Category[]) {
              const before = current.tasks[cat].length;
              current.tasks[cat] = current.tasks[cat].filter(e => e.id !== op.taskId);
              removed += before - current.tasks[cat].length;
            }
            applied.push(`removeTask: #${op.taskId} (removed ${removed})`);
          } else {
            if (!op.name || !op.category) {
              return formatError(`removeTask op without taskId requires both 'name' and 'category'.`);
            }
            const before = current.tasks[op.category].length;
            // Only remove manual entries (id === undefined) to avoid clobbering task-linked entries by name collision
            current.tasks[op.category] = current.tasks[op.category].filter(
              e => !(e.name === op.name && e.id === undefined),
            );
            removed = before - current.tasks[op.category].length;
            applied.push(`removeTask: manual ${op.category}/"${op.name}" (removed ${removed})`);
          }
          break;
        }
        case "setSummary":
          current.summary = op.text;
          applied.push(`setSummary`);
          break;
        case "setHighlights":
          current.highlights = op.items;
          applied.push(`setHighlights (${op.items.length})`);
          break;
        case "setBreakingChanges":
          current.breakingChanges = op.items;
          applied.push(`setBreakingChanges (${op.items.length})`);
          break;
        case "setKnownIssues":
          current.knownIssues = op.items;
          applied.push(`setKnownIssues (${op.items.length})`);
          break;
      }
    }

    await writeChangelog(versionId, current);

    const counts = current.tasks;
    return [
      `# Structured Changelog Updated`,
      ``,
      `**Version:** #${versionId}`,
      ``,
      `**Applied:**`,
      ...applied.map(a => `- ${a}`),
      ``,
      `**Totals:** Feature ${counts.Feature.length}, Fix ${counts.Fix.length}, Improvement ${counts.Improvement.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to update structured changelog: ${error instanceof Error ? error.message : String(error)}`);
  }
}

// =============================================================================
// Tool: migrateStructuredChangelog (pure)
// =============================================================================

export async function migrateStructuredChangelog(args: MigrateStructuredChangelogInput): Promise<string> {
  try {
    const parsed = parseRawChangelog(args.json);
    const migrated = parsed ? migrateChangelog(parsed) : emptyChangelog();
    return JSON.stringify(migrated, null, 2);
  } catch (error) {
    return formatError(`Failed to migrate structured changelog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
