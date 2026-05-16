---
name: triage-feedback
description: Review and triage feedback/requests from Monday.com
user_invocable: true
---

# /triage-feedback — Triage Feedback & Requests

## Workflow

### Step 1: List Pending Feedback

1. Call `mcp__dev-tasks__listFeedback()` to get all feedback items
2. Display summary table:
   ```
   ID       | Title                    | Status    | Submitter  | Date
   ---------|--------------------------|-----------|------------|----------
   {id}     | {title}                  | {status}  | {name}     | {date}
   ```
3. Highlight untriaged items (status: New or Pending)
4. If no untriaged items: "All feedback has been triaged."

### Step 2: Review Individual Item

For each item the user wants to review:

1. Call `mcp__dev-tasks__getFeedback(feedbackId)` for full details
2. Show:
   - Title and description
   - Submitter info
   - Connected tasks (if any — already converted)
   - Status and priority
3. Ask user for disposition:
   - **a) Convert to Task** → Step 3
   - **b) Convert to Bug** → Step 4
   - **c) Dismiss** → note as reviewed, skip
   - **d) Skip** → move to next item

### Step 3: Convert to Task

1. Suggest task name (default: feedback title)
2. Ask user for:
   - Task name (confirm or modify)
   - Priority (default: Medium)
   - Epic assignment:
     a. Call `mcp__dev-tasks__listEpics()` to show available epics
     b. Try to auto-match based on feedback content
     c. If confident: suggest the epic
     d. If not confident: ask user to pick
     e. For generic feedback: suggest product's Maintenance epic
3. Call `mcp__dev-tasks__convertFeedbackToTask(feedbackId, taskName, priority, epicId)`
   - Auto-links feedback → task
   - Sets feedback status to "Converted"
   - If no epicId given: auto-assigns product's Maintenance epic
4. Show created task ID and link

### Step 4: Convert to Bug

1. Suggest bug name (default: feedback title)
2. Ask user for:
   - Bug name (confirm or modify)
   - Priority (Critical / High / Medium / Low)
   - Severity (Blocker / Major / Minor / Cosmetic)
   - Epic (optional — auto-assigns Maintenance epic if omitted)
3. Call `mcp__dev-tasks__createBug(name, description, priority, severity, epicId)`
   - If no epicId: auto-assigns product's Maintenance epic
4. Show created bug ID and link

### Step 5: Continue or Finish

- After each item: "Review next item, or done?"
- If more untriaged items: show remaining count
- If done: summarize actions taken:
  ```
  Triage Summary:
  - Converted to tasks: {N}
  - Converted to bugs: {N}
  - Dismissed: {N}
  - Skipped: {N}
  - Remaining untriaged: {N}
  ```

## Arguments

- `<feedback-id>` (optional): Jump directly to a specific feedback item
- If no ID provided, show all feedback for triage

## Post-Conditions

- Reviewed feedback items have disposition (converted, dismissed, or skipped)
- Converted items have tasks/bugs created with epic assignments
- Converted feedback marked as "Converted" in Monday.com
