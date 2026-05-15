import { executeMondayQuery } from "../monday-client.ts";
import { BOARDS, VERSION_COLUMNS, TASK_COLUMNS } from "../constants.ts";
import type {
  GetStructuredChangelogInput,
  UpdateStructuredChangelogInput,
  MigrateStructuredChangelogInput,
} from "../schemas.ts";
import { evaluatePublicVisibility, getColumnText, formatError } from "./utils.ts";

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

// Task types map 1:1 to changelog categories (Feature/Fix/Improvement). Human todos
// and unset types fall through to Improvement, but in practice they're filtered out
// upstream by evaluatePublicVisibility since they shouldn't have a public name.
const TASK_TYPE_TO_CATEGORY: Record<string, Category> = {
  Feature: "Feature",
  Fix: "Fix",
  Improvement: "Improvement",
  "To Do": "Improvement",
  "Not Set": "Improvement",
};

export function categoryForTaskType(taskType: string | undefined): Category {
  if (!taskType) return "Improvement";
  return TASK_TYPE_TO_CATEGORY[taskType] ?? "Improvement";
}

// =============================================================================
// Storage serialization — bare strings to fit Monday's 2000-char long_text cap
// =============================================================================

function entryToString(entry: ChangelogEntry): string {
  const display = entry.publicName || entry.name;
  return entry.id ? `${display} (#${entry.id})` : display;
}

export function serializeForStorage(c: StructuredChangelog): unknown {
  const out: Record<string, unknown> = { version: c.version };
  if (c.summary !== undefined) out.summary = c.summary;
  if (c.highlights !== undefined) out.highlights = c.highlights;
  if (c.breakingChanges !== undefined) out.breakingChanges = c.breakingChanges;
  if (c.knownIssues !== undefined) out.knownIssues = c.knownIssues;
  out.tasks = {
    Feature: c.tasks.Feature.map(entryToString),
    Fix: c.tasks.Fix.map(entryToString),
    Improvement: c.tasks.Improvement.map(entryToString),
  };
  return out;
}

// =============================================================================
// Parser — strips markers / fences and extracts JSON
// =============================================================================

export function parseRawChangelog(raw: string): unknown | undefined {
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

export function migrateChangelog(parsed: unknown): StructuredChangelog {
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
  const text = typeof cols[0]?.text === "string" ? cols[0].text : "";
  const value = typeof cols[0]?.value === "string" ? cols[0].value : "";

  // Prefer the `text` field (canonical for long_text). Fall back to `value`,
  // which for long_text writes via change_multiple_column_values may contain a
  // {"text": "<inner>", "changed_at": "..."} wrapper instead of raw content.
  let raw = "";
  if (text.trim()) {
    raw = text;
  } else if (value.trim()) {
    try {
      const maybeWrapper = JSON.parse(value);
      if (maybeWrapper && typeof maybeWrapper === "object" && !Array.isArray(maybeWrapper) && typeof (maybeWrapper as Record<string, unknown>).text === "string") {
        raw = (maybeWrapper as Record<string, unknown>).text as string;
      } else {
        raw = value;
      }
    } catch {
      raw = value;
    }
  }

  const parsed = parseRawChangelog(raw);
  return { raw, parsed: parsed ? migrateChangelog(parsed) : emptyChangelog() };
}

export async function writeChangelog(versionId: number, data: StructuredChangelog): Promise<void> {
  // Serialize to bare-string entries (~3x smaller than {id,name,publicName}
  // objects) so we stay under Monday's ~2000-char long_text cap. Monday silently
  // truncates anything larger, producing unparseable JSON.
  const json = JSON.stringify(serializeForStorage(data));
  // change_simple_column_value populates both the `text` and `value` fields on
  // long_text columns; change_multiple_column_values with `{"text": ...}` has
  // historically left `text` null in this codebase, which broke downstream
  // readers that default to the text field.
  const mutation = `
    mutation {
      change_simple_column_value(
        board_id: ${BOARDS.VERSIONS},
        item_id: ${versionId},
        column_id: "${VERSION_COLUMNS.releaseSummary}",
        value: ${JSON.stringify(json)}
      ) {
        id
      }
    }
  `;
  await executeMondayQuery<unknown>(mutation);
}

function isEmptyChangelog(c: StructuredChangelog): boolean {
  return !c.summary
    && !(c.highlights && c.highlights.length > 0)
    && !(c.breakingChanges && c.breakingChanges.length > 0)
    && !(c.knownIssues && c.knownIssues.length > 0)
    && c.tasks.Feature.length === 0
    && c.tasks.Fix.length === 0
    && c.tasks.Improvement.length === 0;
}

async function fetchTaskForChangelog(taskId: number): Promise<{
  name: string;
  publicName?: string;
  category: Category;
  visibilityReasons: string[];
  isPublic: boolean;
} | undefined> {
  const query = `
    query {
      items(ids: [${taskId}]) {
        id
        name
        column_values(ids: ["${TASK_COLUMNS.publicTaskName}", "${TASK_COLUMNS.type}", "${TASK_COLUMNS.epic}", "${TASK_COLUMNS.sprint}"]) {
          id
          text
          ... on BoardRelationValue { linked_items { id name } }
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const item = response.items?.[0];
  if (!item) return undefined;
  const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
  const visibility = evaluatePublicVisibility(colMap);
  return {
    name: item.name,
    publicName: visibility.publicName,
    category: categoryForTaskType(getColumnText(colMap, TASK_COLUMNS.type)),
    visibilityReasons: visibility.reasons,
    isPublic: visibility.isPublic,
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
    const { raw, parsed: current } = await readChangelog(versionId);

    // Defensive: if raw storage has content but the parser returned empty, refuse
    // to write — applying patch ops to empty state would silently wipe the data.
    if (raw.trim().length > 0 && isEmptyChangelog(current)) {
      return formatError(
        `Refusing to update version #${versionId}: storage has content but the parser returned empty buckets. ` +
        `This usually means the stored shape is unrecognized. Inspect the raw value via mcp__monday__get_board_items_page ` +
        `and report the shape so the migrator can be extended.`,
      );
    }

    const applied: string[] = [];

    for (const op of patch) {
      switch (op.op) {
        case "addTask": {
          if (op.taskId) {
            const fetched = await fetchTaskForChangelog(op.taskId);
            if (!fetched) {
              return formatError(`Task #${op.taskId} not found.`);
            }
            // Public visibility requires ALL of: publicTaskName set, linked epic,
            // assigned sprint. Refuse so private work isn't accidentally exposed.
            if (!fetched.isPublic || !fetched.publicName) {
              return formatError(
                `Task #${op.taskId} is private and cannot be added to the changelog (${fetched.visibilityReasons.join(", ")}). ` +
                `Set a public name with setPublicTaskName, link the task to an epic via updateTask({ epicId }), and assign it to a sprint via updateTask({ sprintId }), then retry.`,
              );
            }
            current.tasks[fetched.category].push({
              id: op.taskId,
              name: fetched.name,
              publicName: fetched.publicName,
            });
            applied.push(`addTask: #${op.taskId} → ${fetched.category} (${fetched.publicName})`);
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
