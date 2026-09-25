# Agent minis: the runbook

How to set up, run, update and roll back an agent Mac mini. Eve runs on
Nate's Mac mini at home, and Bob on the office mini. Throughout, `<agent>` is
the agent's name in lower case (`eve`, `bob`), `<Agent>` the same with a
capital (`Eve`, `Bob`), and `<mini>` the machine's name on Tailscale. This is
the one source: the PolAds handbook's "Agent Mac minis" section links here.

Everything runs as the agent's macOS user (`<agent>`) unless a step says the
admin account. Phase 2 of the two-flow plan (STEP-3087) built what it
installs. A second mini starts with the checklist below, then follows every
section as the first one did.

## What runs

```
launchd (<agent>'s GUI session, logged in automatically)
  eu.polads.agentd        watchdog and job launcher   ~/dev-tasks/runtime/src/agentd/main.ts
    tmux -L agentd, session "frontdoor"
      claude --resume ... "/loop /dev-tasks:front-door"   (cwd ~/polads)
    worker, one at a time, detached                    ~/dev-tasks/runtime/src/worker/run.ts
    the Monday bridge, on the coordinator mini only    ~/dev-tasks/runtime/src/monday/bridge.ts
  eu.polads.slack-bridge  Socket Mode and the outbox  ~/dev-tasks/runtime/src/slack/bridge.ts
state   ~/.agentd (config.json, queues, jobs, logs, PAUSE)
secrets ~/.config/linear/.env, ~/.config/agentd/{slack,agentd,claude,monday,usertest}.env, all chmod 600
```

People talk to the agent in Slack. The front door answers, refines issues
into briefs, and starts one develop job at a time. The worker turns a Ready
issue into a PR to `staging` with auto-merge armed.

## A second mini: what is shared, what is per agent

Shared, set up once for every agent:

- The four channels `#polads-agents`, `#polads-questions`, `#polads-intake`
  and `#polads-releases`: private Slack Connect channels. Each agent's app
  is added to them (section 4).
- The Linear team STEP, its states and labels. Each agent is a member.
- The GitHub org's `agents` team, with Write on `v0-politiske-annoncer` and
  `dev-tasks`. Each agent's machine user joins it.
- The Vercel STEP team, the two repositories, and the toolchain floors
  PolAds names in its `package.json` (section 1).
- The people who may talk to the agents: the same Slack member ids in every
  mini's `slack.allowedUsers` (section 6).

Per agent, one each (for Bob: `bob`, `bob@polads.eu`, `bob-polads`):

- The mini, its admin account and the macOS user `<agent>` (section 1).
- The mailbox `<agent>@polads.eu`, which every account below uses (section 2).
- A Claude Max seat on that mailbox (section 2).
- The GitHub machine user `<agent>-polads`, in the `agents` team (section 2).
- Linear membership and the agent's own personal API key (sections 2 and 5).
- The Vercel invite (section 2).
- The Slack app "PolAds <Agent>" and its two tokens (sections 4 and 5).
- The Sentry cron monitor `<agent>-mini` (section 5).
- The orchestrator's SSH key for `<agent>` (Orchestrator access, near the end).
- `mini` in the profile and in `config.json` (sections 3 and 6).

On every mini already running: add the new agent's bot to
`slack.otherAgentBots`, and restart that mini's bridge. The new mini lists
theirs (section 6).

Once a person has done sections 1, 2, 4 and 5 and installed the
orchestrator's key, the orchestrator does sections 3, 6, 8 and 9 from its own
machine with `runtime/scripts/bootstrap-mini.sh` (Bootstrapping a mini, under
Orchestrator access near the end). Section 7 comes after it, at the mini.

## 1. The machine (Nate, from the mini's admin account)

1. Create a standard (not admin) user named `<agent>`.
2. Turn FileVault off in Privacy & Security. macOS allows automatic login
   only without it, and automatic login is what brings the LaunchAgents back
   after a power cut (Nate, 2026-09-24).
3. Users & Groups, Automatically log in as: `<agent>`.
4. Energy: prevent automatic sleep, and start up after a power failure.
5. Turn on Remote Login and Screen Sharing, allowing `<agent>` for both, and
   install Tailscale.

Homebrew's folders belong to the admin account, so install the tools from
there:

```bash
xcode-select --install
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
eval "$(/opt/homebrew/bin/brew shellenv)"
brew install node gh jq tmux vercel-cli
```

Then Claude Code's managed settings, which approve the Slack channel into
the front door (STEP-3293, section 11). A channel of our own is on no list
of Anthropic's, and the development flag asks for a confirmation at every
start, which nobody is there to give. These settings apply to every Claude
Code session on the mini, and approve this one plugin's channel only:

```bash
sudo mkdir -p "/Library/Application Support/ClaudeCode"
printf '%s\n' '{"channelsEnabled": true, "allowedChannelPlugins": [{"marketplace": "dev-tasks-marketplace", "plugin": "dev-tasks"}]}' | sudo tee "/Library/Application Support/ClaudeCode/managed-settings.json"
```

Write the file exactly as it is here. agentd opens the channel only when it
approves this one plugin and nothing else, and starts the front door without
the channel otherwise, logging why. `agentctl doctor` checks the same rule
(`slack channel`). Without the channel the front door still reads every
Slack message, at its next wakeup.

The latest Node, with no version pinned. PolAds names its floors in its
`package.json`: `engines.node` (`24.x`) and `packageManager` (`pnpm@12.6.0`)
since STEP-3156. `agentctl doctor` warns below either, and refuses only a
Node older than the runtime's own floor, 20.18.1. pnpm comes in section 2,
from pnpm's own installer as the agent user, as on Eve's mini. `brew install
pnpm` here works too.

## 2. The agent's own accounts

Nate creates the mailbox `<agent>@polads.eu` first. Every account below uses it.

- **Claude**: a Max seat on `<agent>@polads.eu`. The status line's rate limits,
  which light mode and limit-aware restarts read, exist on Pro and Max only.
- **GitHub**: the machine user `<agent>-polads`, signed up with `<agent>@polads.eu`.
  Nate invites it to STEP-Network, in the org's `agents` team, with Write on
  `v0-politiske-annoncer` and `dev-tasks`. Read is not enough: the runner
  pushes the worker's branch and opens its PR as this user. Eve's had only
  Read until the `agents` team got Write, and doctor refuses that.
- **Linear**: Nate invites `<agent>@polads.eu` as a member. Accept from the
  mailbox, then create a personal API key as the agent (section 5).
- **Vercel**: Nate invites `<agent>@polads.eu` to the STEP team. `/preview` uses it.
- **Slack**: an app of its own (section 4).

Then, logged in as `<agent>`, in a terminal. A standard user does not get
Homebrew on its PATH, so add it and Claude's install folder, and keep Claude
Code from updating itself: the front door starts only on a Claude Code the
sandbox probe passed on (section 9), and a person's own `claude` on the mini
would otherwise update the one it runs. Then Claude Code, and pnpm from
pnpm's own installer, which puts it under `~/Library/pnpm` (Eve's is in
`~/Library/pnpm/bin`) and on the PATH of new terminals. It needs no admin
account, and `pnpm self-update` updates it in place.

```bash
echo 'eval "$(/opt/homebrew/bin/brew shellenv)"' >> ~/.zprofile
echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zprofile
echo 'export DISABLE_AUTOUPDATER=1' >> ~/.zprofile
curl -fsSL https://claude.ai/install.sh | bash
curl -fsSL https://get.pnpm.io/install.sh | sh -
```

In a new terminal:

```bash
touch ~/.gitconfig     # first: git writes to ~/.config/git/config otherwise
claude                 # log in with <agent>@polads.eu, then /exit
gh auth login          # as <agent>-polads
gh auth setup-git
git config --global user.name "<agent>"
git config --global user.email "<agent>@polads.eu"
vercel login
```

