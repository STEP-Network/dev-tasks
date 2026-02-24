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
} as const;

// =============================================================================
// Tasks Board (5091706356) — Column IDs
// =============================================================================

export const TASK_COLUMNS = {
  name: "name",
  status: "task_status",
  priority: "task_priority",
  type: "task_type",
  owner: "task_owner",
  estimatedHours: "lookup_mm0vm1wc",
  actualHours: "lookup_mm0vx6nx",
  description: "long_text_mm0mcp77",
  epic: "task_epic",
  sprint: "task_sprint",
  targetVersion: "board_relation_mm0mqer3",
  startedDate: "date_mm0pfwzk",
  dueDate: "date_mm0pqj58",
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
  branch: "text_mm0pvs3n",
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
  epicStatus: "lookup_mm0mn59r",
  taskProgress: "lookup_mm0mw6gm",
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

// Task Status (task_status column)
export const TASK_STATUS: Record<string, number> = {
  "Backlog": 104,
  "Ready to Start": 11,
  "In Progress": 0,
  "Waiting for Review": 3,
  "Pending Deploy": 2,
  "Done": 1,
  "Stuck": 103,
  "Move to Sprints": 4,
  "Not Set": 5,
};

// Task Priority (task_priority column)
export const TASK_PRIORITY: Record<string, number> = {
  "Critical": 0,
  "High": 2,
  "Medium": 7,
  "Low": 12,
  "Best Effort": 1,
  "Missing": 5,
};

// Task Type (task_type column)
export const TASK_TYPE: Record<string, number> = {
  "Development": 1,
  "Bugfix": 2,
  "Maintenance": 3,
  "Refine": 12,
  "Documentation": 0,
  "PM-work": 4,
  "Not Set": 5,
};

// Subtask Status (status column on subtasks board)
export const SUBTASK_STATUS: Record<string, number> = {
  "Stuck": 2,
  "In Progress": 0,
  "Done": 1,
  "Ready to Start": 153,
  "Waiting for Review": 158,
  "Pending Deploy": 18,
  "Backlog": 104,
};

// Subtask Type (color_mm0mcpha column on subtasks board)
export const SUBTASK_TYPE: Record<string, number> = {
  "Test": 9,
  "Documentation": 7,
  "UX-UI": 12,
  "Database": 3,
  "Backend": 6,
  "PM-work": 1,
};

// Bug Status (bug_status column)
export const BUG_STATUS: Record<string, number> = {
  "Awaiting Review": 9,
  "Ready for Dev": 14,
  "Fixing": 0,
  "Fixed": 1,
  "Missing Info": 2,
  "Move to Sprints": 3,
  "Known Bug": 4,
  "Pending Deploy": 7,
  "Duplicated": 8,
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
// People (system username → Monday.com person ID)
// =============================================================================

export const PEOPLE: Record<string, number> = {
  "naref": 48307552,
  "krmoj": 38667531,
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
