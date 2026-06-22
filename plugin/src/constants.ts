// =============================================================================
// Board IDs
// =============================================================================

export const BOARDS = {
  TASKS: 5091706356,
  SUBTASKS: 5091706366,
  SPRINTS: 5091706352,
  EPICS: 5091706354,
  BUGS: 5091706353,
  VERSIONS: 5091847257,
  PRODUCTS: 5091839409,
  FEEDBACK: 5091852801,
  RETROS: 5091706350,
} as const;

// =============================================================================
// Tasks Board (5091706356) — Column IDs
// =============================================================================

export const TASK_COLUMNS = {
  name: "name",
  publicTaskName: "text_mm349ah6",
  status: "task_status",
  priority: "task_priority",
  type: "task_type",
  owner: "task_owner",
  estimatedHours: "lookup_mm0vm1wc",
  actualHours: "lookup_mm0vx6nx",
  // Task descriptions live on this Monday doc column (no length cap). Removed
  // 2026-05-28: the legacy long_text_mm0mcp77 column was deleted from Monday
  // after the one-off backfill (script: plugin/scripts/backfill-description-to-doc.ts).
  descriptionDoc: "doc_mm3sg1kr",
  epic: "task_epic",
  sprint: "task_sprint",
  targetVersion: "board_relation_mm0mqer3",
  startedDate: "date_mm0pfwzk",
  dueDate: "date",
  doneDate: "date_mm0n499",
  githubLink: "link",
  prLink: "link_mm0m817p",
  demoUrl: "link_mm0mtyf4",
  agentId: "dropdown_mm0mrcex",
  planId: "text_mm0mntgc",
  unplanned: "check",
  taskId: "item_id",
  attachments: "file_mm0m4xde",
  product: "lookup_mm0vsq7f",
  activeSprint: "mirror",
  sprintCompleted: "mirror__1",
  dependencies: "dependency_mm0pwbxn",
  acceptanceCriteria: "long_text_mm0pqaxy",
  uatDoc: "doc_mm3adfdg",
  // Before/after UI screenshots embedded by the visualDiff feature (v0.32.0).
  // Dedicated doc (NOT the UAT doc) because it's written append-only across two
  // passes spanning the merge — the UAT doc's drain-and-replace would wipe images.
  visualChangesDoc: "doc_mm4jkk92",
  branch: "text_mm0pvs3n",
  // Per-task CI-gate policy (added v0.26.0). Empty = Full. Skip values remove
  // the CI WAIT (stop-ci-green-check pending block, ship-pr e2e gates) — a RED
  // check still blocks merge regardless. Label-based writes only.
  ciGate: "color_mm46jxc",
  bugs: "task_bugs",
  feedback: "board_relation_mm0wvysr",
  lastUpdated: "pulse_updated_mm0nxzxb",
  creationLog: "pulse_log_mm0nkhr2",
} as const;

// =============================================================================
// Subtasks Board (5091706366) — Column IDs
// =============================================================================

export const SUBTASK_COLUMNS = {
  name: "name",
  status: "status",
  type: "color_mm0mcpha",
  owner: "person",
  estimatedHours: "numeric",
  actualHours: "numeric5",
  description: "long_text_mm0mbev7",
  date: "date_mm0m5pt4",
  startedDate: "date_mm0v57rr",
  lastUpdated: "pulse_updated_mm0pfjdm",
  creationLog: "pulse_log_mm0pktg6",
} as const;

// =============================================================================
// Sprints Board (5091706352) — Column IDs
// =============================================================================

export const SPRINT_COLUMNS = {
  name: "name",
  goals: "sprint_goals",
  active: "sprint_activation",
  timeline: "sprint_timeline",
  connectedTasks: "sprint_tasks",
  completed: "sprint_completion",
  startDate: "sprint_start_date",
  endDate: "sprint_end_date",
  capacity: "sprint_capacity",
} as const;

// =============================================================================
// Epics Board (5091706354) — Column IDs
// =============================================================================

export const EPIC_COLUMNS = {
  name: "name",
  owner: "epic_owner",
  timeline: "timeline",
  status: "epic_status",
  priority: "color_mm0pjpsf",
  description: "long_text_mm0p38ah",
  prd: "monday_doc_mkmt8122",
  connectedTasks: "epic_tasks",
  statusMirror: "lookup_mm0n9aph",
  estimatedEffort: "mirror_2",
  targetVersion: "board_relation_mm0mnnrn",
  product: "board_relation_mm0ms7sp",
  epicId: "item_id",
  doneDate: "date_mm0m417x",
  deadline: "date_mm0m8asm",
  connectedBugs: "board_relation_mm0ww7ef",
  lastUpdated: "pulse_updated_mm0mrej2",
  creationLog: "pulse_log_mm0mxd4x",
} as const;