Check: `node --version` is at least what PolAds's `engines.node` names (24
today), `pnpm --version` at least its `packageManager` (12.6.0),
`claude --version` 2.1.278 or later, `gh auth status` names
`<agent>-polads`, `git config --global --show-origin user.email` shows
`file:/Users/<agent>/.gitconfig`, and `~/.config/git/config` does not exist.
The worker's sandbox cannot read `~/.config`, and git reads that file
whenever it exists, so every git in the worker would fail on it. If it
exists, move what it holds into `~/.gitconfig` and delete it: `agentctl
doctor` refuses it.

## 3. The checkouts, and marking the machine

```bash
gh repo clone STEP-Network/v0-politiske-annoncer ~/polads
gh repo clone STEP-Network/dev-tasks ~/dev-tasks
cd ~/polads && git checkout --detach origin/staging && pnpm install --frozen-lockfile
cd ~/dev-tasks/plugin && npm ci
cd ~/dev-tasks/runtime && npm ci
mkdir -p ~/.claude
echo '{ "profile": "agent", "devSurface": "preview", "mini": "<agent>" }' > ~/.claude/dev-tasks-profile.json
```

The profile switches on the worktree gates and the i18n parity check at
commit, which laptops do not get. Its `mini` is the name every claim carries,
and it must match `mini` in `~/.agentd/config.json` (section 6): agentd and
the bridge refuse to start while the two differ.

## 4. Slack: one app per agent (Nate)

Follow `runtime/slack/README.md`: it generates this agent's manifest
(`npx tsx src/slack/manifest.ts <agent>`, the app "PolAds <Agent>" with the
bot `@<agent>`), creates and installs the app, makes the app-level token with
`connections:write`, and adds the bot to `#polads-agents`,
`#polads-questions`, `#polads-intake` and `#polads-releases`. The channels
are private Slack Connect channels, so the app needs `groups:read`,
`groups:history` and the `message.groups` event, which the manifest has (an
app made from an older manifest is updated and reinstalled, as the README
says). Add the bot in each channel's settings, Integrations, Add an App,
never with `/invite @<agent>`, which can pick a person called the same. The
bridge refuses to start while the bot is missing from any of them. Note the Bot
User OAuth Token (`xoxb-...`) and the app-level token (`xapp-...`) for the
next section, and the Slack member ids of the people who may talk to the
agent (profile, More, Copy member ID).

## 5. Secrets (Nate, on the mini as <agent>)

Typed with `read -rs`, so nothing lands in shell history or on screen, at the
mini or in an interactive `ssh -t` session, never as a command's argument.
The Linear key is the agent's own personal API key (Linear, signed in as
`<agent>@polads.eu`, Settings, Security and access, Personal API keys).

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

