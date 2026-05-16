import { executeMondayQuery } from "../monday-client.ts";
import { VERSION_COLUMNS, TASK_COLUMNS, BUG_COLUMNS } from "../constants.ts";
import type { GenerateChangelogInput } from "../schemas.ts";
import { evaluatePublicVisibility, getColumnText, getLinkedItems, resolveLinkedItems, formatError } from "./utils.ts";
import { categoryForTaskType, emptyChangelog, writeChangelog, type StructuredChangelog } from "./structuredChangelog.ts";

export async function generateChangelog(args: GenerateChangelogInput): Promise<string> {
  try {
    const { versionId, highlights, breakingChanges, knownIssues } = args;

    // Step 1: Fetch version item
    const columnIds = [
      VERSION_COLUMNS.versionNumber,
      VERSION_COLUMNS.connectedTasks,
      VERSION_COLUMNS.fixedBugs,
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

    // Step 4: Merge user-provided overrides into the structured changelog.
    // The unified writeChangelog (services/changelog-doc.ts) renders both the
    // human view (markdown) and the machine view (fenced JSON block) from this
    // single object — no separate markdown-build step needed.
    const featureCount = structured.tasks.Feature.length;
    const fixCount = structured.tasks.Fix.length;
    const improvementCount = structured.tasks.Improvement.length;
    const summaryParts: string[] = [];
    if (featureCount > 0) summaryParts.push(`${featureCount} new feature${featureCount > 1 ? "s" : ""}`);
    if (fixCount > 0) summaryParts.push(`${fixCount} fix${fixCount > 1 ? "es" : ""}`);
    if (improvementCount > 0) summaryParts.push(`${improvementCount} improvement${improvementCount > 1 ? "s" : ""}`);
    const totalItems = featureCount + fixCount + improvementCount;
    const condensedSummary = `v${versionNumber}: ${summaryParts.join(", ")} (${totalItems} items total)`;

    structured.summary = condensedSummary;
    if (highlights?.length) structured.highlights = highlights;
    if (breakingChanges?.length) structured.breakingChanges = breakingChanges;
    if (knownIssues?.length) structured.knownIssues = knownIssues;

    // Step 5: Write the unified Doc (single drain + write, both views co-located)
    const versionLabel = `v${versionNumber}${item.name && item.name !== `v${versionNumber}` ? ` — ${item.name}` : ""}`;
    try {
      await writeChangelog(versionId, structured, { versionLabel });
    } catch (writeErr) {
      return formatError(`Failed to write changelog Doc: ${writeErr instanceof Error ? writeErr.message : String(writeErr)}`);
    }

    // Step 6: Return confirmation
    const sectionTitle = { Feature: "New Features", Fix: "Fixes", Improvement: "Improvements" } as const;
    const sectionOrder = ["Feature", "Fix", "Improvement"] as const;
    const outputLines: string[] = [
      `# Changelog Generated`,
      ``,
      `**Version:** ${item.name} (v${versionNumber})`,
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
