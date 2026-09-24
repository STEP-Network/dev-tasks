# Agent minis: the runbook

How to set up, run, update and roll back an agent Mac mini. Eve comes first,
on Nate's Mac mini at home. When Eve has shipped a PR, the office mini gets the
same list for Bob, with `bob`, `bob@polads.eu` and `BobPolAds` in place of
every `eve`, `eve@polads.eu` and `eve-polads`. This is the one source: the
PolAds handbook's "Agent Mac minis" section links here.

Everything runs as the agent's macOS user (`eve`) unless a step says the
admin account. Phase 2 of the two-flow plan (STEP-3087) built what it
installs.

## What runs

```
launchd (eve's GUI session, logged in automatically)
  eu.polads.agentd        watchdog and job launcher   ~/dev-tasks/runtime/src/agentd/main.ts
    tmux -L agentd, session "frontdoor"
      claude --resume ... "/loop /dev-tasks:front-door"   (cwd ~/polads)
    worker, one at a time, detached                    ~/dev-tasks/runtime/src/worker/run.ts
  eu.polads.slack-bridge  Socket Mode and the outbox  ~/dev-tasks/runtime/src/slack/bridge.ts
state   ~/.agentd (config.json, queues, jobs, logs, PAUSE)
secrets ~/.config/linear/.env, ~/.config/agentd/{slack,agentd,claude}.env, all chmod 600
```

People talk to the agent in Slack. The front door answers, refines issues
into briefs, and starts one develop job at a time. The worker turns a Ready
issue into a PR to `staging` with auto-merge armed.

## 1. The machine (Nate, from the mini's admin account)

1. Create a standard (not admin) user named `eve`.
2. Turn FileVault off in Privacy & Security. macOS allows automatic login
   only without it, and automatic login is what brings the LaunchAgents back
   after a power cut (Nate, 2026-09-24).
3. Users & Groups, Automatically log in as: `eve`.
4. Energy: prevent automatic sleep, and start up after a power failure.
5. Turn on Remote Login and Screen Sharing, and install Tailscale.

Homebrew's folders belong to the admin account, so install the tools from
there:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install node@20 pnpm@10 gh jq tmux vercel-cli
```

`pnpm@10`, not plain `pnpm`: that one is pnpm 12, which ignores
`pnpm.onlyBuiltDependencies` in PolAds's package.json, and the install
refuses any pnpm but 10. `node@20` and `pnpm@10` are keg-only, so they are
not on anyone's PATH yet. Homebrew stops installing `node@20` on 28 October
2026. A copy already installed keeps working, and STEP-3156 tracks the move.

## 2. The agent's own accounts

Nate creates the mailbox `eve@polads.eu` first. Every account below uses it.

- **Claude**: a Max seat on `eve@polads.eu`. The status line's rate limits,
  which light mode and limit-aware restarts read, exist on Pro and Max only.
- **GitHub**: the machine user `eve-polads`, signed up with `eve@polads.eu`.
  Nate invites it to STEP-Network, in the org's `agents` team, with Write on
  `v0-politiske-annoncer` and `dev-tasks`. Read is not enough: the runner
  pushes the worker's branch and opens its PR as this user.
- **Linear**: Nate invites `eve@polads.eu` as a member. Accept from the
  mailbox, then create a personal API key as Eve (section 5).
- **Vercel**: Nate invites `eve@polads.eu` to the STEP team. `/preview` uses it.
- **Slack**: an app of its own (section 4).

Then, logged in as `eve`, in a terminal. A standard user does not get
Homebrew on its PATH, so add it with the two pinned versions and Claude's
install folder:

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
echo 'export PATH="/opt/homebrew/opt/node@20/bin:/opt/homebrew/opt/pnpm@10/bin:$HOME/.local/bin:$PATH"' >> ~/.zprofile
curl -fsSL https://claude.ai/install.sh | bash
```

In a new terminal:

