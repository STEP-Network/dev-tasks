/**
 * Shared helpers for working with Monday docs.
 *
 * Monday's `create_doc` mutation does not accept a `name` field in
 * `CreateDocInput` (verified via schema introspection on API 2025-10) — new
 * docs land with Monday's default name. To set a meaningful title, use
 * `update_doc_name(docId, name)` immediately after creation.
 */
import { DOC_API_VERSION, executeMondayQuery } from "../monday-client.js";
const DOC_OPTS = { apiVersion: DOC_API_VERSION };
/**
 * Rename a Monday doc. Idempotent — repeated calls with the same name are
 * harmless. Errors are surfaced to the caller so they can decide whether
 * a missing title is fatal (it usually isn't — the doc still works).
 */
export async function setDocName(docId, name) {
    const mutation = `
    mutation {
      update_doc_name(docId: ${docId}, name: ${JSON.stringify(name)}) {
        id
      }
    }
  `;
    await executeMondayQuery(mutation, undefined, DOC_OPTS);
}
/**
 * Fetch an item's `name` field. Used to compose meaningful doc titles
 * ("UAT — Task #123: <task name>", "Changelog — v1.2.3", etc.).
 *
 * Returns undefined if the item doesn't exist or the API call fails — callers
 * should fall back to a generic title rather than blocking.
 */
export async function fetchItemName(itemId) {
    const query = `query { items(ids: [${itemId}]) { name } }`;
    try {
        const response = await executeMondayQuery(query);
        const name = response.items?.[0]?.name;
        if (typeof name === "string" && name.trim().length > 0) {
            return name.trim();
        }
    }
    catch {
        // Fall through — caller will use a fallback title.
    }
    return undefined;
}
