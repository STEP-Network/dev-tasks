import { z } from "zod";

// =============================================================================
// Shared Enums
// =============================================================================

// Workflow: Needs Refinement → Ready to Start → In Progress → Waiting for UAT
//           → Pending Deploy to Prod → Done.
// Off-ramps: Stuck (unresolved blocker; recoverable) and Declined (superseded
// mid-sprint — terminal, no work shipped; excluded from getBacklog defaults).
const TaskStatusEnum = z.enum([
  "Needs Refinement", "Ready to Start", "In Progress",
  "Waiting for UAT", "Pending Deploy to Prod", "Done", "Stuck", "Declined",
]);

const TaskPriorityEnum = z.enum([
  "Critical", "High", "Medium", "Low", "Missing",
]);

const TaskTypeEnum = z.enum([
  "Feature", "Fix", "Improvement", "To Do", "Not Set",
]);

// Subtasks board (5091706366) does NOT have a "Ready to Start" label
// configured on its status column. Subtask lifecycle is binary in practice:
// refinement → working → done. Including "Ready to Start" in the schema
// caused the Monday GraphQL mutation to fail with a cryptic
// ColumnValueException at write time. Drop it from the contract.
const SubtaskStatusEnum = z.enum([
  "Needs Refinement", "In Progress", "Done", "Stuck",
]);

const SubtaskTypeEnum = z.enum([
  "To Do", "Database", "Backend", "Documentation", "Test", "UX-UI",
]);

// Bug board workflow (Option C — intake-only as of v0.12.0):
//   Awaiting Review (default) → Triaged → (one of: Converted to Task | Declined |
//                                          Cannot Reproduce | Duplicated | Missing Info | Known Bug)
// Once a bug is `Converted to Task`, ALL dev work happens on the linked Task
// (with type: Fix). The Bug becomes a terminal breadcrumb at that point.
//
// `Ready for Dev`, `Fixing`, `Fixed`, `Pending Deploy`, `Move to Sprints` are
// DEPRECATED (kept for backwards-compat reading legacy items, but new writes
// should use the intake-only set). The plugin's tools still accept them so
// existing items remain editable.
const BugStatusEnum = z.enum([
  "Awaiting Review", "Triaged", "Converted to Task", "Declined", "Cannot Reproduce",
  "Missing Info", "Known Bug", "Duplicated",
  // Deprecated (legacy) — kept for backwards compat on existing items:
  "Ready for Dev", "Fixing", "Fixed", "Pending Deploy", "Move to Sprints",
]);

const BugPriorityEnum = z.enum([
  "Critical", "High", "Medium", "Low",
]);

const AgentIdEnum = z.enum([
  "Claude Code CLI", "Claude Desktop Cloud", "Codex Local", "Claude Desktop Local", "Codex Cloud",
]);

// Per-task CI-gate policy (CI Gate column, v0.26.0). "Skip (human)" is
// human-set on the board; agents may only write "Skip (agent)" (after
// ci-skip-eval.sh ELIGIBLE) or revert to "Full". Skip removes the CI wait
// + optional e2e gates — a RED check still blocks merge.
const CiGateEnum = z.enum([
  "Full", "Skip (human)", "Skip (agent)",
]);

// `owner` accepts any whoami-style username (or numeric Monday person ID).
// Resolved at call time by services/people.ts against the Monday *People board.
const SystemUserSchema = z.string().min(1);

const EpicStatusEnum = z.enum([
  "Refining", "Done", "On Hold", "Planned", "Backlog", "In Progress", "Review",
]);

const EpicPriorityEnum = z.enum([
  "Critical", "High", "Medium", "Low", "Minimal", "Not Prioritized",
]);

const VersionStatusEnum = z.enum([
  "Planned", "In Development", "Release Candidate", "Released", "Hotfix",
]);

const VersionStatusCreateEnum = z.enum([
  "Planned", "In Development", "Release Candidate", "Hotfix",
]);

const FeedbackStatusEnum = z.enum([
  "New", "Under Review", "Accepted", "Declined", "Converted", "Done",
]);

const FeedbackTypeEnum = z.enum(["Request", "Feedback"]);

const FeedbackPriorityEnum = z.enum(["Critical", "High", "Medium", "Low"]);

const FeedbackSourceEnum = z.enum(["User", "Internal", "Support", "Partner"]);

const RetroTypeEnum = z.enum(["Discussion", "Keep", "Improve"]);

// Retro workflow status (added in v0.12.0).
// New (default, just filed) → Accepted (team agreed; owner assigned) →
// Implemented (PR merged; Resolved In Version + Implemented By populated) →
// Validated (improvement verified to actually help).
// Off-ramp: Declined (terminal — won't action).
const RetroStatusEnum = z.enum([
  "New", "Accepted", "Implemented", "Validated", "Declined",
]);

// `productId` is the Monday Products-board item ID. Accept either a number or
// a numeric string (project-config stores it as a string for JSON readability).
// Regex `^[1-9]\d*$` rejects "0" and leading zeros — both invalid as item IDs.
const ProductIdSchema = z.union([
  z.number().int().positive(),
  z.string().regex(/^[1-9]\d*$/).transform(Number),
]);

// Shared `format` enum for read tools that support both markdown (default,
// LLM-friendly) and JSON (UI-friendly) outputs.
const FormatEnum = z.enum(["markdown", "json"]);

// =============================================================================
// Tool 1: getBacklog
// =============================================================================

