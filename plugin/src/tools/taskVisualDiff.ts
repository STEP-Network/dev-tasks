import { TASK_COLUMNS } from "../constants.ts";
import { uploadFileToMonday } from "../monday-client.ts";
import type { AppendTaskVisualSnapshotsInput } from "../schemas.ts";
import {
  appendDocContent,
  appendImageBlock,
  ensureItemDoc,
  fetchItemName,
} from "../services/doc-utils.ts";
import { formatError } from "./utils.ts";

/**
 * MCP tool for the Tasks board's `visualChangesDoc` column (doc_mm4jkk92).
 *
 * Appends a pass-grouped (before/after) section of labeled UI screenshots to a
 * task's dedicated "Visual Changes" Monday doc. The doc is created on first
 * append; every append leaves prior content intact (the doc is NEVER drained),
 * so the "before" pass written pre-merge and the "after" pass written
 * post-deploy accumulate into a single before/after record.
 *
 * Images are minted as Monday assets (uploaded to the task's attachments file
 * column) and embedded by permanent `asset_id` — never by URL, since an asset's
 * public_url expires ~1h after upload. See uploadFileToMonday + appendImageBlock.
 */

/** Filesystem-safe slug for a deterministic uploaded asset filename. */
function slugify(value: string): string {
  return (
    value
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "screen"
  );
}

export async function appendTaskVisualSnapshots(
  args: AppendTaskVisualSnapshotsInput,
): Promise<string> {
  try {
    const { taskId, phase, captures } = args;
    const environmentLabel = args.environmentLabel?.trim() || "staging";
    const capturedAt = args.capturedAt?.trim() || new Date().toISOString().slice(0, 10);

    const taskName = await fetchItemName(taskId);
    const docTitle = taskName
      ? `Visual Changes — Task #${taskId}: ${taskName}`
      : `Visual Changes — Task #${taskId}`;
    const docId = await ensureItemDoc(taskId, TASK_COLUMNS.visualChangesDoc, docTitle);

    const phaseLabel = phase === "before" ? "Before" : "After";
    const stage = phase === "before" ? "pre-change" : "post-deploy";
    await appendDocContent(
      docId,
      `\n## ${phaseLabel} — ${environmentLabel} (${stage}) · ${capturedAt}\n`,
    );

    let embedded = 0;
    let noteOnly = 0;
    const failures: string[] = [];

    for (const cap of captures) {
      const label = (cap.label?.trim() || cap.route).trim();
      const vp = cap.viewport ? ` · ${cap.viewport}` : "";
      await appendDocContent(docId, `\n**${label}${vp}**\n`);

      if (cap.note?.trim()) {
        await appendDocContent(docId, `\n_${cap.note.trim()}_\n`);
      }

      if (cap.imagePath) {
        try {
          const fileName = `task-${taskId}-${phase}-${slugify(label)}${
            cap.viewport ? `-${cap.viewport}` : ""
          }.png`;
          const { assetId } = await uploadFileToMonday(
            taskId,
            TASK_COLUMNS.attachments,
            cap.imagePath,
            fileName,
          );
          await appendImageBlock(docId, assetId);
          embedded++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          failures.push(`${label}${vp}: ${msg}`);
          await appendDocContent(docId, `\n_⚠️ image upload failed: ${msg}_\n`);
        }
      } else {
        noteOnly++;
      }
    }

    const lines = [
      `# Visual Changes Doc Updated`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${docId}`,
      `**Pass:** ${phaseLabel} — ${environmentLabel} (${stage}) · ${capturedAt}`,
      `**Images embedded:** ${embedded}`,
      `**Note-only entries:** ${noteOnly}`,
    ];
    if (failures.length > 0) {
      lines.push(
        ``,
        `**Upload failures (${failures.length}):**`,
        ...failures.map((f) => `- ${f}`),
      );
    }
    return lines.join("\n");
  } catch (error) {
    return formatError(
      `Failed to append visual snapshots: ${
        error instanceof Error ? error.message : String(error)
      }`,
    );
  }
}
