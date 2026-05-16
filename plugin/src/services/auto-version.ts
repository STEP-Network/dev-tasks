/**
 * Auto-version assignment — fires when a task transitions to "Waiting for UAT".
 *
 * Selection precedence (most specific first):
 *   1. If task already has a `versionId`                  → no-op
 *   2. If task's branch matches `hotfix/*`                → create a fresh
 *      dedicated patch-bump version (status: Hotfix)
 *   3. Else: find an open version for the product
 *      3a. In Development (lowest semver) wins over Planned
 *      3b. If a Planned version is picked, flip it to In Development
 *          (correctness — Planned shouldn't host tasks at UAT)
 *   4. No open version exists                             → cold-create with
 *      patch bump from latest Released (status: In Development)
 *
 * **Versions are time-based**: assignment is purely "which container is
 * currently shipping for this product?" — not "which epic plans this task
 * for which version." The Epic→Target Version link is intentionally NOT
 * consulted here: concurrent epics shouldn't bump version both up and down,
 * and a 24/7 Maintenance epic has no meaningful target version.
 *
 * Conventions:
 *   - Version name and versionNumber column both formatted `v{semver}` (e.g., `v0.9.1`)
 *   - "Patch bump" via computeBumpSuggestion with forcePatch=true — every task
 *     defaults to patch; minor/major elevations are human-only (rename the open
 *     version before promoting).
 *
 * Caller (`updateTask.ts`) wraps this in try/catch and surfaces errors as
 * warnings — auto-version failure must not fail the underlying updateTask.
 */

import { executeMondayQuery } from "../monday-client.ts";
import {
  BOARDS,
  TASK_COLUMNS,
  VERSION_COLUMNS,
  VERSION_STATUS,
  VERSION_GROUPS,
  PRODUCT_IDS,
} from "../constants.ts";
import { refreshChangelogForVersion } from "./changelog-refresh.ts";
import {
  getColumnText,
  getLinkedItems,
  getMirrorDisplayValue,
  buildColumnValues,
} from "../tools/utils.ts";
import {
  computeBumpSuggestion,
  parseSemVer,
  formatSemVer,
  compareSemVer,
  type SemVer,
} from "./version-bump.ts";

const COLD_START: SemVer = { major: 0, minor: 0, patch: 0 };

/**
 * Main entry. Returns:
 *   - action description string (auto-version action taken)
 *   - null if task already has a version (no-op)
 *   - "skipped: …" string if we couldn't determine product
 *
 * Throws on any Monday API error. Caller catches and surfaces as warning.
 */