```bash
touch ~/.gitconfig     # first: git writes to ~/.config/git/config otherwise
claude                 # log in with eve@polads.eu, then /exit
gh auth login          # as eve-polads
gh auth setup-git
git config --global user.name "eve"
git config --global user.email "eve@polads.eu"
vercel login
```

Check: `node --version` starts with v20 (20.18.1 or later), `pnpm --version`
with 10, `claude --version` is 2.1.278 or later, `gh auth status` names
`eve-polads`, `git config --global --show-origin user.email` shows
`file:/Users/eve/.gitconfig`, and `~/.config/git/config` does not exist. The
worker's sandbox cannot read `~/.config`, and git reads that file whenever it
exists, so every git in the worker would fail on it. If it exists, move what
it holds into `~/.gitconfig` and delete it: `agentctl doctor` refuses it.

A mini that runs another Node works: Eve's runs Node 24. `agentctl doctor`
warns about it, and refuses anything older than 20.18.1.

## 3. The checkouts, and marking the machine

```bash
gh repo clone STEP-Network/v0-politiske-annoncer ~/polads
gh repo clone STEP-Network/dev-tasks ~/dev-tasks
cd ~/polads && git checkout --detach origin/staging && pnpm install --frozen-lockfile
cd ~/dev-tasks/plugin && npm ci
cd ~/dev-tasks/runtime && npm ci
mkdir -p ~/.claude
echo '{ "profile": "agent", "devSurface": "preview", "mini": "eve" }' > ~/.claude/dev-tasks-profile.json
```

The profile switches on the worktree gates and the i18n parity check at
commit, which laptops do not get. Its `mini` is the name every claim carries,
and it must match `mini` in `~/.agentd/config.json` (section 6): agentd and
the bridge refuse to start while the two differ.

## 4. Slack: one app per agent (Nate)

Follow `runtime/slack/README.md`: it generates this agent's manifest
(`npx tsx src/slack/manifest.ts eve`, the app "PolAds Eve" with the bot
`@eve`), creates and installs the app, makes the app-level token with
`connections:write`, and invites the bot into `#polads-agents`,
`#polads-questions`, `#polads-intake` and `#polads-releases`. The bridge
refuses to start while the bot is missing from any of them. Note the Bot
User OAuth Token (`xoxb-...`) and the app-level token (`xapp-...`) for the
next section, and the Slack member ids of the people who may talk to the
agent (profile, More, Copy member ID).

## 5. Secrets (Nate, on the mini as eve)

Typed with `read -rs`, so nothing lands in shell history or on screen. The
Linear key is Eve's own personal API key (Linear, Settings, Security and
access, Personal API keys).

```bash
mkdir -p ~/.config/linear ~/.config/agentd
read -rs LINEAR_KEY
(umask 077; printf 'LINEAR_API_KEY=%s\n' "$LINEAR_KEY" > ~/.config/linear/.env); unset LINEAR_KEY
read -rs BOT_TOKEN
read -rs APP_TOKEN
(umask 077; printf 'SLACK_BOT_TOKEN=%s\nSLACK_APP_TOKEN=%s\n' "$BOT_TOKEN" "$APP_TOKEN" > ~/.config/agentd/slack.env); unset BOT_TOKEN APP_TOKEN
read -rs CRON_URL
(umask 077; printf 'SENTRY_CRON_URL=%s\n' "$CRON_URL" > ~/.config/agentd/agentd.env); unset CRON_URL
chmod 600 ~/.config/linear/.env ~/.config/agentd/slack.env ~/.config/agentd/agentd.env
```

