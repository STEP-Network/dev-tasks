/**
 * Version aggregate state machine.
 *
 * Fires from `updateTask` after a task's status changes. Two responsibilities:
 *
 * 1. **Bounceback handling** — if the task moves *backward* (away from
 *    Pending Deploy to Prod / Done) AND its current version is Released,
 *    the task unlinks from the released version. Released stays Released;
 *    the bounced task re-enters the open version's pool on its next UAT
 *    transition (auto-version handles the re-link).
 *
 * 2. **Aggregate state recompute** — Planned ↔ In Development ↔ Release
 *    Candidate, derived from the linked tasks' statuses. Never touches
 *    Released or Hotfix (those are terminal/manual states).
 *
 *    - All linked tasks at "Pending Deploy to Prod" or "Done" → Release Candidate
 *    - Otherwise (some task still in progress / UAT) → In Development
 *      (or Planned, if no task has reached UAT yet — that case is auto-version's
 *      domain, not this one)
 *
 * Trigger from `updateTask.ts`. Both steps fail-soft — errors surface as
 * warnings on the user-visible response but don't fail the updateTask.
 */
import { executeMondayQuery } from "../monday-client.js";
import { BOARDS, TASK_COLUMNS, VERSION_COLUMNS, } from "../constants.js";
import { buildColumnValues, getColumnText, getLinkedItems, resolveLinkedItems, } from "../tools/utils.js";
// Statuses that count as "release-completed" for the aggregate calculation.
// A version becomes Release Candidate when ALL linked tasks are in one of these.
const RELEASE_COMPLETED_STATUSES = new Set(["Pending Deploy to Prod", "Done"]);
// Terminal version statuses the state machine never touches.
const TERMINAL_VERSION_STATUSES = new Set(["Released", "Hotfix"]);
// =============================================================================
// Bounceback handling
// =============================================================================
/**
 * If the task is linked to a Released version AND its new status is BEFORE the
 * release-completed point (i.e., a regression), unlink the task from the released
 * version. Auto-version will reassign on the next UAT transition.
 *
 * Returns a user-facing note string (or null if no action).
 */