The Sentry URL is the check-in URL of a cron monitor `<agent>-mini` (every 5
minutes, 10 minutes' margin, alerts to Nate). Without `agentd.env` there is
no dead-man switch, and nothing else changes.

Only if the worker cannot authenticate (the first `agentctl probe-hooks`
says so): run `claude setup-token` as `<agent>`, which prints a token valid for a
year for the same subscription, and store it for the worker alone:

```bash
read -rs CLAUDE_TOKEN
(umask 077; printf 'CLAUDE_CODE_OAUTH_TOKEN=%s\n' "$CLAUDE_TOKEN" > ~/.config/agentd/claude.env); unset CLAUDE_TOKEN
chmod 600 ~/.config/agentd/claude.env
```

No production secret ever goes on a mini: no `.env` file in the checkout, no
`vercel env pull`, no `DATABASE_URL`, and no `MONDAY_API_KEY` (Monday is
read-only for agents, and on the agent profile the plugin offers no Monday
tools at all). The one exception is the coordinator mini's board token,
`~/.config/agentd/monday.env`, which only agentd reads ("The Monday board",
near the end).

## 6. The configuration

```bash
mkdir -p ~/.agentd && cp ~/dev-tasks/runtime/templates/config.example.json ~/.agentd/config.json
printf '{"reason":"first start, not watched yet"}\n' > ~/.agentd/PAUSE
```

Edit `~/.agentd/config.json`: `slack.allowedUsers` (the member ids from
section 4, the same on every mini), and `queue.allow` with the issue ids the
first runs may take. The example names Eve, so on any other mini also `mini`,
`repo.path` and `pluginRoot` (`/Users/<agent>/polads`,
`/Users/<agent>/dev-tasks/plugin`). Each mini lists every other agent's bot
in `slack.otherAgentBots` (`runtime/slack/README.md`): add the new agent's to
the minis already running too, and restart their bridges
(`launchctl kickstart -k gui/$(id -u)/eu.polads.slack-bridge` on each). The
`PAUSE` file keeps anything from being developed or refined before someone
is watching.

`worker.autoMerge` decides whether this mini's PRs merge on their own.
Supervised phases set it to `false`, as the example does: the worker still
opens the PR, and the PR and its Slack notice say "auto-merge off on this
mini: a person merges". With `true` (the default when it is left out),
auto-merge is armed whenever the project's policy for the base branch is
`auto-after-checks-and-review`. The worker reads it at the start of each
job, so a change needs no restart.

`retro.enabled` turns on the weekly retro (section 11, The weekly retro) on
this mini. Only one mini, the coordinator, has it on. It is off by default,
as in the example. The retro pushes a branch to STEP-Network/dev-tasks with
the mini's own GitHub login, so that login needs write access there: without
it every retro ends at the push, says so in Slack, and opens no PR.

## 7. The first interactive run, and the plugin (at the mini or over Screen Sharing)

Once, with the permission mode the front door uses, so its one-time prompts
are answered by a person now and never block an unattended start later:

```bash
cd ~/polads && claude --permission-mode auto
```

Accept the folder-trust and auto-mode prompts, then inside Claude Code:

```
/plugin marketplace add /Users/<agent>/dev-tasks
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

From the mini's own Terminal, in person or over Screen Sharing, not over
SSH: the login keychain, which holds the Claude Code and gh logins, is
locked in an SSH session ("User interaction is not allowed"), so `claude
auth status` and `gh auth status` fail there although both work in the
automatic-login session. The first install and any check of those logins
(`claude auth status`, `gh auth status`, `agentctl doctor`'s `claude login`
and `gh` lines) belong in the mini's own Terminal. Over SSH, doctor reports
those two as "can't check over SSH (login keychain)" instead of failing,
and install.sh says the same when it finishes. The LaunchAgents run in the GUI
session and use its keychain, so agentd, the bridge, the front door and the
workers are not affected. Everything else works over SSH. `agentctl
probe-sandbox`, `probe-hooks --scripted` and `resume` need no login from
there, only a terminal: `ssh -t`. The real-model `agentctl probe-hooks`
uses the Claude login, so it belongs in the mini's own Terminal. The rules
for running steps over SSH are under Orchestrator access, near the end.

```bash
bash ~/dev-tasks/runtime/scripts/install.sh
```

It runs `agentctl doctor --fresh` first and writes nothing while a line says FAIL:
the profile, the configuration, the one mini name, the secrets files'
modes, the git identity, the GitHub login and its push access, pnpm and
Node against PolAds's floors, tmux, jq, Claude Code and its login, the
checkout and the plugin. Then it writes
`~/.agentd/bin/{agentctl,trackerctl,statusline}`, renders the front door's
settings to `~/.agentd/front-door-settings.json`, records the absolute paths
of `claude` and `tmux` in `config.json`, and loads the two LaunchAgents with
an explicit PATH it has checked. A LaunchAgent gets no login shell's PATH, so
that PATH is made of the directories where install.sh found node, pnpm,
claude, tmux, gh, git and jq: on Eve's mini the standalone pnpm in
`~/Library/pnpm/bin` is the pnpm launchd runs. Run install.sh again after
any change to a tool's location: it is idempotent.

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
- `agentctl resume`, `retry`, `probe-hooks` and `probe-sandbox` are denied,
  and agentctl refuses them anywhere but at a person's terminal: only a
  person on the mini lifts a pause or a block.
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

Then, within two minutes, `agentctl status` reads, line by line: `<agent> PAUSED
(first start, not watched yet)`, `agentd: running`, `front door: running`
with a wakeup 0 or 1 min ago, `worker: idle`, `bridge: connected`, a
`usage:` line with numbers, and `linear: ok (<agent>@polads.eu)`.

- `tmux -L agentd attach -t =frontdoor` shows the front door (detach with
  Ctrl-b then d). The front door has a tmux server of its own, so plain
  `tmux ls` does not list it, and a tmux a person starts can never hand it
  that person's environment. If it waits at a permission prompt, answer it
  once and write down which: the front door runs with
  `--permission-prompts none`, which Claude Code documents for `--print`
  only, and the rehearsal checks what an interactive session does with it.
- On the phone or claude.ai, signed in as `<agent>@polads.eu`, the front door appears under
  Remote Control. If it does not, attach, run `/remote-control` once, and
  detach.
- `~/.agentd/bin/agentctl probe-hooks --scripted` (free, a few seconds, no
  login): a worker session with the worker's own settings, on the Claude
  Code workers run (the Agent SDK's, not the front door's), in a throwaway
  home and repository, against a local fake of the Messages API that
  attempts each command the guards refuse. Every line must say `ok`, and
  the last `the worker's hooks fire on <version>`. It records the binary and
  the version it passed on, and doctor's `hooks probe` line trusts the
  worker's hooks only on those. If a line says FAIL, keep the mini paused
  and report it: workers would run unguarded.
- `~/.agentd/bin/agentctl probe-hooks` (a few cents, from the mini's own
  Terminal: it uses the Claude login): the same with a real model, which
  also shows the worker authenticates on the subscription. Expected:
  `"pluginHookFired":true`, `"workerGuardFired":true`,
  `"loadedPlugins":["dev-tasks"]` (with Claude Code's own built-in plugins
  beside it, if any), `"apiKeySource":"none"`, and exit 0. A model may
  decline a destructive command, which reads as a hook that did not fire:
  the scripted probe is the one to trust for the hooks. Doctor accepts
  either as proof.

Then `~/.agentd/bin/agentctl resume` when someone is watching. It, and
the probes, run only at a person's terminal: over SSH use `ssh -t`.

## 10. Watching it

- `~/.agentd/bin/agentctl status`: every part in one screen, with agentd's
  own error when it could not start, the pause's reason, and the issues held
  back.
- `~/.agentd/bin/agentctl report --days 7`: jobs, PRs, spend, questions,
  usage, pauses, and the weekly retro's numbers with the first-pass trend
  week by week, beside the baseline (8 of Eve's first 9 PRs needed a second
  pass, 2026-09-25).
- `~/.agentd/bin/agentctl retro`: the PR the weekly retro would open now,
  with this week's numbers and recurring misses, and its Slack summary. It
  runs no session and writes nothing.
- `~/.agentd/bin/agentctl doctor`: the install's checks, any time.
- `tmux -L agentd attach -t =frontdoor`: the front door. Do not type into it
  while it works. Pause first.
- Remote Control on the phone or claude.ai, signed in as `<agent>@polads.eu`.
- Logs in `~/.agentd/logs/`: `agentd.log`, `slack-bridge.log`,
  `worker.log`, `worker-<job>.log`, `ledger.jsonl`, and the two
  `*.launchd.log` files for a crash before a process's own log started.
- Slack: `#polads-agents` shows claims, PRs, parks and alerts, each starting
  `<agent>:`. `#polads-questions` has one thread per issue that needs a person.

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

A job that ended blocked left its issue On hold, and its commits on the
issue's branch. Once the cause is fixed, retry it:

```bash
~/.agentd/bin/agentctl job list                      # the job's id, e.g. STEP-3184-20260925071840
~/.agentd/bin/agentctl retry STEP-3184-20260925071840
```

The new job takes the issue On hold, carries the branch's commits on, and
tells the worker why the earlier job ended, so it checks the work rather than
redoing it. A job whose report only lacked its form (a PR title, say) no
longer ends blocked while it has commits: the runner asks the same session
once for the report, then titles the PR from the newest commit, and the PR
says so.

Every develop and revise worker runs a self-check before it reports
(STEP-3284): a one-hop sweep from each change (sibling call sites, public
outputs and exports, caches and their version keys, crons, reminders and
emails, docs and comments, translations), and one deliberate mutation of the
invariant per new guard test, shown failing and then reverted. Its report
answers the checklist, the searches with their commands, and lists the
mutations, and the PR shows both. A report without them is asked for again
the same way, with turns for the sweep. If they still do not come, the PR
goes out with the gaps named for the reviewer ("Not answered by the worker:
..."). No job ever stops on the checklist alone, a revise round with nothing
new to push included: it replies on the PR all the same. A small change
(three code files at most, tests aside, and none for a revise round that only
answers) may give a reason instead of a search command, `none: only the copy
changed`, unless the answer says it searched: then it shows the command.
`agentctl report` counts how often each happened.

### Its own PRs

A PR the mini opened comes back to it on review feedback (STEP-3274):

- a review with changes requested, by anyone but the agent
- a required check its code failed: Claude review's blockers, Test, Lint,
  TypeScript, i18n
- a PR comment starting `@<agent>`, or carrying "Review fixes requested", by
  a member, owner or collaborator of the repository (GitHub's author
  association). A bot's comment never counts, nor one from anyone else who
  can comment. The Slack side has its own gate: `slack.allowedUsers`.

agentd's PR watcher, every 15 minutes, queues a `revise` job for the issue,
ahead of new work. The worker continues the PR's branch as origin has it (a
person's commits included), with the reviews, comments, code comments and
failing logs in its brief. The runner pushes to the same branch, never
forced, and replies on the PR point by point. The issue stays In Review,
and `#polads-agents` says `<agent>: STEP-<n>: I am fixing the review comments
on PR #<n> (...), try 1 of 3. Nothing needed from you.`

A round that stops for the same reason as the round before it on that PR asks
nobody again: it pushes what it has, notes on the PR what is left for the
reviewer, and says so in the issue's thread, where the last question was.

Every message a person reads in Slack is in plain words (`runtime/src/plain.ts`,
and the front door's rule in its skill): what happened, what the agent did,
and the one thing it needs, or "Nothing needed from you."

A failure of CI's infrastructure is not the code's: a Neon 404, ECONNRESET,
a runner that lost its connection, a cancelled run, a skipped shard. The
watcher re-runs that workflow run in full, never with `--failed` (Test shards
share a database branch the first run tore down), once per head commit.
Failing on the infrastructure again, it goes to the issue's thread for a
person.

After three rounds on one PR the agent asks in `#polads-questions` and stops
revising it. It never dismisses a review, a person's or a bot's. To have it
fix something, comment on the PR starting `@<agent>`.

A PR that GitHub cannot merge into its base (`mergeable: CONFLICTING`,
`mergeStateStatus: DIRTY`) comes back too, once per head commit (STEP-3340).
`UNKNOWN` waits for the next watch, since GitHub works it out only after a
read asks. The runner starts `git merge --no-ff origin/<base>` in the
worktree, outside the sandbox: the sandbox cannot fetch, and the merge may
bring agent configuration the sandbox keeps read-only. A clean merge is
committed there. Otherwise the brief names the conflicted files, and the
worker resolves them hunk by hunk, keeping both sides' intent. It never
rebases, never takes one side of the whole merge (its guard refuses `git
rebase`, `-s ours`, `-X ours|theirs`, and `--ours|--theirs` on anything but
one named file), and runs the tests the conflicts touched, then commits.
Commits that add a conflict marker (`<<<<<<<` or `>>>>>>>`) over both the
branch and the base are never pushed, in a revise round or a develop job: a
Markdown or YAML file passes CI with one. The round stops and asks what next. The plugin's
secrets scan (1.3.4) reads a merge commit's own lines, what differs from the
branch merged in, so a fixture the base gained never blocks it. A conflict that
needs a product decision is a plain-English question in the issue's thread.
The runner pushes the merge commit, never forced, and the round then follows
the browser-test rules any revise push follows: auto-merge off, the test,
and on again after a pass. The test reads the PR's own diff against its
base, which after the merge is its own change again.

A round with only the conflict has its own cap, three per PR, and never
counts against the review rounds: a base that keeps moving would otherwise
use them up. Feedback at the same head takes the merge along in its review
round. At the merge cap the agent asks in the issue's thread, once per head.
A PR against another base than the agent's is left to a person.

### Talking with the agent in Slack (STEP-3293)

Slack works like a Claude Code Channel: every message from a person on
`slack.allowedUsers` in a thread the agent owns (an issue's thread), and
every mention of the agent, reaches the front door's own session within
seconds, like a typed prompt. The front door reads it with the issue and the
thread's last question, and answers in the thread in plain words. Nate, on
STEP-3225: a reply of "what do you recommend?" is a question back, not an
answer.

- The bridge stays the front: it takes the message from Slack, drops
  everyone not on the allowlist and every bot, and files it in the inbox. It
  never decides what the words mean, and never records an answer itself.
- The Slack channel (`runtime/src/channel/`, declared by the dev-tasks
  plugin, and approved by the managed settings of section 1) pushes each
  message into the front door's session, and again after a restart or ten
  unclosed minutes. agentd opens it only when config.json and the managed
  settings allow it, and marks that session `AGENTD_CHANNEL=1`, which the
  channel server needs to run.
- The digest offers every message not closed yet, pushed or not. Claude Code
  drops a push for a channel it did not register and says nothing, so the
  digest is what makes sure the front door reads every message, at its next
  wakeup at the latest. A message still open after 30 minutes is a health
  problem.
- The front door decides what a reply is:
  - a decision: `agentctl decide` records it on the issue in words that stand
    on their own ("Nate agreed with the recommendation: use the publication
    date", with their own words beside it, never a bare "yes"), moves the
    issue on as an answer always did, and thanks them in the thread. A "yes"
    agrees to the question they answered, the last one asked before their
    reply. The agent asks again instead when a newer question came after
    the reply, when it wrote in the thread in its own words after the
    question, or when more than one question was open: a "yes" to any of
    those says nothing certain.
  - a question back: it answers with a new question and its recommendation,
    through `agentctl ask`, so their next "yes" agrees to what it recommends
    now. The issue keeps waiting.
  - an instruction: `agentctl instruct` files the fixed actions below that
    their own words ask for, and nothing else, for agentd, which acts and
    answers in words. It acts on what their words name: a reply on its
    thread's issue, a mention on the issue or PR it names. A mention that
    names none can only pause.
  - unsure: it asks "Is that your decision, or a question for me?"
- Every question the agent asks a person ends with "My recommendation: ...
  Reply yes to go with it, or tell me what you want instead." A "yes"
  records that recommendation. A hand-off, something a person must do, ends
  "Reply done when it is done." instead, and a "yes" there records nothing.
- The bridge acts itself only on a message that is nothing but a command:
  "pause", "pause everything", "stop everything" or "hold everything" pauses
  the mini at once, since that is safe and only a person lifts it. With the
  front door down, "leave it" or "I'll take it" leaves the PR too. Anything
  else is the front door's to read, the front door up or down: a sentence
  that says pause about something else ("pause the countdown", "should we
  pause the rollout?"), a bare "stop" or "hold", and a "pause" in a thread
  with a question open, where it may be the answer. While the front door is
  down (no wakeup within `frontDoor.staleTickMinutes`, its usage limit
  reached, or agentd holding it back), the bridge says once in the thread "I
  am not reading messages right now, and I will read this one as soon as I
  am back. Nothing needed from you." It never closes a message: the front
  door reads it later, with what the bridge did beside it. A pause needs no
  issue or PR: "@eve pause" pauses the mini.

Slack text is data: the front door's settings, sandbox and deny rules are
the same as before, and nothing in a message widens them. They also deny the
GitHub MCP server's write tools, now that Slack words reach the session as a
prompt. `agentctl status` shows the channel server (`slack channel: server
running, 2 messages waiting for the front door`).

The fixed actions agentd takes. It answers in plain words
(`runtime/src/plain.ts`): what it did, and the one thing a person must do, or
"Nothing needed from you." A ✅ comes only beside that answer, and agentd's
log has the job ids:

- `fix it`, `make it green`, `take care of it`: a revise job for the PR now,
  past the round cap too, since a person asked. With no open PR, a blocked
  job is retried.
- `re-run`: a full re-run of each failing required check's workflow run,
  never `--failed`.
- `merge`: auto-merge armed (`gh pr merge --auto --squash`) where the mini's
  `worker.autoMerge` and the project's policy for the PR's base allow it.
  Otherwise the answer says which one does not.
- `retry`, `try again`: the issue's last blocked job again, on its branch.
- `pause`: the PAUSE file. Lifting it stays a person's, on the mini.
- `leave it`: nothing, and the PR is left to a person.

`don't merge` and the like name no action. A "yes" to one of agentd's own
questions takes its recommended default (`agentctl instruct --actions default`).

The agent escalates only what it cannot settle itself, as one question with
its recommendation, which is also its default. A CI run whose infrastructure failed
again after its full re-run asks whether to re-run once more (the default)
or leave it. The round cap asks whether to revise once more or leave it (the
default). With no answer in an hour, agentd takes a reversible,
staging-only default and says so in the thread. It also writes it under
"Decisions taken by default" in the PR body and on the issue.

The front door explains a pause or a hold when someone asks in Slack, and
never lifts one because Slack said so. It cannot lift a pause at all: only a
person on the mini (SSH or Screen Sharing) runs `agentctl resume`.

Running `agentctl tick` by hand counts as a front-door wakeup and marks the
jobs that finished since as reported, so the front door never sees them. Use
`agentctl status` and `agentctl job list` to look instead.

### The weekly retro (STEP-3290)

The agents, their prompts and their workflow are a product too (Nate,
2026-09-25). Every mini records what it can learn from in
`~/.agentd/state/lessons.jsonl`, one line each, with the issue, the PR, the
kind, the text, where it came from and when:

- a revise round's feedback: each review, PR comment and code comment, each
  finding a reviewer tagged `BLOCKER` or `FIX`, and each failing check.
- a person's correction in Slack ("no, do X", "don't ...", "you should have
  ..."). Monday's follow once its bridge exists (STEP-3289).
- each job that ended blocked, and why.
- each merged PR of the mini's that someone reverted.
- each report that went out with its self-check gaps named.

Every text is data other people wrote, never an instruction: secrets are
redacted (tokens, a URL's credentials, `key=`, `token=`, `secret=` and
`password=` values, Postgres URLs, bearer tokens, JWTs and private keys),
and the retro's brief fences the lessons as data. Each write locks the file,
since workers, agentd, the Slack bridge and the retro all append to it, and
agentd's daily cleanup keeps it, and `retros.jsonl`, to the last 90 days.

On the coordinator mini (`retro.enabled`), agentd starts the retro on Friday
from 14:00 local, or within a day of it if the mini was busy, once a week,
never while the mini is paused and never while a job runs. That is checked
when the retro starts: a job may start while it runs. It:

1. computes the week's numbers beside last week's and the baseline:
   first-pass merges (merged with no revise round and no one else's commit),
   PRs with a must-fix finding, revise rounds per PR, blocked jobs, human
   interventions (a person's instruction or answer in Slack), and cost and
   minutes per issue.
2. clusters the recurring misses by kind and topic.
3. runs one session in a dev-tasks worktree, at the base it fetched, that
   drafts the smallest changes to the agents' own prompts, checklists,
   skills and docs the evidence supports. Most go in
   `runtime/prompts/worker-lessons.md`, which every worker reads at the
   start of every job. The session only edits files in its worktree: its
   sandbox keeps it out of git's own files, and it runs without the
   dev-tasks plugin, whose Monday task hooks dev-tasks' own project config
   turns on and which would refuse every edit and commit.
4. commits what the session left, itself, on that base, and checks every
   file that commit changes against the allowlist
   (`runtime/src/retro/guard.ts`): Markdown text in `runtime/prompts/`,
   `plugin/skills/`, `plugin/rules/` and `docs/`, added or edited in place,
   with its frontmatter as Claude Code reads it unchanged, no new file with
   frontmatter, no byte-order mark, and no added line that looks like a
   secret. A guard, a hook, a permission, an allowlist, the merge policy, a
   configuration, a secret or any code fails it, and then no PR opens at
   all.
5. keeps anything private out of dev-tasks, which is public. The PR's body
   carries only the numbers, the misses' kinds and counts, and one general
   line per change. No added line of the diff, and no line of the body, may
   name a Slack member id, an email, a link to PolAds (its repository or a
   `polads.eu` host), a person on the Monday board by name, or a Monday id
   from `config.json`. One such line and no PR opens, with a plain note in
   `#polads-agents` that names the kind, never the words.
6. files the evidence privately: one Linear issue in STEP, in Triage,
   labelled `dev-tasks` and `retro` (the runner creates the `retro` label
   the first time), with the session's summary, the quoted lessons, the
   issues and PRs they came from, and each change's evidence. If Linear does
   not take it, nothing is pushed.
7. pushes that commit by its id and opens ONE dev-tasks PR, which names the
   evidence issue (STEP-n) and links itself on it. It never auto-merges: a
   person reviews and merges it like any other.
8. posts a plain-English summary in `#polads-agents` (and to Monday, once
   the retro's FYI goes through the bridge).

A change is kept only while its number does not get worse: the next retro
proposes taking back a merged change whose number got worse, with the
before and after in its PR. `agentctl retro --run` starts one now, at a
person's terminal. Its log is `~/.agentd/logs/retro-<date>.log`, and
`~/.agentd/state/retros.jsonl` keeps each one's numbers and changes.

The numbers are this mini's own: a second mini's lessons and ledger stay on
that mini.

## 12. Updating

```bash
~/.agentd/bin/agentctl pause --reason update
cd ~/dev-tasks && git pull --ff-only
(cd plugin && npm ci) && (cd runtime && npm ci)
bash ~/dev-tasks/runtime/scripts/install.sh      # re-renders, restarts agentd and the bridge
~/.agentd/bin/agentctl probe-sandbox             # every line ok, or stay paused
~/.agentd/bin/agentctl probe-hooks --scripted    # every line ok, or stay paused
tmux -L agentd kill-session -t =frontdoor        # agentd resumes it within 15 seconds, on the new plugin
~/.agentd/bin/agentctl resume
```

Claude Code does not update itself on the mini (`DISABLE_AUTOUPDATER` in
agentd's LaunchAgent and in `~/.zprofile`), and agentd starts the front door
only on the `claude` the sandbox probe last passed on, at the path and the
version it recorded: until then it keeps the mini paused, and `agentctl
status` says why. To update it: pause, `claude update`, `agentctl
probe-sandbox`, restart the front door as above, resume. `cd
~/dev-tasks/runtime && npm test` runs the same probe with the SDK's own
binary.

Workers run a different Claude Code: the one the Agent SDK ships, in
`~/dev-tasks/runtime/node_modules`, which `npm ci` changes when the pull
brings a new SDK. So `agentctl probe-hooks --scripted` comes after every
update, and doctor's `hooks probe` line warns while its record names
another binary or version than the one workers run now.

The front door's plugin comes straight from `~/dev-tasks/plugin` (section
7), so the pull updates it and the restart loads it. If `/plugin` in the
front door still shows the old version (a later Claude Code that copies a
directory marketplace to its cache), remove
`~/.claude/plugins/cache/dev-tasks-marketplace`, attach, run
`/plugin install dev-tasks@dev-tasks-marketplace`, and restart the session.

Node and pnpm have no pin to move with: `brew upgrade node` from the admin
account, and `pnpm self-update` as `<agent>` for pnpm's own installer (or
`brew upgrade pnpm` for Homebrew's). An update in place keeps the path the
LaunchAgents' PATH names. A tool that moves, from Homebrew to pnpm's own
installer say, needs install.sh again, which checks and records the PATH
anew. Then `agentctl doctor`: it warns while either is below PolAds's floors.

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
   the agent holds in Linear, on the mini:
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
   assigned to the agent) can stay, or be unassigned with
   `~/.agentd/bin/trackerctl update STEP-<n> --assign none`. A worker's open PR is an
   ordinary PR: let it merge, or close it with `gh pr close <n> --comment "<why>"`.
   Post one line in `#polads-agents` saying `<agent>` is off.
3. **Revoke access** (the mini leaves for good, or is lost): in Slack, the
   app's Install App page, Revoke Tokens, or remove the app. On the mini,
   delete `~/.config/agentd/*.env` and `~/.config/linear/.env`,
   `gh auth logout`, `claude auth logout`. If the mini is lost, revoke its
   agent's GitHub, Linear, Claude and Slack access from each service.
4. **Code**: nothing needs reverting for people. The runtime and the two
   skills only run on a mini. If a laptop flow broke on the plugin, go back
   to the previous plugin release.

## The Monday board (the coordinator mini, STEP-3289)

People live in Monday. Linear stays the engineering record, and the board
(AI Workspace, board 5104953028) shows people what they need to see or do.
Exactly one mini runs the Monday bridge, Eve's first: agentd reads the board
every 2 minutes, or less often when the account's API calls would not
stretch to that (below). No other mini turns it on, or every request would
be filed twice.

What it does:

- **Needs you.** One item per Linear id for this mini's open decisions (the
  questions agentd asks with a default, section 11), an issue labelled
  `needs-human`, and an issue On hold for a worker's question
  (`awaiting-answer`) or a person's to-do (`human-todo`). Each item has its
  Kind, the Person (the issue's owner, else its requester, when they are one
  of the people below, else the default person), the Agent, the Linear and
  PR links, and the Due date. Its text is plain English, with the question
  as the agent asked it when this mini asked it. A decision there names each
  reply to write, the default marked with its time: the fixed verbs read
  Monday's words, so a bare "yes" there acts on nothing before the default's
  time, where in Slack the front door takes it at once (STEP-3293).
- **Answers.** A person's update on an item (or a reply under one), or the
  Answer column, is always added to the issue under "## Answers from
  Monday", so the issue keeps it. Where this mini has work of its own on
  the issue (a PR it opened and still watches, an open decision it asked,
  or its most recent job there ended blocked), the fixed verbs of section
  11 (fix it, re-run, merge, retry, pause, leave it) are also an instruction
  agentd acts on within seconds and answers on the item, with a like on the
  update. Otherwise, and always on a request, the words are an answer (a
  plain "yes" to a question that recommended something is recorded as that
  recommendation, as in Slack, through the same code). Words written before
  this mini's newest question on the issue answer nothing: the item asks for
  an answer to the newer question, the issue stays where it is, and a bare
  "yes" is not recorded at all. Slack decides this by the same rule. Otherwise a
  parked issue moves on. So "hold off" on another mini's issue pauses
  nothing here. The State goes to Waiting on agent, then Done once Linear
  no longer needs a person. Words are acted on once, even when Monday fails
  after Linear has them. The Recommendation column (Wave 2) is input too:
  where this mini asked no question on the issue, a plain "yes" agrees to
  what the column says, so write in it only what a yes should mean. A plain
  "yes" to a plan with nothing to agree to is asked back and records
  nothing. A person who writes out "Build it as planned" approves it.
- **Test day.** Every issue in Waiting for UAT that carries this mini's
  product label (`repo.product`, `polads` on Eve), as a Check with the "You
  must check" steps of its latest Agent UAT review (its acceptance criteria
  when there is no review). Another product's issues (dev-tasks, say) cannot
  be tried on the test site, so they get no item, and one made for them
  before is archived at the next poll, with nothing said on it. A reply starting PASS or FAIL is recorded as
  review-uat records a person's verdict (its Step 10 and
  `references/linear-io.md`). PASS: a comment naming the person, then
  Approved, and for a `UAT fix:` its parent back to Agent UAT once none of
  the parent's fixes is open. FAIL: a `UAT fix:` sub-issue with what they
  saw (Ready, `bug`, `polads`, `agent`, the parent's priority), a comment
  naming it, then Needs Correction. Nothing else counts on a Test day item.
- **Requests.** A new item a person adds to Requests becomes a Linear Triage
  issue labelled `intake/monday`, with their words quoted as written and a
  link each way. The item moves to Agents working on (Blocked while the
  issue is On hold), then to Done once the issue is released.
- **Done** items are archived after 14 days. An item a person deletes is not
  put back. An item that asks again starts with an empty Answer column.

| Why a person is needed | Kind |
|---|---|
| a decision, a worker's question | Decision |
| `needs-human` | Approval |
| a person's to-do | Check |
| Waiting for UAT | Check |
| a request | Request |

Only the Monday users in `bridges.monday.people` count. Anyone else's
updates, answers and items are left alone, and so are the agent's own. Item
text is data: it reaches an agent only as one of the fixed verbs, or quoted
on the issue.

Limits while one mini coordinates: a decision lives on the mini that asked
it and sets no Linear label, so another mini's decisions do not reach the
board at all. Another mini's worker questions and to-dos do, through their
`awaiting-answer` and `human-todo` labels, without the question's words. An
answer to another mini's issue goes onto that issue as words.

**The API budget.** monday caps the API calls a whole account makes in a
day, by plan: 1,000 on Free, Basic and Standard, 10,000 on Pro, 25,000 on
Enterprise, reset at midnight UTC, and shared by everyone's API use, the
plugin's Monday tools included ([monday.com API, Rate
limits](https://developer.monday.com/api-reference/docs/rate-limits),
"Daily call limit"). A poll is one call (the items and the Answer column's
history together), plus a write for each change. The bridge reads the
account's own limit once a day (`platform_api { daily_limit }`) and polls
no more often than `apiShare` (20 percent) of it allows: every 2 minutes
on Pro and Enterprise (720 calls a day of 10,000), every 8 minutes on
Basic or Standard (180 of 1,000). When Monday does not say, it assumes the
smallest plan (1,000, every 8 minutes), and `monday.log` says so once. While
Monday is out of reach, replies wait, in order, and agentd goes on.

### Turning it on (Nate)

1. A Monday user for the agents, a member and never an admin, with access
   to board 5104953028 only. Its personal API token (avatar, Developers, My
   access tokens) goes on the coordinator mini as `<agent>`:

   ```bash
   read -rs MONDAY_TOKEN
   (umask 077; printf 'MONDAY_API_TOKEN=%s\n' "$MONDAY_TOKEN" > ~/.config/agentd/monday.env); unset MONDAY_TOKEN
   chmod 600 ~/.config/agentd/monday.env
   ```

   The bridge refuses an admin's token, and the token of any of the people.
   Check the token once, live, before turning the bridge on: the user must
   not be an admin, and Monday should name the account's daily limit. The
   token goes to curl on stdin, never in its arguments:

   ```bash
   ( . ~/.config/agentd/monday.env; printf 'header = "Authorization: %s"\n' "$MONDAY_API_TOKEN" ) \
     | curl -s --config - https://api.monday.com/v2 -H 'Content-Type: application/json' -H 'API-Version: 2025-10' \
       -d '{"query":"query { me { is_admin } platform_api { daily_limit { base total } } }"}'
   ```

   Expect `"is_admin":false` and a `total`. Without a `total`, the bridge
   assumes 1,000 calls a day and reads the board every 8 minutes.
2. The people's Monday user ids: the number at the end of each person's
   Monday profile link.
3. In Linear, the labels `intake/monday` and `needs-human` (both made on
   2026-09-25). Without `intake/monday` requests are still filed,
   unlabelled, and `monday.log` says so once.
4. In `~/.agentd/config.json` on the coordinator mini:

   ```json
   "bridges": {
     "monday": {
       "enabled": true,
       "people": [
         { "id": "<Nate's id>", "name": "Nate", "linearEmail": "<his Linear email>" },
         { "id": "<Kristoffer's id>", "name": "Kristoffer", "linearEmail": "<his Linear email>" },
         { "id": "<Tomas's id>", "name": "Tomas" }
       ],
       "defaultPerson": "<Nate's id>",
       "agentLabels": ["Eve", "Bob"]
     }
   }
   ```

   The ids and emails stay out of this repository, which is public: the
   orchestrator has them. A person without a Linear account (Tomas, for
   now) has no `linearEmail`, and gets items only as the default person or
   by hand. `agentLabels` names the Agent column's labels for the agents'
   Linear accounts, so an issue another agent holds shows its name. Left
   out, only this mini's own label (`agentLabel`, its name capitalised) is
   used.
   Everything else defaults to the board as it was built on 2026-09-25: the
   board and column ids, the group names (Needs you, Test day, Requests,
   Agents working on, Done), `pollMinutes` 2, `apiShare` 0.2,
   `requestLabel` and `archiveAfterDays` 14. The bridge never creates a
   label, so the Kind, State and Agent labels must exist on the board as
   named.
5. `~/.agentd/bin/agentctl doctor` (its `monday token` line), then restart
   agentd: `launchctl kickstart -k gui/$(id -u)/eu.polads.agentd`. With the
   bridge on and no token, agentd does not start, and `agentctl status`
   says why.
6. Watch `~/.agentd/logs/monday.log`. The first poll says how often the
   board is read, and the first items appear within that.

To turn it off: `"enabled": false`, and restart agentd. The items stay on
the board as they are.

### No agent session writes as a person (the people-doors guard, STEP-3330)

The bridge takes a Monday user's update or Answer column as that person's
words, the Slack bridge takes a Slack member's message as theirs, and the
answer recorder trusts the answer entries and plan labels on a Linear issue.
The Monday, Slack, Linear and dev-tasks tools a Claude session has write as
the person whose account they use, so an agent session that used them would
be taken for one of the people, or for the recorder. The rule: **an agent
session never writes on the people's boards, in their Slack channels, to the
agents, or as the answer recorder.**

The dev-tasks plugin's people-doors guard holds to it in every Claude
session that has the plugin, on both profiles, with no opt-in. It goes by
the server's name: any server whose name says monday, slack, linear or
dev-tasks (the claude.ai connectors, the dev-tasks plugin, the hosted Dev
Tasks server, or any other). It refuses:

- On Monday and dev-tasks: reads pass. Anything else passes only when it
  touches none of the people's boards. The guard reads which board every id
  in the call is on (one Monday read with the person's `MONDAY_API_KEY`, up
  to 5 seconds), and refuses a people's board, an item or update on one (a
  subitem counts on its parent's board), `execute_code` (which can build any
  id), and any write it cannot check.
- On Slack: reads pass. Anything else (a message, reply, schedule, draft,
  reaction or edit) is refused when it names a people's channel (by id, or
  by name with or without `#`) or an agent's bot (a direct message by the
  bot's user id, a `<@…>` mention anywhere, or its name typed as `@eve`,
  which Slack turns into a mention when a message is sent with `link_names`).
- On Linear: an answer entry (`<!-- slack:…`, `<!-- monday:…`,
  `<!-- slack-user:…`) and the recorder's plan labels (`plan-to-approve`,
  `plan-approved`, by name or id), on a new issue or an existing one, added
  or taken away, or another label renamed to one. An existing issue's labels
  replaced wholesale. A description edit or patch that adds, changes or
  takes out an answer entry: the guard reads the description as it stands
  (the Linear key, `LINEAR_API_KEY` or `~/.config/linear/.env`) and applies
  the patch first. An edit that keeps every entry passes.
- From the shell: any command that names `api.monday.com` or
  `api.linear.app` (and so `client-api.linear.app`), reads included. The
  Monday and Linear tools cover reads, and no rule on a request's body can
  see a mutation the shell builds from a file, a variable or a pipe. A Slack
  write method (`chat.`, `reactions.`, `files.`, `conversations.open` and the
  like) to `slack.com/api`. And `sudo` on its own list.
- A guard that cannot run refuses: with no `node` on `PATH`, a Node that
  fails, or a tool call it cannot read, every guarded call is refused.

**What it costs outside PolAds**, since the plugin is user-wide:

- Every Monday or dev-tasks write that names an existing board, item or
  update waits for one Monday read. It needs `MONDAY_API_KEY` in the
  environment Claude Code starts with, from an account that can see the
  people's boards. Without it, those writes are refused on every board.
- A description edit on an existing Linear issue, or a label given by id,
  waits for one Linear read. Without a Linear key it is refused in every
  workspace.
- Monday's `execute_code` is refused on every board.
- No shell call to Monday or Linear at all, reads included, and no Slack
  write, from an agent session, on any board, workspace or channel. Even a
  `grep` for the host name is refused: search code with the Grep tool.
- Without `node` on `PATH`, every Monday, Slack, Linear and dev-tasks tool
  that writes is refused.
- Until the list is in place, every Monday, dev-tasks and Slack write is
  refused everywhere (reads pass). So the list goes on in the same step as
  the plugin update that brings the guard.
- Everything else passes as before.

**On an agent mini.** The minis carry no list, and need none. Their sessions
reach Slack and Monday through agentd, not through tool calls that write as a
person:

- The front door replies with `~/.agentd/bin/agentctl slack reply
  --text-file …`, a Bash command that names no API, so the guard never
  sees it.
- The workers have no MCP server at all.
- On the agent profile, the plugin's own dev-tasks server registers no tools.
- The plugin's own Slack channel server (`mcp__plugin_dev-tasks_slack__*`)
  has none today, and would speak only with an agent bot's token, as the
  agent. The guard leaves that one server alone everywhere.

Otherwise the guard does on a mini what it does on a laptop. With no list,
any Monday, dev-tasks or Slack write through a tool is refused: a claude.ai
connector on a mini would write as its account's person. The Bash and Linear
rules hold too.

The dev-tasks server is not exempted by profile. The profile is
`~/.claude/dev-tasks-profile.json` or `DEV_TASKS_PROFILE`, both the
session's to set, so on a laptop such an exemption would reopen
`createUpdate` with the person's key.

Its list is root's, since this repository is public and an agent session
runs as the person: `/etc/dev-tasks/people-doors.json`. The guard trusts it
only when the file and `/etc/dev-tasks` are owned by root and writable by no
one else. It never reads a list from `$HOME`, and no environment variable
moves it. A list that is missing, not root's, or has an empty list in it is
no list: the guard refuses as above.

```json
{
  "mondayBoards": ["1234567890"],
  "slackChannels": ["C0123456789", "polads-questions", "C0123456790", "polads-intake"],
  "agentBots": ["U0123456789"],
  "agentNames": ["eve"]
}
```

- `mondayBoards` are the people's boards: today the Needs-you board, later
  the Requests board too.
- `slackChannels` are the four channels, by id and by name, since a tool may
  take either.
- `agentBots` are the agents' bot users: a direct message to one, or its
  mention in any channel, reaches an agent.
- `agentNames` (optional) are the agents' display names, for a plain `@eve`.

The ids are not secrets:

- the board id is in the coordinator mini's `config.json` (`bridges.monday.boardId`);
- the agents' bot ids are in each mini's `~/.agentd/state/bridge.json` (`botUserId`);
- the channel names are in `slack.channels`, and their ids are in each channel's details in Slack.

Each person sets it once on their own machine, with one command in their own
terminal (the guard refuses it from an agent session). The same command with
the whole new list changes it, for example when a new agent's bot comes:

```bash
echo '{"mondayBoards":["1234567890"],"slackChannels":["C0123456789","polads-questions"],"agentBots":["U0123456789"],"agentNames":["eve"]}' | sudo sh -c 'umask 022 && mkdir -p /etc/dev-tasks && cat > /etc/dev-tasks/people-doors.json'
```

`node <plugin>/hooks/people-doors-guard.mjs check` says whether the guard
trusts it. A machine that never works on PolAds can be taken out of the
guard, by root only:
`sudo sh -c 'mkdir -p /etc/dev-tasks && touch /etc/dev-tasks/people-doors.off'`.

**What it does not do.** It is a guardrail for misled sessions, not a
sandbox. It stops a misled session, not a determined one: a
session set on writing as a person can still find another way (a script
file, a host built from parts, its own environment). Three more doors it does
not see at all:

- **A script that calls the APIs from a file** (python, node, or anything
  else the command runs): only the command's own words are read, never the
  file it runs.
- **The Make connector**, which runs Monday and Slack modules on the
  person's own Monday and Slack connections: a scenario it builds or runs
  writes as the person, and its tools name no Monday or Slack server.
- **Browser and computer-use tools** in a browser where the person is
  logged in to Monday, Slack or Linear: a click there is the person's.

Keep those off in sessions that work on PolAds, or watch them. The detection layer is
#polads-agents: from Wave 2, every plan approval and every lowering of an
approval class from Monday or Slack is announced there, with who approved or
lowered it and where, so a forged one shows. Until then a class is lowered
only in Linear, by the person's own account.

A hook change needs the plugin cache cleared and a reload before it runs
(the plugin version goes up with it).

## The browser test (WS5)

Before any person looks at an agent's PR, the agent clicks it through in a
real Chrome, at desktop and phone width, with screenshots and a GIF on the
PR and the issue. On the PR's Vercel preview it is always signed out: the
preview runs code nobody has reviewed yet, so the test-login secret never
goes there. The journeys that need a staging persona run on staging after
the merge (and on the release candidate once it exists). A headless Google
Chrome runs on the mini, driven by chrome-devtools-mcp 1.9.0 (pinned in
`runtime/package.json`, never fetched with npx), and the browser opens only
the preview and staging.

### Setting it up (Nate, then the orchestrator)

1. **Chrome**, from the mini's admin account:
   `brew install --cask google-chrome`. Version 149 or newer: the browser
   allowlist needs it. Node 22.12 or newer runs the runtime.
2. **The two secrets**, typed on the mini as `<agent>`, the same way as
   section 5, never through an agent's session:

   ```bash
   read -rs LOGIN_SECRET
   read -rs BYPASS_SECRET
   (umask 077; printf 'TEST_LOGIN_SECRET=%s\nVERCEL_AUTOMATION_BYPASS_SECRET=%s\n' "$LOGIN_SECRET" "$BYPASS_SECRET" > ~/.config/agentd/usertest.env); unset LOGIN_SECRET BYPASS_SECRET
   chmod 600 ~/.config/agentd/usertest.env
   ```

   `TEST_LOGIN_SECRET` is the Vercel project's own (staging's test-login
   route checks it), and `VERCEL_AUTOMATION_BYPASS_SECRET` is the project's
   Deployment Protection "Protection Bypass for Automation" secret. Only the
   runtime's own code reads them, from outside the browser: the persona's
   session and the bypass reach Chrome as cookies, and the model never sees
   either secret. The test-login secret goes only to staging and the release
   candidate, never to a preview. Without the file the test runs as a
   visitor who is not signed in, and cannot open a protected preview.