The Sentry URL is the check-in URL of a cron monitor `eve-mini` (every 5
minutes, 10 minutes' margin, alerts to Nate). Without `agentd.env` there is
no dead-man switch, and nothing else changes.

Only if the worker cannot authenticate (the first `agentctl probe-hooks`
says so): run `claude setup-token` as `eve`, which prints a token valid for a
year for the same subscription, and store it for the worker alone:

```bash
read -rs CLAUDE_TOKEN
(umask 077; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_TOKEN" > ~/.config/agentd/claude.env); unset CLAUDE_TOKEN
chmod 600 ~/.config/agentd/claude.env
```

No production secret ever goes on a mini: no `.env` file in the checkout, no
`vercel env pull`, no `DATABASE_URL`, and no `MONDAY_API_KEY` (Monday is
read-only for agents, and on the agent profile the plugin offers no Monday
tools at all).

## 6. The configuration

```bash
mkdir -p ~/.agentd && cp ~/dev-tasks/runtime/templates/config.example.json ~/.agentd/config.json
printf '{"reason":"first start, not watched yet"}\n' > ~/.agentd/PAUSE
```

Edit `~/.agentd/config.json`: `slack.allowedUsers` (the member ids from
section 4), and `queue.allow` with the issue ids the first runs may take. On
Bob's mini also `mini`, `repo.path` and `pluginRoot`. Once a second agent
exists, each lists the other's bot in `slack.otherAgentBots`
(`runtime/slack/README.md`). The `PAUSE` file keeps anything from being
developed or refined before someone is watching.

## 7. The first interactive run, and the plugin (at the mini or over Screen Sharing)

Once, with the permission mode the front door uses, so its one-time prompts
are answered by a person now and never block an unattended start later:

```bash
cd ~/polads && claude --permission-mode auto
```

Accept the folder-trust and auto-mode prompts, then inside Claude Code:

```
/plugin marketplace add /Users/eve/dev-tasks
/plugin install dev-tasks@dev-tasks-marketplace
/exit
```

Keep the user's MCP servers lean (GitHub, Linear, Playwright, Corridor,
context7) and nothing personal: no mail, calendar or drive.

A directory marketplace is the one to use: Claude Code (2.1.281, checked for
this runbook) loads its plugin from `~/dev-tasks/plugin` itself, so the
front door runs the same plugin as the worker, which loads that directory
too. If the plugin was installed from GitHub before (the 1.0 install doc),
remove that marketplace first: `agentctl doctor` warns about it.

## 8. Install

```bash
bash ~/dev-tasks/runtime/scripts/install.sh
```

It runs `agentctl doctor --fresh` first and writes nothing while a line says FAIL:
the profile, the configuration, the one mini name, the secrets files'
modes, the git identity, the GitHub login and its push access, pnpm 10,
Node, tmux, jq, Claude Code and its login, the checkout and the plugin.
Then it writes `~/.agentd/bin/{agentctl,trackerctl,statusline}`, renders the
front door's settings to `~/.agentd/front-door-settings.json`, records the
absolute paths of `claude` and `tmux` in `config.json`, and loads the two
LaunchAgents with an explicit PATH it has checked. Run it again after any
change to a tool's location: it is idempotent.

