import { TASK_COLUMNS } from "../constants.ts";
import type {
  GetTaskUatDocInput,
  CreateTaskUatDocInput,
  UpdateTaskUatDocInput,
} from "../schemas.ts";
import { formatError } from "./utils.ts";
import {
  appendDocContent,
  ensureItemDoc,
  fetchItemDocId,
  fetchItemName,
  readDocAsMarkdown,
  writeDocContentReplacing,
} from "../services/doc-utils.ts";

/**
 * MCP tools for the Tasks board's `uatDoc` column (doc_mm3adfdg).
 *
 * Doc plumbing (object_id ↔ primary id resolution, block draining, content
 * replace/append, naming) lives in `doc-utils.ts` and is shared with the
 * description-doc tools. This file is the UAT-specific wrapper.
 */

export async function getTaskUatDoc(args: GetTaskUatDocInput): Promise<string> {
  try {
    const { taskId } = args;
    const docId = await fetchItemDocId(taskId, TASK_COLUMNS.uatDoc);
    if (!docId) {
      return formatError(
        `Task #${taskId} has no UAT doc set. Use createTaskUatDoc(taskId, markdown) to create one.`,
      );
    }
    const md = (await readDocAsMarkdown(docId)).trim();
    return [
      `# UAT Doc — Task #${taskId} (doc ${docId})`,
      ``,
      md.length > 0 ? md : "_(empty doc)_",
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to read UAT doc: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function createTaskUatDoc(args: CreateTaskUatDocInput): Promise<string> {
  try {
    const { taskId, markdown } = args;
    const existing = await fetchItemDocId(taskId, TASK_COLUMNS.uatDoc);
    if (existing) {
      return formatError(
        `Task #${taskId} already has a UAT doc (id ${existing}). Use updateTaskUatDoc to modify it.`,
      );
    }
    const taskName = await fetchItemName(taskId);
    const docTitle = taskName
      ? `UAT — Task #${taskId}: ${taskName}`
      : `UAT — Task #${taskId}`;
    const docId = await ensureItemDoc(taskId, TASK_COLUMNS.uatDoc, docTitle);
    await writeDocContentReplacing(docId, markdown);
    return [
      `# UAT Doc Created`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${docId}`,
      `**Title:** ${docTitle}`,
      `**Characters written:** ${markdown.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to create UAT doc: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateTaskUatDoc(args: UpdateTaskUatDocInput): Promise<string> {
  try {
    const { taskId, markdown, overwrite = true } = args;
    const docId = await fetchItemDocId(taskId, TASK_COLUMNS.uatDoc);
    if (!docId) {
      return formatError(
        `Task #${taskId} has no UAT doc to update. Use createTaskUatDoc(taskId, markdown) first.`,
      );
    }
    if (overwrite) {
      const { deletedBlocks } = await writeDocContentReplacing(docId, markdown);
      return [
        `# UAT Doc Updated`,
        ``,
        `**Task:** #${taskId}`,
        `**Doc ID:** ${docId}`,
        `**Mode:** overwrite (deleted ${deletedBlocks} block${deletedBlocks === 1 ? "" : "s"})`,
        `**Characters written:** ${markdown.length}`,
      ].join("\n");
    }
    await appendDocContent(docId, markdown);
    return [
      `# UAT Doc Updated`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${docId}`,
      `**Mode:** append`,
      `**Characters written:** ${markdown.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to update UAT doc: ${error instanceof Error ? error.message : String(error)}`);
  }
}