3. **The config**: `usertest` in `~/.agentd/config.json`, the template's
   section with `"enabled": true` and the personas. The persona addresses
   stay in the mini's config, never in this repository:

   ```json
   "usertest": {
     "enabled": true,
     "previewEnvironment": "Preview – v0-politiske-annoncer",
     "previewHost": "^v0-politiske-annoncer-[a-z0-9-]+\\.vercel\\.app$",
     "stagingOrigin": "https://test.polads.eu",
     "extraAllowedUrlPatterns": ["https://api.stack-auth.com/*"],
     "personas": [
       { "id": "<persona>", "email": "<the staging persona's address>", "admin": false, "paths": ["<changed paths that call for it>"] }
     ]
   }
   ```

   A persona whose pages show real people's data (an admin) has
   `"publishScreenshots": false`: its screenshots stay on the mini.
   `previewHost` is anchored with `^` and `$`, because the bypass secret
   goes to any host it matches, and each `extraAllowedUrlPatterns` entry
   names one https host literally. `bootstrap-mini.sh --usertest <file>`
   adds the orchestrator's private file (`enabled` and `personas`) to the
   template's section on a new mini. `--force-config` without `--usertest`
   leaves the section out, which turns the test off.
4. `~/.agentd/bin/agentctl doctor`: the "browser test" lines are Chrome, the
   browser tool, Node and the secrets file, and all must be ok. Then
   `~/.agentd/bin/agentctl probe-browser`, which opens staging and shows that
   any other site is refused, in the page and in a new page, on the real
   Chrome and with no model. A refusal counts only in the browser tool's own
   words ("is blocked by blocklist/allowlist rules"): any other failure says
   the allowlist is not proven, and the test stays off.

