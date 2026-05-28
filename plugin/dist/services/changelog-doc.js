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
 * **Doc resolution + drain-and-replace** live in `doc-utils.ts` (`fetchItemDocId`,
 * `ensureItemDoc`, `writeDocContentReplacing`, `readDocAsMarkdown`). Earlier
 * versions of this module inlined those Monday API patterns; the cleanup that
 * landed in PR M (code-review finding #12) collapsed them to thin wrappers
 * around the shared helpers so changes to the Monday doc contract land in one
 * place instead of silently diverging.
 */
import { VERSION_COLUMNS } from "../constants.js";
import { todayDate } from "../tools/utils.js";
import { fetchItemDocId, fetchItemName, ensureItemDoc, readDocAsMarkdown, writeDocContentReplacing, } from "./doc-utils.js";
const MARKER_BEGIN = "<!-- structured-changelog:begin -->";
const MARKER_END = "<!-- structured-changelog:end -->";
// =============================================================================
// Ensure a Doc on a version (find-or-create with title)
// =============================================================================
/**
 * Ensure a Doc exists for a version's changelog column. Creates one if missing,
 * setting a title based on the version's name. Returns the doc's primary id.
 *
 * Internal — callers go through `writeUnifiedChangelogToVersion`.
 */
async function ensureDocForVersion(versionId) {
    const versionName = await fetchItemName(versionId);
    const title = versionName
        ? `Changelog — ${versionName}`
        : `Changelog — Version #${versionId}`;
    return ensureItemDoc(versionId, VERSION_COLUMNS.changelog, title);
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
 *   - Monday export fails (best-effort — callers fall back to legacy paths)
 */
export async function readStructuredFromVersionDoc(versionId) {
    const docId = await fetchItemDocId(versionId, VERSION_COLUMNS.changelog);
    if (!docId)
        return null;
    try {
        const markdown = await readDocAsMarkdown(docId);
        if (!markdown)
            return null;
        return extractStructuredFromMarkdown(markdown);
    }
    catch {
        // readDocAsMarkdown throws on Monday `success:false`; pre-refactor behavior
        // was to silently return null here, and callers already treat null as "no
        // parseable structured changelog available" and fall back accordingly.
        return null;
    }
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
    await writeDocContentReplacing(docId, markdown);
    return docId;
}
