/**
 * Shared helpers for working with Monday docs.
 *
 * Monday's `create_doc` mutation does not accept a `name` field in
 * `CreateDocInput` (verified via schema introspection on API 2025-10) — new
 * docs land with Monday's default name. To set a meaningful title, use
 * `update_doc_name(docId, name)` immediately after creation.
 *
 * Three resolution patterns live here:
 *   - `ensureItemDoc(itemId, columnId, title)` — find-or-create a doc on
 *     an item's doc column, sets title on create. Returns the doc's primary id.
 *   - `writeDocContentReplacing(docId, markdown)` — delete-all-blocks then
 *     add-content. Monday 2025-10 removed the overwrite flag from
 *     `add_content_to_doc_from_markdown`; this emulates it.
 *   - `readDocAsMarkdown(docId)` — export the doc as a markdown string.
 *
 * Used by both UAT-doc handling and (soon) Description-doc handling.
 */

import { DOC_API_VERSION, executeMondayQuery } from "../monday-client.ts";

const DOC_OPTS = { apiVersion: DOC_API_VERSION };

/**
 * Rename a Monday doc. Idempotent — repeated calls with the same name are
 * harmless. Errors are surfaced to the caller so they can decide whether
 * a missing title is fatal (it usually isn't — the doc still works).
 */
export async function setDocName(docId: number, name: string): Promise<void> {
  const mutation = `
    mutation {
      update_doc_name(docId: ${docId}, name: ${JSON.stringify(name)}) {
        id
      }
    }
  `;
  await executeMondayQuery<unknown>(mutation, undefined, DOC_OPTS);
}

/**
 * Fetch an item's `name` field. Used to compose meaningful doc titles
 * ("UAT — Task #123: <task name>", "Changelog — v1.2.3", etc.).
 *
 * Returns undefined if the item doesn't exist or the API call fails — callers
 * should fall back to a generic title rather than blocking.
 */
export async function fetchItemName(itemId: number): Promise<string | undefined> {
  const query = `query { items(ids: [${itemId}]) { name } }`;
  try {
    const response = await executeMondayQuery<any>(query);
    const name = response.items?.[0]?.name;
    if (typeof name === "string" && name.trim().length > 0) {
      return name.trim();
    }
  } catch {
    // Fall through — caller will use a fallback title.
  }
  return undefined;
}

/**
 * Extract Monday's per-item `object_id` from a doc column value.
 * Docs are stored on the column as `{ files: [{ fileId, objectId }] }`.
 * Returns undefined when no doc is attached.
 */
export function extractDocObjectId(docValue: unknown): number | undefined {
  if (!docValue || typeof docValue !== "object") return undefined;
  const obj = docValue as Record<string, unknown>;
  if (typeof obj.doc_id === "number") return obj.doc_id;
  if (typeof obj.doc_id === "string" && /^\d+$/.test(obj.doc_id)) return Number(obj.doc_id);
  const files = obj.files as Array<Record<string, unknown>> | undefined;
  if (files && files.length > 0) {
    const oid = files[0].objectId;
    if (typeof oid === "number") return oid;
    if (typeof oid === "string" && /^\d+$/.test(oid)) return Number(oid);
  }
  const match = JSON.stringify(obj).match(/"(?:doc_id|objectId|object_id)"\s*:\s*(\d+)/);
  return match ? Number(match[1]) : undefined;
}

/**
 * Resolve a doc's primary id from its per-item object_id. Returns undefined
 * if Monday doesn't find a doc behind that object_id (shouldn't happen for
 * docs created through this codebase, but defensive).
 */
async function resolveDocPrimaryId(objectId: number): Promise<number | undefined> {
  const query = `query { docs(object_ids: [${objectId}]) { id } }`;
  const response = await executeMondayQuery<any>(query, undefined, DOC_OPTS);
  const raw = response.docs?.[0]?.id;
  if (typeof raw === "number") return raw;
  if (typeof raw === "string" && /^\d+$/.test(raw)) return Number(raw);
  return undefined;
}

/**
 * Look up the doc id attached to a given item's doc column. Returns undefined
 * when no doc is attached yet.
 */