### In develop and revise jobs

Once a develop job opens its PR, or a revise round pushes, the agent tests
the PR's preview, signed out. Where the mini may auto-merge, a develop PR
that a user could see waits for the test: auto-merge is armed after a pass,
and also when the test could not run (the PR then says why, and the checks
and the review still decide). A revise round's push switches auto-merge off
until its own test passes. Findings leave auto-merge off, and agentd's PR
watcher sends the blockers and major findings back as a revise round. A
change no user can see (docs, tests, `.claude`, `.github`) is not tested,
and is armed at once. The test's own time is `previewWaitMinutes` plus
`wallClockMinutes`, and runs and verdicts older than 14 days are removed.

### A merged PR's test on staging

`~/.agentd/bin/agentctl usertest --issue STEP-n --pr <number>` queues the
browser test of a merged PR on staging (`--target rc` once the release
candidate exists), as a job of its own: no claim and no worktree. Staging is
where a persona signs in, so this is where the signed-in journeys are
walked. The report goes on the PR and the Linear issue, like a preview's.
A persona whose `publishScreenshots` is false keeps its screenshots on the
mini, under `~/.agentd/usertest/`.

## Orchestrator access over SSH

The orchestrator (the Claude Code session that runs the agents' rollout)
works on a mini over SSH as the agent user, as it does on Eve's. Install its
key once, as `<agent>`, at the mini or over Screen Sharing. Nate sends the
orchestrator's public key, one line starting `ssh-ed25519`:

```bash
mkdir -p ~/.ssh && chmod 700 ~/.ssh
read -r ORCH_KEY
printf '%s\n' "$ORCH_KEY" >> ~/.ssh/authorized_keys; unset ORCH_KEY
chmod 600 ~/.ssh/authorized_keys
```

Remote Login must allow `<agent>` (section 1). From the orchestrator's
machine, `ssh <agent>@<mini> true` then returns with no password.

Over SSH:

- **One step per SSH call.** Each call runs one command,
  `ssh <agent>@<mini> '<command>'`, and its result is read before the next.
  A chain or a piped script hides which step failed.
- **The login shell's PATH is not there.** `ssh` runs a shell that does not
  read `~/.zprofile`. `~/.agentd/bin/agentctl` and `trackerctl` carry their
  own PATH. Any other command runs as `zsh -lc '<command>'`, which reads
  `~/.zprofile` but not `~/.zshrc`, where pnpm's own installer puts
  `~/Library/pnpm/bin`: on Eve's mini `zsh -lc` finds neither pnpm nor
  claude. Name the PATH in front of the command, as bootstrap-mini.sh does:
  `export PATH="$HOME/Library/pnpm/bin:$HOME/.local/bin:/opt/homebrew/bin:$PATH"`.
- **`ssh -tt` only for the person-only commands**: `agentctl probe-sandbox`,
  `probe-hooks`, `resume` and `retry`, which refuse without a terminal. Everything
  else runs without one.
- **No secret on a command line.** The `read -rs` steps (section 5) are typed
  by a person, at the mini or in an interactive `ssh -t` session.
- **The login keychain is locked.** doctor reports `gh` and `claude login` as
  "can't check over SSH (login keychain)": expected. Check them in the mini's
  own Terminal (section 8). The LaunchAgents are not affected. Nor is git
  through gh's login: `git fetch` in `~/polads` fails over SSH with "could
  not read Username". `runtime/scripts/gui-session.sh` runs a command in the
  automatic-login session instead, as a one-shot LaunchAgent, where the
  keychain is open.

### Bootstrapping a mini

Once a person has done sections 1, 2, 4 and 5 and installed the key above,
the orchestrator runs, from its own checkout of dev-tasks:

```bash
runtime/scripts/bootstrap-mini.sh --dry-run --allowed-users <id>,<id> --other-bots <bot id> <agent> <mini>
runtime/scripts/bootstrap-mini.sh --allowed-users <id>,<id> --other-bots <bot id> <agent> <mini>
```

`--allowed-users` are the Slack member ids of section 4, the same on every
mini. `--other-bots` are the other agents' bots (Eve's, for Bob). The SSH key
is `~/.ssh/<agent>_mini_ed25519` unless `--key` names another. The keys and
ids stay out of this repository.

