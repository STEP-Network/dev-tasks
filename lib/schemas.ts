import { z } from "zod";

// =============================================================================
// Shared Enums
// =============================================================================

const TaskStatusEnum = z.enum([
  "Backlog", "Ready to Start", "In Progress", "Waiting for Review",
  "Pending Deploy", "Done", "Stuck", "Move to Sprints",
]);

const TaskPriorityEnum = z.enum([
  "Critical", "High", "Medium", "Low", "Best Effort", "Missing",
]);

const TaskTypeEnum = z.enum([
  "Development", "Bugfix", "Maintenance", "Refine", "Documentation", "PM-work",
]);

const SubtaskStatusEnum = z.enum([
  "Stuck", "Working on it", "Done", "Ready to start",
  "Waiting for review", "Pending Deploy", "Backlog",
]);

const SubtaskTypeEnum = z.enum([
  "Test", "Documentation", "UX-UI", "Database", "Backend", "PM-work",
]);

const BugStatusEnum = z.enum([
  "Awaiting Review", "Ready for Dev", "Fixing", "Fixed",
  "Missing Info", "Move to Sprints", "Known Bug", "Pending Deploy", "Duplicated",
]);

const BugPriorityEnum = z.enum([
  "Critical", "High", "Medium", "Low",
]);

const AgentIdEnum = z.enum([
  "Claude Code CLI", "Claude Desktop Cloud", "Codex Local", "Claude Desktop Local", "Codex Cloud",
]);

const SystemUserEnum = z.enum(["naref", "krmoj"]);

const EpicStatusEnum = z.enum([
  "Refining", "Done", "On Hold", "Planned", "Backlog", "In Progress", "Review",
]);

const EpicPriorityEnum = z.enum([
  "Critical", "High", "Medium", "Low", "Minimal", "Not Prioritized",
]);

// =============================================================================
// Tool 1: getBacklog
// =============================================================================

export const GetBacklogSchema = z.object({
  status: TaskStatusEnum.optional().describe("Filter by specific status. Defaults to showing Backlog + Ready to Start tasks"),
  type: TaskTypeEnum.optional().describe("Filter by task type"),
  unclaimedOnly: z.boolean().optional().default(false).describe("Only show tasks with no Agent ID set (available for claiming)"),
  agentId: AgentIdEnum.optional().describe("Filter by agent currently working on the task"),
  epicId: z.number().optional().describe("Filter by epic — use listEpics to find the ID"),
  sprintId: z.number().optional().describe("Filter by sprint — use getSprint() to find the ID"),
  productId: z.number().optional().describe("Filter by product — use listProducts to find the ID. Resolves product → epics → tasks"),
  limit: z.number().optional().default(25).describe("Max tasks to return (default: 25)"),
});

// =============================================================================
// Tool 2: getBugs
// =============================================================================

export const GetBugsSchema = z.object({
  status: BugStatusEnum.optional().describe("Filter by bug status"),
  priority: BugPriorityEnum.optional().describe("Filter by bug priority"),
  productId: z.number().optional().describe("Filter by product — use listProducts to find the ID"),
  search: z.string().optional().describe("Search text in bug name and description"),
  limit: z.number().optional().default(25).describe("Max bugs to return (default: 25)"),
});

// =============================================================================
// Tool 3: getTask
// =============================================================================

export const GetTaskSchema = z.object({
  itemId: z.number().describe("Monday.com task item ID"),
});

// =============================================================================
// Tool 4: getSprint
// =============================================================================

