import { DOC_API_VERSION, executeMondayQuery } from "../monday-client";

const DOC_OPTS = { apiVersion: DOC_API_VERSION };
import { VERSION_COLUMNS, TASK_COLUMNS, BUG_COLUMNS } from "../constants";
import type { GenerateChangelogInput } from "../schemas";
import { evaluatePublicVisibility, getColumnText, getColumnValue, getLinkedItems, resolveLinkedItems, todayDate, formatError } from "./utils";
import { categoryForTaskType, emptyChangelog, writeChangelog, type StructuredChangelog } from "./structuredChangelog";

export async function generateChangelog(args: GenerateChangelogInput): Promise<string> {
  try {
    const { versionId, highlights, breakingChanges, knownIssues } = args;

    // Step 1: Fetch version item
    const columnIds = [
      VERSION_COLUMNS.versionNumber,
      VERSION_COLUMNS.connectedTasks,
      VERSION_COLUMNS.fixedBugs,
      VERSION_COLUMNS.changelog,
    ].map(c => `"${c}"`).join(", ");

    const query = `
      query {
        items(ids: [${versionId}]) {
          id
          name
          column_values(ids: [${columnIds}]) {
            id
            text
            value
            ... on BoardRelationValue { linked_items { id name } }
          }
        }
      }
    `;

    const response = await executeMondayQuery<any>(query);
    const item = response.items?.[0];

    if (!item) {
      return formatError(`Version with ID ${versionId} not found.`);
    }

    const colMap = new Map<string, any>(item.column_values?.map((c: any) => [c.id, c]) || []);
    const versionNumber = getColumnText(colMap, VERSION_COLUMNS.versionNumber) || item.name;

    // Step 2: Resolve all linked tasks and bugs
    const connectedTaskItems = getLinkedItems(colMap, VERSION_COLUMNS.connectedTasks);
    const fixedBugItems = getLinkedItems(colMap, VERSION_COLUMNS.fixedBugs);

    const taskIds = connectedTaskItems.map(t => Number(t.id));
    let resolvedTasks: any[] = [];
    if (taskIds.length > 0) {
      resolvedTasks = await resolveLinkedItems(taskIds, [
        TASK_COLUMNS.status,
        TASK_COLUMNS.type,
        TASK_COLUMNS.publicTaskName,
        TASK_COLUMNS.epic,
        TASK_COLUMNS.sprint,
      ]);
    }

    const bugIds = fixedBugItems.map(b => Number(b.id));
    let resolvedBugs: any[] = [];
    if (bugIds.length > 0) {
      resolvedBugs = await resolveLinkedItems(bugIds, [
        BUG_COLUMNS.status,
      ]);
    }

    // Step 3: Categorize tasks by type — canonical 3-cat shape.
    // A task is public only when ALL three hold: publicTaskName set, linked to
    // an epic, and assigned to a sprint. Anything missing is private and skipped.
    const structured: StructuredChangelog = emptyChangelog();
    let skippedPrivate = 0;
    const skipReasons: string[] = [];

    for (const task of resolvedTasks) {
      const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
      const visibility = evaluatePublicVisibility(taskColMap);
      if (!visibility.isPublic || !visibility.publicName) {
        skippedPrivate++;
        skipReasons.push(`#${task.id} ${task.name}: ${visibility.reasons.join(", ")}`);
        continue;
      }
      const taskType = getColumnText(taskColMap, TASK_COLUMNS.type);
      const category = categoryForTaskType(taskType);
      structured.tasks[category].push({
        id: Number(task.id),
        name: task.name,
        publicName: visibility.publicName,
      });
    }

    // Bugs always count as Fix
    for (const bug of resolvedBugs) {
      structured.tasks.Fix.push({
        id: Number(bug.id),
        name: bug.name,
      });
    }

    // Step 4: Build changelog markdown
    const mdLines: string[] = [];
    mdLines.push(`# Changelog — v${versionNumber}`);
    mdLines.push("");

    // Highlights (from param)
    if (highlights && highlights.length > 0) {
      mdLines.push("## Highlights");
      for (const h of highlights) {
        mdLines.push(`- ${h}`);
      }
      mdLines.push("");
    }

    // Auto-generated sections (only if they have content)
    const sectionOrder = ["Feature", "Fix", "Improvement"] as const;
    const sectionTitle = { Feature: "New Features", Fix: "Fixes", Improvement: "Improvements" } as const;
    for (const section of sectionOrder) {
      const entries = structured.tasks[section];
      if (entries.length > 0) {
        mdLines.push(`## ${sectionTitle[section]}`);
        for (const entry of entries) {
          const display = entry.publicName || entry.name;
          mdLines.push(entry.id ? `- ${display} (#${entry.id})` : `- ${display}`);
        }
        mdLines.push("");
      }
    }

    // Breaking Changes (from param)
    if (breakingChanges && breakingChanges.length > 0) {
      mdLines.push("## Breaking Changes");
      for (const bc of breakingChanges) {
        mdLines.push(`- ${bc}`);
      }
      mdLines.push("");
    }

    // Known Issues (from param)
    if (knownIssues && knownIssues.length > 0) {
      mdLines.push("## Known Issues");
      for (const ki of knownIssues) {
        mdLines.push(`- ${ki}`);
      }
      mdLines.push("");
    }

    mdLines.push("---");
    mdLines.push(`Generated on ${todayDate()}`);

    const markdown = mdLines.join("\n");

    // Step 5: Write to Monday Doc
    // Monday's doc column stores `{ files: [{ fileId: "<uuid>", objectId: <object id> }] }`.
    // The objectId is the per-item linkage id, but `add_content_to_doc_from_markdown(docId: ...)`
    // and `export_markdown_from_doc(docId: ...)` need the doc's primary `id` instead.
    // Resolve via `docs(object_ids: [objectId]) { id }`.
    const docValue = getColumnValue(colMap, VERSION_COLUMNS.changelog);
    let docId: number | undefined;
    let docObjectId: number | undefined;

    if (docValue && typeof docValue === "object") {
      const obj = docValue as Record<string, unknown>;
      const files = obj.files as Array<Record<string, unknown>> | undefined;
      if (files && files.length > 0) {
        const oid = files[0].objectId;
        if (typeof oid === "number") docObjectId = oid;
        else if (typeof oid === "string" && /^\d+$/.test(oid)) docObjectId = Number(oid);
      }
      if (!docObjectId) {
        const idMatch = JSON.stringify(obj).match(/"(?:objectId|object_id)"\s*:\s*(\d+)/);
        if (idMatch) docObjectId = Number(idMatch[1]);
      }
    }

    if (docObjectId) {
      const resolveQuery = `
        query {
          docs(object_ids: [${docObjectId}]) { id }
        }
      `;
      const resolveResponse = await executeMondayQuery<any>(resolveQuery, undefined, DOC_OPTS);
      const rawId = resolveResponse.docs?.[0]?.id;
      if (typeof rawId === "number") docId = rawId;
      else if (typeof rawId === "string" && /^\d+$/.test(rawId)) docId = Number(rawId);
    }

    if (docId) {
      // 2025-10 dropped the `overwrite` flag — content is always appended.
      // To emulate overwrite, drain every existing block first. Monday paginates
      // blocks at ~25 per query, so loop until the doc is empty (capped to keep
      // a buggy response from looping forever).
      try {
        for (let pass = 0; pass < 50; pass++) {
          const blocksQuery = `
            query {
              docs(ids: [${docId}]) {
                blocks { id }
              }
            }
          `;
          const blocksResponse = await executeMondayQuery<any>(blocksQuery, undefined, DOC_OPTS);
          const blocks: Array<{ id: string }> = blocksResponse.docs?.[0]?.blocks || [];
          if (blocks.length === 0) break;
          for (const block of blocks) {
            if (!block.id) continue;
            const delMutation = `
              mutation {
                delete_doc_block(block_id: ${JSON.stringify(block.id)}) { id }
              }
            `;
            await executeMondayQuery<unknown>(delMutation, undefined, DOC_OPTS);
          }
        }

        const writeQuery = `
          mutation {
            add_content_to_doc_from_markdown(
              docId: ${docId},
              markdown: ${JSON.stringify(markdown)}
            ) {
              success
            }
          }
        `;
        await executeMondayQuery<any>(writeQuery, undefined, DOC_OPTS);
      } catch (docErr) {
        return formatError(`Changelog generated but failed to write to doc: ${docErr instanceof Error ? docErr.message : String(docErr)}`);
      }
    } else {
      // Create new doc attached to the version item
      try {
        const createDocQuery = `
          mutation {
            create_doc(
              location: { board: { item_id: ${versionId}, column_id: "${VERSION_COLUMNS.changelog}" } }
            ) {
              id
            }
          }
        `;
        const createDocResponse = await executeMondayQuery<any>(createDocQuery, undefined, DOC_OPTS);
        const newDocId = createDocResponse.create_doc?.id;

        if (newDocId) {
          const writeQuery = `
            mutation {
              add_content_to_doc_from_markdown(
                docId: ${newDocId},
                markdown: ${JSON.stringify(markdown)}
              ) {
                success
              }
            }
          `;
          await executeMondayQuery<any>(writeQuery, undefined, DOC_OPTS);
          docId = newDocId;
        }
      } catch (createErr) {
        return formatError(`Changelog generated but failed to create doc: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      }
    }

    // Step 6: Persist canonical structured JSON to releaseSummary
    const summaryParts: string[] = [];
    const featureCount = structured.tasks.Feature.length;
    const fixCount = structured.tasks.Fix.length;
    const improvementCount = structured.tasks.Improvement.length;
    if (featureCount > 0) summaryParts.push(`${featureCount} new feature${featureCount > 1 ? "s" : ""}`);
    if (fixCount > 0) summaryParts.push(`${fixCount} fix${fixCount > 1 ? "es" : ""}`);
    if (improvementCount > 0) summaryParts.push(`${improvementCount} improvement${improvementCount > 1 ? "s" : ""}`);

    const totalItems = featureCount + fixCount + improvementCount;
    const condensedSummary = `v${versionNumber}: ${summaryParts.join(", ")} (${totalItems} items total)`;

    structured.summary = condensedSummary;
    if (highlights?.length) structured.highlights = highlights;
    if (breakingChanges?.length) structured.breakingChanges = breakingChanges;
    if (knownIssues?.length) structured.knownIssues = knownIssues;

    try {
      await writeChangelog(versionId, structured);
    } catch {
      // Non-critical — changelog markdown was still written to the doc
    }

    // Step 7: Return confirmation
    const outputLines: string[] = [
      `# Changelog Generated`,
      ``,
      `**Version:** ${item.name} (v${versionNumber})`,
      `**Doc ID:** ${docId || "N/A"}`,
      ``,
      `## Item Counts`,
    ];

    for (const section of sectionOrder) {
      const count = structured.tasks[section].length;
      if (count > 0) {
        outputLines.push(`- **${sectionTitle[section]}:** ${count}`);
      }
    }

    if (highlights?.length) outputLines.push(`- **Highlights:** ${highlights.length}`);
    if (breakingChanges?.length) outputLines.push(`- **Breaking Changes:** ${breakingChanges.length}`);
    if (knownIssues?.length) outputLines.push(`- **Known Issues:** ${knownIssues.length}`);
    if (skippedPrivate > 0) {
      outputLines.push(`- **Skipped (private — missing public name, epic, or sprint):** ${skippedPrivate}`);
      const preview = skipReasons.slice(0, 5);
      for (const reason of preview) outputLines.push(`  - ${reason}`);
      if (skipReasons.length > 5) outputLines.push(`  - …and ${skipReasons.length - 5} more`);
    }
    outputLines.push(`- **Total items:** ${totalItems}`);
    outputLines.push(``);
    outputLines.push(`**Summary:** ${condensedSummary}`);

    return outputLines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to generate changelog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
