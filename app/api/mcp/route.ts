import { createMcpHandler } from "mcp-handler";
import {
  GetBacklogSchema,
  GetBugsSchema,
  GetTaskSchema,
  GetSprintSchema,
  GetEpicSchema,
  ListEpicsSchema,
  ListProductsSchema,
  ClaimTaskSchema,
  UpdateTaskSchema,
  ManageSubtasksSchema,
  CreateTaskSchema,
  ConvertBugToTaskSchema,
  CreateBugSchema,
  UpdateVersionSchema,
  CreateVersionSchema,
  ListVersionsSchema,
  GetVersionSchema,
  GenerateChangelogSchema,
  GetUpdatesSchema,
  CreateUpdateSchema,
  CreateEpicSchema,
  UpdateEpicSchema,
  ListFeedbackSchema,
  GetFeedbackSchema,
  CreateFeedbackSchema,
  UpdateFeedbackSchema,
  ConvertFeedbackToTaskSchema,
  CreateRetroSchema,
  ListRetrosSchema,
  SetPublicTaskNameSchema,
  GetPublicRoadmapSchema,
  GetStructuredChangelogSchema,
  UpdateStructuredChangelogSchema,
  MigrateStructuredChangelogSchema,
} from "@/lib/schemas";
import {
  getBacklog,
  getBugs,
  getTask,
  getSprint,
  getEpic,
  listEpics,
  listProducts,
  claimTask,
  updateTask,
  manageSubtasks,
  createTask,
  convertBugToTask,
  createBug,
  updateVersion,
  createVersion,
  listVersions,
  getVersion,
  generateChangelog,
  getUpdates,
  createUpdate,
  createEpic,
  updateEpic,
  listFeedback,
  getFeedback,
  createFeedback,
  updateFeedback,
  convertFeedbackToTask,
  createRetro,
  listRetros,
  setPublicTaskName,
  getPublicRoadmap,
  getStructuredChangelog,
  updateStructuredChangelog,
  migrateStructuredChangelog,
} from "@/lib/tools";

