/**
 * Structured-changelog storage on the Versions board's `changelog` Doc column.
 *
 * **Why Doc instead of long_text**: Monday's `long_text` columns cap at ~2000
 * characters. A version with 100+ tasks (Sprint 9 reality) overflows the JSON
 * shape easily. Docs have no such practical limit.
 *
 * **Unified format** — one Doc per version, two co-located views:
 *
 *   ```
 *   # vX.Y.Z — release name
 *
 *   ## Summary
 *   ...
 *
 *   ## Features (N)
 *   - Task A (#123)
 *   - ...
 *
 *   ## Fixes (N)
 *   ## Improvements (N)
 *   ## Breaking changes
 *   ## Known issues
 *
 *   ---
 *   <!-- structured-changelog:begin -->
 *   ```json
 *   { "version": 1, "summary": "...", "tasks": { ... } }
 *   ```
 *   <!-- structured-changelog:end -->
 *   ```
 *
 *   The markdown above the marker is the human view. The fenced JSON block
 *   between the markers is the machine-readable canonical form. Both regenerate
 *   together on every write.
 *
 * **Doc resolution**: Monday's `doc` column stores `{ files: [{ objectId }] }`.
 * The objectId is the per-item linkage id, but `add_content_to_doc_from_markdown`
 * and `export_markdown_from_doc` want the doc's primary `id`. Resolve via
 * `docs(object_ids: [objectId]) { id }`. This module hides that complexity.
 *
 * **Replace semantics**: Monday 2025-10 dropped the `overwrite` flag on
 * `add_content_to_doc_from_markdown`. To emulate replacement, drain every
 * existing block via `delete_doc_block`, then `add_content_to_doc_from_markdown`
 * with the new content. Pattern lifted from generateChangelog.ts.
 */
import { DOC_API_VERSION, executeMondayQuery } from "../monday-client.js";
import { VERSION_COLUMNS } from "../constants.js";
import { getColumnValue, todayDate } from "../tools/utils.js";
import { setDocName, fetchItemName } from "./doc-utils.js";
const DOC_OPTS = { apiVersion: DOC_API_VERSION };
const MARKER_BEGIN = "<!-- structured-changelog:begin -->";
const MARKER_END = "<!-- structured-changelog:end -->";
// =============================================================================
// Resolve / ensure a Doc on a version
// =============================================================================
/**
 * Find the docId for a version's changelog column. Returns null if no doc
 * is attached yet.
 */
export async function resolveDocIdForVersion(versionId) {
    const query = `
    query {
      items(ids: [${versionId}]) {
        column_values(ids: ["${VERSION_COLUMNS.changelog}"]) {
          id
          value
        }
      }
    }
  `;
    const res = await executeMondayQuery(query);
    const cols = res.items?.[0]?.column_values || [];
    const colMap = new Map(cols.map((c) => [c.id, c]));
    const docValue = getColumnValue(colMap, VERSION_COLUMNS.changelog);
    if (!docValue || typeof docValue !== "object")
        return null;
    let docObjectId;
    const obj = docValue;
    const files = obj.files;
    if (files && files.length > 0) {
        const oid = files[0].objectId;
        if (typeof oid === "number")
            docObjectId = oid;
        else if (typeof oid === "string" && /^\d+$/.test(oid))
            docObjectId = Number(oid);
    }
    if (!docObjectId) {
        const idMatch = JSON.stringify(obj).match(/"(?:objectId|object_id)"\s*:\s*(\d+)/);
        if (idMatch)
            docObjectId = Number(idMatch[1]);
    }
    if (!docObjectId)
        return null;
    const resolveQuery = `
    query {
      docs(object_ids: [${docObjectId}]) { id }
    }
  `;
    const resolveRes = await executeMondayQuery(resolveQuery, undefined, DOC_OPTS);
    const rawId = resolveRes.docs?.[0]?.id;
    if (typeof rawId === "number")
        return rawId;
    if (typeof rawId === "string" && /^\d+$/.test(rawId))
        return Number(rawId);
    return null;
}
/**
 * Ensure a Doc exists for a version's changelog column. Creates one if missing.
 */