export const GetBacklogSchema = z.object({
  statuses: z.array(TaskStatusEnum).optional().describe("Filter to one or more statuses (any_of). Default: Needs Refinement + Ready to Start — the tasks not yet in flight. In Progress, Waiting for UAT, Pending Deploy to Prod, Done, Stuck, and Declined are excluded from the default; pass them explicitly to surface them."),
  types: z.array(TaskTypeEnum).optional().describe("Filter to one or more task types (any_of). Server-side filter."),
  unclaimedOnly: z.boolean().optional().default(false).describe("Only show tasks with no Agent ID set (available for claiming)."),
  agentId: AgentIdEnum.optional().describe("Filter by agent currently working on the task."),
  epicIds: z.array(z.number()).optional().describe("Filter to one or more epic IDs (any_of). Use listEpics to discover IDs."),
  sprintIds: z.array(z.number()).optional().describe("Filter to one or more sprint IDs (any_of). Use listSprints to discover IDs."),
  productId: ProductIdSchema.optional().describe("Filter by product item ID (Monday Products-board item ID). Resolves product → epics → tasks server-side. Use listProducts to discover IDs."),
  query: z.string().optional().describe("Server-side text search on task name (case-insensitive contains)."),
  cursor: z.string().optional().describe("Pagination cursor. Pass nextCursor from a previous response (any format) to fetch the next page. Note: Monday inherits the original filter set with the cursor — additional filter args are ignored when paginating."),
  limit: z.number().optional().default(25).describe("Max tasks per page (default 25). Monday caps at 500 per page."),
  format: FormatEnum.optional().default("markdown").describe("Output format. 'json' returns { tasks, nextCursor, filters } — recommended for UIs and for paginating."),
});

// =============================================================================
// Tool 2: getBugs
// =============================================================================

export const GetBugsSchema = z.object({
  status: BugStatusEnum.optional().describe("Filter by bug status"),
  priority: BugPriorityEnum.optional().describe("Filter by bug priority"),
  productId: z.number().optional().describe("Filter by product — use listProducts to find the ID"),
  epicId: z.number().optional().describe("Filter by epic — use listEpics to find the ID"),
  search: z.string().optional().describe("Search text in bug name and description"),
  limit: z.number().optional().default(25).describe("Max bugs to return (default: 25)"),
});

// =============================================================================
// Tool 3: getTask
// =============================================================================

export const GetTaskSchema = z.object({
  itemId: z.number().describe("Monday.com task item ID"),
  format: FormatEnum.optional().default("markdown").describe("Output format. 'markdown' (default) is LLM-friendly; 'json' returns a structured response."),
});

// =============================================================================
// Tool 4: getSprint
// =============================================================================

export const GetSprintSchema = z.object({
  sprintId: z.number().optional().describe("Specific sprint ID. If omitted, returns the active sprint. Use listSprints to discover sprint IDs"),
  format: z.enum(["markdown", "json", "summary"]).optional().default("markdown").describe("Output format. 'markdown' (default) is LLM-friendly. 'json' returns the full structured response with every task. 'summary' returns a compact JSON `{id, name, active, completion, totalsByStatus, taskCount, estimatedHours, actualHours}` — no task list — for cheap active-sprint-id lookups when you don't need the full task array (the full version can exceed tool-result token limits)."),
});

// =============================================================================
// Tool 4b: listSprints
// =============================================================================

export const ListSprintsSchema = z.object({
  pastOnly: z.boolean().optional().default(false).describe("Show only past (ended) sprints — those whose end date is before today, sorted newest-ended first. Default: list active + upcoming sprints (end date today or later, plus sprints with no end date), sorted oldest-start-first so the current sprint comes before future ones."),
  activeOnly: z.boolean().optional().default(false).describe("Only return sprints with the activation checkbox set. Mutually exclusive with pastOnly."),
  includeStatusCounts: z.boolean().optional().default(true).describe("Include a per-status count line (NR/Ready/InP/UAT/PendingDeploy/Done/Stuck) and an Hours line (actual / estimated) per sprint. Default true — these are cheap and most callers need them for kanban-style summaries."),
  includeTasks: z.boolean().optional().default(false).describe("Expand each sprint with its full task list (name + status). Default false to keep the output compact; the per-status counts (see includeStatusCounts) usually answer what you need. Flip on for full per-task scanning."),
  format: FormatEnum.optional().default("markdown").describe("Output format. 'markdown' (default) is LLM-friendly; 'json' returns a structured response UIs can render without parsing markdown."),
});

// =============================================================================
// Tool 5: getEpic
// =============================================================================

export const GetEpicSchema = z.object({
  epicId: z.number().describe("Epic item ID — use listEpics to discover available epics"),
});

// =============================================================================
// Tool 5b: listEpics
// =============================================================================

export const ListEpicsSchema = z.object({
  productId: ProductIdSchema.describe("Product item ID (Monday Products-board item ID) to list epics for. Use listProducts to discover IDs."),
});

// =============================================================================
// Tool 5c: listProducts
// =============================================================================

export const ListProductsSchema = z.object({
  search: z.string().optional().describe("Search text in product name"),
});

// =============================================================================
// Tool 6: claimTask
// =============================================================================

export const ClaimTaskSchema = z.object({
  itemId: z.number().describe("Task ID to claim"),
  agentId: AgentIdEnum.describe("Your agent identity"),
  owner: SystemUserSchema.describe("Your system username (e.g. the output of `whoami`)"),
  planId: z.string().optional().describe("Today's date + plan file name (format: YYYY-MM-DD_plan-name, e.g. 2026-02-18_enumerated-scribbling-rose). Found in ~/.claude/plans/"),
});

