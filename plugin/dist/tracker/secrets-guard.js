/**
 * What trackerctl and agentctl refuse to send anywhere: a secrets file, and
 * text that carries a secret. On an agent mini both run outside the front
 * door's sandbox (they read the Linear key and write ~/.agentd), so the
 * sandbox cannot be what keeps a key out of an issue or a Slack message.
 * No message here ever contains a value.
 */
import { readFileSync, realpathSync } from "node:fs";
import { homedir } from "node:os";
import { basename, join, resolve, sep } from "node:path";
/**
 * Key and token shapes: Linear, Slack, Anthropic, GitHub, npm, a private key,
 * the token in the Vercel CLI's auth.json, a .netrc entry, and the lines of
 * the mini's own secrets files.
 */
const SECRET_RE = new RegExp([
    "lin_api_[A-Za-z0-9]{8,}",
    "xox[abpr]-[A-Za-z0-9-]{6,}",
    "xapp-[A-Za-z0-9-]{6,}",
    "sk-ant-[A-Za-z0-9_-]{8,}",
    "gh[pousr]_[A-Za-z0-9]{20,}",
    "github_pat_[A-Za-z0-9_]{20,}",
    "npm_[A-Za-z0-9]{30,}",
    "_authToken\\s*=",
    "-----BEGIN [A-Z ]*PRIVATE KEY-----",
    '"token"\\s*:\\s*"[A-Za-z0-9_-]{20,}"',
    "\\bmachine\\s+\\S+\\s+login\\s+\\S+\\s+password\\s+\\S+",
    "\\b(LINEAR_API_KEY|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|SENTRY_CRON_URL)\\s*=",
].join("|"));
/**
 * Where credentials live on a mini, below the home directory: the mini's own
 * secrets and gh's login (~/.config), SSH keys, npm's and curl's logins, git's
 * credential store, and the Vercel CLI's login. The front door's settings deny
 * the Read tool the same places.
 */
export const CREDENTIAL_PATHS = [
    ".config",
    ".ssh",
    ".npmrc",
    ".netrc",
    ".git-credentials",
    ".vercel",
    join("Library", "Application Support", "com.vercel.cli"),
    join(".local", "share", "com.vercel.cli"),
];
/** Throws when `text` looks like it carries a key or a token. `what` names the flag, never the text. */
export function assertNoSecretText(text, what) {
    if (SECRET_RE.test(text)) {
        throw new Error(`usage: ${what} looks like it carries a key or a token, and it is never sent anywhere. Leave the secret out.`);
    }
}
/**
 * Reads a file named on the command line (a brief, a reply), refusing a
 * secrets file: anything under CREDENTIAL_PATHS or named .env*, as given and
 * as resolved through symlinks, and any content that carries a secret (a hard
 * link or a copy of one).
 */
export function readTextFile(path, what, home = homedir()) {
    const refuse = () => {
        throw new Error(`usage: ${what} ${path} looks like a secrets file (where credentials live, or named .env*), and it is never sent anywhere`);
    };
    const within = (p, dir) => p === dir || p.startsWith(dir + sep);
    const real = (p) => {
        try {
            return realpathSync(p);
        }
        catch {
            return p;
        }
    };
    const places = CREDENTIAL_PATHS.flatMap((rel) => [join(home, rel), real(join(home, rel))]);
    const given = resolve(path);
    // Missing: real() gives the path back, and readFileSync below says so.
    const resolved = real(given);
    for (const p of [given, resolved]) {
        if (places.some((dir) => within(p, dir)) || basename(p).startsWith(".env"))
            refuse();
    }
    const text = readFileSync(resolved, "utf8");
    assertNoSecretText(text, `${what} ${path}`);
    return text;
}
