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
  eu.polads.slack-bridge  Socket Mode and the outbox  ~/dev-tasks/runtime/src/slack/bridge.ts
state   ~/.agentd (config.json, queues, jobs, logs, PAUSE)
secrets ~/.config/linear/.env, ~/.config/agentd/{slack,agentd,claude}.env, all chmod 600
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
tools at all).

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
  usage, pauses.
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
goes out with the gaps named for the reviewer. `agentctl report` counts how
often each happened.

### Its own PRs

A PR the mini opened comes back to it on review feedback (STEP-3274):

- a review with changes requested, by anyone but the agent
- a required check its code failed: Claude review's blockers, Test, Lint,
  TypeScript, i18n
- a PR comment starting `@<agent>`, or carrying "Review fixes requested"

agentd's PR watcher, every 15 minutes, queues a `revise` job for the issue,
ahead of new work. The worker continues the PR's branch as origin has it (a
person's commits included), with the reviews, comments, code comments and
failing logs in its brief. The runner pushes to the same branch, never
forced, and replies on the PR point by point. The issue stays In Review,
and `#polads-agents` says `<agent>: STEP-<n> revising <PR> (round 1 of 3)`.

A failure of CI's infrastructure is not the code's: a Neon 404, ECONNRESET,
a runner that lost its connection, a cancelled run, a skipped shard. The
watcher re-runs that workflow run in full, never with `--failed` (Test shards
share a database branch the first run tore down), once per head commit.
Failing on the infrastructure again, it goes to the issue's thread for a
person.

After three rounds on one PR the agent asks in `#polads-questions` and stops
revising it. It never dismisses a review, a person's or a bot's. To have it
fix something, comment on the PR starting `@<agent>`.

### Replies that act (STEP-3285)

A reply in the thread of one of the agent's posts about a PR or a job, or a
mention that names the PR (`@<agent> fix #1679 and merge`, a STEP id or the
PR's link), is an instruction. agentd acts on it within seconds and answers
in words, with the job id and the PR link, and a ✅ only beside that answer:

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

`don't merge` and the like name no action. A reply to a question the issue
waits on, or to a person's to-do, stays an answer, whatever its words.

The agent escalates only what it cannot settle itself, as one question with
its options and a recommended default. A CI run whose infrastructure failed
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
  own PATH. Any other command runs as `zsh -lc '<command>'`.
- **`ssh -tt` only for the person-only commands**: `agentctl probe-sandbox`,
  `probe-hooks`, `resume` and `retry`, which refuse without a terminal. Everything
  else runs without one.
- **No secret on a command line.** The `read -rs` steps (section 5) are typed
  by a person, at the mini or in an interactive `ssh -t` session.
- **The login keychain is locked.** doctor reports `gh` and `claude login` as
  "can't check over SSH (login keychain)": expected. Check them in the mini's
  own Terminal (section 8). The LaunchAgents are not affected.

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