const handler = createMcpHandler(
  (server) => {
    // =========================================================================
    // Discovery Phase
    // =========================================================================

    server.tool(
      "getBacklog",
      "Get the prioritized task queue for coding agents. Returns tasks ordered by board position (priority). Default: shows Backlog + Ready to Start tasks. Use unclaimedOnly=true to see tasks available for claiming. Filters: status, type, unclaimedOnly, agentId, epicId, sprintId.",
      GetBacklogSchema.shape,
      async (args) => {
        const result = await getBacklog(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getBugs",
      "Get bugs from the Bugs Queue. Returns bugs with status, priority, product, epic, and linked tasks. Use listProducts to find productId, listEpics for epicId. Filters: status, priority, productId, epicId, search text.",
      GetBugsSchema.shape,
      async (args) => {
        const result = await getBugs(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Context Phase
    // =========================================================================

    server.tool(
      "getTask",
      "Get full task details by ID. Returns: status, priority, type, description, acceptance criteria, subtasks with progress, epic/sprint/version context, agent workflow fields, links (GitHub, PR, Demo), hours, and dates. Use this before starting work on a task.",
      GetTaskSchema.shape,
      async (args) => {
        const result = await getTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getSprint",
      "Get sprint overview. If no sprintId provided, returns the active sprint. Shows: goals, timeline, capacity, all tasks with their statuses/agents, and progress stats (tasks by status, estimated vs actual hours).",
      GetSprintSchema.shape,
      async (args) => {
        const result = await getSprint(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getEpic",
      "Get full epic details by ID. Shows: description, PRD reference, linked tasks with progress breakdown, connected bugs with status, target version, product, timeline, and deadline. Use listEpics first to discover available epic IDs.",
      GetEpicSchema.shape,
      async (args) => {
        const result = await getEpic(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "listEpics",
      "List all epics for a product with status, progress, owner, and deadline. Use this to discover epic IDs before assigning tasks to epics via createTask or updateTask. Required: product ('STEPhie' or 'PolAds').",
      ListEpicsSchema.shape,
      async (args) => {
        const result = await listEpics(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "listProducts",
      "List all products with status, owner, and counts of linked epics/bugs/versions/feedback. Use this to find the right productId when filing bugs via createBug.",
      ListProductsSchema.shape,
      async (args) => {
        const result = await listProducts(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Execution Phase
    // =========================================================================

    server.tool(
      "claimTask",
      "Atomically claim a task for your agent. Pass your system username (output of `whoami`) as owner. Validates: task must be 'Backlog' or 'Ready to Start', must not be claimed by another agent, and all dependencies must be resolved (Done). On success: sets status to 'In Progress', assigns owner, records Agent ID, Plan ID, and started date. Returns error with current owner if already claimed.",
      ClaimTaskSchema.shape,
      async (args) => {
        const result = await claimTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "updateTask",
      "Update any task field. Supports: status, priority, type, description, hours (estimated/actual), links (GitHub/PR/Demo), epic, sprint, version, agent metadata, branch name, acceptance criteria, dependencies. Set delete=true to delete. IMPORTANT: Do NOT set status to 'Done' directly — mark all subtasks as Done instead (Monday automation auto-completes the parent). Remember to set actualHours when moving to 'Waiting for Review'. Use listEpics/getSprint to find epicId/sprintId.",
      UpdateTaskSchema.shape,
      async (args) => {
        const result = await updateTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "manageSubtasks",
      "Create, update, and delete subtasks in a single call. Each operation specifies action='create'|'update'|'delete'. Supports typed subtasks (Backend, Test, Documentation, UX-UI, Database, PM-work), status tracking, hours, and name-based lookup for updates/deletes. Remember to set actualHours on subtasks when marking them Done. IMPORTANT: When all subtasks are Done, Monday automation auto-completes the parent task — delete unwanted subtasks before marking the last one Done.",
      ManageSubtasksSchema.shape,
      async (args) => {
        const result = await manageSubtasks(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Creation Phase
    // =========================================================================

    server.tool(
      "createTask",
      "IMPORTANT: Use getBacklog first to check for existing similar tasks. Create one or more tasks with optional subtasks, epic/sprint linkage, acceptance criteria, dependencies, and agent metadata. Pass your system username (output of `whoami`) as owner. Use listEpics to find the right epicId. For discovered tech debt, follow-up work, or breaking down larger tasks.",
      CreateTaskSchema.shape,
      async (args) => {
        const result = await createTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "convertBugToTask",
      "Convert a bug into a Bugfix task. Use getBugs to find the bugId. Copies bug name, description, and priority. Creates task with type=Bugfix, links bug<->task, and sets bug status to 'Fixing'. If no epicId specified, auto-assigns the product's maintenance epic (if one exists). Optionally link to epic/sprint.",
      ConvertBugToTaskSchema.shape,
      async (args) => {
        const result = await convertBugToTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "createBug",
      "File a new bug discovered during development. Set name (include component + symptom), description (reproduction steps), priority (by user impact). Use listProducts to find productId, listEpics for epicId. If no epicId specified and productId is set, auto-assigns the product's maintenance epic. Bug starts in 'Awaiting Review' status.",
      CreateBugSchema.shape,
      async (args) => {
        const result = await createBug(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Shipping Phase
    // =========================================================================

    server.tool(
      "updateVersion",
      "Update any version field: status, name, versionNumber, dates (expected/release), owner, release summary, link tasks/bugs/epics. Move between groups (upcoming/released). Set delete=true to delete. Setting status to 'Released' requires confirmRelease=true as a safety check. Use listVersions to find the versionId.",
      UpdateVersionSchema.shape,
      async (args) => {
        const result = await updateVersion(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "createVersion",
      "Create a new version in the Upcoming group. Required: name, productId. Optional: versionNumber, status (default: Planned), dates, release summary, owner, and link tasks/bugs/epics. Use listProducts to find productId.",
      CreateVersionSchema.shape,
      async (args) => {
        const result = await createVersion(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "listVersions",
      "List versions with status, version number, dates, owner, product, and linked item counts. Filter by status, productId, group (upcoming/released), or search text. Use this to discover version IDs.",
      ListVersionsSchema.shape,
      async (args) => {
        const result = await listVersions(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getVersion",
      "Get full version details by ID. Shows: status, version number, dates, owner, release summary, linked tasks (with status/type), linked epics (with status), fixed bugs (with status), and changelog content from Monday Doc.",
      GetVersionSchema.shape,
      async (args) => {
        const result = await getVersion(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "generateChangelog",
      "Generate a public changelog for a version. A task is only included when ALL THREE conditions hold: (1) publicTaskName is set, (2) linked to an epic, (3) assigned to a sprint. Tasks missing any are skipped; the response reports the count and per-task reasons. Bugs are always included as Fix. Tasks are categorized by type (Development→Feature, Bugfix→Fix, Maintenance/Refine/Documentation/PM-work→Improvement). Writes the canonical 3-cat JSON to the version's release summary AND creates/overwrites a Monday Doc with the human-readable changelog. Optional: highlights, breakingChanges, knownIssues arrays for additional sections.",
      GenerateChangelogSchema.shape,
      async (args) => {
        const result = await generateChangelog(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Communication Phase
    // =========================================================================

    server.tool(
      "getUpdates",
      "Get updates (comments/discussion) on a Monday.com item. Returns updates with author, timestamp, content, and threaded replies. Newest updates first. Use to read context, progress notes, or discussion before starting work on a task.",
      GetUpdatesSchema.shape,
      async (args) => {
        const result = await getUpdates(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "createUpdate",
      "Post an update (comment) on a Monday.com item. Use to share progress, blockers, completion notes, or ask questions. Supports HTML formatting. Set parentUpdateId to reply to an existing update thread.",
      CreateUpdateSchema.shape,
      async (args) => {
        const result = await createUpdate(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Epic Management
    // =========================================================================

    server.tool(
      "createEpic",
      "Create a new epic on the Epics board. Set name (required), status (default: Backlog), priority, description, owner, deadline, timeline (start+end), and link to product/version. Use listProducts to find productId.",
      CreateEpicSchema.shape,
      async (args) => {
        const result = await createEpic(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "updateEpic",
      "Update any epic field. Supports: name, status, priority, description, owner, deadline, timeline (start+end), product, version. Set delete=true to delete. Use listEpics to find the epicId.",
      UpdateEpicSchema.shape,
      async (args) => {
        const result = await updateEpic(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Feedback & Requests
    // =========================================================================

    server.tool(
      "listFeedback",
      "List requests and feedback items. Filter by type (Request/Feedback), status (New/Under Review/Accepted/Declined/Converted/Done), priority, source (User/Internal/Support/Partner), productId, or search text. Returns: name, type, status, priority, source, reporter, product, and connected task count.",
      ListFeedbackSchema.shape,
      async (args) => {
        const result = await listFeedback(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getFeedback",
      "Get full details of a feedback/request item by ID. Shows: type, status, priority, source, reporter, product, description, and connected tasks (resolved with status/type/priority). Use listFeedback first to discover item IDs.",
      GetFeedbackSchema.shape,
      async (args) => {
        const result = await getFeedback(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "createFeedback",
      "Create a new request or feedback item. Required: name, type (Request/Feedback). Optional: description, priority (Critical/High/Medium/Low), source (User/Internal/Support/Partner), productId, reporter (person ID). Items start with status 'New' in the Incoming group.",
      CreateFeedbackSchema.shape,
      async (args) => {
        const result = await createFeedback(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "updateFeedback",
      "Update any feedback/request field. Supports: name, status (New/Under Review/Accepted/Declined/Converted/Done), type (Request/Feedback), priority, source, description, productId. Set delete=true to delete. Use listFeedback to find the feedbackId.",
      UpdateFeedbackSchema.shape,
      async (args) => {
        const result = await updateFeedback(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "convertFeedbackToTask",
      "Convert a feedback/request item into a task. Copies name, priority, and description from the feedback item. Auto-infers task type from feedback type (Request→Development, Feedback→Maintenance) unless overridden. If no epicId specified, auto-assigns the product's maintenance epic (if one exists). Links the new task back to the feedback item via two-way relation and sets feedback status to 'Converted'. Optionally assign to epic/sprint or add extra description.",
      ConvertFeedbackToTaskSchema.shape,
      async (args) => {
        const result = await convertFeedbackToTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Retrospectives
    // =========================================================================

    server.tool(
      "createRetro",
      "Create a retrospective item on the Retrospectives board. Required: name, type ('Discussion' | 'Keep' | 'Improve'). Optional: description (long_text — reasoning, examples, links, next steps), repeating (carries over between sprints), submitter / owner person IDs. File retros first-class instead of dropping into raw mcp__monday__create_item.",
      CreateRetroSchema.shape,
      async (args) => {
        const result = await createRetro(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "listRetros",
      "List retro items from the Retrospectives board. Filters: type (Discussion / Keep / Improve), repeating (true/false), search text. Use this to dedupe before filing a new retro. Returns name, type, repeating flag, submitter, owner, and vote count.",
      ListRetrosSchema.shape,
      async (args) => {
        const result = await listRetros(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "setPublicTaskName",
      "Set the public-facing name of a task. This is ONE of three requirements for public exposure — a task appears on the public roadmap and in changelogs only when ALL of these hold: (1) public name is non-empty, (2) task is linked to an epic, (3) task is assigned to a sprint. If any are missing, the task stays private. Setting an empty string clears the public name and forces the task private regardless of epic/sprint.",
      SetPublicTaskNameSchema.shape,
      async (args) => {
        const result = await setPublicTaskName(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getPublicRoadmap",
      "Get a public-facing roadmap for a product as Epic → Sprint → Task markdown. A task only appears when ALL THREE conditions hold: (1) publicTaskName is set, (2) it's linked to an epic, (3) it's assigned to a sprint. Tasks missing any of these are private and excluded. Required: product ('STEPhie' or 'PolAds'). Optional: onlyInProgress to limit to in-progress epics.",
      GetPublicRoadmapSchema.shape,
      async (args) => {
        const result = await getPublicRoadmap(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "getStructuredChangelog",
      "Read the structured changelog for a version as JSON. Canonical 3-cat shape: { version, summary?, highlights?, breakingChanges?, knownIssues?, tasks: { Feature, Fix, Improvement } }. Auto-migrates legacy shapes. Stored in the version's release summary column.",
      GetStructuredChangelogSchema.shape,
      async (args) => {
        const result = await getStructuredChangelog(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "updateStructuredChangelog",
      "Apply patch operations to the structured changelog. Ops: addTask (by taskId — auto-categorizes from task type AND requires the task to be public, i.e. publicTaskName set + linked epic + assigned sprint; refuses with reasons if private — or manual {name, category} which bypasses the gate), removeTask (by taskId, or manual {name, category}), setSummary, setHighlights, setBreakingChanges, setKnownIssues. Read-modify-write happens server-side; callers do not need to fetch first. To clear a list field, pass an empty array (e.g. setHighlights with items: []).",
      UpdateStructuredChangelogSchema.shape,
      async (args) => {
        const result = await updateStructuredChangelog(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "migrateStructuredChangelog",
      "Pure migration helper. Takes raw JSON or marker-wrapped text and returns the canonical 3-cat shape. Useful for migrating data from external sources without touching Monday.",
      MigrateStructuredChangelogSchema.shape,
      async (args) => {
        const result = await migrateStructuredChangelog(args);
        return { content: [{ type: "text", text: result }] };
      }
    );
  },
  {
    serverInfo: {
      name: "dev-tasks",
      version: "1.0.0",
    },
  },
  {
    basePath: "/api",
    maxDuration: 60,
  }
);

export { handler as GET, handler as POST, handler as DELETE };
