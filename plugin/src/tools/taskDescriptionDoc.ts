import { TASK_COLUMNS } from "../constants.ts";
import type {
  GetTaskDescriptionDocInput,
  CreateTaskDescriptionDocInput,
  UpdateTaskDescriptionDocInput,
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
 * MCP tools for the Tasks board's `descriptionDoc` column (doc_mm3sg1kr).
 *
 * Parallel surface to the UAT doc tools (`getTaskUatDoc` / `createTaskUatDoc`
 * / `updateTaskUatDoc`). The plain `description` field on createTask /
 * updateTask writes here transparently; these tools are for direct
 * doc-level access (long-form refinement, separate-from-update workflow).
 */

export async function getTaskDescriptionDoc(
  args: GetTaskDescriptionDocInput,
): Promise<string> {
  try {
    const { taskId } = args;
    const docId = await fetchItemDocId(taskId, TASK_COLUMNS.descriptionDoc);
    if (!docId) {
      return formatError(
        `Task #${taskId} has no description doc set. Use createTaskDescriptionDoc(taskId, markdown) to create one.`,
      );
    }
    const md = (await readDocAsMarkdown(docId)).trim();
    return [
      `# Description Doc — Task #${taskId} (doc ${docId})`,
      ``,
      md.length > 0 ? md : "_(empty doc)_",
    ].join("\n");
  } catch (error) {
    return formatError(
      `Failed to read description doc: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function createTaskDescriptionDoc(
  args: CreateTaskDescriptionDocInput,
): Promise<string> {
  try {
    const { taskId, markdown } = args;
    const existing = await fetchItemDocId(taskId, TASK_COLUMNS.descriptionDoc);
    if (existing) {
      return formatError(
        `Task #${taskId} already has a description doc (id ${existing}). Use updateTaskDescriptionDoc to modify it.`,
      );
    }
    const taskName = await fetchItemName(taskId);
    const title = taskName
      ? `Description — Task #${taskId}: ${taskName}`
      : `Description — Task #${taskId}`;
    const docId = await ensureItemDoc(taskId, TASK_COLUMNS.descriptionDoc, title);
    await writeDocContentReplacing(docId, markdown);
    return [
      `# Description Doc Created`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${docId}`,
      `**Title:** ${title}`,
      `**Characters written:** ${markdown.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(
      `Failed to create description doc: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

export async function updateTaskDescriptionDoc(
  args: UpdateTaskDescriptionDocInput,
): Promise<string> {
  try {
    const { taskId, markdown, overwrite = true } = args;
    const docId = await fetchItemDocId(taskId, TASK_COLUMNS.descriptionDoc);
    if (!docId) {
      return formatError(
        `Task #${taskId} has no description doc to update. Use createTaskDescriptionDoc(taskId, markdown) first.`,
      );
    }
    if (overwrite) {
      const { deletedBlocks } = await writeDocContentReplacing(docId, markdown);
      return [
        `# Description Doc Updated`,
        ``,
        `**Task:** #${taskId}`,
        `**Doc ID:** ${docId}`,
        `**Mode:** overwrite (deleted ${deletedBlocks} block${deletedBlocks === 1 ? "" : "s"})`,
        `**Characters written:** ${markdown.length}`,
      ].join("\n");
    }
    await appendDocContent(docId, markdown);
    return [
      `# Description Doc Updated`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${docId}`,
      `**Mode:** append`,
      `**Characters written:** ${markdown.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(
      `Failed to update description doc: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
}