// =============================================================================
// Bugs Board (5091706353) — Column IDs
// =============================================================================

export const BUG_COLUMNS = {
  name: "name",
  reporter: "people1",
  description: "long_text_mm0nw5va",
  timeTracking: "time_tracking",
  status: "bug_status",
  priority: "priority_1",
  files: "files",
  connectedTasks: "bug_tasks",
  bugId: "item_id",
  fixedInVersion: "board_relation_mm0mtsqz",
  product: "board_relation_mm0mbw41",
  epic: "board_relation_mm0ws076",
  fixedDate: "date_mm0nbxeb",
  filedByAgent: "dropdown_mm3fq2hs",     // which agent filed (added v0.12.0). Labels NOT pre-configured — tools use `{ labels: [name] }` + create_labels_if_missing. If you later pre-populate labels with numeric IDs matching AGENT_ID (mirroring the Tasks board's dropdown_mm0mrcex), switch writes to `{ ids: [String(AGENT_ID[x])] }` for ID-based stability.
  sourceTool: "color_mm3bqre",           // who/what filed the bug. Observability webhook bridge writes checkly/sentry/posthog/vercel/etc.; createBug sets "agent" (label index 1) for MCP-tool-filed bugs.
  creationLog: "pulse_log_mm0nb308",
  lastUpdated: "pulse_updated_mm0nh785",
} as const;

// =============================================================================
// Versions Board (5091847257) — Column IDs
// =============================================================================

export const VERSION_COLUMNS = {
  name: "name",
  status: "color_mm0m8mp",
  releaseDate: "date_mm0mj930",
  owner: "multiple_person_mm0maq97",
  versionId: "pulse_id_mm0my2dy",
  connectedEpics: "board_relation_mm0wnteg",
  connectedTasks: "board_relation_mm0ws43a",
  fixedBugs: "board_relation_mm0w8srv",
  versionNumber: "text_mm0rea7a",
  expectedReleaseDate: "date_mm0rn0fk",
  changelog: "doc_mm0m764r",
  releaseSummary: "long_text_mm0mw7hp",
  epicStatus: "lookup_mm0w3a0z",
  taskProgress: "lookup_mm0wzq1a",
  tasksTimeline: "lookup_mm0wabye",
  product: "board_relation_mm0mfd4t",
  creationLog: "pulse_log_mm0n1jtx",
  lastUpdated: "pulse_updated_mm0njvet",
} as const;

// =============================================================================
// Requests & Feedback Board (5091852801) — Column IDs
// =============================================================================

export const FEEDBACK_COLUMNS = {
  name: "name",
  reporter: "multiple_person_mm0m7w50",
  attachments: "file_mm0mvtm3",
  description: "long_text_mm0wvj92",
  status: "color_mm0wrpmn",
  type: "color_mm0wnher",
  priority: "color_mm0wathj",
  source: "color_mm0wrd82",
  product: "board_relation_mm0mcda1",
  connectedTasks: "board_relation_mm0w5j8m",
  lastUpdated: "pulse_updated_mm0nzv8y",
  creationLog: "pulse_log_mm0nqcwe",
  itemId: "pulse_id_mm0mqk43",
} as const;

// =============================================================================
// Retrospectives Board (5091706350) — Column IDs
// =============================================================================

export const RETRO_COLUMNS = {
  name: "name",
  type: "status",
  status: "color_mm3fq6w7",                  // workflow status (added v0.12.0)
  repeating: "check",
  submitter: "people1",
  owner: "people",
  implementedBy: "multiple_person_mm3fc9b7", // person who shipped the improvement (added v0.12.0)
  vote: "vote",
  description: "long_text_mm362mkh",
  sprint: "board_relation_mm39dksv",
  resolvedInVersion: "board_relation_mm3fmg92", // link to Versions board (added v0.12.0)
  filedByAgent: "dropdown_mm3fn3cf",         // which agent filed (added v0.12.0). Labels NOT pre-configured — tools use `{ labels: [name] }` + create_labels_if_missing. If you later pre-populate labels with numeric IDs matching AGENT_ID (mirroring the Tasks board's dropdown_mm0mrcex), switch writes to `{ ids: [String(AGENT_ID[x])] }` for ID-based stability.
  subitems: "subitems",
  creationLog: "pulse_log_mm0nbxdt",
  lastUpdated: "pulse_updated_mm0ne1ny",
} as const;

