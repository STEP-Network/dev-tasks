# CLAUDE.md — Dev Tasks MCP Server

## Overview

MCP server for autonomous coding agents managing development work across a Monday.com board ecosystem: Tasks, Sprints, Epics, Bugs, Versions, Products, and Feedback.

## Commands

```bash
npm run dev          # Start dev server with Turbopack
npm run build        # Production build
npm run lint         # ESLint check
npm run test         # Run integration tests
```

## Architecture

### Board Ecosystem

```
Products (5091839409) [read-only]
  └→ Epics (5091706354) [read-write]
       ├→ Tasks (5091706356) [read-write] ←→ Sprints (5091706352) [read-only]
       │    └→ Product (mirror via Epic)
       ├→ Bugs (5091706353) [read-write] ←→ Epics (two-way relation)
       └→ Versions (5091847257) [read-write]
       Feedback (5091852801) [read-write] ←→ Tasks (two-way relation)
```

**Mirror columns:** Tasks has a Product mirror column (`lookup_mm0vsq7f`) mirrored through the Epic relation (`task_epic`). Mirror columns are read-only and cannot be filtered server-side — `getBacklog` resolves product → epics → tasks instead.

Subtasks board: 5091706366 (linked from Tasks)

### MCP Server Entry Point
- `app/api/mcp/route.ts` — Registers all 27 tools

### Core Library
- `lib/constants.ts` — Board IDs, column IDs, status/type/priority mappings, default owner ID
- `lib/monday-client.ts` — GraphQL executor
- `lib/schemas.ts` — Zod schemas for all 26 tools
- `lib/tools/utils.ts` — Shared helpers

### Tools (27 total)

| # | Tool | Phase | Purpose |
|---|------|-------|---------|
| 1 | `getBacklog` | Discovery | Prioritized task queue with filters |
| 2 | `getBugs` | Discovery | Bug queue with filters |
| 3 | `getTask` | Context | Full task details with subtasks/context |
| 4 | `getSprint` | Context | Sprint overview with progress stats |
| 5 | `getEpic` | Context | Epic details with task progress |
| 6 | `listEpics` | Context | List/search epics to discover epic IDs |
| 7 | `listProducts` | Context | List products to discover product IDs |
| 8 | `claimTask` | Execution | Atomically claim a task (auto-assigns owner) |
| 9 | `updateTask` | Execution | Update any task field |
| 10 | `manageSubtasks` | Execution | Create/update/delete subtasks |
| 11 | `createTask` | Creation | Create tasks with acceptance criteria, dependencies, subtasks |
| 12 | `convertBugToTask` | Creation | Bug → Bugfix task conversion |
| 13 | `createBug` | Creation | File new bugs |
| 14 | `updateVersion` | Shipping | Update version fields, link items, delete, group moves |
| 15 | `createVersion` | Shipping | Create versions with product link, status, dates |
| 16 | `listVersions` | Context | List/search versions with group/status/product filters |
| 17 | `getVersion` | Context | Full version details with linked items and changelog |
| 18 | `generateChangelog` | Shipping | Auto-generate structured changelog as Monday Doc |
| 19 | `getUpdates` | Communication | Read item updates/comments |
| 20 | `createUpdate` | Communication | Post updates/comments on items |
| 21 | `createEpic` | Creation | Create epics with status, priority, timeline, product link |
| 22 | `updateEpic` | Execution | Update any epic field or delete an epic |
| 23 | `listFeedback` | Discovery | List/filter requests and feedback items |
| 24 | `getFeedback` | Context | Full feedback details with connected tasks |
| 25 | `createFeedback` | Creation | File new requests or feedback |
| 26 | `updateFeedback` | Execution | Update any feedback field or delete |
| 27 | `convertFeedbackToTask` | Creation | Convert feedback → task with auto-linking |

## Agent Workflow

```
1. getBacklog(unclaimedOnly: true)     → Find available work
2. getTask(itemId)                      → Read full context
3. listEpics()                          → Find epic to assign (if needed)
4. claimTask(itemId, agentId, planId)   → Claim it (auto-assigns owner)
5. manageSubtasks(parentItemId, ops)    → Create/update subtasks as you work
6. updateTask(itemId, prLink, status)   → Set PR link, update status
7. listVersions()                       → Find or create target version
8. updateVersion(versionId, linkTaskIds) → Link to release version
9. generateChangelog(versionId)         → Auto-generate changelog doc
```

## Claiming Protocol

- Agent calls `claimTask` → server validates:
  - Status is "Backlog" or "Ready to Start"
  - Agent ID dropdown is empty
  - Dependencies are all Done
- Success → sets In Progress + Agent ID + Plan ID + Started Date + Owner (auto-assigned)
- Conflict → returns error with current owner

## Owner Assignment

Pass your system username (`whoami`) as the `owner` field. The server maps usernames to Monday.com person IDs:
- `naref` → 48307552
- `krmoj` → 38667531

Used in:
- `claimTask` — required, assigns you as owner when claiming
- `createTask` — optional, assigns owner at creation time
- `createEpic` — optional, assigns owner at creation time
- `updateEpic` — optional, changes owner
- `createVersion` — optional, assigns owner at creation time
- `updateVersion` — optional, changes owner

## Key Status Mappings

**Task Status:** Backlog → Ready to Start → In Progress → Waiting for Review → Pending Deploy → Done (+ Stuck)
**Task Priority:** Critical, High, Medium, Low, Best Effort, Missing
**Task Type:** Development, Bugfix, Maintenance, Refine, Documentation, PM-work
**Subtask Status:** Backlog → Ready to Start → In Progress → Waiting for Review → Pending Deploy → Done (+ Stuck)
**Subtask Type:** Test, Documentation, UX-UI, Database, Backend, PM-work
**Epic Status:** Backlog, Planned, Refining, In Progress, Review, On Hold, Done
**Epic Priority:** Critical, High, Medium, Low, Minimal, Not Prioritized
**Version Status:** Planned, In Development, Release Candidate, Released, Hotfix
**Feedback Status:** New → Under Review → Accepted → Converted / Declined / Done
**Feedback Type:** Request, Feedback
**Feedback Priority:** Critical, High, Medium, Low
**Feedback Source:** User, Internal, Support, Partner
**Agent ID:** Claude Code CLI, Claude Desktop Cloud, Codex Local, Claude Desktop Local, Codex Cloud

## Maintenance Epics

Every product should have a permanent "Maintenance & Hotfixes" epic (Status: In Progress, no deadline). This ensures all tasks have an epic — and therefore Product context via the Task mirror column.

- `createBug`, `convertBugToTask`, and `convertFeedbackToTask` auto-assign the maintenance epic when no explicit epicId is provided
- The resolver matches epics whose name contains "maintenance" (case-insensitive)
- Convention: name the epic "{Product Name} — Maintenance & Hotfixes"
- Hotfix tasks, tech debt, and miscellaneous work go here

## Product Inheritance

Product flows through the hierarchy: **Product → Epic → Task** (mirror column). Bugs, Feedback, and Versions keep direct Product connections because they exist at different lifecycle stages (intake/output) before tasks or epics are assigned.

## Task Completion

Monday.com automation auto-completes the parent task when all subtasks are Done:
- Do NOT set task status to Done directly
- Instead, mark all subtasks as Done
- Delete unwanted subtasks first (automation triggers when last subtask is marked Done)

## Environment Variables

- `MONDAY_API_KEY` — Monday.com API key (required)
