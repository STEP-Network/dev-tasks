import { createMcpHandler } from "mcp-handler";
import {
  GetBacklogSchema,
  GetBugsSchema,
  GetTaskSchema,
  GetSprintSchema,
  GetEpicSchema,
  ClaimTaskSchema,
  UpdateTaskSchema,
  ManageSubtasksSchema,
  CreateTaskSchema,
  ConvertBugToTaskSchema,
  CreateBugSchema,
  UpdateVersionSchema,
} from "@/lib/schemas";
import {
  getBacklog,
  getBugs,
  getTask,
  getSprint,
  getEpic,
  claimTask,
  updateTask,
  manageSubtasks,
  createTask,
  convertBugToTask,
  createBug,
  updateVersion,
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
      "Get bugs from the Bugs Queue. Returns bugs with status, priority, description, and linked tasks. Filters: status, priority, productId, search text.",
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
      "Get epic details. Shows: description, PRD reference, linked tasks with progress breakdown, target version, product, timeline, and deadline.",
      GetEpicSchema.shape,
      async (args) => {
        const result = await getEpic(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    // =========================================================================
    // Execution Phase
    // =========================================================================

    server.tool(
      "claimTask",
      "Atomically claim a task for your agent. Validates: task must be 'Backlog' or 'Ready to Start', must not be claimed by another agent, and all dependencies must be resolved (Done). On success: sets status to 'In Progress', records your Agent ID, Plan ID, and started date. Returns error with current owner if already claimed.",
      ClaimTaskSchema.shape,
      async (args) => {
        const result = await claimTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "updateTask",
      "Update any task field. Supports: status, priority, type, description, hours (estimated/actual), links (GitHub/PR/Demo), epic, sprint, version, agent metadata, branch name, acceptance criteria, dependencies. Set delete=true to delete. Note: setting status to 'Done' requires all subtasks to be Done first.",
      UpdateTaskSchema.shape,
      async (args) => {
        const result = await updateTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "manageSubtasks",
      "Create, update, and delete subtasks in a single call. Each operation specifies action='create'|'update'|'delete'. Supports typed subtasks (Backend, Test, Documentation, UX-UI, Database, PM-work), status tracking, hours, and name-based lookup for updates/deletes.",
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
      "IMPORTANT: Use getBacklog first to check for existing similar tasks. Create one or more tasks with optional subtasks, epic/sprint linkage, and agent metadata. For discovered tech debt, follow-up work, or breaking down larger tasks.",
      CreateTaskSchema.shape,
      async (args) => {
        const result = await createTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "convertBugToTask",
      "Convert a bug into a Bugfix task. Copies bug name, description, and priority. Creates task with type=Bugfix, links bug<->task, and sets bug status to 'Fixing'. Optionally link to epic/sprint.",
      ConvertBugToTaskSchema.shape,
      async (args) => {
        const result = await convertBugToTask(args);
        return { content: [{ type: "text", text: result }] };
      }
    );

    server.tool(
      "createBug",
      "File a new bug discovered during development. Set name (include component + symptom), description (reproduction steps), priority (by user impact). Optionally link to product. Bug starts in 'Awaiting Review' status.",
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
      "Link completed tasks/bugs to a version and update release metadata. Set status (Planned, In Development, Release Candidate, Hotfix — 'Released' requires human approval), release summary, and link tasks/bugs/epics.",
      UpdateVersionSchema.shape,
      async (args) => {
        const result = await updateVersion(args);
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
