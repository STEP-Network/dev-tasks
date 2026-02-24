import { executeMondayQuery } from "../monday-client";
import { BOARDS, VERSION_COLUMNS, TASK_COLUMNS, BUG_COLUMNS } from "../constants";
import type { GenerateChangelogInput } from "../schemas";
import { buildColumnValues, getColumnText, getColumnValue, getLinkedItems, resolveLinkedItems, todayDate, formatError } from "./utils";

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
      ]);
    }

    const bugIds = fixedBugItems.map(b => Number(b.id));
    let resolvedBugs: any[] = [];
    if (bugIds.length > 0) {
      resolvedBugs = await resolveLinkedItems(bugIds, [
        BUG_COLUMNS.status,
      ]);
    }

    // Step 3: Auto-categorize tasks by type
    const categories: Record<string, string[]> = {
      Added: [],
      Fixed: [],
      Changed: [],
      Documentation: [],
      Other: [],
    };

    for (const task of resolvedTasks) {
      const taskColMap = new Map<string, any>(task.column_values?.map((c: any) => [c.id, c]) || []);
      const taskType = getColumnText(taskColMap, TASK_COLUMNS.type) || "";

      const entry = `- ${task.name} (#${task.id})`;

      switch (taskType) {
        case "Development":
          categories.Added.push(entry);
          break;
        case "Bugfix":
          categories.Fixed.push(entry);
          break;
        case "Maintenance":
        case "Refine":
          categories.Changed.push(entry);
          break;
        case "Documentation":
          categories.Documentation.push(entry);
          break;
        default:
          categories.Other.push(entry);
          break;
      }
    }

    // Bugs go in Fixed
    for (const bug of resolvedBugs) {
      categories.Fixed.push(`- ${bug.name} (#${bug.id})`);
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
    const sectionOrder = ["Added", "Fixed", "Changed", "Documentation", "Other"];
    for (const section of sectionOrder) {
      if (categories[section].length > 0) {
        mdLines.push(`## ${section}`);
        mdLines.push(...categories[section]);
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
    const docValue = getColumnValue(colMap, VERSION_COLUMNS.changelog);
    let docId: number | undefined;

    if (docValue) {
      if (docValue.doc_id) {
        docId = docValue.doc_id;
      } else if (docValue.files?.[0]?.fileId) {
        docId = docValue.files[0].fileId;
      } else if (typeof docValue === "object") {
        const idMatch = JSON.stringify(docValue).match(/"(?:doc_id|id|fileId)"\s*:\s*(\d+)/);
        if (idMatch) docId = parseInt(idMatch[1]);
      }
    }

    if (docId) {
      // Overwrite existing doc content
      try {
        const overwriteQuery = `
          mutation {
            add_content_to_doc_from_markdown(
              doc_id: ${docId},
              markdown: ${JSON.stringify(markdown)},
              overwrite: true
            ) {
              doc_id
            }
          }
        `;
        await executeMondayQuery<any>(overwriteQuery);
      } catch {
        // Fallback: try without overwrite flag
        try {
          const appendQuery = `
            mutation {
              add_content_to_doc_from_markdown(
                doc_id: ${docId},
                markdown: ${JSON.stringify(markdown)}
              ) {
                doc_id
              }
            }
          `;
          await executeMondayQuery<any>(appendQuery);
        } catch (docErr) {
          return formatError(`Changelog generated but failed to write to doc: ${docErr instanceof Error ? docErr.message : String(docErr)}`);
        }
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
        const createDocResponse = await executeMondayQuery<any>(createDocQuery);
        const newDocId = createDocResponse.create_doc?.id;

        if (newDocId) {
          const writeQuery = `
            mutation {
              add_content_to_doc_from_markdown(
                doc_id: ${newDocId},
                markdown: ${JSON.stringify(markdown)}
              ) {
                doc_id
              }
            }
          `;
          await executeMondayQuery<any>(writeQuery);
          docId = newDocId;
        }
      } catch (createErr) {
        return formatError(`Changelog generated but failed to create doc: ${createErr instanceof Error ? createErr.message : String(createErr)}`);
      }
    }

    // Step 6: Write condensed summary to releaseSummary field
    const totalItems = resolvedTasks.length + resolvedBugs.length;
    const summaryParts: string[] = [];
    if (categories.Added.length > 0) summaryParts.push(`${categories.Added.length} new feature${categories.Added.length > 1 ? "s" : ""}`);
    if (categories.Fixed.length > 0) summaryParts.push(`${categories.Fixed.length} fix${categories.Fixed.length > 1 ? "es" : ""}`);
    if (categories.Changed.length > 0) summaryParts.push(`${categories.Changed.length} change${categories.Changed.length > 1 ? "s" : ""}`);
    if (categories.Documentation.length > 0) summaryParts.push(`${categories.Documentation.length} doc update${categories.Documentation.length > 1 ? "s" : ""}`);
    if (categories.Other.length > 0) summaryParts.push(`${categories.Other.length} other`);

    const condensedSummary = `v${versionNumber}: ${summaryParts.join(", ")} (${totalItems} items total)`;

    try {
      const summaryMutation = `
        mutation {
          change_multiple_column_values(
            board_id: ${BOARDS.VERSIONS},
            item_id: ${versionId},
            column_values: ${buildColumnValues({ [VERSION_COLUMNS.releaseSummary]: { text: condensedSummary } })}
          ) {
            id
          }
        }
      `;
      await executeMondayQuery<any>(summaryMutation);
    } catch {
      // Non-critical — changelog was still written
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
      if (categories[section].length > 0) {
        outputLines.push(`- **${section}:** ${categories[section].length}`);
      }
    }

    if (highlights?.length) outputLines.push(`- **Highlights:** ${highlights.length}`);
    if (breakingChanges?.length) outputLines.push(`- **Breaking Changes:** ${breakingChanges.length}`);
    if (knownIssues?.length) outputLines.push(`- **Known Issues:** ${knownIssues.length}`);
    outputLines.push(`- **Total items:** ${totalItems}`);
    outputLines.push(``);
    outputLines.push(`**Summary:** ${condensedSummary}`);

    return outputLines.join("\n").trim();
  } catch (error) {
    return formatError(`Failed to generate changelog: ${error instanceof Error ? error.message : String(error)}`);
  }
}
