/**
 * The runtime's only way into the plugin: the Linear adapter from the same
 * checkout. Linear only: the runtime never falls back to Monday, so it does
 * not go through resolveTracker().
 */
export { createLinearTracker } from "../../plugin/src/tracker/linear.ts"
export { branchNameFor, byPriorityThenAge } from "../../plugin/src/tracker/types.ts"
export type {
  ClaimRecord,
  CreateIssueInput,
  IssuePatch,
  Tracker,
  TrackerIssue,
  TrackerUser,
} from "../../plugin/src/tracker/types.ts"
