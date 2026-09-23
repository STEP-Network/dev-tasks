/**
 * Which tracker this project uses.
 *
 * `tracker.provider` in .claude/project-config.json, defaulting to `monday`.
 * The default is deliberate: phase 0 ships BEFORE the Linear workspace exists
 * (spec section 14), so defaulting to Linear would break every consumer on
 * release day. PolAds flips the key on cutover weekend, and unflipping it is
 * the rollback.
 *
 * DEV_TASKS_TRACKER overrides it, for the Task 16 rehearsal and for a mini
 * that is testing the Linear path before its project config moves.
 *
 * The config is the one at the git toplevel of the working directory, so a
 * skill run from a subdirectory still finds it. Every fallback that is not
 * the documented default (a missing or unparseable file, an unrecognised
 * value) still answers `monday` but says so on stderr: silently writing to
 * the wrong tracker is the failure this guards against.
 */
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { createLinearTracker } from "./linear.js";
import { createMondayTracker } from "./monday.js";
const DEFAULT_PROVIDER = "monday";
function isProvider(value) {
    return value === "linear" || value === "monday";
}
/** stderr, never stdout: trackerctl's stdout is exactly one line of JSON. */
function warn(message) {
    process.stderr.write(`dev-tasks: ${message}\n`);
}
/**
 * The git toplevel of `cwd` (a worktree's own root: the config is committed,
 * so every worktree carries it), else `cwd` itself. The same order as
 * hooks/lib/resolve-project-root.sh, minus that script's file-path probe and
 * its CLAUDE_PROJECT_DIR step.
 */
function resolveProjectRoot(cwd) {
    try {
        const toplevel = execFileSync("git", ["rev-parse", "--show-toplevel"], {
            cwd,
            encoding: "utf8",
            stdio: ["ignore", "pipe", "ignore"],
        }).trim();
        if (toplevel)
            return toplevel;
    }
    catch {
        // Not inside a git checkout, or no git at all: cwd is all there is.
    }
    return cwd;
}
export function readTrackerProvider(cwd = process.cwd()) {
    const fromEnv = process.env.DEV_TASKS_TRACKER;
    if (isProvider(fromEnv))
        return fromEnv;
    if (fromEnv) {
        warn(`ignoring DEV_TASKS_TRACKER=${JSON.stringify(fromEnv)}: it must be "linear" or "monday".`);
    }
    const path = join(resolveProjectRoot(cwd), ".claude", "project-config.json");
    let raw;
    try {
        raw = readFileSync(path, "utf8");
    }
    catch {
        warn(`could not read ${path}; using the ${DEFAULT_PROVIDER} tracker. Set tracker.provider there, or DEV_TASKS_TRACKER.`);
        return DEFAULT_PROVIDER;
    }
    let provider;
    try {
        const parsed = JSON.parse(raw);
        provider = parsed?.tracker?.provider;
    }
    catch {
        warn(`${path} is not valid JSON; using the ${DEFAULT_PROVIDER} tracker.`);
        return DEFAULT_PROVIDER;
    }
    // No tracker block is the documented pre-cutover default, not a fallback.
    if (provider === undefined)
        return DEFAULT_PROVIDER;
    if (isProvider(provider))
        return provider;
    // An unrecognised value falls back rather than throwing: a typo must not
    // take /dev, /preview and /ship down, and Monday still works.
    warn(`tracker.provider ${JSON.stringify(provider)} in ${path} is not "linear" or "monday"; ` +
        `using the ${DEFAULT_PROVIDER} tracker.`);
    return DEFAULT_PROVIDER;
}
export function resolveTracker(cwd = process.cwd()) {
    return readTrackerProvider(cwd) === "linear"
        ? createLinearTracker()
        : createMondayTracker();
}
export { createLinearTracker } from "./linear.js";
export { createMondayTracker, stripDescriptionDocHeader } from "./monday.js";
export * from "./types.js";
