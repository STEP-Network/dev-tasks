/**
 * The runtime's only way into the plugin: the Linear adapter from the same
 * checkout. Linear only: the runtime never falls back to Monday, so it does
 * not go through resolveTracker().
 */
export { createLinearTracker } from "../../plugin/src/tracker/linear.ts"
/** The adapter's own transport (its key file, rate limit and retries), for the Monday bridge's reads the Tracker has no fields for (monday/people.ts). */
export { linearRequest } from "../../plugin/src/tracker/linear-client.ts"
export { branchNameFor, byPriorityThenAge, extractAcceptanceCriteria, LINEAR_TEAM_KEY } from "../../plugin/src/tracker/types.ts"
export { assertNoSecretText, readTextFile } from "../../plugin/src/tracker/secrets-guard.ts"
/** Approval classes (the human-agent flow spec, section 3), as trackerctl applies them. */
export { APPROVAL_CLASSES, approvalLabel, approvalPatch, classOfLabels, classRank, type ApprovalClass } from "../../plugin/src/tracker/approval.ts"
/** The answer recorder's marks on an issue (Wave 2): written by answer.ts alone, kept by trackerctl. */
export { answerEntries, insertUnder, keepAnswers, PLAN_RECOMMENDATION, RECORDER_LABELS, type AnswerEntry } from "../../plugin/src/tracker/answers.ts"
export type {
  ClaimRecord,
  CreateIssueInput,
  IssuePatch,
  Tracker,
  TrackerIssue,
  TrackerUser,
} from "../../plugin/src/tracker/types.ts"

/** An error that says Linear has no such issue, in the adapter's own words (plugin/src/tracker/linear.ts). */
export function isIssueGone(error: unknown): boolean {
  return error instanceof Error && error.message.startsWith("Linear: no issue ")
}