export const GetSprintSchema = z.object({
  sprintId: z.number().optional().describe("Specific sprint ID. If omitted, returns the active sprint"),
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
  status: EpicStatusEnum.optional().describe("Filter by epic status (e.g. 'In Progress', 'Planned')"),
  search: z.string().optional().describe("Search text in epic name"),
  limit: z.number().optional().default(25).describe("Max epics to return (default: 25)"),
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
  owner: SystemUserEnum.describe("Your system username (e.g. the output of `whoami`)"),
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
  estimatedHours: z.number().optional().describe("Estimated hours"),
  actualHours: z.number().optional().describe("Actual hours spent"),
  dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
  startedDate: z.string().optional().describe("Started date (YYYY-MM-DD)"),
  epicId: z.number().optional().describe("Link to epic — use listEpics to find the ID"),
  sprintId: z.number().optional().describe("Link to sprint — use getSprint() to find the ID"),
  versionId: z.number().optional().describe("Link to target version"),
  githubLink: z.string().optional().describe("GitHub branch/repo URL"),
  prLink: z.string().optional().describe("Pull request URL"),
  demoUrl: z.string().optional().describe("Demo/preview URL"),
  agentId: AgentIdEnum.optional().describe("Agent working on this task"),
  planId: z.string().optional().describe("Today's date + plan file name (format: YYYY-MM-DD_plan-name, e.g. 2026-02-18_enumerated-scribbling-rose). Found in ~/.claude/plans/"),
  unplanned: z.boolean().optional().describe("Mark as unplanned (added mid-sprint)"),
  branch: z.string().optional().describe("Git branch name"),
  acceptanceCriteria: z.string().optional().describe("Machine-readable acceptance criteria"),
  dependencyIds: z.array(z.number()).optional().describe("Task IDs this task depends on (blocked by)"),
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
    status: TaskStatusEnum.optional().describe("Initial status (default: Backlog)"),
    description: z.string().optional().describe("Task description"),
    estimatedHours: z.number().optional().describe("Estimated hours"),
    dueDate: z.string().optional().describe("Due date (YYYY-MM-DD)"),
    epicId: z.number().optional().describe("Link to epic — use listEpics to find the ID"),
    sprintId: z.number().optional().describe("Link to sprint — use getSprint() to find the ID"),
    versionId: z.number().optional().describe("Link to target version"),
    agentId: AgentIdEnum.optional().describe("Agent creating this task"),
    planId: z.string().optional().describe("Today's date + plan file name (format: YYYY-MM-DD_plan-name, e.g. 2026-02-18_enumerated-scribbling-rose). Found in ~/.claude/plans/"),
    unplanned: z.boolean().optional().describe("Mark as unplanned mid-sprint addition"),
    acceptanceCriteria: z.string().optional().describe("Machine-readable acceptance criteria (definition of done)"),
    dependencyIds: z.array(z.number()).optional().describe("Task IDs this task depends on (blocked by)"),
    branch: z.string().optional().describe("Git branch name"),
    owner: SystemUserEnum.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
    subitems: z.array(SubitemSpec).optional().describe("Subtasks to create with the task"),
  })).describe("Array of tasks to create"),
});

// =============================================================================
// Tool 10: convertBugToTask
// =============================================================================

export const ConvertBugToTaskSchema = z.object({
  bugId: z.number().describe("Bug item ID — use getBugs to find the ID"),
  epicId: z.number().optional().describe("Epic to link the new task to — use listEpics to find the ID"),
  sprintId: z.number().optional().describe("Sprint to assign the new task to — use getSprint() to find the ID"),
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
  reporter: z.number().optional().describe("Reporter person ID"),
});

// =============================================================================
// Tool 12: updateVersion
// =============================================================================

export const UpdateVersionSchema = z.object({
  versionId: z.number().describe("Version item ID to update"),
  status: z.enum(["Planned", "In Development", "Release Candidate", "Hotfix"]).optional()
    .describe("New status (cannot set to Released — requires human approval)"),
  releaseSummary: z.string().optional().describe("Release summary text"),
  linkTaskIds: z.array(z.number()).optional().describe("Task IDs to link to this version"),
  linkBugIds: z.array(z.number()).optional().describe("Bug IDs to link as fixed in this version"),
  linkEpicIds: z.array(z.number()).optional().describe("Epic IDs to link to this version"),
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
  body: z.string().describe("Update text content (supports HTML formatting)"),
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
  owner: SystemUserEnum.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
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
  owner: SystemUserEnum.optional().describe("Owner — use your system username (e.g. the output of `whoami`)"),
  deadline: z.string().optional().describe("Deadline date (YYYY-MM-DD)"),
  timelineStart: z.string().optional().describe("Timeline start date (YYYY-MM-DD) — must provide both start and end"),
  timelineEnd: z.string().optional().describe("Timeline end date (YYYY-MM-DD) — must provide both start and end"),
  productId: z.number().optional().describe("Link to product — use listProducts to find the ID"),
  versionId: z.number().optional().describe("Link to target version"),
});

// =============================================================================
// Type Exports
// =============================================================================

export type GetBacklogInput = z.input<typeof GetBacklogSchema>;
export type GetBugsInput = z.input<typeof GetBugsSchema>;
export type GetTaskInput = z.infer<typeof GetTaskSchema>;
export type GetSprintInput = z.infer<typeof GetSprintSchema>;
export type GetEpicInput = z.infer<typeof GetEpicSchema>;
export type ListEpicsInput = z.input<typeof ListEpicsSchema>;
export type ListProductsInput = z.infer<typeof ListProductsSchema>;
export type ClaimTaskInput = z.infer<typeof ClaimTaskSchema>;
export type UpdateTaskInput = z.infer<typeof UpdateTaskSchema>;
export type ManageSubtasksInput = z.infer<typeof ManageSubtasksSchema>;
export type CreateTaskInput = z.infer<typeof CreateTaskSchema>;
export type ConvertBugToTaskInput = z.infer<typeof ConvertBugToTaskSchema>;
export type CreateBugInput = z.infer<typeof CreateBugSchema>;
export type UpdateVersionInput = z.infer<typeof UpdateVersionSchema>;
export type GetUpdatesInput = z.input<typeof GetUpdatesSchema>;
export type CreateUpdateInput = z.infer<typeof CreateUpdateSchema>;
export type CreateEpicInput = z.infer<typeof CreateEpicSchema>;
export type UpdateEpicInput = z.infer<typeof UpdateEpicSchema>;