// =============================================================================
// Products Board (5091839409) — Column IDs
// =============================================================================

export const PRODUCT_COLUMNS = {
  name: "name",
  status: "color_mm0m3b1n",
  priority: "color_mm0mfe2h",
  timeline: "timerange_mm0mc60k",
  estimatedHours: "numeric_mm0m6v4p",
  owner: "multiple_person_mm0mms57",
  description: "text_mm0mkrqp",
  epics: "board_relation_mm0m3z2m",
  epicStatus: "lookup_mm0mfjth",
  bugs: "board_relation_mm0m9bck",
  versions: "board_relation_mm0mz8n7",
  feedback: "board_relation_mm0me4r6",
  doneDate: "date_mm0ngats",
  lastUpdated: "pulse_updated_mm0n50tr",
  creationLog: "pulse_log_mm0m5phv",
} as const;

// =============================================================================
// Status Mappings (label → Monday.com label ID for mutations)
// =============================================================================

// Task Status (task_status column) — workflow:
// Needs Refinement → Ready to Start → In Progress → Waiting for UAT → Pending Deploy to Prod → Done
// Off-ramps: Stuck (unresolved blocker), Declined (superseded mid-sprint — terminal, no work shipped).
export const TASK_STATUS: Record<string, number> = {
  "Needs Refinement": 5,
  "Ready to Start": 11,
  "In Progress": 0,
  "Waiting for UAT": 3,
  "Pending Deploy to Prod": 2,
  "Done": 1,
  "Stuck": 103,
  "Declined": 4,
};

// Task Priority (task_priority column)
export const TASK_PRIORITY: Record<string, number> = {
  "Critical": 0,
  "High": 2,
  "Medium": 7,
  "Low": 12,
  "Missing": 5,
};

// Task Type (task_type column) — these map 1:1 to the public changelog categories
// (Feature/Fix/Improvement) when generateChangelog runs. "To Do" = human task,
// "Not Set" = needs refinement of type.
export const TASK_TYPE: Record<string, number> = {
  "Feature": 1,
  "Fix": 2,
  "Improvement": 3,
  "To Do": 4,
  "Not Set": 5,
};

// Subtask Status (status column on subtasks board 5091706366)
// NOTE: index 153 ("Ready to Start") was copied from the Tasks board's status
// column but is not configured on the Subtasks board, so writes targeting it
// failed with ColumnValueException. The corresponding enum value was dropped
// from SubtaskStatusEnum (schemas.ts).
export const SUBTASK_STATUS: Record<string, number> = {
  "Needs Refinement": 5,
  "In Progress": 0,
  "Done": 1,
  "Stuck": 2,
};

// Subtask Type (color_mm0mcpha column on subtasks board)
export const SUBTASK_TYPE: Record<string, number> = {
  "To Do": 0,
  "Database": 3,
  "Backend": 6,
  "Documentation": 7,
  "Test": 9,
  "UX-UI": 12,
};

// Bug Status (bug_status column)
// Bug Status (bug_status column on Bugs board).
//
// NOTE: legacy entries below use the label `id` field as the numeric value
// (Monday accepts either `id` or `index` in the `{ index: N }` write format).
// New entries (Triaged, Converted to Task, Declined, Cannot Reproduce) lack
// known IDs — Monday assigns them on first write. Tools that set these
// statuses MUST use label-based writes (`{ label: "X" }`) which work
// regardless of the numeric value. The map below is retained for legacy
// callers that still pass `{ index: BUG_STATUS["X"] }`.
//
// Workflow (Option C, v0.12.0+):
//   Awaiting Review (default) → Triaged → (one of: Converted to Task |
//   Declined | Cannot Reproduce | Duplicated | Missing Info | Known Bug)
// Once Converted to Task, all dev work lives on the linked Task (type: Fix).
export const BUG_STATUS: Record<string, number> = {
  "Awaiting Review": 9,
  "Triaged": -1,             // assigned on first label-based write
  "Converted to Task": -1,   // assigned on first label-based write
  "Declined": -1,            // assigned on first label-based write
  "Cannot Reproduce": -1,    // assigned on first label-based write
  "Missing Info": 2,
  "Known Bug": 4,
  "Duplicated": 8,
  // Deprecated (legacy values, do not write via plugin going forward):
  "Ready for Dev": 14,
  "Fixing": 0,
  "Fixed": 1,
  "Pending Deploy": 7,
  "Move to Sprints": 3,
};

// Retro workflow Status (status column color_mm3fq6w7 on Retros board, added v0.12.0).
// Indices assigned on first label-based write — use label-based writes only.
export const RETRO_STATUS: Record<string, number> = {
  "New": -1,
  "Accepted": -1,
  "Implemented": -1,
  "Validated": -1,
  "Declined": -1,
};

