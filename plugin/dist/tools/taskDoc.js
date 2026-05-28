import { DOC_API_VERSION, executeMondayQuery } from "../monday-client.js";
import { TASK_COLUMNS } from "../constants.js";
import { getColumnValue, formatError } from "./utils.js";
import { setDocName, fetchItemName } from "../services/doc-utils.js";
// Doc-related GraphQL fields are exposed on API 2025-10+ (`docId` camelCase
// args, `export_markdown_from_doc`, `add_content_to_doc_from_markdown`).
// The rest of the codebase stays on the project default (2024-10).
const DOC_OPTS = { apiVersion: DOC_API_VERSION };
// Extract Monday's object_id (the per-item doc reference) from the column value.
// The doc column stores `{ files: [{ fileId: "<uuid>", objectId: <numeric> }] }`.
// objectId is what `docs(object_ids: [...])` needs to resolve to the primary doc id.
function extractDocObjectId(docValue) {
    if (!docValue || typeof docValue !== "object")
        return undefined;
    const obj = docValue;
    if (typeof obj.doc_id === "number")
        return obj.doc_id;
    if (typeof obj.doc_id === "string" && /^\d+$/.test(obj.doc_id))
        return Number(obj.doc_id);
    const files = obj.files;
    if (files && files.length > 0) {
        const oid = files[0].objectId;
        if (typeof oid === "number")
            return oid;
        if (typeof oid === "string" && /^\d+$/.test(oid))
            return Number(oid);
    }
    const match = JSON.stringify(obj).match(/"(?:doc_id|objectId|object_id)"\s*:\s*(\d+)/);
    return match ? Number(match[1]) : undefined;
}
// Fetch the task's UAT doc primary id. Returns undefined if no doc.
// Monday's doc API uses TWO different ids:
//   - object_id (5096385810): per-item linkage, stored in the column value
//   - id (8664429): the doc's primary key, needed for export/write mutations
// We resolve object_id → primary id via `docs(object_ids: [...]) { id }`.
async function fetchUatDocId(taskId) {
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
    const response = await executeMondayQuery(query);
    const item = response.items?.[0];
    if (!item)
        return undefined;
    const colMap = new Map(item.column_values?.map((c) => [c.id, c]) || []);
    const docValue = getColumnValue(colMap, TASK_COLUMNS.uatDoc);
    const objectId = extractDocObjectId(docValue);
    if (!objectId)
        return undefined;
    const docQuery = `
    query {
      docs(object_ids: [${objectId}]) {
        id
      }
    }
  `;
    const docResponse = await executeMondayQuery(docQuery, undefined, DOC_OPTS);
    const rawId = docResponse.docs?.[0]?.id;
    if (typeof rawId === "number")
        return rawId;
    if (typeof rawId === "string" && /^\d+$/.test(rawId))
        return Number(rawId);
    return undefined;
}
async function fetchDocBlockIds(docId) {
    // docId here is the doc's primary id (resolved by fetchUatDocId),
    // so look it up via `docs(ids: [...])` rather than `docs(object_ids: [...])`.
    const query = `
    query {
      docs(ids: [${docId}]) {
        blocks {
          id
        }
      }
    }
  `;
    const response = await executeMondayQuery(query, undefined, DOC_OPTS);
    const blocks = response.docs?.[0]?.blocks || [];
    return blocks.map((b) => b.id).filter(Boolean);
}
async function deleteAllDocBlocks(docId) {
    // Monday returns blocks in pages of ~25. Loop until the doc is empty.
    // Cap the iterations so a buggy reply can't spin forever.
    let total = 0;
    for (let pass = 0; pass < 50; pass++) {
        const ids = await fetchDocBlockIds(docId);
        if (ids.length === 0)
            break;
        for (const id of ids) {
            const mutation = `
        mutation {
          delete_doc_block(block_id: ${JSON.stringify(id)}) {
            id
          }
        }
      `;
            await executeMondayQuery(mutation, undefined, DOC_OPTS);
            total++;
        }
    }
    return total;
}
export async function getTaskUatDoc(args) {
    try {
        const { taskId } = args;
        const docId = await fetchUatDocId(taskId);
        if (!docId) {
            return formatError(`Task #${taskId} has no UAT doc set. Use createTaskUatDoc(taskId, markdown) to create one.`);
        }
        const query = `
      query {
        export_markdown_from_doc(docId: ${docId}) {
          success
          markdown
          error
        }
      }
    `;
        const response = await executeMondayQuery(query, undefined, DOC_OPTS);
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
    }
    catch (error) {
        return formatError(`Failed to read UAT doc: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function createTaskUatDoc(args) {
    try {
        const { taskId, markdown } = args;
        const existing = await fetchUatDocId(taskId);
        if (existing) {
            return formatError(`Task #${taskId} already has a UAT doc (id ${existing}). Use updateTaskUatDoc to modify it.`);
        }
        // CreateDocBoardInput only accepts column_id + item_id (verified via schema
        // introspection on 2026-05-13). Earlier versions of this code included a
        // board_id field, which Monday rejected with "Field 'board_id' is not
        // defined by type 'CreateDocBoardInput'". The board is inferred from item_id.
        const createMutation = `
      mutation {
        create_doc(
          location: { board: { item_id: ${taskId}, column_id: "${TASK_COLUMNS.uatDoc}" } }
        ) {
          id
        }
      }
    `;
        const createResponse = await executeMondayQuery(createMutation, undefined, DOC_OPTS);
        const newDocIdRaw = createResponse.create_doc?.id;
        const newDocId = typeof newDocIdRaw === "number"
            ? newDocIdRaw
            : typeof newDocIdRaw === "string" && /^\d+$/.test(newDocIdRaw)
                ? Number(newDocIdRaw)
                : undefined;
        if (!newDocId) {
            return formatError(`Failed to create UAT doc for task #${taskId}: Monday did not return a doc id.`);
        }
        // Rename the new doc so it's findable in Monday's UI ("Untitled doc" is the
        // default). Best-effort — a rename failure shouldn't block the content write.
        const taskName = await fetchItemName(taskId);
        const docTitle = taskName
            ? `UAT — Task #${taskId}: ${taskName}`
            : `UAT — Task #${taskId}`;
        try {
            await setDocName(newDocId, docTitle);
        }
        catch {
            // Title is nice-to-have, not load-bearing. Proceed with content write.
        }
        const writeMutation = `
      mutation {
        add_content_to_doc_from_markdown(
          docId: ${newDocId},
          markdown: ${JSON.stringify(markdown)}
        ) {
          success
        }
      }
    `;
        await executeMondayQuery(writeMutation, undefined, DOC_OPTS);
        return [
            `# UAT Doc Created`,
            ``,
            `**Task:** #${taskId}`,
            `**Doc ID:** ${newDocId}`,
            `**Title:** ${docTitle}`,
            `**Characters written:** ${markdown.length}`,
        ].join("\n");
    }
    catch (error) {
        return formatError(`Failed to create UAT doc: ${error instanceof Error ? error.message : String(error)}`);
    }
}
export async function updateTaskUatDoc(args) {
    try {
        const { taskId, markdown, overwrite = true } = args;
        const docId = await fetchUatDocId(taskId);
        if (!docId) {
            return formatError(`Task #${taskId} has no UAT doc to update. Use createTaskUatDoc(taskId, markdown) first.`);
        }
        // Monday's 2025-10 API removed the `overwrite` flag from
        // add_content_to_doc_from_markdown — content is always appended. To emulate
        // overwrite, delete every existing block first, then append.
        let deletedBlocks = 0;
        if (overwrite) {
            deletedBlocks = await deleteAllDocBlocks(docId);
        }
        const mutation = `
      mutation {
        add_content_to_doc_from_markdown(
          docId: ${docId},
          markdown: ${JSON.stringify(markdown)}
        ) {
          success
        }
      }
    `;
        await executeMondayQuery(mutation, undefined, DOC_OPTS);
        return [
            `# UAT Doc Updated`,
            ``,
            `**Task:** #${taskId}`,
            `**Doc ID:** ${docId}`,
            `**Mode:** ${overwrite ? `overwrite (deleted ${deletedBlocks} block${deletedBlocks === 1 ? "" : "s"})` : "append"}`,
            `**Characters written:** ${markdown.length}`,
        ].join("\n");
    }
    catch (error) {
        return formatError(`Failed to update UAT doc: ${error instanceof Error ? error.message : String(error)}`);
    }
}