export async function maybeHandleBounceback(taskId, newStatus) {
    // Only meaningful for backward moves
    if (RELEASE_COMPLETED_STATUSES.has(newStatus))
        return null;
    // Fetch task's current version
    const taskQuery = `
    query {
      items(ids: [${taskId}]) {
        column_values(ids: ["${TASK_COLUMNS.targetVersion}"]) {
          id
          ... on BoardRelationValue { linked_items { id name } }
        }
      }
    }
  `;
    const taskRes = await executeMondayQuery(taskQuery);
    const taskCols = taskRes.items?.[0]?.column_values || [];
    const taskColMap = new Map(taskCols.map((c) => [c.id, c]));
    const linkedVersions = getLinkedItems(taskColMap, TASK_COLUMNS.targetVersion);
    if (linkedVersions.length === 0)
        return null;
    const versionId = Number(linkedVersions[0].id);
    const versionName = linkedVersions[0].name;
    // Read the version's status
    const verQuery = `
    query {
      items(ids: [${versionId}]) {
        column_values(ids: ["${VERSION_COLUMNS.status}"]) {
          id
          text
        }
      }
    }
  `;
    const verRes = await executeMondayQuery(verQuery);
    const verCols = verRes.items?.[0]?.column_values || [];
    const verColMap = new Map(verCols.map((c) => [c.id, c]));
    const versionStatus = getColumnText(verColMap, VERSION_COLUMNS.status) || "";
    if (versionStatus !== "Released")
        return null;
    // Bounceback: unlink the task from the released version
    await unlinkTaskFromVersion(taskId);
    return `Bounceback: unlinked from ${versionName} (#${versionId}) (Released; task regressed to "${newStatus}" — will reassign on next UAT transition)`;
}
async function unlinkTaskFromVersion(taskId) {
    const columnValues = {
        [TASK_COLUMNS.targetVersion]: { item_ids: [] },
    };
    const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${taskId},
        board_id: ${BOARDS.TASKS},
        column_values: ${buildColumnValues(columnValues)}
      ) {
        id
      }
    }
  `;
    await executeMondayQuery(mutation);
}
// =============================================================================
// Aggregate state recompute
// =============================================================================
/**
 * Read the task's current version (post-mutation, post-auto-version) and
 * recompute that version's aggregate status.
 *
 * Returns a user-facing note string (or null if no change).
 */
export async function recomputeAggregateForTaskVersion(taskId) {
    // Fetch task's current version
    const taskQuery = `
    query {
      items(ids: [${taskId}]) {
        column_values(ids: ["${TASK_COLUMNS.targetVersion}"]) {
          id
          ... on BoardRelationValue { linked_items { id name } }
        }
      }
    }
  `;
    const taskRes = await executeMondayQuery(taskQuery);
    const taskCols = taskRes.items?.[0]?.column_values || [];
    const taskColMap = new Map(taskCols.map((c) => [c.id, c]));
    const linkedVersions = getLinkedItems(taskColMap, TASK_COLUMNS.targetVersion);
    if (linkedVersions.length === 0)
        return null;
    const versionId = Number(linkedVersions[0].id);
    return await recomputeVersionStatus(versionId);
}
/**
 * Compute the version's aggregate status from its linked tasks; apply if
 * different from current. Returns a note string (or null if no change).
 *
 * Skips Released and Hotfix versions (terminal/manual states).
 */
export async function recomputeVersionStatus(versionId) {
    // Read version status + linked tasks
    const versionQuery = `
    query {
      items(ids: [${versionId}]) {
        id
        name
        column_values(ids: ["${VERSION_COLUMNS.status}", "${VERSION_COLUMNS.connectedTasks}"]) {
          id
          text
          ... on BoardRelationValue { linked_items { id name } }
        }
      }
    }
  `;
    const versionRes = await executeMondayQuery(versionQuery);
    const versionItem = versionRes.items?.[0];
    if (!versionItem)
        return null;
    const versionColMap = new Map(versionItem.column_values?.map((c) => [c.id, c]) || []);
    const currentStatus = getColumnText(versionColMap, VERSION_COLUMNS.status) || "";
    // Terminal — never auto-modify
    if (TERMINAL_VERSION_STATUSES.has(currentStatus))
        return null;
    const linkedTasks = getLinkedItems(versionColMap, VERSION_COLUMNS.connectedTasks);
    if (linkedTasks.length === 0)
        return null; // empty version, no change
    // Read all linked tasks' statuses through the shared chunking resolver.
    //
    // This used to be a hand-rolled `items(ids: [...])` with every id inlined and
    // no `limit`, which was wrong in two independent ways once a version grew:
    //   - past 100 ids Monday rejects the query outright ("Argument 'ids'
    //     exceeding the 100 limit"), surfacing as a recompute failure on EVERY
    //     status transition touching that version;
    //   - below 100 it was quietly worse — `items(ids:)` defaults to `limit: 25`
    //     however many ids you pass, so a 40-task version computed its aggregate
    //     from 25 tasks and could flip to Release Candidate while 15 were still
    //     open.
    // `resolveLinkedItems` chunks at 100 AND passes an explicit limit, so it fixes
    // both. Do not re-inline this query.
    const taskIds = linkedTasks
        .map(t => Number(t.id))
        .filter(id => Number.isInteger(id) && id > 0);
    if (taskIds.length === 0)
        return null;
    const taskItems = await resolveLinkedItems(taskIds, [TASK_COLUMNS.status]);
    const tasks = taskItems.map((t) => {
        const colMap = new Map(t.column_values?.map((c) => [c.id, c]) || []);
        return { id: t.id, status: getColumnText(colMap, TASK_COLUMNS.status) || "" };
    });
    // A truncated read must never drive a status flip: computing "all ready" from
    // a short list is exactly how a version flips to Release Candidate early.
    if (tasks.length !== taskIds.length) {
        return `Version state: ${versionItem.name} (#${versionId}) recompute skipped — read ${tasks.length} of ${taskIds.length} linked tasks`;
    }
    const readyCount = tasks.filter(t => RELEASE_COMPLETED_STATUSES.has(t.status)).length;
    const aggregate = `${readyCount}/${tasks.length} tasks at Pending Deploy / Done`;
    const allReleaseReady = readyCount === tasks.length;
    let target = null;
    if (allReleaseReady && currentStatus !== "Release Candidate") {
        target = "Release Candidate";
    }
    else if (!allReleaseReady && currentStatus === "Release Candidate") {
        // Backward: drop RC back to In Development
        target = "In Development";
    }
    if (!target) {
        // No flip needed — emit a visible trace so callers can tell the state
        // machine ran and decided not to change status.
        return `Version state: ${versionItem.name} (#${versionId}) stays ${currentStatus} (aggregate: ${aggregate})`;
    }
    await setVersionStatus(versionId, target);
    return `Version state: ${versionItem.name} (#${versionId}) ${currentStatus} → ${target} (aggregate: ${aggregate})`;
}
async function setVersionStatus(versionId, status) {
    // Use `{label: "..."}` not `{index: N}` — workspace label indices have
    // drifted from the constants (e.g., Release Candidate's 102 returns
    // "missingLabel" in the polads workspace). Label is self-documenting
    // and immune to drift.
    const columnValues = {
        [VERSION_COLUMNS.status]: { label: status },
    };
    const mutation = `
    mutation {
      change_multiple_column_values(
        item_id: ${versionId},
        board_id: ${BOARDS.VERSIONS},
        column_values: ${buildColumnValues(columnValues)}
      ) {
        id
      }
    }
  `;
    await executeMondayQuery(mutation);
}
