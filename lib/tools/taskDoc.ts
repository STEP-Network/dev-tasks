import { executeMondayQuery } from "../monday-client";
import { BOARDS, TASK_COLUMNS } from "../constants";
import type {
  GetTaskUatDocInput,
  CreateTaskUatDocInput,
  UpdateTaskUatDocInput,
} from "../schemas";
import { getColumnValue, formatError } from "./utils";

// Fetch the doc_id from the task's UAT doc column. Returns undefined if no doc.
async function fetchUatDocId(taskId: number): Promise<number | undefined> {
  const query = `
    query {
      items(ids: [${taskId}]) {
        column_values(ids: ["${TASK_COLUMNS.uatDoc}"]) {
          id
          value
        }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const item = response.items?.[0];
  if (!item) return undefined;

  const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
  const docValue = getColumnValue(colMap, TASK_COLUMNS.uatDoc);
  if (!docValue || typeof docValue !== "object") return undefined;

  const obj = docValue as Record<string, unknown>;
  if (typeof obj.doc_id === "number") return obj.doc_id;
  if (typeof obj.doc_id === "string" && /^\d+$/.test(obj.doc_id)) return Number(obj.doc_id);

  const files = obj.files as Array<Record<string, unknown>> | undefined;
  if (files && files.length > 0) {
    const fid = files[0].fileId;
    if (typeof fid === "number") return fid;
    if (typeof fid === "string" && /^\d+$/.test(fid)) return Number(fid);
  }

  // Fallback: regex-scan the serialized object for any id-shaped key
  const match = JSON.stringify(obj).match(/"(?:doc_id|id|fileId)"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

export async function getTaskUatDoc(args: GetTaskUatDocInput): Promise<string> {
  try {
    const { taskId } = args;
    const docId = await fetchUatDocId(taskId);
    if (!docId) {
      return formatError(
        `Task #${taskId} has no UAT doc set. Use createTaskUatDoc(taskId, markdown) to create one.`,
      );
    }

    const query = `
      query {
        export_markdown_from_doc(doc_id: ${docId}) {
          success
          markdown
          error
        }
      }
    `;
    const response = await executeMondayQuery<any>(query);
    const result = response.export_markdown_from_doc;
    if (!result?.success) {
      return formatError(`Failed to export UAT doc for task #${taskId}: ${result?.error ?? "unknown error"}`);
    }

    const md = typeof result.markdown === "string" ? result.markdown : "";
    return [
      `# UAT Doc — Task #${taskId} (doc ${docId})`,
      ``,
      md.trim().length > 0 ? md : "_(empty doc)_",
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to read UAT doc: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function createTaskUatDoc(args: CreateTaskUatDocInput): Promise<string> {
  try {
    const { taskId, markdown } = args;
    const existing = await fetchUatDocId(taskId);
    if (existing) {
      return formatError(
        `Task #${taskId} already has a UAT doc (id ${existing}). Use updateTaskUatDoc to modify it.`,
      );
    }

    const createMutation = `
      mutation {
        create_doc(
          location: { board: { item_id: ${taskId}, column_id: "${TASK_COLUMNS.uatDoc}", board_id: ${BOARDS.TASKS} } }
        ) {
          id
        }
      }
    `;
    const createResponse = await executeMondayQuery<any>(createMutation);
    const newDocId = createResponse.create_doc?.id;
    if (!newDocId) {
      return formatError(`Failed to create UAT doc for task #${taskId}: Monday did not return a doc id.`);
    }

    const writeMutation = `
      mutation {
        add_content_to_doc_from_markdown(
          doc_id: ${newDocId},
          markdown: ${JSON.stringify(markdown)}
        ) {
          doc_id
        }
      }
    `;
    await executeMondayQuery<any>(writeMutation);

    return [
      `# UAT Doc Created`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${newDocId}`,
      `**Characters written:** ${markdown.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to create UAT doc: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export async function updateTaskUatDoc(args: UpdateTaskUatDocInput): Promise<string> {
  try {
    const { taskId, markdown, overwrite = true } = args;
    const docId = await fetchUatDocId(taskId);
    if (!docId) {
      return formatError(
        `Task #${taskId} has no UAT doc to update. Use createTaskUatDoc(taskId, markdown) first.`,
      );
    }

    const mutation = `
      mutation {
        add_content_to_doc_from_markdown(
          doc_id: ${docId},
          markdown: ${JSON.stringify(markdown)},
          overwrite: ${overwrite ? "true" : "false"}
        ) {
          doc_id
        }
      }
    `;
    await executeMondayQuery<any>(mutation);

    return [
      `# UAT Doc Updated`,
      ``,
      `**Task:** #${taskId}`,
      `**Doc ID:** ${docId}`,
      `**Mode:** ${overwrite ? "overwrite" : "append"}`,
      `**Characters written:** ${markdown.length}`,
    ].join("\n");
  } catch (error) {
    return formatError(`Failed to update UAT doc: ${error instanceof Error ? error.message : String(error)}`);
  }
}
