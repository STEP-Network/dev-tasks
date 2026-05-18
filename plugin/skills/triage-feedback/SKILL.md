---
name: triage-feedback
description: Review and triage feedback/requests from Monday.com
user_invocable: true
---

# /triage-feedback — Triage Feedback & Requests

## Workflow

### Step 1: List Pending Feedback

1. `mcp__plugin_dev-tasks_dev-tasks__listFeedback()` — get all items.
2. Display summary table (ID, Title, Status, Submitter, Date).
3. Highlight untriaged (status: New or Pending).
4. None untriaged → "All feedback has been triaged."

### Step 2: Review Individual Item

For each item to review:

1. `getFeedback(feedbackId)` for full details.
2. Show title, description, submitter, connected tasks (if converted), status, priority.
3. Ask disposition:
   - a) Convert to Task → Step 3
   - b) Convert to Bug → Step 4
   - c) Dismiss → note as reviewed, skip
   - d) Skip → next item

### Step 3: Convert to Task

1. Suggest task name (default: feedback title).
2. Ask user for:
   - Task name (confirm or modify)
   - Priority (default: Medium)
   - Epic: `listEpics()`, auto-match by content, suggest if confident, else ask user. Generic feedback → product's Maintenance epic.
3. `convertFeedbackToTask(feedbackId, taskName, priority, epicId)`. Auto-links feedback → task; sets feedback `Converted`; auto-assigns Maintenance epic if no `epicId`.
4. Show created task ID and link.

### Step 4: Convert to Bug

1. Suggest bug name (default: feedback title).
2. Ask user for:
   - Bug name (confirm or modify)
   - Priority (Critical / High / Medium / Low)
   - Severity (Blocker / Major / Minor / Cosmetic)
   - Epic (optional — auto-assigns Maintenance if omitted)
3. `createBug(name, description, priority, severity, epicId)`. Auto-assigns Maintenance if no `epicId`.
4. Show created bug ID and link.

### Step 5: Continue or Finish

After each: "Review next item, or done?" Show remaining count if more. Done → summary:
```
Triage Summary:
- Converted to tasks: {N}
- Converted to bugs: {N}
- Dismissed: {N}
- Skipped: {N}
- Remaining untriaged: {N}
```

## Arguments

- `<feedback-id>` (optional): jump directly to specific item; else show all.

## Post-Conditions

- Reviewed items have disposition (converted / dismissed / skipped)
- Converted items have tasks/bugs created with epic assignments
- Converted feedback marked `Converted` in Monday
