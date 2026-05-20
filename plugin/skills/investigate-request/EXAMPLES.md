# /investigate-request — Worked Examples

Two full input → output walkthroughs from real PolAds-agent reports. Use these as the contract: future maintainers can dogfood the skill against these inputs and verify the report shape matches.

These examples DO NOT include real-time Monday data — they document the expected output schema on known inputs, so the skill's behavior is testable by inspection.

---

## Example 1 — `--mode=dedup` (filing time)

### Invocation

```text
/investigate-request --mode=dedup "place-autocomplete allows invalid house numbers, silently falls back to street"
```

### Expected report

```markdown
## Investigation report

### Item 1: place-autocomplete accepts invalid house numbers, silent street fallback

#### Related existing tasks
- #2926512992 "Address input validation hardening" — Done — partial fix for empty input; doesn't cover invalid-house-number-with-fallback case
- #2929216933 "Place autocomplete: handle silent street-fallback case" — Ready to Start (refinement in flight by another agent) — direct match

#### Likely-affected files
- `app/components/forms/AddressInput.tsx` — Places autocomplete wiring
- `lib/places/parse-address.ts` — fallback logic

#### In-flight overlap
- #2929216933 is being refined by another agent (claimed ~2 hours ago); branch unknown

#### Recent merges possibly explaining the symptom
- PR #359 (merged 2026-05-19) — single-field Places component — changed parse logic; may have introduced the silent-fallback regression
- PR #361 (merged 2026-05-19) — country cascade — narrowed Places query scope

#### Recommendation
SKIP — duplicate of in-flight #2929216933.

#### Open questions for human

**BLOCKING**:
- Confirm: is this the same bug as #2929216933, or a distinct symptom worth a separate task?

**OPTIONAL**: none — agent will mark as duplicate if user confirms.

#### Recall caveat
Searched [house number validation, place autocomplete fallback, address parse]. Closed tasks > 30 days ago and bug-board items not searched. Semantic dupes with different wording may not appear.
```

### How the caller acts

`/create-task` invoked this via Phase 0. It reads the report, sees `Recommendation: SKIP` + a BLOCKING question. It:

1. Surfaces the BLOCKING question via `AskUserQuestion`:
   > "Investigation found #2929216933 already in flight on this. Is this a duplicate, or a distinct symptom?"
   > Options: `Duplicate (skip)` / `Distinct (file new)`
2. Waits for the answer.
3. If `Duplicate (skip)` → abort, post the report as a Monday update on #2929216933 for context (no new task).
4. If `Distinct (file new)` → proceed to existing Phase 1+ with the report's findings informing the description (cross-link to #2929216933 in the new task's description).

---

## Example 2 — `--mode=relevance` (refine time, third report)

### Invocation

```text
/investigate-request --mode=relevance --taskId=2926684317 "validate sponsor on Add Sponsor button, NOT later"
```

### Expected report

```markdown
## Investigation report

### Item 1: validate sponsor on Add Sponsor button (third report against #2926684317)

#### Related existing tasks
- #2926684317 "Sponsor validation hardening" — Waiting for UAT — partial fix (validates on form submit, NOT on Add Sponsor button click); original AC covers submit-time but third report shows expected click-time validation

#### Likely-affected files
- `app/components/sponsors/AddSponsorButton.tsx` — button handler
- `app/components/sponsors/SponsorForm.tsx` — form-level validation (current fix scope)
- `lib/sponsors/validate.ts` — validation logic

#### In-flight overlap
- None — #2926684317 is at Waiting for UAT, not actively claimed

#### Recent merges possibly explaining the symptom
- PR #355 (merged 2026-05-12) — initial sponsor validation — submit-time only
- PR #360 (merged 2026-05-18) — sponsor form refactor — kept submit-time validation; click-time was out of scope

#### Recommendation
REFINE existing #2926684317 — add subtask "click-time validation on Add Sponsor button" to extend the partial fix. The task is still relevant; scope expansion within the same epic.

#### Open questions for human

**BLOCKING**:
- The task is at Waiting for UAT — to add new subtasks, the agent needs to bounce it back to In Progress (which auto-version may unlink from a version). Confirm: bounce back and refine, OR file a NEW task with "supersedes incomplete #2926684317" cross-link?

**OPTIONAL**:
- Subtask estimate: ~0.5h (defaulting to S size)
- Subtask type: UX-UI (defaulting based on button-handler scope)

#### Recall caveat
Searched [sponsor validation, add sponsor button, sponsor form validate]. Closed tasks > 30 days ago and bug-board items not searched. Semantic dupes with different wording may not appear.
```

### How the caller acts

`/refine-task 2926684317` invoked this via Phase 0. It reads the report, sees `Recommendation: REFINE` + a BLOCKING question about bounceback. It:

1. Surfaces the BLOCKING question via `AskUserQuestion`:
   > "#2926684317 is at Waiting for UAT. To extend scope, the agent must bounce back to In Progress (auto-version may unlink). Or file new task with supersedes-link."
   > Options: `Bounce back + refine` / `File new with supersedes-link`
2. Waits for the answer.
3. If `Bounce back + refine` → call `updateTask({ status: "In Progress" })` (triggers bounceback; auto-version unlinks per version-state-machine.ts), then proceed to existing refinement phases adding the click-time subtask.
4. If `File new with supersedes-link` → redirect to `/create-task` with the report's findings + an explicit "Supersedes #2926684317 (incomplete fix)" line in the description.

---

## What these examples are NOT

- **Not a runtime test.** The skill orchestrates a `dev-tasks:codebase-researcher` subagent; the report content depends on the actual Monday + git state at invocation time. These examples document the expected SHAPE, not literal output.
- **Not exhaustive.** Multi-item requests, `--mode=relevance` for filing-time clarifications, and `--depth=quick` outputs all follow the same schema with fewer sections populated. The two examples above cover the two common call-sites; other shapes inherit the same structure.

## Verifying the skill against these examples

When changing the skill, dogfood against these inputs in a real session:
1. Invoke `/investigate-request --mode=dedup "place-autocomplete allows invalid house numbers..."` standalone
2. Compare the produced report's section structure to Example 1 above
3. The section headers, recommendation enum, and BLOCKING/OPTIONAL split MUST match — content varies with current Monday state, but the schema is the contract.

Failures to look for:
- Missing sections (every section must be present, write `none` if empty)
- BLOCKING/OPTIONAL questions not split
- No recall caveat
- Recommendation not in {NEW, REFINE, SKIP, DECLINE}
- Multi-item input collapsed into one block when items were clearly distinct