export async function fetchItemDocId(
  itemId: number,
  columnId: string,
): Promise<number | undefined> {
  const query = `
    query {
      items(ids: [${itemId}]) {
        column_values(ids: ["${columnId}"]) { id value }
      }
    }
  `;
  const response = await executeMondayQuery<any>(query);
  const col = response.items?.[0]?.column_values?.[0];
  if (!col) return undefined;
  let parsed: unknown;
  try {
    parsed = col.value ? JSON.parse(col.value) : undefined;
  } catch {
    parsed = undefined;
  }
  const objectId = extractDocObjectId(parsed);
  if (!objectId) return undefined;
  return resolveDocPrimaryId(objectId);
}

/**
 * Find-or-create a doc on an item's doc column. Sets the title on creation
 * (no-op on existing docs — Monday's UI permits manual renames that we
 * shouldn't blow away on every write). Returns the doc's primary id.
 */
export async function ensureItemDoc(
  itemId: number,
  columnId: string,
  title: string,
): Promise<number> {
  const existing = await fetchItemDocId(itemId, columnId);
  if (existing) return existing;

  const createMutation = `
    mutation {
      create_doc(
        location: { board: { item_id: ${itemId}, column_id: "${columnId}" } }
      ) {
        id
      }
    }
  `;
  const response = await executeMondayQuery<any>(createMutation, undefined, DOC_OPTS);
  const raw = response.create_doc?.id;
  const newId =
    typeof raw === "number"
      ? raw
      : typeof raw === "string" && /^\d+$/.test(raw)
        ? Number(raw)
        : undefined;
  if (!newId) {
    throw new Error(
      `Failed to create doc on item #${itemId} column ${columnId}: Monday did not return a doc id.`,
    );
  }

  // Best-effort title set. Failure here doesn't invalidate the doc.
  try {
    await setDocName(newId, title);
  } catch {
    // Title is nice-to-have.
  }

  return newId;
}

/**
 * Drain all blocks in a doc (used to emulate overwrite — Monday 2025-10
 * removed the overwrite flag on add_content_to_doc_from_markdown).
 * Returns the number of blocks deleted.
 */
async function deleteAllDocBlocks(docId: number): Promise<number> {
  let total = 0;
  for (let pass = 0; pass < 50; pass++) {
    const blockQuery = `query { docs(ids: [${docId}]) { blocks { id } } }`;
    const blockResponse = await executeMondayQuery<any>(blockQuery, undefined, DOC_OPTS);
    const ids: string[] = (blockResponse.docs?.[0]?.blocks || [])
      .map((b: { id: string }) => b.id)
      .filter(Boolean);
    if (ids.length === 0) break;
    for (const id of ids) {
      const mutation = `
        mutation { delete_doc_block(block_id: ${JSON.stringify(id)}) { id } }
      `;
      await executeMondayQuery<unknown>(mutation, undefined, DOC_OPTS);
      total++;
    }
  }
  return total;
}

/**
 * Overwrite a doc's content with the given markdown. Drains existing blocks
 * first, then appends. Returns `{ deletedBlocks }` for the caller's progress
 * message.
 */
export async function writeDocContentReplacing(
  docId: number,
  markdown: string,
): Promise<{ deletedBlocks: number }> {
  const deletedBlocks = await deleteAllDocBlocks(docId);
  const mutation = `
    mutation {
      add_content_to_doc_from_markdown(
        docId: ${docId},
        markdown: ${JSON.stringify(markdown)}
      ) { success }
    }
  `;
  await executeMondayQuery<unknown>(mutation, undefined, DOC_OPTS);
  return { deletedBlocks };
}

/**
 * Append content to a doc without clearing existing blocks.
 */
export async function appendDocContent(docId: number, markdown: string): Promise<void> {
  const mutation = `
    mutation {
      add_content_to_doc_from_markdown(
        docId: ${docId},
        markdown: ${JSON.stringify(markdown)}
      ) { success }
    }
  `;
  await executeMondayQuery<unknown>(mutation, undefined, DOC_OPTS);
}

/**
 * Export a doc's content as a markdown string. Returns empty string when the
 * doc exists but has no exportable content (rather than throwing — callers
 * can fall back to legacy long_text reads).
 */
export async function readDocAsMarkdown(docId: number): Promise<string> {
  const query = `
    query {
      export_markdown_from_doc(docId: ${docId}) {
        success
        markdown
        error
      }
    }
  `;
  const response = await executeMondayQuery<any>(query, undefined, DOC_OPTS);
  const result = response.export_markdown_from_doc;
  if (!result?.success) return "";
  return typeof result.markdown === "string" ? result.markdown : "";
}