agentd starts the front door with `--settings ~/.agentd/front-door-settings.json`.
Those settings are added on top of the user's (`~/.claude/settings.json`)
and the checkout's, not put in their place, so a `sandbox` block or
`permissions.allow` rules in `~/.claude/settings.json` or
`~/polads/.claude/settings.local.json` would reach the front door and could
loosen its sandbox: `agentctl doctor` fails on either. install.sh leaves
`~/.claude/settings.json` as it was, and a person's own `claude` on the mini
(the handbook's `/dev`, `/preview` and `/ship` smoke test, say) runs without
the front door's settings. agentd starts nothing on a front-door settings
file it cannot parse or that turns the sandbox off: claude would start on
one it cannot parse with no sandbox at all.

The front door's settings, from `runtime/templates/claude-settings.json`:

- `~/.agentd/bin/agentctl` and `~/.agentd/bin/trackerctl` run outside its
  sandbox, without a prompt, when each is one simple command: they read the
  Linear key and reach Linear (a sandboxed Node process cannot, as its fetch
  ignores the sandbox's proxy). Joined to anything else (`&&`, `;`, a pipe,
  a second line, `$(...)`, a redirect) or with a variable set in front, the
  whole command runs sandboxed. Both start node with a clean environment
  (`runtime/templates/shim.sh`), so nothing set in front of them reaches it.
  The skills write people's words to a file first, with a new heredoc
  delimiter each time, and pass the file, so no shell expands them.
- Every other command runs sandboxed: no network, no write but
  `~/.front-door` (the briefs and replies), and no read of where credentials
  live: `~/.config` (the Linear key, the Slack tokens, gh's login), `~/.ssh`,
  `~/.npmrc`, `~/.netrc`, `~/.git-credentials` and the Vercel CLI's login. The
  Read tool is denied the same (decision 8), and Edit and Write are denied in
  `~/polads` and `~/.agentd`.
- `agentctl resume`, `probe-hooks` and `probe-sandbox` are denied, and
  agentctl refuses them anywhere but at a person's terminal: only a person on
  the mini lifts a pause.
- `git push`, `gh pr create` and `gh pr merge` are denied.
- `trackerctl` and `agentctl` refuse a secrets file and any text that
  carries a key or a token, since they can read the key.

How Claude Code treats these settings is Claude Code's, so it is checked, not
assumed: `agentctl probe-sandbox` (section 9) runs one front-door session
with them against local fakes of the Messages API and Linear, and
`runtime/src/__tests__/sessions.test.ts` runs the same probe with the binary
the SDK ships.

Smoke test:

```bash
bash ~/dev-tasks/plugin/hooks/lib/profile.sh get profile     # agent
cd ~/polads && ~/.agentd/bin/trackerctl ready --limit 3       # a JSON list
~/.agentd/bin/agentctl doctor                                 # ready
~/.agentd/bin/agentctl status
```

## 9. First start, paused

agentd starts the front door only once the sandbox probe has passed on the
`claude` it runs, so the probe comes first, at a terminal:

```bash
~/.agentd/bin/agentctl probe-sandbox
```

It is free and takes a few seconds: one front-door session with the front
door's own `claude`, its settings and the two commands, in a throwaway home
with fake secrets, against local fakes of the Messages API and Linear. Every
line must say `ok`. It records the Claude Code version it passed on. If a
line says FAIL, the sandbox does not hold on this Claude Code: keep the mini
paused and report it. Until it passes, `agentctl status` says
`front door: NOT RUNNING ... NOT STARTED: the sandbox probe has not passed`.

Then, within two minutes, `agentctl status` reads, line by line: `eve PAUSED
(first start, not watched yet)`, `agentd: running`, `front door: running`
with a wakeup 0 or 1 min ago, `worker: idle`, `bridge: connected`, a
`usage:` line with numbers, and `linear: ok (eve@polads.eu)`.

- `tmux -L agentd attach -t =frontdoor` shows the front door (detach with
  Ctrl-b then d). The front door has a tmux server of its own, so plain
  `tmux ls` does not list it, and a tmux a person starts can never hand it
  that person's environment. If it waits at a permission prompt, answer it
  once and write down which: the front door runs with
  `--permission-prompts none`, which Claude Code documents for `--print`
  only, and the rehearsal checks what an interactive session does with it.
- On the phone or claude.ai, signed in as Eve, the front door appears under
  Remote Control. If it does not, attach, run `/remote-control` once, and
  detach.
- `~/.agentd/bin/agentctl probe-hooks` (a few cents): a real SDK session in
  a throwaway repository proves the plugin's hooks and the worker's own
  guard fire. Expected: `"pluginHookFired":true`, `"workerGuardFired":true`,
  `"loadedPlugins":["dev-tasks"]` (with Claude Code's own built-in plugins
  beside it, if any), `"apiKeySource":"none"`, and exit 0.

Then `~/.agentd/bin/agentctl resume` when someone is watching. It, and
both probes, run only at a person's terminal: over SSH use `ssh -t`.

## 10. Watching it

- `~/.agentd/bin/agentctl status`: every part in one screen, with agentd's
  own error when it could not start, the pause's reason, and the issues held
  back.
- `~/.agentd/bin/agentctl report --days 7`: jobs, PRs, spend, questions,
  usage, pauses.
- `~/.agentd/bin/agentctl doctor`: the install's checks, any time.
- `tmux -L agentd attach -t =frontdoor`: the front door. Do not type into it
  while it works. Pause first.
- Remote Control on the phone or claude.ai, signed in as Eve.
- Logs in `~/.agentd/logs/`: `agentd.log`, `slack-bridge.log`,
  `worker.log`, `worker-<job>.log`, `ledger.jsonl`, and the two
  `*.launchd.log` files for a crash before a process's own log started.
- Slack: `#polads-agents` shows claims, PRs, parks and alerts, each starting
  `eve:`. `#polads-questions` has one thread per issue that needs a person.

## 11. Pause, resume, and held-back issues

```bash
~/.agentd/bin/agentctl pause --reason "why"
~/.agentd/bin/agentctl resume
```

Paused, no job starts and nothing is refined from the queue, a running
worker finishes, and the front door still answers Slack, including refining
what people file in `#polads-intake`.

agentd pauses the mini by itself after workers on two different issues in a
row died within minutes of starting: something on the mini is broken (the
install, a secrets file, the SDK), and every issue would be lost the same
way. The worker runner pauses it when the main checkout has
`.git/info/grafts` or `.git/shallow`. Either way the reason is in
`agentctl status` and in `#polads-agents`. Fix the cause, then
`agentctl resume`. The losses before the pause count towards nothing
afterwards, and a pause a person set is never overwritten.

An issue whose last two workers died within minutes of starting is held
back: the front door is no longer offered it, and `agentctl status` lists
it. Once the cause is fixed, `agentctl job submit --issue STEP-<n>` runs it by
hand, and a job of that issue that ends any other way lifts the hold. An
issue whose last job failed on Linear waits 15 minutes before it is offered
again, by itself, and is listed nowhere.

The front door explains a pause or a hold when someone asks in Slack, and
never lifts one because Slack said so. It cannot lift a pause at all: only a
person on the mini (SSH or Screen Sharing) runs `agentctl resume`.

Running `agentctl tick` by hand counts as a front-door wakeup and marks the
jobs that finished since as reported, so the front door never sees them. Use
`agentctl status` and `agentctl job list` to look instead.

## 12. Updating

```bash
~/.agentd/bin/agentctl pause --reason update
cd ~/dev-tasks && git pull --ff-only
(cd plugin && npm ci) && (cd runtime && npm ci)
bash ~/dev-tasks/runtime/scripts/install.sh      # re-renders, restarts agentd and the bridge
~/.agentd/bin/agentctl probe-sandbox             # every line ok, or stay paused
tmux -L agentd kill-session -t =frontdoor        # agentd resumes it within 15 seconds, on the new plugin
~/.agentd/bin/agentctl resume
```

The front door's Claude Code does not update itself (agentd's LaunchAgent
sets `DISABLE_AUTOUPDATER`), and agentd starts the front door only on a
`claude` the sandbox probe passed on. To update it: pause, `claude update`,
`agentctl probe-sandbox`, restart the front door as above, resume. The same after a runtime update that moves the
SDK's version, and `cd ~/dev-tasks/runtime && npm test` runs the probe with
the SDK's own binary.

The front door's plugin comes straight from `~/dev-tasks/plugin` (section
7), so the pull updates it and the restart loads it. If `/plugin` in the
front door still shows the old version (a later Claude Code that copies a
directory marketplace to its cache), remove
`~/.claude/plugins/cache/dev-tasks-marketplace`, attach, run
`/plugin install dev-tasks@dev-tasks-marketplace`, and restart the session.

