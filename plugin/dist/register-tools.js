#!/usr/bin/env node
import { GetBacklogSchema, GetBugsSchema, GetTaskSchema, GetSprintSchema, ListSprintsSchema, GetEpicSchema, ListEpicsSchema, ListProductsSchema, ClaimTaskSchema, UpdateTaskSchema, ManageSubtasksSchema, CreateTaskSchema, ConvertBugToTaskSchema, CreateBugSchema, UpdateBugSchema, UpdateVersionSchema, CreateVersionSchema, ListVersionsSchema, GetVersionSchema, GetVersionTimelineSchema, GenerateChangelogSchema, GetUpdatesSchema, CreateUpdateSchema, CreateEpicSchema, UpdateEpicSchema, ListFeedbackSchema, GetFeedbackSchema, CreateFeedbackSchema, UpdateFeedbackSchema, ConvertFeedbackToTaskSchema, CreateRetroSchema, UpdateRetroSchema, ListRetrosSchema, SetPublicTaskNameSchema, GetPublicRoadmapSchema, GetStructuredChangelogSchema, UpdateStructuredChangelogSchema, MigrateStructuredChangelogSchema, GetTaskUatDocSchema, CreateTaskUatDocSchema, UpdateTaskUatDocSchema, GetTaskDescriptionDocSchema, CreateTaskDescriptionDocSchema, UpdateTaskDescriptionDocSchema, AppendTaskVisualSnapshotsSchema, ListTaskAttachmentsSchema, DownloadTaskAttachmentsSchema, } from "./schemas.js";
import { getBacklog, getBugs, getTask, getSprint, listSprints, getEpic, listEpics, listProducts, claimTask, updateTask, manageSubtasks, createTask, convertBugToTask, createBug, updateBug, updateVersion, createVersion, listVersions, getVersion, generateChangelog, getUpdates, createUpdate, createEpic, updateEpic, listFeedback, getFeedback, createFeedback, updateFeedback, convertFeedbackToTask, createRetro, updateRetro, listRetros, setPublicTaskName, getPublicRoadmap, getStructuredChangelog, updateStructuredChangelog, migrateStructuredChangelog, getTaskUatDoc, createTaskUatDoc, updateTaskUatDoc, getTaskDescriptionDoc, createTaskDescriptionDoc, updateTaskDescriptionDoc, appendTaskVisualSnapshots, getVersionTimeline, listTaskAttachments, downloadTaskAttachments, } from "./tools/index.js";
/**
 * Register all 47 Monday MCP tools on the given McpServer. Shared by the
 * stdio entry (server.ts) and the HTTP entry (api/mcp.ts).
 */