export async function autoAssignVersionForTask(taskId: number): Promise<string | null> {
  // 1. Read the task's relevant columns
  const taskQuery = `
    query {
      items(ids: [${taskId}]) {
        column_values(ids: ["${TASK_COLUMNS.targetVersion}", "${TASK_COLUMNS.product}", "${TASK_COLUMNS.branch}"]) {
          id
          text
          value
          ... on BoardRelationValue { linked_items { id name } }
          ... on MirrorValue { display_value }
        }
      }
    }
  `;
  const taskRes = await executeMondayQuery<any>(taskQuery);
  const taskCols = taskRes.items?.[0]?.column_values || [];
  const taskColMap = new Map<string, any>(taskCols.map((c: any) => [c.id, c]));

  // 2. No-op if already linked
  const currentVersion = getLinkedItems(taskColMap, TASK_COLUMNS.targetVersion);
  if (currentVersion.length > 0) return null;

  // 3. Resolve product
  const productName = getMirrorDisplayValue(taskColMap, TASK_COLUMNS.product);
  if (!productName) {
    return "auto-version skipped: task has no product (no epic linked, or epic missing product mirror)";
  }
  const productId = PRODUCT_IDS[productName.trim()];
  if (!productId) {
    return `auto-version skipped: unknown product "${productName}" (not in PRODUCT_IDS map — add to plugin/src/constants.ts)`;
  }

  // 4. Detect hotfix path
  const branchText = (getColumnText(taskColMap, TASK_COLUMNS.branch) || "").trim();
  const isHotfix = branchText.startsWith("hotfix/");

  // 5. Compute patch bump seed (latest released for product, else cold start)
  const latestReleased = await findLatestReleasedForProduct(productId);

  // 6. HOTFIX path — fresh dedicated version with Hotfix status
  if (isHotfix) {
    const bump = computeBumpSuggestion({
      latestReleased,
      tasks: [],
      v1MilestoneReady: false, // forcePatch never crosses v1.0
      forcePatch: true,
    });
    const versionName = `v${formatSemVer(bump.next)}`;
    const created = await createVersionItem(versionName, versionName, productId, "Hotfix");
    await linkTaskToVersion(taskId, created.id);
    const refreshNote = await refreshChangelogAndDescribe(created.id);
    return `Auto-version (hotfix): created ${created.name} (#${created.id}), linked task${refreshNote}`;
  }

  // 7. NON-HOTFIX path — find or create open version.
  //    Preference: In Development (lowest semver) before Planned (lowest semver).
  const openVersion = await findBestOpenVersionForProduct(productId);
  if (openVersion) {
    await linkTaskToVersion(taskId, openVersion.id);
    let statusNote = "";
    if (openVersion.status === "Planned") {
      await updateVersionStatus(openVersion.id, "In Development");
      statusNote = "; auto-corrected status Planned → In Development (a version hosting UAT-stage tasks shouldn't stay Planned)";
    } else {
      statusNote = " (status: In Development)";
    }
    const refreshNote = await refreshChangelogAndDescribe(openVersion.id);
    return `Auto-version: linked to ${openVersion.name} (#${openVersion.id})${statusNote}${refreshNote}`;
  }

  // 8. Cold-create the next version
  const bump = computeBumpSuggestion({
    latestReleased,
    tasks: [],
    v1MilestoneReady: false,
    forcePatch: true,
  });
  const versionName = `v${formatSemVer(bump.next)}`;
  const created = await createVersionItem(versionName, versionName, productId, "In Development");
  await linkTaskToVersion(taskId, created.id);
  const refreshNote = await refreshChangelogAndDescribe(created.id);
  return `Auto-version: created ${created.name} (#${created.id}) (no open version existed), linked task${refreshNote}`;
}

/**
 * Trigger a changelog refresh and produce a short note for the user-facing
 * return message. Fail-soft — refresh errors degrade to "refresh skipped: …"
 * so they don't fail the link operation that already succeeded.
 */