// =============================================================================
// Tool 7: updateTask
// =============================================================================

export const UpdateTaskSchema = z.object({
  itemId: z.number().describe("Task ID to update"),
  delete: z.boolean().optional().describe("Set true to delete the task"),
  name: z.string().optional().describe("New task name"),
  status: TaskStatusEnum.optional().describe("New status"),
  type: TaskTypeEnum.optional().describe("New task type"),
  priority: TaskPriorityEnum.optional().describe("New priority"),
  description: z.string().optional().describe("Updated description"),
  dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
  startedDate: z.string().optional().describe("Started date (YYYY-MM-DD)"),
  epicId: z.number().optional().describe("Link to epic — use listEpics to find the ID"),
  sprintId: z.number().optional().describe("Link to sprint — use listSprints to discover the ID"),
  versionId: z.number().optional().describe("Link to target version"),
  githubLink: z.string().optional().describe("GitHub branch/repo URL"),
  prLink: z.string().optional().describe("Pull request URL"),
  demoUrl: z.string().optional().describe("Demo/preview URL"),
  agentId: AgentIdEnum.optional().describe("Agent working on this task"),
  planId: z.string().optional().describe("Today's date + plan file name (format: YYYY-MM-DD_plan-name, e.g. 2026-02-18_enumerated-scribbling-rose). Found in ~/.claude/plans/"),
  unplanned: z.boolean().optional().describe("Mark as unplanned (added mid-sprint)"),
  branch: z.string().optional().describe("Git branch name"),
  acceptanceCriteria: z.string().optional().describe("Machine-readable acceptance criteria"),
  dependencyIds: z.array(z.number()).optional().describe("Blocked-by relationships: task IDs that must be Done before this one can start. Stored in Monday's dependency_mm0pwbxn column. claimTask refuses to start a task whose dependencies aren't all Done. Pass an empty array [] to clear."),
  ciGate: CiGateEnum.optional().describe("Per-task CI-gate policy (CI Gate column). 'Full' = full gating (same as empty). 'Skip (human)' is reserved for humans setting it on the board. Agents may only write 'Skip (agent)' — and only after plugin/scripts/ci-skip-eval.sh prints ELIGIBLE for the current diff — or revert to 'Full'. Skip removes the CI wait + e2e gates; a RED check still blocks merge."),
});

// =============================================================================
// Tool 8: manageSubtasks
// =============================================================================

const SubtaskCreateInput = z.object({
  action: z.literal("create"),
  name: z.string().describe("Subtask name"),
  type: SubtaskTypeEnum.optional().describe("Subtask type"),
  status: SubtaskStatusEnum.optional().describe("Initial status"),
  description: z.string().optional().describe("Subtask description"),
  estimatedHours: z.number().optional().describe("Estimated hours"),
  date: z.string().optional().describe("Due date (YYYY-MM-DD)"),
  owner: z.number().optional().describe("Owner person ID"),
});

const SubtaskUpdateInput = z.object({
  action: z.literal("update"),
  subtaskId: z.string().optional().describe("Subtask ID (required unless using name lookup)"),
  subtaskName: z.string().optional().describe("Subtask name for lookup (use with parent context)"),
  name: z.string().optional().describe("Rename subtask"),
  type: SubtaskTypeEnum.optional().describe("New type"),
  status: SubtaskStatusEnum.optional().describe("New status"),
  description: z.string().optional().describe("Updated description"),
  estimatedHours: z.number().optional().describe("Updated estimated hours"),
  actualHours: z.number().optional().describe("Actual hours spent"),
  date: z.string().optional().describe("New due date"),
  owner: z.number().optional().describe("New owner person ID"),
});

const SubtaskDeleteInput = z.object({
  action: z.literal("delete"),
  subtaskId: z.string().optional().describe("Subtask ID (required unless using name lookup)"),
  subtaskName: z.string().optional().describe("Subtask name for lookup"),
});

export const ManageSubtasksSchema = z.object({
  parentItemId: z.number().describe("Parent task item ID"),
  operations: z.array(z.discriminatedUnion("action", [
    SubtaskCreateInput,
    SubtaskUpdateInput,
    SubtaskDeleteInput,
  ])).describe("Array of create/update/delete operations"),
});

// =============================================================================
// Tool 9: createTask
// =============================================================================

const SubitemSpec = z.object({
  name: z.string().describe("Subtask name"),
  type: SubtaskTypeEnum.optional().describe("Subtask type"),
  status: SubtaskStatusEnum.optional().describe("Initial status"),
  description: z.string().optional().describe("Description"),
  estimatedHours: z.number().optional().describe("Estimated hours"),
});

