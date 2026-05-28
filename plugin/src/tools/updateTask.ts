import { executeMondayQuery } from "../monday-client.ts";
import {
  BOARDS,
  TASK_COLUMNS,
  TASK_STATUS,
  TASK_PRIORITY,
  TASK_TYPE,
  AGENT_ID,
} from "../constants.ts";
import type { UpdateTaskInput } from "../schemas.ts";
import {
  ensureItemDoc,
  fetchItemName,
  writeDocContentReplacing,
} from "../services/doc-utils.ts";
import { autoAssignVersionForTask } from "../services/auto-version.ts";
import {
  maybeHandleBounceback,
  recomputeAggregateForTaskVersion,
} from "../services/version-state-machine.ts";
import {
  buildColumnValues,
  formatError,
  formatSubtask,
  getLinkedItems,
  planActiveSprintPull,
  validateReadyToStart,
  validateTaskInActiveSprint,
  validateWaitingForUAT,
} from "./utils.ts";

export async function updateTask(args: UpdateTaskInput): Promise<string> {
  try {
    const { itemId } = args;

    // Handle deletion
    if (args.delete) {
      const deleteMutation = `
        mutation {
          delete_item(item_id: ${itemId}) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(deleteMutation);
      return `# Task Deleted\n\nTask #${itemId} has been deleted.`;
    }

    // Build column values from provided fields
    const columnValues: Record<string, unknown> = {};
    const changes: string[] = [];

    // List of warnings to surface in the success output (non-blocking)
    const warnings: string[] = [];

    if (args.status !== undefined) {
      // Ready to Start gate: refuse unless the task is fully specified.
      // Same-call args override Monday-side values so a single updateTask that
      // sets description + acceptanceCriteria + status="Ready to Start" succeeds.
      if (args.status === "Ready to Start") {
        const check = await validateReadyToStart(itemId, {
          type: args.type,
          priority: args.priority,
          epicId: args.epicId,
          description: args.description,
          acceptanceCriteria: args.acceptanceCriteria,
        });
        if (!check.valid) {
          const list = check.blockers.map(b => `  - ${b}`).join("\n");
          return formatError(
            `Cannot set task #${itemId} to "Ready to Start". The task is not fully specified:\n${list}`
          );
        }
      }

      // Waiting for UAT gate: hard-block on incomplete subtasks or missing UAT doc;
      // warn on missing GitHub/branch/demo/PR.
      if (args.status === "Waiting for UAT") {
        const check = await validateWaitingForUAT(itemId, {
          githubLink: args.githubLink,
          prLink: args.prLink,
          demoUrl: args.demoUrl,
          branch: args.branch,
        });
        if (check.blockers.length > 0) {
          const list = check.blockers.map(b => `  - ${b}`).join("\n");
          return formatError(
            `Cannot set task #${itemId} to "Waiting for UAT":\n${list}`
          );
        }
        for (const w of check.warnings) warnings.push(`Waiting for UAT: ${w}`);
      }

      // Sprint gate: any status transition OUT OF the refinement phase
      // ({Ready to Start, Needs Refinement}) requires the task to be in the
      // active sprint. If it isn't and the caller didn't explicitly set
      // `sprintId` in the same call, auto-pull into the active sprint and
      // mark `unplanned: true` — then continue. The pull columns are merged
      // into the same atomic mutation as the status change.
      //
      // Declined is a terminal off-ramp (task superseded mid-sprint, no work
      // shipped). It does not require active-sprint membership — exempt it.
      const noSprintRequired = new Set(["Ready to Start", "Needs Refinement", "Declined"]);
      if (args.status !== undefined && !noSprintRequired.has(args.status)) {
        if (args.sprintId !== undefined) {
          // Caller is setting sprint explicitly — validate that choice. If it's
          // not active, that's a contradiction with the status transition.
          const sprintCheck = await validateTaskInActiveSprint([args.sprintId]);
          if (!sprintCheck.valid) {
            return formatError(
              `Cannot set task #${itemId} to "${args.status}" with sprintId #${args.sprintId}.\n` +
              `The explicitly-passed sprintId must be the active sprint. ${sprintCheck.message}`
            );
          }
        } else {
          // Auto-pull path: read current linked sprints, plan the pull.
          const sprintQuery = `
            query {
              items(ids: [${itemId}]) {
                column_values(ids: ["${TASK_COLUMNS.sprint}"]) {
                  id
                  ... on BoardRelationValue { linked_items { id name } }
                }
              }
            }
          `;
          const sprintResponse = await executeMondayQuery<any>(sprintQuery);
          const sprintCols = sprintResponse.items?.[0]?.column_values || [];
          const colMap = new Map<string, any>(sprintCols.map((c: any) => [c.id, c]));
          const linkedSprintIds = getLinkedItems(colMap, TASK_COLUMNS.sprint).map(s => Number(s.id));

          const pull = await planActiveSprintPull(linkedSprintIds, {
            skipUnplannedFlag: args.unplanned !== undefined,
          });
          if (pull.error) {
            return formatError(
              `Cannot set task #${itemId} to "${args.status}".\n${pull.error}`
            );
          }
          if (!pull.wasInActiveSprint) {
            Object.assign(columnValues, pull.columnsToWrite);
            changes.push(`Sprint -> #${pull.pulledIntoSprintId} (auto-pulled into active sprint)`);
            if (pull.markedUnplanned) {
              changes.push(`Unplanned -> true (auto-set: task was pulled into active sprint mid-flight)`);
            }
            if (pull.warning) warnings.push(pull.warning);
          }
        }
      }

      // If setting status to Done, validate all subtasks are Done/Rejected first
      if (args.status === "Done") {
        const subtaskQuery = `
          query {
            items(ids: [${itemId}]) {
              subitems {
                id
                name
                column_values(ids: ["status"]) {
                  id
                  text
                }
              }
            }
          }
        `;
        const subtaskResponse = await executeMondayQuery<any>(subtaskQuery);
        const subitems = subtaskResponse.items?.[0]?.subitems || [];

        if (subitems.length > 0) {
          const incomplete = subitems.filter((sub: any) => {
            const formatted = formatSubtask(sub);
            return formatted.status !== "Done" && formatted.status !== "Rejected";
          });

          if (incomplete.length > 0) {
            const incompleteList = incomplete
              .map((sub: any) => {
                const formatted = formatSubtask(sub);
                return `  - #${formatted.id} "${formatted.name}" (${formatted.status})`;
              })
              .join("\n");
            return formatError(
              `Cannot set task #${itemId} to "Done".\n` +
              `The following subtasks are not Done/Rejected:\n${incompleteList}\n\n` +
              `Mark all subtasks as Done or Rejected first (Monday.com automation will auto-complete the parent).`
            );
          }
        }
      }
      columnValues[TASK_COLUMNS.status] = { index: TASK_STATUS[args.status] };
      changes.push(`Status -> ${args.status}`);
    }

    if (args.priority !== undefined) {
      columnValues[TASK_COLUMNS.priority] = { index: TASK_PRIORITY[args.priority] };
      changes.push(`Priority -> ${args.priority}`);
    }

    if (args.type !== undefined) {
      columnValues[TASK_COLUMNS.type] = { index: TASK_TYPE[args.type] };
      changes.push(`Type -> ${args.type}`);
    }

    // Description is written to the descriptionDoc (doc column), not long_text.
    // Handled as a separate post-mutation step below since it needs its own
    // doc-API calls (ensureItemDoc + writeDocContentReplacing).

    if (args.dueDate !== undefined) {
      columnValues[TASK_COLUMNS.dueDate] = { date: args.dueDate };
      changes.push(`Due Date -> ${args.dueDate}`);
    }

    if (args.startedDate !== undefined) {
      columnValues[TASK_COLUMNS.startedDate] = { date: args.startedDate };
      changes.push(`Started Date -> ${args.startedDate}`);
    }

    if (args.epicId !== undefined) {
      columnValues[TASK_COLUMNS.epic] = { item_ids: [args.epicId] };
      changes.push(`Epic -> #${args.epicId}`);
    }

    if (args.sprintId !== undefined) {
      columnValues[TASK_COLUMNS.sprint] = { item_ids: [args.sprintId] };
      changes.push(`Sprint -> #${args.sprintId}`);
    }

    if (args.versionId !== undefined) {
      columnValues[TASK_COLUMNS.targetVersion] = { item_ids: [args.versionId] };
      changes.push(`Version -> #${args.versionId}`);
    }

    if (args.githubLink !== undefined) {
      columnValues[TASK_COLUMNS.githubLink] = { url: args.githubLink, text: "GitHub" };
      changes.push(`GitHub Link -> ${args.githubLink}`);
    }

    if (args.prLink !== undefined) {
      columnValues[TASK_COLUMNS.prLink] = { url: args.prLink, text: "PR" };
      changes.push(`PR Link -> ${args.prLink}`);
    }

    if (args.demoUrl !== undefined) {
      columnValues[TASK_COLUMNS.demoUrl] = { url: args.demoUrl, text: "Demo" };
      changes.push(`Demo URL -> ${args.demoUrl}`);
    }

    if (args.agentId !== undefined) {
      columnValues[TASK_COLUMNS.agentId] = { ids: [String(AGENT_ID[args.agentId])] };
      changes.push(`Agent -> ${args.agentId}`);
    }

    if (args.planId !== undefined) {
      columnValues[TASK_COLUMNS.planId] = args.planId;
      changes.push(`Plan ID -> ${args.planId}`);
    }

    if (args.unplanned !== undefined) {
      columnValues[TASK_COLUMNS.unplanned] = { checked: args.unplanned ? "true" : "false" };
      changes.push(`Unplanned -> ${args.unplanned}`);
    }

    // New columns that may not exist yet -- handle gracefully
    if (args.branch !== undefined) {
      try {
        // Attempt to set branch column if it exists in TASK_COLUMNS
        const branchColumnId = (TASK_COLUMNS as Record<string, string>)["branch"];
        if (branchColumnId) {
          columnValues[branchColumnId] = args.branch;
          changes.push(`Branch -> ${args.branch}`);
        } else {
          changes.push(`Branch -> skipped (column not configured)`);
        }
      } catch {
        changes.push(`Branch -> skipped (column not configured)`);
      }
    }

    if (args.acceptanceCriteria !== undefined) {
      try {
        const acColumnId = (TASK_COLUMNS as Record<string, string>)["acceptanceCriteria"];
        if (acColumnId) {
          columnValues[acColumnId] = { text: args.acceptanceCriteria };
          changes.push(`Acceptance Criteria updated`);
        } else {
          changes.push(`Acceptance Criteria -> skipped (column not configured)`);
        }
      } catch {
        changes.push(`Acceptance Criteria -> skipped (column not configured)`);
      }
    }

    if (args.dependencyIds !== undefined) {
      columnValues[TASK_COLUMNS.dependencies] = { item_ids: args.dependencyIds };
      changes.push(args.dependencyIds.length > 0
        ? `Dependencies -> [${args.dependencyIds.join(", ")}]`
        : `Dependencies -> cleared`);
    }

    // Execute column value update if there are changes
    if (Object.keys(columnValues).length > 0) {
      const mutation = `
        mutation {
          change_multiple_column_values(
            item_id: ${itemId},
            board_id: ${BOARDS.TASKS},
            column_values: ${buildColumnValues(columnValues)}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(mutation);
    }

    // Write description to the doc column. Best-effort: surface failure but
    // don't undo the column updates above.
    if (args.description !== undefined) {
      try {
        const name = await fetchItemName(itemId);
        const docId = await ensureItemDoc(
          itemId,
          TASK_COLUMNS.descriptionDoc,
          name ? `Description — Task #${itemId}: ${name}` : `Description — Task #${itemId}`,
        );
        await writeDocContentReplacing(docId, args.description);
        changes.push(`Description updated`);
      } catch (e) {
        warnings.push(
          `Description write failed: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
    }

    // Version-side automation after a status change. Three steps run in order
    // — each is fail-soft so a Monday API hiccup doesn't fail the underlying
    // updateTask. See plugin/src/services/{auto-version,version-state-machine}.ts.
    if (args.status !== undefined) {
      // 1. Bounceback: if the task moved backward (away from Pending Deploy /
      //    Done) AND its current version is Released, unlink. Auto-version
      //    will reassign on the next UAT transition.
      try {
        const note = await maybeHandleBounceback(itemId, args.status);
        if (note) changes.push(note);
      } catch (e) {
        warnings.push(`Bounceback check failed: ${e instanceof Error ? e.message : String(e)}`);
      }

      // 2. Auto-version: on Waiting for UAT, ensure the task is linked to a
      //    version. See plugin/src/services/auto-version.ts.
      if (args.status === "Waiting for UAT") {
        try {
          const action = await autoAssignVersionForTask(itemId);
          if (action) changes.push(action);
        } catch (e) {
          warnings.push(
            `Auto-version assignment failed: ${e instanceof Error ? e.message : String(e)}`
          );
        }
      }

      // 3. Aggregate recompute: the task's current version may need a status
      //    update based on the aggregate of all linked tasks (In Development ↔
      //    Release Candidate). Skips Released and Hotfix versions.
      try {
        const note = await recomputeAggregateForTaskVersion(itemId);
        if (note) changes.push(note);
      } catch (e) {
        warnings.push(`Version aggregate recompute failed: ${e instanceof Error ? e.message : String(e)}`);
      }
    }

    // Handle name update separately (uses a different mutation field)
    if (args.name !== undefined) {
      const nameMutation = `
        mutation {
          change_simple_column_value(
            item_id: ${itemId},
            board_id: ${BOARDS.TASKS},
            column_id: "name",
            value: ${JSON.stringify(args.name)}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(nameMutation);
      changes.push(`Name -> "${args.name}"`);
    }

    if (changes.length === 0) {
      // If we attempted side-effect work (e.g. description doc write) but it
      // failed, the only signal is in `warnings`. Surface those instead of the
      // misleading "no fields provided" message — the caller DID provide a
      // field; the write just failed (often transient Monday doc-API races).
      if (warnings.length > 0) {
        const lines = [
          `Update failed for task #${itemId}:`,
          ...warnings.map(w => `  - ${w}`),
        ];
        return formatError(lines.join("\n"));
      }
      return formatError(`No fields provided to update for task #${itemId}.`);
    }

    // Return summary
    const lines: string[] = [
      `# Task Updated`,
      ``,
      `**Task:** #${itemId}`,
      ``,
      `**Changes:**`,
      ...changes.map(c => `- ${c}`),
    ];

    if (warnings.length > 0) {
      lines.push("");
      lines.push("**Warnings:**");
      for (const w of warnings) lines.push(`- ${w}`);
    }

    return lines.join("\n");
  } catch (error) {
    return formatError(`Failed to update task: ${error instanceof Error ? error.message : String(error)}`);
  }
}