export function registerAllTools(server) {
    // =========================================================================
    // Discovery Phase
    // =========================================================================
    server.tool("getBacklog", "Get the prioritized task queue. Default: Needs Refinement + Ready to Start tasks. Compound array filters: statuses, types, epicIds, sprintIds (each `any_of`). Single-value filters: agentId, unclaimedOnly, productId (Monday Products-board item ID — resolved server-side via the product's epics; use listProducts to discover IDs). Server-side name search: query (contains_text). Pagination: pass `cursor` (from a previous nextCursor) to fetch the next page; limit defaults to 25 (Monday caps at 500). Pass format='json' for { tasks, nextCursor, filters } — recommended for UIs and when paginating. Every task carries a Monday URL.", GetBacklogSchema.shape, async (args) => {
        const result = await getBacklog(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getBugs", "Get bugs from the Bugs Queue. Returns bugs with status, priority, product, epic, and linked tasks. Use listProducts to find productId, listEpics for epicId. Filters: status, priority, productId, epicId, search text.", GetBugsSchema.shape, async (args) => {
        const result = await getBugs(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Context Phase
    // =========================================================================
    server.tool("getTask", "Get full task details by ID. Returns: status, priority, type, description, acceptance criteria, subtasks with progress, epic/sprint/version context, agent workflow fields, links (GitHub, PR, Demo), hours, and dates. Includes a stable Monday URL on the task and on every linked item (epic/sprint/version/bug). Pass format='json' to get a structured response instead of markdown.", GetTaskSchema.shape, async (args) => {
        const result = await getTask(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getSprint", "Get sprint overview. If no sprintId provided, returns the active sprint. Shows: goals, timeline, capacity, all tasks (no truncation) with their statuses/agents, and progress stats (total, byStatus, estimated vs actual hours). Pass format='json' to get a structured response (id as number, url, progress.byStatus dict, tasks: [{id, name, url, status, priority, type, agent?, estimatedHours?, actualHours?}]) instead of markdown.", GetSprintSchema.shape, async (args) => {
        const result = await getSprint(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("listSprints", "List sprints with their IDs, timelines, per-status task counts, hours, and (optionally) full task lists. Use this to discover sprintId before passing it to getSprint, getBacklog, createTask, updateTask, etc. DEFAULT VIEW: active + upcoming sprints (end date today or later, plus sprints with no end date), sorted oldest-start-first so the current sprint surfaces above future ones. Pass pastOnly=true for ended sprints (newest-ended first). Pass activeOnly=true to filter to just the activation-checkbox sprint (mutually exclusive with pastOnly). DEFAULT-ON: includeStatusCounts adds a `Counts: NR · Ready · InP · UAT · PendingDeploy · Done · Stuck` line and an `Hours: actual / estimated` line per sprint — pass false to skip. OPT-IN: includeTasks=true expands each sprint with its full task list (name + status). Pass format='json' to get a structured response (id as number, url, statusCounts dict, hours object) instead of markdown.", ListSprintsSchema.shape, async (args) => {
        const result = await listSprints(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getEpic", "Get full epic details by ID. Shows: description, PRD reference, linked tasks with progress breakdown, connected bugs with status, target version, product, timeline, and deadline. Use listEpics first to discover available epic IDs.", GetEpicSchema.shape, async (args) => {
        const result = await getEpic(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("listEpics", "List all epics for a product with status, progress, owner, and deadline. Use this to discover epic IDs before assigning tasks to epics via createTask or updateTask. Required: productId (Monday Products-board item ID; use listProducts to discover IDs).", ListEpicsSchema.shape, async (args) => {
        const result = await listEpics(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("listProducts", "List all products with status, owner, and counts of linked epics/bugs/versions/feedback. Use this to find the right productId when filing bugs via createBug.", ListProductsSchema.shape, async (args) => {
        const result = await listProducts(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Execution Phase
    // =========================================================================
    server.tool("claimTask", "Atomically claim a task for your agent. Pass your system username (output of `whoami`) as owner. Validates: task must be 'Ready to Start' (tasks in 'Needs Refinement' must be refined and sprint-assigned first), must be in the active sprint, must not be claimed by another agent, and all blocked-by dependencies (dependency_mm0pwbxn column) must be Done. On success: sets status to 'In Progress', assigns owner, records Agent ID, Plan ID, and started date. Returns error with current owner if already claimed.", ClaimTaskSchema.shape, async (args) => {
        const result = await claimTask(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateTask", "Update any task field. Supports: status (Needs Refinement, Ready to Start, In Progress, Waiting for UAT, Pending Deploy to Prod, Done, Stuck), priority (Critical/High/Medium/Low/Missing), type (Feature/Fix/Improvement/To Do/Not Set), description, hours (estimated/actual), links (GitHub/PR/Demo), epic, sprint, version, agent metadata, branch name, acceptance criteria, dependencyIds (array of task IDs this task is blocked-by — stored in column dependency_mm0pwbxn; claimTask refuses until all are Done), ciGate (per-task CI-gate policy: Full | Skip (human) | Skip (agent) — agents may only write 'Skip (agent)' after ci-skip-eval.sh ELIGIBLE, or 'Full'; 'Skip (human)' is human-set on the board). Set delete=true to delete. STATUS GATES: 'Ready to Start' requires type + priority + epic + description + acceptance criteria + ≥1 subtask with name/description/type/estimate. 'Waiting for UAT' requires all subtasks Done + UAT doc set (use createTaskUatDoc); warns on missing GitHub/branch/demo/PR links. 'In Progress' requires the task to be in the active sprint. Do NOT set status to 'Done' directly — mark all subtasks as Done instead (Monday automation auto-completes the parent). Set actualHours when moving to 'Waiting for UAT'. Use listEpics/listSprints to find epicId/sprintId.", UpdateTaskSchema.shape, async (args) => {
        const result = await updateTask(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("manageSubtasks", "Create, update, and delete subtasks in a single call. Each operation specifies action='create'|'update'|'delete'. Subtask types: Backend, Test, Documentation, UX-UI, Database, To Do. Subtask statuses: Needs Refinement → In Progress → Done (+ Stuck). Always set the type on every subtask. Remember to set actualHours when marking a subtask Done. IMPORTANT: When all subtasks are Done, Monday automation auto-completes the parent task — delete unwanted subtasks before marking the last one Done.", ManageSubtasksSchema.shape, async (args) => {
        const result = await manageSubtasks(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Creation Phase
    // =========================================================================
    server.tool("createTask", "IMPORTANT: Use getBacklog first to check for existing similar tasks. Create one or more tasks with optional subtasks, epic/sprint linkage, acceptance criteria, dependencyIds (blocked-by tasks stored in column dependency_mm0pwbxn), and agent metadata. Status defaults to 'Needs Refinement'; pass 'Ready to Start' once name/priority/type/epic/description are filled in and subtasks exist. Type values: Feature (new functionality), Fix (bugfix), Improvement (tech debt / refactor / small UX), To Do (human task), Not Set. Pass your system username (output of `whoami`) as owner. Use listEpics to find the right epicId. For discovered tech debt, follow-up work, or breaking down larger tasks.", CreateTaskSchema.shape, async (args) => {
        const result = await createTask(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("convertBugToTask", "Convert a bug into a Fix task (Option C workflow). Use getBugs to find the bugId. Copies bug name, description, and priority. Creates task with type=Fix, status='Ready to Start', links bug↔task, and sets bug status to 'Converted to Task' (terminal — bug becomes a breadcrumb, all dev work happens on the linked Task). If no epicId specified, auto-assigns the product's maintenance epic. Optionally link to epic/sprint.", ConvertBugToTaskSchema.shape, async (args) => {
        const result = await convertBugToTask(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("createBug", "File a new bug discovered during development. Set name (include component + symptom), description (reproduction steps), priority (by user impact). Use listProducts to find productId, listEpics for epicId. If no epicId specified and productId is set, auto-assigns the product's maintenance epic. Bug starts in 'Awaiting Review' status.", CreateBugSchema.shape, async (args) => {
        const result = await createBug(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateBug", "Update any bug field — name, description, status, priority, productId, epicId, fixedInVersionId, filedByAgent. Set delete=true to delete (rare — prefer Declined/Cannot Reproduce/Duplicated for closure). Option C workflow: Awaiting Review → Triaged → (Converted to Task | Declined | Cannot Reproduce | Duplicated | Missing Info | Known Bug). Once 'Converted to Task', all dev work happens on the linked Task — prefer convertBugToTask for that transition. Legacy statuses (Ready for Dev, Fixing, Fixed, Pending Deploy, Move to Sprints) are still accepted for backwards compat but should NOT be used for new writes. New labels are auto-created by Monday on first write via create_labels_if_missing.", UpdateBugSchema.shape, async (args) => {
        const result = await updateBug(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Shipping Phase
    // =========================================================================
    server.tool("updateVersion", "Update any version field: status, name, versionNumber, dates (expected/release), owner, release summary, link tasks/bugs/epics. Move between groups (upcoming/released). Set delete=true to delete. Setting status to 'Released' requires confirmRelease=true as a safety check. Use listVersions to find the versionId.", UpdateVersionSchema.shape, async (args) => {
        const result = await updateVersion(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("createVersion", "Create a new version in the Upcoming group. Required: name, productId. Optional: versionNumber, status (default: Planned), dates, release summary, owner, and link tasks/bugs/epics. Use listProducts to find productId.", CreateVersionSchema.shape, async (args) => {
        const result = await createVersion(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("listVersions", "List versions with status, version number, dates, owner, product, and linked item counts. Filter by status, productId, group (upcoming/released), or search text. Use this to discover version IDs.", ListVersionsSchema.shape, async (args) => {
        const result = await listVersions(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getVersion", "Get full version details by ID. Shows: status, version number, dates, owner, release summary, linked tasks (with status/type), linked epics (with status), fixed bugs (with status), and changelog content from Monday Doc.", GetVersionSchema.shape, async (args) => {
        const result = await getVersion(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getVersionTimeline", "Get a product's versions in chronological order (newest first). Versions are HISTORICAL — what shipped + what's about to ship. For future planning, use getPublicRoadmap (epic-based). Sections: 'Shipping now' (Planned/In Development/Release Candidate), 'Hotfixes', 'Released'. Per version: number, name, status, release date, task counts (Feature/Fix/Improvement/Other). Options: statusFilter ('all'|'released'|'open'|'hotfix'), format ('markdown'|'json'), expandTasks (include full task list per version), limit. Required: productId — use listProducts to find the ID.", GetVersionTimelineSchema.shape, async (args) => {
        const result = await getVersionTimeline(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("generateChangelog", "Generate a public changelog for a version. A task is only included when ALL THREE conditions hold: (1) publicTaskName is set, (2) linked to an epic, (3) assigned to a sprint. Tasks missing any are skipped; the response reports the count and per-task reasons. Bugs are always included as Fix. Tasks are categorized by type (Development→Feature, Bugfix→Fix, Maintenance/Refine/Documentation/PM-work→Improvement). Writes the canonical 3-cat JSON to the version's release summary AND creates/overwrites a Monday Doc with the human-readable changelog. Optional: highlights, breakingChanges, knownIssues arrays for additional sections.", GenerateChangelogSchema.shape, async (args) => {
        const result = await generateChangelog(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Communication Phase
    // =========================================================================
    server.tool("getUpdates", "Get updates (comments/discussion) on a Monday.com item. Returns updates with author, timestamp, content, and threaded replies. Newest updates first. Use to read context, progress notes, or discussion before starting work on a task.", GetUpdatesSchema.shape, async (args) => {
        const result = await getUpdates(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("createUpdate", "Post an update (comment) on a Monday.com item. Use to share progress, blockers, completion notes, or ask questions. Body must be HTML — Monday Updates render HTML and strip markdown to plaintext (use <p>, <strong>, <em>, <ul>/<li>, <a href>, <br>, <code>, <pre>, not **bold** or - bullets). Set parentUpdateId to reply to an existing update thread.", CreateUpdateSchema.shape, async (args) => {
        const result = await createUpdate(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Epic Management
    // =========================================================================
    server.tool("createEpic", "Create a new epic on the Epics board. Set name (required), status (default: Backlog), priority, description, owner, deadline, timeline (start+end), and link to product/version. Use listProducts to find productId.", CreateEpicSchema.shape, async (args) => {
        const result = await createEpic(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateEpic", "Update any epic field. Supports: name, status, priority, description, owner, deadline, timeline (start+end), product, version. Set delete=true to delete. Use listEpics to find the epicId.", UpdateEpicSchema.shape, async (args) => {
        const result = await updateEpic(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Feedback & Requests
    // =========================================================================
    server.tool("listFeedback", "List requests and feedback items. Filter by type (Request/Feedback), status (New/Under Review/Accepted/Declined/Converted/Done), priority, source (User/Internal/Support/Partner), productId, or search text. Returns: name, type, status, priority, source, reporter, product, and connected task count.", ListFeedbackSchema.shape, async (args) => {
        const result = await listFeedback(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getFeedback", "Get full details of a feedback/request item by ID. Shows: type, status, priority, source, reporter, product, description, and connected tasks (resolved with status/type/priority). Use listFeedback first to discover item IDs.", GetFeedbackSchema.shape, async (args) => {
        const result = await getFeedback(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("createFeedback", "Create a new request or feedback item. Required: name, type (Request/Feedback). Optional: description, priority (Critical/High/Medium/Low), source (User/Internal/Support/Partner), productId, reporter (person ID). Items start with status 'New' in the Incoming group.", CreateFeedbackSchema.shape, async (args) => {
        const result = await createFeedback(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateFeedback", "Update any feedback/request field. Supports: name, status (New/Under Review/Accepted/Declined/Converted/Done), type (Request/Feedback), priority, source, description, productId. Set delete=true to delete. Use listFeedback to find the feedbackId.", UpdateFeedbackSchema.shape, async (args) => {
        const result = await updateFeedback(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("convertFeedbackToTask", "Convert a feedback/request item into a task. Copies name, priority, and description from the feedback item. Auto-infers task type from feedback type (Request→Feature, Feedback→Improvement) unless overridden. If no epicId specified, auto-assigns the product's maintenance epic (if one exists). Links the new task back to the feedback item via two-way relation and sets feedback status to 'Converted'. Optionally assign to epic/sprint or add extra description.", ConvertFeedbackToTaskSchema.shape, async (args) => {
        const result = await convertFeedbackToTask(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Retrospectives
    // =========================================================================
    server.tool("createRetro", "Create a retrospective item on the Retrospectives board. Required: name, type ('Discussion' | 'Keep' | 'Improve'). Optional: description (long_text — reasoning, examples, links, next steps), repeating (carries over between sprints), submitter / owner person IDs, sprintId (sprint this retro was registered or implemented for — use listSprints to discover the ID).", CreateRetroSchema.shape, async (args) => {
        const result = await createRetro(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateRetro", "Update any retro item field. Supports: name, type (Discussion/Keep/Improve), status (workflow: New → Accepted → Implemented → Validated; off-ramp Declined — added v0.12.0), description, repeating, submitter, owner, implementedBy (person who shipped the improvement), sprintId, resolvedInVersionId (Versions board item — set when status: Implemented), filedByAgent (Agent ID dropdown). Set delete=true to delete the retro item. Use listRetros to find the retroId. Workflow: status: New (default) → Accepted (team agreed, owner assigned) → Implemented (PR merged, implementedBy + resolvedInVersionId populated) → Validated. Use Declined for retros that won't be actioned (terminal).", UpdateRetroSchema.shape, async (args) => {
        const result = await updateRetro(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("listRetros", "List retro items from the Retrospectives board. Filters: sprintId (use listSprints to find), activeSprint (resolves to the currently active sprint — mutually exclusive with sprintId), search (case-insensitive match across name + description). Use this to dedupe before filing a new retro or to review what was raised in a given sprint. Returns name, type, repeating flag, sprint link, submitter, owner, and vote count.", ListRetrosSchema.shape, async (args) => {
        const result = await listRetros(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Public Roadmap
    // =========================================================================
    server.tool("setPublicTaskName", "Set the public-facing name of a task. This is ONE of three requirements for public exposure — a task appears on the public roadmap and in changelogs only when ALL of these hold: (1) public name is non-empty, (2) task is linked to an epic, (3) task is assigned to a sprint. If any are missing, the task stays private. Setting an empty string clears the public name and forces the task private regardless of epic/sprint.", SetPublicTaskNameSchema.shape, async (args) => {
        const result = await setPublicTaskName(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("getPublicRoadmap", "Get a public-facing roadmap for a product as Epic → Sprint → Task markdown. A task only appears when ALL THREE conditions hold: (1) publicTaskName is set, (2) it's linked to an epic, (3) it's assigned to a sprint. Tasks missing any of these are private and excluded. Required: productId (Monday Products-board item ID; use listProducts to discover IDs). Optional: onlyInProgress to limit to in-progress epics.", GetPublicRoadmapSchema.shape, async (args) => {
        const result = await getPublicRoadmap(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Structured Changelog
    // =========================================================================
    server.tool("getStructuredChangelog", "Read the structured changelog for a version as JSON. Canonical 3-cat shape: { version, summary?, highlights?, breakingChanges?, knownIssues?, tasks: { Feature, Fix, Improvement } }. Auto-migrates legacy shapes. Stored in the version's release summary column.", GetStructuredChangelogSchema.shape, async (args) => {
        const result = await getStructuredChangelog(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateStructuredChangelog", "Apply patch operations to the structured changelog. Ops: addTask (by taskId — auto-categorizes from task type AND requires the task to be public, i.e. publicTaskName set + linked epic + assigned sprint; refuses with reasons if private — or manual {name, category} which bypasses the gate), removeTask (by taskId, or manual {name, category}), setSummary, setHighlights, setBreakingChanges, setKnownIssues. Read-modify-write happens server-side; callers do not need to fetch first. To clear a list field, pass an empty array (e.g. setHighlights with items: []).", UpdateStructuredChangelogSchema.shape, async (args) => {
        const result = await updateStructuredChangelog(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("migrateStructuredChangelog", "Pure migration helper. Takes raw JSON or marker-wrapped text and returns the canonical 3-cat shape. Useful for migrating data from external sources without touching Monday.", MigrateStructuredChangelogSchema.shape, async (args) => {
        const result = await migrateStructuredChangelog(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // UAT Docs
    // =========================================================================
    server.tool("getTaskUatDoc", "Read the UAT testing doc (Monday Doc on column doc_mm3adfdg) for a task as markdown. Returns an error if the task has no UAT doc.", GetTaskUatDocSchema.shape, async (args) => {
        const result = await getTaskUatDoc(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("createTaskUatDoc", "Create a new UAT testing doc on a task (column doc_mm3adfdg). Used to describe what the user should test for the task. Refuses if a doc already exists — use updateTaskUatDoc to modify. Setting this doc is required before updateTask can transition the task to 'Waiting for UAT'.", CreateTaskUatDocSchema.shape, async (args) => {
        const result = await createTaskUatDoc(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateTaskUatDoc", "Update the existing UAT testing doc on a task (column doc_mm3adfdg). overwrite=true (default) replaces the doc; overwrite=false appends. Refuses if no doc exists — use createTaskUatDoc first.", UpdateTaskUatDocSchema.shape, async (args) => {
        const result = await updateTaskUatDoc(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Description Docs (Monday Doc column doc_mm3sg1kr)
    // =========================================================================
    server.tool("getTaskDescriptionDoc", "Read the task description doc (Monday Doc on column doc_mm3sg1kr) as markdown. Tasks store descriptions on this doc column (uncapped length); getTask reads it transparently. Use this tool for direct doc-level access (avoids the createTask/updateTask round-trip when you only want the description content).", GetTaskDescriptionDocSchema.shape, async (args) => {
        const result = await getTaskDescriptionDoc(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("createTaskDescriptionDoc", "Create a new description doc on a task (column doc_mm3sg1kr). Refuses if a doc already exists — use updateTaskDescriptionDoc to modify. Most callers should pass `description` to createTask/updateTask instead; this is for direct doc-only flows (e.g. converting an existing long description without other field changes).", CreateTaskDescriptionDocSchema.shape, async (args) => {
        const result = await createTaskDescriptionDoc(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("updateTaskDescriptionDoc", "Update the existing description doc on a task (column doc_mm3sg1kr). overwrite=true (default) replaces; overwrite=false appends. Refuses if no doc exists — use createTaskDescriptionDoc first.", UpdateTaskDescriptionDocSchema.shape, async (args) => {
        const result = await updateTaskDescriptionDoc(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Visual Changes Doc (Monday Doc column doc_mm4jkk92) — before/after UI shots
    // =========================================================================
    server.tool("appendTaskVisualSnapshots", "Append a pass-grouped section of before/after UI screenshots to a task's 'Visual Changes' Monday doc (column doc_mm4jkk92). phase='before' (staging pre-change, captured pre-merge) or 'after' (staging post-deploy). Each capture is a route with an optional absolute imagePath; images are uploaded as Monday assets and embedded by permanent asset_id (URLs expire). Append-only — before + after accumulate; the doc is created on first call. Used by /ship-pr's visualDiff passes. Note-only entries (no imagePath) record skips, e.g. 'new route, no before state'.", AppendTaskVisualSnapshotsSchema.shape, async (args) => {
        const result = await appendTaskVisualSnapshots(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Task Attachments (DOWN direction — pull + read a task's files/screenshots)
    // =========================================================================
    server.tool("listTaskAttachments", "Enumerate the files attached to a Monday task — both its file columns AND (by default) the files posted inside its Updates (spec PDFs, mockups, screenshots, logs). Returns non-sensitive metadata per asset: id, name, extension, size, and source ('task-file-column' or 'update-<id>'). Signed download URLs are intentionally NOT returned. Pass includeUpdates=false to list only the item's own file columns. Pair with downloadTaskAttachments to pull the bytes and Read them. This is the DOWN direction; appendTaskVisualSnapshots is the UP direction.", ListTaskAttachmentsSchema.shape, async (args) => {
        const result = await listTaskAttachments(args);
        return { content: [{ type: "text", text: result }] };
    });
    server.tool("downloadTaskAttachments", "Download a Monday task's attachments (file columns + Update files) to a local directory and return the local file paths so you can Read them — image-aware Read for screenshots/mockups, plus PDFs/text/logs. destDir defaults to a scratchpad dir under the OS temp dir and must resolve inside an allowed root (OS temp dir, cwd, or $DEV_TASKS_DOWNLOAD_DIR). Pass assetIds (from listTaskAttachments) to download specific files, includeUpdates=false to skip Update files, maxFileSizeMb to change the per-file size cap (default 25MB), and timeoutMs for the per-file timeout (default 30000). Filenames are collision-safe; the API token is never included in output.", DownloadTaskAttachmentsSchema.shape, async (args) => {
        const result = await downloadTaskAttachments(args);
        return { content: [{ type: "text", text: result }] };
    });
    // =========================================================================
    // Boot
}