async function refreshChangelogAndDescribe(versionId: number): Promise<string> {
  try {
    const r = await refreshChangelogForVersion(versionId);
    const parts: string[] = [`${r.taskCount} public task${r.taskCount === 1 ? "" : "s"}`];
    if (r.bugCount > 0) parts.push(`${r.bugCount} bug${r.bugCount === 1 ? "" : "s"}`);
    if (r.skippedPrivate > 0) parts.push(`${r.skippedPrivate} private skipped`);
    return `; changelog refreshed (${parts.join(", ")})`;
  } catch (e) {
    return `; changelog refresh skipped (${e instanceof Error ? e.message : String(e)})`;
  }
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

async function findLatestReleasedForProduct(productId: number): Promise<SemVer> {
  const releasedStatusIdx = VERSION_STATUS["Released"];
  const query = `
    query {
      boards(ids: [${BOARDS.VERSIONS}]) {
        items_page(limit: 200, query_params: {
          rules: [
            { column_id: "${VERSION_COLUMNS.status}", compare_value: [${releasedStatusIdx}], operator: any_of }
          ],
          operator: and
        }) {
          items {
            id
            name
            column_values(ids: ["${VERSION_COLUMNS.versionNumber}", "${VERSION_COLUMNS.product}"]) {
              id
              text
              value
              ... on BoardRelationValue { linked_items { id name } }
            }
          }
        }
      }
    }
  `;
  const res = await executeMondayQuery<any>(query);
  const items = res.boards?.[0]?.items_page?.items || [];
  let highest: SemVer = COLD_START;
  for (const item of items) {
    const colMap = new Map<string, any>(item.column_values.map((c: any) => [c.id, c]));
    const linkedProducts = getLinkedItems(colMap, VERSION_COLUMNS.product);
    if (!linkedProducts.some(p => Number(p.id) === productId)) continue;
    const verText = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || "";
    const semver = parseSemVer(verText);
    if (!semver) continue;
    if (compareSemVer(semver, highest) > 0) highest = semver;
  }
  return highest;
}

/**
 * Find the best open version for a product.
 * Priority: In Development (lowest semver) before Planned (lowest semver).
 * Rationale: an In-Development version is already shipping; a Planned version
 * is cooling/scheduled. New UAT-stage tasks belong in what's shipping.
 */
async function findBestOpenVersionForProduct(
  productId: number
): Promise<{ id: number; name: string; status: string } | null> {
  const plannedIdx = VERSION_STATUS["Planned"];
  const inDevIdx = VERSION_STATUS["In Development"];
  const query = `
    query {
      boards(ids: [${BOARDS.VERSIONS}]) {
        items_page(limit: 200, query_params: {
          rules: [
            { column_id: "${VERSION_COLUMNS.status}", compare_value: [${plannedIdx}, ${inDevIdx}], operator: any_of }
          ],
          operator: and
        }) {
          items {
            id
            name
            column_values(ids: ["${VERSION_COLUMNS.status}", "${VERSION_COLUMNS.versionNumber}", "${VERSION_COLUMNS.product}"]) {
              id
              text
              value
              ... on BoardRelationValue { linked_items { id name } }
            }
          }
        }
      }
    }
  `;
  const res = await executeMondayQuery<any>(query);
  const items = res.boards?.[0]?.items_page?.items || [];
  const candidates: Array<{ id: number; name: string; status: string; semver: SemVer }> = [];
  for (const item of items) {
    const colMap = new Map<string, any>(item.column_values.map((c: any) => [c.id, c]));
    const linkedProducts = getLinkedItems(colMap, VERSION_COLUMNS.product);
    if (!linkedProducts.some(p => Number(p.id) === productId)) continue;
    const verText = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || "";
    const semver = parseSemVer(verText);
    if (!semver) continue;
    const status = getColumnText(colMap, VERSION_COLUMNS.status) || "";
    candidates.push({ id: Number(item.id), name: item.name, status, semver });
  }
  if (candidates.length === 0) return null;
  // Sort: In Development first (priority 1), then Planned (priority 0);
  // within each tier, lowest semver wins.
  candidates.sort((a, b) => {
    const aPri = a.status === "In Development" ? 1 : 0;
    const bPri = b.status === "In Development" ? 1 : 0;
    if (aPri !== bPri) return bPri - aPri;
    return compareSemVer(a.semver, b.semver);
  });
  return { id: candidates[0].id, name: candidates[0].name, status: candidates[0].status };
}

async function createVersionItem(
  name: string,
  versionNumber: string,
  productId: number,
  status: "In Development" | "Hotfix"
): Promise<{ id: number; name: string }> {
  // Use `{label: "..."}` for status — see version-state-machine.ts comment;
  // label-by-name is immune to workspace label-index drift.
  const columnValues: Record<string, unknown> = {
    [VERSION_COLUMNS.status]: { label: status },
    [VERSION_COLUMNS.versionNumber]: versionNumber,
    [VERSION_COLUMNS.product]: { item_ids: [productId] },
  };
  const mutation = `
    mutation {
      create_item(
        board_id: ${BOARDS.VERSIONS},
        group_id: "${VERSION_GROUPS.UPCOMING}",
        item_name: ${JSON.stringify(name)},
        column_values: ${buildColumnValues(columnValues)}
      ) {
        id
        name
      }
    }
  `;
  const res = await executeMondayQuery<any>(mutation);
  const created = res.create_item;
  if (!created) throw new Error(`Failed to create version "${name}"`);
  return { id: Number(created.id), name: created.name };
}

async function linkTaskToVersion(taskId: number, versionId: number): Promise<void> {
  const columnValues = {
    [TASK_COLUMNS.targetVersion]: { item_ids: [versionId] },
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
  await executeMondayQuery<any>(mutation);
}

async function updateVersionStatus(versionId: number, status: string): Promise<void> {
  // Use `{label: "..."}` not `{index: N}` — workspace label indices drift;
  // see version-state-machine.ts setVersionStatus comment.
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
  await executeMondayQuery<any>(mutation);
}