// Bug Priority (priority_1 column)
export const BUG_PRIORITY: Record<string, number> = {
  "Critical": 0,
  "High": 2,
  "Medium": 7,
  "Low": 1,
};

// Epic Priority (color_mm0pjpsf column)
export const EPIC_PRIORITY: Record<string, number> = {
  "Critical": 3,
  "High": 4,
  "Medium": 0,
  "Low": 2,
  "Minimal": 1,
  "Not Prioritized": 5,
};

// Epic Status (epic_status column)
export const EPIC_STATUS: Record<string, number> = {
  "Refining": 0,
  "Done": 1,
  "On Hold": 2,
  "Planned": 3,
  "Backlog": 4,
  "In Progress": 9,
  "Review": 102,
};

// Version Status (color_mm0m8mp column)
export const VERSION_STATUS: Record<string, number> = {
  "Planned": 107,
  "In Development": 0,
  "Release Candidate": 102,
  "Released": 1,
  "Hotfix": 2,
};

// Feedback Status (color_mm0wrpmn column)
export const FEEDBACK_STATUS: Record<string, number> = {
  "New": 19,
  "Under Review": 0,
  "Accepted": 3,
  "Declined": 2,
  "Converted": 4,
  "Done": 1,
};

// Feedback Type (color_mm0wnher column)
export const FEEDBACK_TYPE: Record<string, number> = {
  "Request": 0,
  "Feedback": 1,
};

// Feedback Priority (color_mm0wathj column)
export const FEEDBACK_PRIORITY: Record<string, number> = {
  "Critical": 0,
  "High": 2,
  "Medium": 7,
  "Low": 1,
};

// Feedback Source (color_mm0wrd82 column)
export const FEEDBACK_SOURCE: Record<string, number> = {
  "User": 0,
  "Internal": 1,
  "Support": 2,
  "Partner": 3,
};

// Retro Type (status column on Retrospectives board)
// Index values come directly from the board: Discussion=0, Improve=1, Keep=2.
export const RETRO_TYPE: Record<string, number> = {
  "Discussion": 0,
  "Improve": 1,
  "Keep": 2,
};

// CI Gate (color_mm46jxc column on Tasks board, added v0.26.0).
// Per-task CI-gate policy. Empty column = "Full" semantics (full gating —
// the safe default; no backfill needed). "Skip (human)" is set by a human on
// the board; "Skip (agent)" may only be written by the agent after
// ci-skip-eval.sh prints ELIGIBLE. Skip removes the CI WAIT (pending-check
// stop block + optional e2e gates) — a RED check still blocks merge.
// Always write label-based ({ label }) — never by index.
export const CI_GATE = {
  FULL: "Full",
  SKIP_HUMAN: "Skip (human)",
  SKIP_AGENT: "Skip (agent)",
} as const;

export type CiGateValue = (typeof CI_GATE)[keyof typeof CI_GATE];

/** True when a CI Gate label authorizes skipping the CI wait. */
export function isCiGateSkip(value: string | undefined | null): boolean {
  return value === CI_GATE.SKIP_HUMAN || value === CI_GATE.SKIP_AGENT;
}

// =============================================================================
// Agent ID Dropdown (dropdown_mm0mrcex on Tasks board)
// =============================================================================

export const AGENT_ID: Record<string, number> = {
  "Claude Code CLI": 1,
  "Claude Desktop Cloud": 2,
  "Codex Local": 3,
  "Claude Desktop Local": 4,
  "Codex Cloud": 5,
};

// =============================================================================
// Board Groups
// =============================================================================

export const TASK_GROUPS = {
  ALL: "topics",
  DONE: "group_mm0nqssh",
} as const;

export const BUG_GROUPS = {
  INCOMING: "topics",
  DEVELOPMENT: "new_group24572",
  RESOLVED: "group_title",
  SPRINTS: "new_group",
} as const;

export const EPIC_GROUPS = {
  ACTIVE: "new_group313",
  DONE: "group_mm0mdytb",
  BACKLOG: "new_group",
} as const;

export const VERSION_GROUPS = {
  RELEASED: "group_mm0m6bkb",
  UPCOMING: "topics",
} as const;

export const FEEDBACK_GROUPS = {
  INCOMING: "topics",
  IN_PROGRESS: "group_mm0wmef6",
  RESOLVED: "group_mm0wvb8m",
} as const;

export const RETRO_GROUPS = {
  DEFAULT: "group_title",
} as const;