A running worker is not affected by any of this: it is its own process group.

## 13. Rollback

From lightest to heaviest. Each level leaves people's delivery flow as it
was: `/dev`, `/preview` and `/ship` on their laptops.

1. **Pause** (seconds, reversible): `~/.agentd/bin/agentctl pause --reason "<why>"`.
   Undo: `agentctl resume`.
2. **Stop the mini** (minutes): `bash ~/dev-tasks/runtime/scripts/uninstall.sh`.
   It pauses the mini, unloads both LaunchAgents, stops the front door and a
   running worker (only while its pid is still that job's worker), and
   leaves `~/.agentd` and the settings for whoever looks next. A later
   `install.sh` starts nothing until `agentctl resume`. Then release what
   Eve holds in Linear, on the mini:
   ```bash
   cd ~/polads && ~/.agentd/bin/trackerctl claims
   cd ~/polads && ~/.agentd/bin/trackerctl release STEP-<n> --reason "agent mini stopped"
   ```
   one `release` per id. The claim sweep, the commands and `claims` all act
   only on the Linear key's own user, so each mini releases its own claims
   (decision 7). A mini that cannot run them any more has its claims released
   with its key: on another agent machine, with that mini's key in
   `~/.config/linear/.env` and its name as `mini` in the profile for the two
   commands, then both put back. Pause the borrowing mini first
   (`agentctl pause --reason "releasing <mini>'s claims"`) and wait until
   `agentctl status` shows `worker: idle`: its own worker would otherwise
   heartbeat and claim as the other mini meanwhile. Or a person unassigns its
   issues in Linear (people have Linear accounts). Parked issues (On hold,
   assigned to Eve) can stay, or be unassigned with
   `~/.agentd/bin/trackerctl update STEP-<n> --assign none`. A worker's open PR is an
   ordinary PR: let it merge, or close it with `gh pr close <n> --comment "<why>"`.
   Post one line in `#polads-agents` saying Eve is off.
3. **Revoke access** (the mini leaves for good, or is lost): in Slack, the
   app's Install App page, Revoke Tokens, or remove the app. On the mini,
   delete `~/.config/agentd/*.env` and `~/.config/linear/.env`,
   `gh auth logout`, `claude auth logout`. If the mini is lost, revoke its
   agent's GitHub, Linear, Claude and Slack access from each service.
4. **Code**: nothing needs reverting for people. The runtime and the two
   skills only run on a mini. If a laptop flow broke on the plugin, go back
   to the previous plugin release.

## Troubleshooting

- **`agentd: NOT RUNNING: ...` in status.** agentd exits when it cannot start
  (a configuration problem, a mini name the profile does not share) and
  launchd leaves it down, since a restart would not help. Fix what it says,
  then `launchctl kickstart -k gui/$(id -u)/eu.polads.agentd`.
- **`bridge: STOPPED` or `OUTBOX PAUSED`.** Stopped: see
  `~/.agentd/logs/slack-bridge.log`, fix, then
  `launchctl kickstart -k gui/$(id -u)/eu.polads.slack-bridge`. Outbox
  paused: Slack refused the app (a token or a channel it is not in). Nothing
  is lost, and the outbox retries every 5 minutes once it is fixed.
- **"the dev-tasks plugin loaded 2 times in the worker".** With Claude Code
  2.1.281 the worker's own copy (`pluginRoot`) shadows the marketplace copy
  that PolAds's project settings enable, so it loads once, and
  `runtime/src/__tests__/sessions.test.ts` checks that with the binary the
  SDK ships. If a later version loads both, every job stops at its start
  and `agentctl probe-hooks` shows it first.
- **`agentctl probe-sandbox` says FAIL.** The installed Claude Code treats
  the front door's settings differently from the one they were built on.
  Keep the mini paused, note the failing lines and the version in the
  rehearsal record, and go back to the last Claude Code that passed
  (`agentctl doctor` names it) until the template is fixed.
- **A command the front door needs is refused by its sandbox.** Only
  `~/.agentd/bin/agentctl` and `trackerctl`, each as one simple command, run
  outside it. A change goes into `runtime/templates/claude-settings.json` and
  a re-run of `install.sh`, which renders the file whole, never into
  `~/.agentd/front-door-settings.json` by hand.
- **The dev-tasks MCP server shows 0 tools in the front door.** On purpose:
  on the agent profile the plugin's Monday server registers no tools.