export async function ensureDocForVersion(versionId) {
    const existing = await resolveDocIdForVersion(versionId);
    if (existing)
        return existing;
    const createMutation = `
    mutation {
      create_doc(
        location: { board: { item_id: ${versionId}, column_id: "${VERSION_COLUMNS.changelog}" } }
      ) {
        id
      }
    }
  `;
    const res = await executeMondayQuery(createMutation, undefined, DOC_OPTS);
    const newIdRaw = res.create_doc?.id;
    const newId = typeof newIdRaw === "number"
        ? newIdRaw
        : typeof newIdRaw === "string" && /^\d+$/.test(newIdRaw)
            ? Number(newIdRaw)
            : undefined;
    if (!newId) {
        throw new Error(`Failed to create changelog Doc for version #${versionId}`);
    }
    // Rename the new doc so it's findable in Monday's UI. Best-effort —
    // a rename failure shouldn't block downstream changelog content writes.
    const versionName = await fetchItemName(versionId);
    const docTitle = versionName
        ? `Changelog — ${versionName}`
        : `Changelog — Version #${versionId}`;
    try {
        await setDocName(newId, docTitle);
    }
    catch {
        // Title is nice-to-have.
    }
    return newId;
}
// =============================================================================
// Read structured changelog from Doc
// =============================================================================
/**
 * Extract the structured JSON block from a markdown doc.
 *
 * Two strategies — fast path (markers) and fallback (last shape-matching
 * fenced block). Monday's `add_content_to_doc_from_markdown` →
 * `export_markdown_from_doc` round-trip turned out to strip HTML comments
 * in some cases, so we can't rely on the markers always surviving.
 *
 * Returns null only when both strategies fail.
 */
export function extractStructuredFromMarkdown(markdown) {
    if (!markdown)
        return null;
    // Fast path: marker pair present → JSON block lives between them.
    const beginIdx = markdown.indexOf(MARKER_BEGIN);
    const endIdx = markdown.indexOf(MARKER_END);
    if (beginIdx !== -1 && endIdx !== -1 && endIdx > beginIdx) {
        const between = markdown.slice(beginIdx + MARKER_BEGIN.length, endIdx);
        const stripped = between
            .replace(/```\s*json\s*/gi, "")
            .replace(/```/g, "")
            .trim();
        if (stripped) {
            try {
                return JSON.parse(stripped);
            }
            catch {
                // Fall through to the fenced-block fallback
            }
        }
    }
    // Fallback: scan all fenced code blocks (regardless of language tag),
    // try to parse each as JSON, accept the last one that LOOKS like a
    // structured changelog (object with a `tasks` key). Monday preserves
    // fenced code blocks as first-class doc blocks even when it loses HTML
    // comments — so this path survives marker stripping.
    const codeBlockRegex = /```[^\n]*\n?([\s\S]*?)```/g;
    const matches = Array.from(markdown.matchAll(codeBlockRegex));
    for (let i = matches.length - 1; i >= 0; i--) {
        const content = (matches[i][1] || "").trim();
        if (!content)
            continue;
        try {
            const parsed = JSON.parse(content);
            if (parsed &&
                typeof parsed === "object" &&
                !Array.isArray(parsed) &&
                "tasks" in parsed) {
                return parsed;
            }
        }
        catch {
            // try the next earlier block
        }
    }
    return null;
}
/**
 * Read the version's Doc, extract the structured JSON block, return parsed.
 * Returns null when:
 *   - No Doc attached
 *   - Doc has no `structured-changelog:begin/end` markers
 *   - JSON block fails to parse
 */