It does section 3: both checkouts, PolAds's dependencies with the agent's
standalone pnpm, the plugin's and the runtime's, and the profile. Then
section 6: `config.json` from the template, with the agent's name and paths,
the allowed users, the other agents' bots, an empty allowlist,
`worker.autoMerge` on, and the template's models and limits, which are Eve's.
Then the first start's `PAUSE`, section 8 (`install.sh`), section 9's
`probe-sandbox` and `probe-hooks --scripted` over `ssh -tt`, `agentctl
status` and `agentctl doctor`.

- One step per SSH call. The first that fails stops the run and names
  itself. Once it is fixed, the same command runs again.
- A checkout that exists is fetched. A `config.json` that exists is kept
  (`--force-config` writes it again). `PAUSE` is written only on a mini that
  had no `config.json`, so a mini a person resumed stays resumed.
- PolAds is private, so its clone and fetch run in the automatic-login
  session (`gui-session.sh`, sent over the same SSH call). dev-tasks is
  public.
- It reads no secret and passes none: the secrets files are checked by their
  mode. `--dry-run` prints every step's command and the `config.json` it
  would write, and runs nothing.

It ends with what is left to a person: section 7 at the mini, then a
restart of the front door, the logins that SSH cannot check, and `agentctl
resume` when someone is watching. It also prints the new agent's bot id,
which the bridge records in `~/.agentd/state/bridge.json` once Slack takes
the app, with the three commands that add it to `slack.otherAgentBots` on
every other mini and restart their bridges.

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
- **`the bot cannot see #polads-...` or `the bot is not in #polads-...`.**
  Add the bot in that channel's settings, Integrations, Add an App. A private
  channel stays invisible to the bot until then.
- **`the Slack app lacks the scope groups:read`.** The app predates private
  channels: update it from the manifest and reinstall it
  (`runtime/slack/README.md`, Updating an existing app).
- **"the dev-tasks plugin loaded 2 times in the worker".** With Claude Code
  2.1.281 the worker's own copy (`pluginRoot`) shadows the marketplace copy
  that PolAds's project settings enable, so it loads once, and
  `runtime/src/__tests__/sessions.test.ts` checks that with the binary the
  SDK ships. If a later version loads both, every job stops at its start
  and `agentctl probe-hooks --scripted` shows it first.
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