export const CreateTaskSchema = z.object({
  tasks: z.array(z.object({
    name: z.string().describe("Task name"),
    type: TaskTypeEnum.describe("Task type"),
    priority: TaskPriorityEnum.describe("Task priority"),
    status: TaskStatusEnum.optional().describe("Initial status (default: 'Needs Refinement'; pass 'Ready to Start' if the task is already specified and sprint-assigned)"),
    description: z.string().optional().describe("Task description"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    epicId: z.number().optional().describe("Link to epic — use listEpics to find the ID"),
    sprintId: z.number().optional().describe("Link to sprint — use listSprints to discover the ID"),
    versionId: z.number().optional().describe("Link to target version"),
    agentId: AgentIdEnum.optional().describe("Agent creating this task"),
    planId: z.string().optional().describe("Today's date + plan file name (format: YYYY-MM-DD_plan-name, e.g. 2026-02-18_enumerated-scribbling-rose). Found in ~/.claude/plans/"),
    unplanned: z.boolean().optional().describe("Mark as unplanned mid-sprint addition"),
    acceptanceCriteria: z.string().optional().describe("Machine-readable acceptance criteria (definition of done)"),
    dependencyIds: z.array(z.number()).optional().describe("Blocked-by relationships: task IDs that must be Done before this one can start. Stored in column dependency_mm0pwbxn."),
    branch: z.string().optional().describe("Git branch name"),
    owner: SystemUserSchema.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
    subitems: z.array(SubitemSpec).optional().describe("Subtasks to create with the task"),
    // NOTE: agentId is intentionally absent. Ownership transitions happen via claimTask
    // (atomic: validates status + sprint + dependencies, sets Agent ID + Owner + Started Date).
    // Setting agentId at create time pre-claimed the task and broke the claim flow.
  })).describe("Array of tasks to create"),
});

// =============================================================================
// Tool 10: convertBugToTask
// =============================================================================

export const ConvertBugToTaskSchema = z.object({
  bugId: z.number().describe("Bug item ID — use getBugs to find the ID"),
  epicId: z.number().optional().describe("Epic to link the new task to — use listEpics to find the ID"),
  sprintId: z.number().optional().describe("Sprint to assign the new task to — use listSprints to discover the ID"),
  agentId: AgentIdEnum.optional().describe("Agent performing the conversion"),
  planId: z.string().optional().describe("Today's date + plan file name (format: YYYY-MM-DD_plan-name, e.g. 2026-02-18_enumerated-scribbling-rose). Found in ~/.claude/plans/"),
  additionalDescription: z.string().optional().describe("Extra context to append to the bug description"),
});

// =============================================================================
// Tool 11: createBug
// =============================================================================

export const CreateBugSchema = z.object({
  name: z.string().describe("Bug title — include component, action, and symptom"),
  description: z.string().describe("Reproduction steps, expected vs actual behavior"),
  priority: BugPriorityEnum.describe("Bug severity"),
  productId: z.number().optional().describe("Product this bug affects — use listProducts to find the ID"),
  epicId: z.number().optional().describe("Epic to link the bug to — use listEpics to find the ID. If omitted and productId is set, auto-assigns the product's maintenance epic"),
  reporter: z.number().optional().describe("Reporter person ID"),
  filedByAgent: AgentIdEnum.optional().describe("Which agent filed this bug (omit for human-relayed). Sets the Filed By Agent dropdown. Source Tool is always set to 'agent' for MCP-filed bugs."),
});

// updateBug — Option C intake-workflow tool. Lets agents move bugs through
// the triage funnel without UI access: Awaiting Review → Triaged →
// (Converted to Task | Declined | Cannot Reproduce | Duplicated | Missing Info | Known Bug).
// Once `Converted to Task`, the linked Task tracks dev work (use
// convertBugToTask instead of setting status manually for that transition).
export const UpdateBugSchema = z.object({
  bugId: z.number().describe("Bug item ID to update — use getBugs to find it"),
  delete: z.boolean().optional().describe("Set true to delete the bug item (rare — prefer Declined/Cannot Reproduce/Duplicated)"),
  name: z.string().optional().describe("Rename the bug"),
  description: z.string().optional().describe("Updated reproduction steps / expected vs actual behavior"),
  status: BugStatusEnum.optional().describe("Workflow status. Intake-only flow: Awaiting Review → Triaged → (Converted to Task | Declined | Cannot Reproduce | Duplicated | Missing Info | Known Bug). Legacy values (Ready for Dev, Fixing, Fixed, Pending Deploy, Move to Sprints) accepted for backwards compat but should not be used for new writes."),
  priority: BugPriorityEnum.optional().describe("Bug severity"),
  productId: z.number().optional().describe("Product board relation — use listProducts to find the ID"),
  epicId: z.number().optional().describe("Epic board relation — use listEpics to find the ID"),
  fixedInVersionId: z.number().optional().describe("Versions board relation — set when the fix is included in a specific release"),
  filedByAgent: AgentIdEnum.optional().describe("Which agent filed this bug (empty for human-filed). Triage signal."),
});

// =============================================================================
// Tool 12: updateVersion
// =============================================================================

export const UpdateVersionSchema = z.object({
  versionId: z.number().describe("Version item ID to update"),
  delete: z.boolean().optional().describe("Set true to delete the version"),
  name: z.string().optional().describe("Rename the version"),
  status: VersionStatusEnum.optional()
    .describe("New status — setting to 'Released' requires confirmRelease=true"),
  confirmRelease: z.boolean().optional().describe("Required safety flag when setting status to 'Released'"),
  versionNumber: z.string().optional().describe("Version number (e.g. '1.2.0')"),
  expectedReleaseDate: z.string().optional().describe("Expected release date (YYYY-MM-DD)"),
  releaseDate: z.string().optional().describe("Actual release date (YYYY-MM-DD)"),
  releaseSummary: z.string().optional().describe("Release summary text"),
  owner: SystemUserSchema.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
  groupId: z.enum(["upcoming", "released"]).optional().describe("Move version to a group. Note: setting status='Released' auto-moves to the released group; pass groupId only when you want to override that or move without changing status."),
  linkTaskIds: z.array(z.number()).optional().describe("Task IDs to link to this version"),
  linkBugIds: z.array(z.number()).optional().describe("Bug IDs to link as fixed in this version"),
  linkEpicIds: z.array(z.number()).optional().describe("Epic IDs to link to this version"),
});

// =============================================================================
// Tool 19: createVersion
// =============================================================================

export const CreateVersionSchema = z.object({
  name: z.string().describe("Version name (e.g. 'v1.2.0')"),
  productId: z.number().describe("Product to link — use listProducts to find the ID"),
  versionNumber: z.string().optional().describe("Version number (e.g. '1.2.0')"),
  status: VersionStatusCreateEnum.optional().describe("Initial status (default: Planned). Cannot set to Released at creation"),
  expectedReleaseDate: z.string().optional().describe("Expected release date (YYYY-MM-DD)"),
  releaseDate: z.string().optional().describe("Actual release date (YYYY-MM-DD)"),
  releaseSummary: z.string().optional().describe("Release summary text"),
  owner: SystemUserSchema.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
  linkTaskIds: z.array(z.number()).optional().describe("Task IDs to link to this version"),
  linkBugIds: z.array(z.number()).optional().describe("Bug IDs to link as fixed in this version"),
  linkEpicIds: z.array(z.number()).optional().describe("Epic IDs to link to this version"),
});

// =============================================================================
// Tool 20: listVersions
// =============================================================================

export const ListVersionsSchema = z.object({
  status: VersionStatusEnum.optional().describe("Filter by version status"),
  productId: z.number().optional().describe("Filter by product — use listProducts to find the ID"),
  group: z.enum(["upcoming", "released"]).optional().describe("Filter by board group (upcoming or released)"),
  search: z.string().optional().describe("Search text in version name"),
  limit: z.number().optional().default(25).describe("Max versions to return (default: 25)"),
});

// =============================================================================
// Tool 21: getVersion
// =============================================================================

export const GetVersionSchema = z.object({
  versionId: z.number().describe("Version item ID — use listVersions to discover available versions"),
});

// =============================================================================
// Tool 38: getVersionTimeline
// =============================================================================

export const GetVersionTimelineSchema = z.object({
  productId: z.number().describe("Product item ID — use listProducts to find the ID"),
  statusFilter: z.enum(["all", "released", "open", "hotfix"]).optional().default("all")
    .describe("'released' = shipped versions only · 'open' = In Development + Release Candidate · 'hotfix' = Hotfix only · 'all' = everything (default)"),
  format: z.enum(["markdown", "json"]).optional().default("markdown")
    .describe("Output format. Markdown is the chronological human-readable timeline; JSON returns a structured array suitable for UIs."),
  expandTasks: z.boolean().optional().default(false)
    .describe("Include the full task list per version (Feature/Fix/Improvement). Default: counts only."),
  limit: z.number().optional().default(25)
    .describe("Max versions to return, sorted newest-first by semver (default: 25)."),
});

// =============================================================================
// Tool 22: generateChangelog
// =============================================================================

export const GenerateChangelogSchema = z.object({
  versionId: z.number().describe("Version item ID to generate changelog for"),
  highlights: z.array(z.string()).optional().describe("Key highlights to feature at the top of the changelog"),
  breakingChanges: z.array(z.string()).optional().describe("Breaking changes to include in the changelog"),
  knownIssues: z.array(z.string()).optional().describe("Known issues to include in the changelog"),
});

// =============================================================================
// Tool 15: getUpdates
// =============================================================================

export const GetUpdatesSchema = z.object({
  itemId: z.number().describe("Monday.com item ID to get updates for"),
  limit: z.number().optional().default(25).describe("Max updates to return (default: 25, max: 100)"),
  page: z.number().optional().default(1).describe("Page number for pagination (starts at 1)"),
});

// =============================================================================
// Tool 16: createUpdate
// =============================================================================

export const CreateUpdateSchema = z.object({
  itemId: z.number().describe("Monday.com item ID to add the update to"),
  body: z.string().describe("Update body as HTML. Monday Updates render HTML — markdown is stripped to plaintext, so use <p>, <strong>, <em>, <ul>/<li>, <a href>, <br>, <code>, <pre> instead of markdown syntax."),
  parentUpdateId: z.number().optional().describe("ID of an existing update to reply to (creates a threaded reply)"),
});

// =============================================================================
// Tool 17: createEpic
// =============================================================================

export const CreateEpicSchema = z.object({
  name: z.string().describe("Epic name"),
  status: EpicStatusEnum.optional().describe("Initial status (default: Backlog)"),
  priority: EpicPriorityEnum.optional().describe("Epic priority"),
  description: z.string().optional().describe("Epic description"),
  owner: SystemUserSchema.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
  deadline: z.string().optional().describe("Deadline date (YYYY-MM-DD)"),
  timelineStart: z.string().optional().describe("Timeline start date (YYYY-MM-DD) — must provide both start and end"),
  timelineEnd: z.string().optional().describe("Timeline end date (YYYY-MM-DD) — must provide both start and end"),
  productId: z.number().optional().describe("Link to product — use listProducts to find the ID"),
  versionId: z.number().optional().describe("Link to target version"),
});

// =============================================================================
// Tool 18: updateEpic
// =============================================================================

export const UpdateEpicSchema = z.object({
  epicId: z.number().describe("Epic item ID to update — use listEpics to find the ID"),
  delete: z.boolean().optional().describe("Set true to delete the epic"),
  name: z.string().optional().describe("New epic name"),
  status: EpicStatusEnum.optional().describe("New status"),
  priority: EpicPriorityEnum.optional().describe("New priority"),
  description: z.string().optional().describe("Updated description"),
  owner: SystemUserSchema.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
  deadline: z.string().optional().describe("Deadline date (YYYY-MM-DD)"),
  timelineStart: z.string().optional().describe("Timeline start date (YYYY-MM-DD) — must provide both start and end"),
  timelineEnd: z.string().optional().describe("Timeline end date (YYYY-MM-DD) — must provide both start and end"),
  productId: z.number().optional().describe("Link to product — use listProducts to find the ID"),
  versionId: z.number().optional().describe("Link to target version"),
});

// =============================================================================
// Tool 23: listFeedback
// =============================================================================

export const ListFeedbackSchema = z.object({
  type: FeedbackTypeEnum.optional().describe("Filter by type (Request or Feedback)"),
  status: FeedbackStatusEnum.optional().describe("Filter by status"),
  priority: FeedbackPriorityEnum.optional().describe("Filter by priority"),
  source: FeedbackSourceEnum.optional().describe("Filter by source"),
  productId: z.number().optional().describe("Filter by product — use listProducts to find the ID"),
  search: z.string().optional().describe("Search text in name and description"),
  limit: z.number().optional().default(25).describe("Max items to return (default: 25)"),
});

// =============================================================================
// Tool 24: getFeedback
// =============================================================================

export const GetFeedbackSchema = z.object({
  feedbackId: z.number().describe("Feedback/request item ID — use listFeedback to discover available items"),
});

// =============================================================================
// Tool 25: createFeedback
// =============================================================================

export const CreateFeedbackSchema = z.object({
  name: z.string().describe("Title — clearly describe the request or feedback"),
  type: FeedbackTypeEnum.describe("Item type: Request (feature/enhancement) or Feedback (observation/suggestion)"),
  description: z.string().optional().describe("Full details, context, and any relevant information"),
  priority: FeedbackPriorityEnum.optional().describe("Priority level"),
  source: FeedbackSourceEnum.optional().describe("Where this came from: User, Internal, Support, Partner"),
  productId: z.number().optional().describe("Product this relates to — use listProducts to find the ID"),
  reporter: z.number().optional().describe("Reporter person ID"),
});

// =============================================================================
// Tool 26: convertFeedbackToTask
// =============================================================================

export const UpdateFeedbackSchema = z.object({
  feedbackId: z.number().describe("Feedback/request item ID to update — use listFeedback to find the ID"),
  delete: z.boolean().optional().describe("Set true to delete the feedback item"),
  name: z.string().optional().describe("New title"),
  status: FeedbackStatusEnum.optional().describe("New status"),
  type: FeedbackTypeEnum.optional().describe("Change type (Request or Feedback)"),
  priority: FeedbackPriorityEnum.optional().describe("New priority"),
  source: FeedbackSourceEnum.optional().describe("Change source"),
  description: z.string().optional().describe("Updated description"),
  productId: z.number().optional().describe("Link to product — use listProducts to find the ID"),
});

export const ConvertFeedbackToTaskSchema = z.object({
  feedbackId: z.number().describe("Feedback/request item ID to convert — use listFeedback to find the ID"),
  epicId: z.number().optional().describe("Epic to link the new task to — use listEpics to find the ID"),
  sprintId: z.number().optional().describe("Sprint to assign the new task to — use listSprints to discover the ID"),
  taskType: TaskTypeEnum.optional().describe("Task type override (default: Feature for requests, Improvement for feedback)"),
  additionalDescription: z.string().optional().describe("Extra context to append to the description"),
});

// =============================================================================
// Tool 28: createRetro
// =============================================================================

export const CreateRetroSchema = z.object({
  name: z.string().describe("Retro item title — short, headline-style (e.g. 'Improve our bugs process')"),
  type: RetroTypeEnum.describe("Retro item type: Discussion (talk about it), Keep (working well), Improve (change this)"),
  description: z.string().optional().describe("Optional longer-form context — reasoning, examples, links, suggested next steps. Stored on the Description long_text column."),
  repeating: z.boolean().optional().describe("Mark as repeating (carries over between sprints) — flips the Repeating? checkbox"),
  submitter: z.number().optional().describe("Submitter person ID"),
  owner: z.number().optional().describe("Owner person ID"),
  sprintId: z.number().optional().describe("Sprint this retro was registered or implemented for — use listSprints to discover the ID"),
});

// =============================================================================
// Tool: updateRetro
// =============================================================================

export const UpdateRetroSchema = z.object({
  retroId: z.number().describe("Retro item ID to update — use listRetros to discover available items"),
  delete: z.boolean().optional().describe("Set true to delete the retro item"),
  name: z.string().optional().describe("New retro title"),
  type: RetroTypeEnum.optional().describe("New retro type (Discussion / Keep / Improve)"),
  status: RetroStatusEnum.optional().describe("Workflow status. New (default) → Accepted (team agreed) → Implemented (PR merged) → Validated. Off-ramp: Declined."),
  description: z.string().optional().describe("Updated longer-form context — reasoning, examples, links, suggested next steps"),
  repeating: z.boolean().optional().describe("Toggle the Repeating? checkbox"),
  submitter: z.number().optional().describe("Submitter person ID"),
  owner: z.number().optional().describe("Owner person ID — the human responsible for shepherding this retro to closure (set on Accepted)"),
  implementedBy: z.number().optional().describe("Person ID of who actually shipped the improvement (set alongside status: Implemented)"),
  sprintId: z.number().optional().describe("Sprint this retro was registered or implemented for — use listSprints to discover the ID"),
  resolvedInVersionId: z.number().optional().describe("Version item ID where the improvement shipped — use listVersions to discover. Set when status flips to Implemented."),
  filedByAgent: AgentIdEnum.optional().describe("Which agent filed this retro (empty for human-filed). Triage signal."),
});

// =============================================================================
// Tool 29: listRetros
// =============================================================================

export const ListRetrosSchema = z.object({
  sprintId: z.number().optional().describe("Filter to retros linked to this sprint — use listSprints to discover the ID"),
  activeSprint: z.boolean().optional().default(false).describe("Filter to retros linked to the currently active sprint (mutually exclusive with sprintId)"),
  search: z.string().optional().describe("Search text in name and description (case-insensitive)"),
  limit: z.number().optional().default(25).describe("Max items to return (default: 25)"),
});

// =============================================================================
// Tool 30: setPublicTaskName
// =============================================================================

export const SetPublicTaskNameSchema = z.object({
  taskId: z.number().describe("Task item ID"),
  name: z.string().describe("Public-facing task name. Sets the display string AND counts toward the public/private gate. A task is public ONLY when ALL three conditions hold: (1) public name is non-empty, (2) the task is linked to an epic, (3) the task is assigned to a sprint. Setting a public name alone is not enough if the task lacks an epic or sprint — link those via updateTask({ epicId, sprintId }) too. Pass '' to clear the public name and force the task private."),
});

// =============================================================================
// Tool 29: getPublicRoadmap
// =============================================================================

export const GetPublicRoadmapSchema = z.object({
  productId: ProductIdSchema.describe("Product item ID (Monday Products-board item ID) to fetch the roadmap for. Use listProducts to discover IDs."),
  onlyInProgress: z.boolean().optional().default(false).describe("Filter to epics with status 'In Progress' only"),
});

// =============================================================================
// Tool 30-32: Structured Changelog
// =============================================================================

const ChangelogCategoryEnum = z.enum(["Feature", "Fix", "Improvement"]);

export const GetStructuredChangelogSchema = z.object({
  versionId: z.number().describe("Version item ID"),
});

const AddTaskOp = z.object({
  op: z.literal("addTask"),
  taskId: z.number().optional().describe("Task ID to add — name and category are auto-derived from the task"),
  name: z.string().optional().describe("Manual entry name (use when there's no Monday task to reference)"),
  category: ChangelogCategoryEnum.optional().describe("Manual entry category (required if taskId is omitted)"),
});

const RemoveTaskOp = z.object({
  op: z.literal("removeTask"),
  taskId: z.number().optional().describe("Task ID — removes the task-linked entry with this id from all categories"),
  name: z.string().optional().describe("Manual entry name to remove (no taskId) — must be paired with category"),
  category: ChangelogCategoryEnum.optional().describe("Category to remove the manual entry from (required when using name)"),
});

const SetSummaryOp = z.object({
  op: z.literal("setSummary"),
  text: z.string(),
});

const SetHighlightsOp = z.object({
  op: z.literal("setHighlights"),
  items: z.array(z.string()),
});

const SetBreakingChangesOp = z.object({
  op: z.literal("setBreakingChanges"),
  items: z.array(z.string()),
});

const SetKnownIssuesOp = z.object({
  op: z.literal("setKnownIssues"),
  items: z.array(z.string()),
});

export const UpdateStructuredChangelogSchema = z.object({
  versionId: z.number().describe("Version item ID"),
  patch: z.array(z.union([AddTaskOp, RemoveTaskOp, SetSummaryOp, SetHighlightsOp, SetBreakingChangesOp, SetKnownIssuesOp]))
    .describe("Patch operations applied in order. Read-modify-write is atomic for the caller."),
});

export const MigrateStructuredChangelogSchema = z.object({
  json: z.string().describe("Raw JSON or marker-wrapped text. Returns the canonical 3-cat shape."),
});

// =============================================================================
// UAT Doc tools (column doc_mm3adfdg on Tasks board)
// =============================================================================

export const GetTaskUatDocSchema = z.object({
  taskId: z.number().describe("Task item ID"),
});

export const CreateTaskUatDocSchema = z.object({
  taskId: z.number().describe("Task item ID — must not already have a UAT doc; use updateTaskUatDoc to modify an existing one"),
  markdown: z.string().describe("Markdown content for the UAT testing doc (what the user should test, steps, expected results)"),
});

export const UpdateTaskUatDocSchema = z.object({
  taskId: z.number().describe("Task item ID — must already have a UAT doc; use createTaskUatDoc otherwise"),
  markdown: z.string().describe("Markdown content"),
  overwrite: z.boolean().optional().default(true).describe("true (default) replaces the doc; false appends to existing content"),
});

// =============================================================================
// Visual Changes Doc tool (column doc_mm4jkk92 on Tasks board, v0.33.0)
// =============================================================================

export const AppendTaskVisualSnapshotsSchema = z.object({
  taskId: z.number().describe("Task item ID whose 'Visual Changes' doc to append to (the doc is created on first use)."),
  phase: z
    .enum(["before", "after"])
    .describe("'before' = staging pre-change (captured pre-merge); 'after' = staging post-deploy (captured once the change is live). Each call appends a new pass-grouped section — it never drains existing blocks, so before + after accumulate."),
  environmentLabel: z.string().optional().describe("Environment name shown in the section heading. Defaults to 'staging'."),
  capturedAt: z.string().optional().describe("ISO date (YYYY-MM-DD) shown in the heading. Defaults to today."),
  captures: z
    .array(
      z.object({
        route: z.string().describe("Route path or screen label, e.g. '/dashboard'."),
        label: z.string().optional().describe("Override the displayed label (defaults to route)."),
        viewport: z.enum(["desktop", "mobile"]).optional().describe("Viewport the screenshot was taken at."),
        imagePath: z
          .string()
          .optional()
          .describe("Absolute local path to the screenshot image (png/jpg/jpeg/webp/gif). Omit for a note-only entry, e.g. a new route with no 'before' state."),
        note: z
          .string()
          .optional()
          .describe("Italic note shown under the label, e.g. 'no before state — new route' or 'skipped — auth required, no persona'."),
      }),
    )
    .min(1)
    .max(24)
    .describe("Per-route captures to append, in display order. Cap of 24 keeps the doc readable; the /ship-pr skill enforces maxRoutes upstream."),
});

// =============================================================================
// Description Doc tools (column doc_mm3sg1kr on Tasks board)
// =============================================================================

export const GetTaskDescriptionDocSchema = z.object({
  taskId: z.number().describe("Task item ID"),
});

export const CreateTaskDescriptionDocSchema = z.object({
  taskId: z.number().describe("Task item ID — must not already have a description doc; use updateTaskDescriptionDoc to modify an existing one"),
  markdown: z.string().describe("Markdown content for the task description (replaces the legacy long_text description column which capped at 2000 chars)"),
});

export const UpdateTaskDescriptionDocSchema = z.object({
  taskId: z.number().describe("Task item ID — must already have a description doc; use createTaskDescriptionDoc otherwise"),
  markdown: z.string().describe("Markdown content"),
  overwrite: z.boolean().optional().default(true).describe("true (default) replaces the doc; false appends to existing content"),
});

// =============================================================================
// Type Exports
// =============================================================================

export type GetBacklogInput = z.input<typeof GetBacklogSchema>;
export type GetBugsInput = z.input<typeof GetBugsSchema>;
export type GetTaskInput = z.input<typeof GetTaskSchema>;
export type GetSprintInput = z.input<typeof GetSprintSchema>;
export type ListSprintsInput = z.input<typeof ListSprintsSchema>;
export type GetEpicInput = z.infer<typeof GetEpicSchema>;
export type ListEpicsInput = z.input<typeof ListEpicsSchema>;
export type ListProductsInput = z.infer<typeof ListProductsSchema>;
export type ClaimTaskInput = z.infer<typeof ClaimTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type ManageSubtasksInput = z.infer<typeof ManageSubtasksSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type ConvertBugToTaskInput = z.infer<typeof ConvertBugToTaskSchema>;
export type CreateBugInput = z.infer<typeof CreateBugSchema>;
export type UpdateBugInput = z.infer<typeof UpdateBugSchema>;
export type UpdateVersionInput = z.infer<typeof UpdateVersionSchema>;
export type CreateVersionInput = z.infer<typeof CreateVersionSchema>;
export type ListVersionsInput = z.input<typeof ListVersionsSchema>;
export type GetVersionInput = z.infer<typeof GetVersionSchema>;
export type GetVersionTimelineInput = z.infer<typeof GetVersionTimelineSchema>;
export type GenerateChangelogInput = z.infer<typeof GenerateChangelogSchema>;
export type GetUpdatesInput = z.input<typeof GetUpdatesSchema>;
export type CreateUpdateInput = z.infer<typeof CreateUpdateSchema>;
export type CreateEpicInput = z.infer<typeof CreateEpicSchema>;
export type UpdateEpicInput = z.infer<typeof UpdateEpicSchema>;
export type ListFeedbackInput = z.input<typeof ListFeedbackSchema>;
export type GetFeedbackInput = z.infer<typeof GetFeedbackSchema>;
export type CreateFeedbackInput = z.infer<typeof CreateFeedbackSchema>;
export type UpdateFeedbackInput = z.infer<typeof UpdateFeedbackSchema>;
export type ConvertFeedbackToTaskInput = z.infer<typeof ConvertFeedbackToTaskSchema>;
export type CreateRetroInput = z.infer<typeof CreateRetroSchema>;
export type UpdateRetroInput = z.infer<typeof UpdateRetroSchema>;
export type ListRetrosInput = z.input<typeof ListRetrosSchema>;
export type SetPublicTaskNameInput = z.infer<typeof SetPublicTaskNameSchema>;
export type GetPublicRoadmapInput = z.input<typeof GetPublicRoadmapSchema>;
export type GetStructuredChangelogInput = z.infer<typeof GetStructuredChangelogSchema>;
export type UpdateStructuredChangelogInput = z.infer<typeof UpdateStructuredChangelogSchema>;
export type MigrateStructuredChangelogInput = z.infer<typeof MigrateStructuredChangelogSchema>;
export type GetTaskUatDocInput = z.infer<typeof GetTaskUatDocSchema>;
export type CreateTaskUatDocInput = z.infer<typeof CreateTaskUatDocSchema>;
export type UpdateTaskUatDocInput = z.input<typeof UpdateTaskUatDocSchema>;
export type AppendTaskVisualSnapshotsInput = z.infer<typeof AppendTaskVisualSnapshotsSchema>;
export type GetTaskDescriptionDocInput = z.infer<typeof GetTaskDescriptionDocSchema>;
export type CreateTaskDescriptionDocInput = z.infer<typeof CreateTaskDescriptionDocSchema>;
export type UpdateTaskDescriptionDocInput = z.input<typeof UpdateTaskDescriptionDocSchema>;
