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
/** Key and token shapes, and the lines of the mini's secrets files. */
const SECRET_RE = /lin_api_[A-Za-z0-9]{8,}|xox[abpr]-[A-Za-z0-9-]{6,}|xapp-[A-Za-z0-9-]{6,}|sk-ant-[A-Za-z0-9_-]{8,}|gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,}|\b(LINEAR_API_KEY|SLACK_BOT_TOKEN|SLACK_APP_TOKEN|CLAUDE_CODE_OAUTH_TOKEN|SENTRY_CRON_URL)\s*=/;
/** Throws when `text` looks like it carries a key or a token. `what` names the flag, never the text. */
export function assertNoSecretText(text, what) {
    if (SECRET_RE.test(text)) {
        throw new Error(`usage: ${what} looks like it carries a key or a token, and it is never sent anywhere. Leave the secret out.`);
    }
}
/**
 * Reads a file named on the command line (a brief, a reply), refusing a
 * secrets file: anything under ~/.config (the Linear key, a mini's Slack and
 * Claude tokens) or named .env*, as given and as resolved through symlinks,
 * and any content that carries a secret (a hard link or a copy of one).
 */
export function readTextFile(path, what, home = homedir()) {
    const refuse = () => {
        throw new Error(`usage: ${what} ${path} looks like a secrets file (under ~/.config, or named .env*), and it is never sent anywhere`);
    };
    const config = join(home, ".config");
    const within = (p, dir) => p === dir || p.startsWith(dir + sep);
    const given = resolve(path);
    let real = given;
    try {
        real = realpathSync(given);
    }
    catch {
        // Missing: readFileSync below says so.
    }
    let realConfig = config;
    try {
        realConfig = realpathSync(config);
    }
    catch {
        // No ~/.config: nothing can be inside it.
    }
    for (const p of [given, real]) {
        if (within(p, config) || within(p, realConfig) || basename(p).startsWith(".env"))
            refuse();
    }
    const text = readFileSync(real, "utf8");
    assertNoSecretText(text, `${what} ${path}`);
    return text;
}