export async function readStructuredFromVersionDoc(versionId) {
    const docId = await resolveDocIdForVersion(versionId);
    if (!docId)
        return null;
    const query = `
    query {
      export_markdown_from_doc(docId: ${docId}) {
        markdown
      }
    }
  `;
    const res = await executeMondayQuery(query, undefined, DOC_OPTS);
    const markdown = res.export_markdown_from_doc?.markdown;
    if (!markdown || typeof markdown !== "string")
        return null;
    return extractStructuredFromMarkdown(markdown);
}
// =============================================================================
// Render structured changelog as unified markdown (human + JSON block)
// =============================================================================
function entryDisplay(e) {
    const display = e.publicName || e.name;
    return e.id ? `${display} (#${e.id})` : display;
}
/**
 * Pure render: structured changelog → unified markdown (human view + JSON block).
 * Writers call this and pipe the result to `add_content_to_doc_from_markdown`.
 */
export function renderUnifiedChangelog(c, opts) {
    const lines = [];
    const label = opts?.versionLabel ?? "Changelog";
    lines.push(`# ${label}`);
    lines.push("");
    if (c.summary && c.summary.trim()) {
        lines.push("## Summary");
        lines.push(c.summary.trim());
        lines.push("");
    }
    if (c.highlights && c.highlights.length > 0) {
        lines.push("## Highlights");
        for (const h of c.highlights)
            lines.push(`- ${h}`);
        lines.push("");
    }
    const sections = [
        [`Features (${c.tasks.Feature.length})`, c.tasks.Feature],
        [`Fixes (${c.tasks.Fix.length})`, c.tasks.Fix],
        [`Improvements (${c.tasks.Improvement.length})`, c.tasks.Improvement],
    ];
    for (const [heading, entries] of sections) {
        if (entries.length === 0)
            continue;
        lines.push(`## ${heading}`);
        for (const e of entries)
            lines.push(`- ${entryDisplay(e)}`);
        lines.push("");
    }
    if (c.breakingChanges && c.breakingChanges.length > 0) {
        lines.push("## Breaking changes");
        for (const b of c.breakingChanges)
            lines.push(`- ${b}`);
        lines.push("");
    }
    if (c.knownIssues && c.knownIssues.length > 0) {
        lines.push("## Known issues");
        for (const k of c.knownIssues)
            lines.push(`- ${k}`);
        lines.push("");
    }
    lines.push("---");
    lines.push(`Last updated ${todayDate()}`);
    lines.push("");
    // Machine-readable block
    lines.push(MARKER_BEGIN);
    lines.push("```json");
    lines.push(JSON.stringify(c, null, 2));
    lines.push("```");
    lines.push(MARKER_END);
    return lines.join("\n");
}
// =============================================================================
// Write unified changelog to Doc (drain + replace)
// =============================================================================
/**
 * Write the unified changelog to the version's Doc. Creates the Doc if missing,
 * drains all existing blocks, then appends the rendered content.
 *
 * Returns the docId so callers (e.g. generateChangelog) can echo it in their
 * response for traceability.
 */
export async function writeUnifiedChangelogToVersion(versionId, c, opts) {
    const docId = await ensureDocForVersion(versionId);
    const markdown = renderUnifiedChangelog(c, opts);
    // Drain all existing blocks. Monday paginates ~25 per query; cap iterations.
    for (let pass = 0; pass < 50; pass++) {
        const blocksQuery = `
      query {
        docs(ids: [${docId}]) {
          blocks { id }
        }
      }
    `;
        const blocksRes = await executeMondayQuery(blocksQuery, undefined, DOC_OPTS);
        const blocks = blocksRes.docs?.[0]?.blocks || [];
        if (blocks.length === 0)
            break;
        for (const block of blocks) {
            if (!block.id)
                continue;
            const delMutation = `
        mutation {
          delete_doc_block(block_id: ${JSON.stringify(block.id)}) { id }
        }
      `;
            await executeMondayQuery(delMutation, undefined, DOC_OPTS);
        }
    }
    const writeMutation = `
    mutation {
      add_content_to_doc_from_markdown(
        docId: ${docId},
        markdown: ${JSON.stringify(markdown)}
      ) {
        success
      }
    }
  `;
    await executeMondayQuery(writeMutation, undefined, DOC_OPTS);
    return docId;
}
