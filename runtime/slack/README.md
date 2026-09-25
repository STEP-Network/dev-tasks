# The Slack app: one per agent

Every agent mini has its own Slack app (decision 3, 2026-09-24). Socket Mode hands each event to only one of an app's open connections, so two minis on one app would each miss part of the traffic.

`app-manifest.json` is the template all of them share: the scopes, the events and Socket Mode. Only the name differs, and `src/slack/manifest.ts` fills it in. For Eve:

```bash
cd ~/dev-tasks/runtime && npm ci   # Node 20.18.1 or later
npx tsx src/slack/manifest.ts eve > ~/eve-manifest.json
```

That is the app `PolAds Eve` with the bot user `@eve`. The argument is the mini's name exactly as `~/.agentd/config.json` and `~/.claude/dev-tasks-profile.json` spell it, and people mention the bot by it (`@eve the notice page shows the wrong date`).

Then, once per agent (step N2):

1. On api.slack.com/apps: Create New App, From a manifest, pick the workspace, paste the file.
2. Install the app to the workspace. The Bot User OAuth Token (`xoxb-...`) is `SLACK_BOT_TOKEN`.
3. Basic Information, App-Level Tokens: make one with the scope `connections:write`. That token (`xapp-...`) is `SLACK_APP_TOKEN`.
4. Both tokens go in that mini's `~/.config/agentd/slack.env`, chmod 600 (step N3). Each mini holds only its own app's tokens.
5. Add the bot to `#polads-agents`, `#polads-questions`, `#polads-intake` and `#polads-releases`: in each channel's settings, Integrations, Add an App, pick `PolAds Eve`. Not `/invite @eve`, which can pick a person called the same. The bridge refuses to start while the bot is missing from any of them.
6. Once a second agent exists, tell each mini about the other's bot: its member ID (the bot's profile in Slack, More, Copy member ID, or `botUserId` in that mini's `~/.agentd/state/bridge.json` once its bridge has started) goes in `slack.otherAgentBots` in the other mini's `~/.agentd/config.json`, and that mini's bridge is restarted. `runtime/scripts/bootstrap-mini.sh` prints the commands.

## Private and Slack Connect channels

The four channels may be private, and may be Slack Connect channels hosted in STEP Network or shared with it. The bridge lists public channels and the private ones its bot is in, which takes `groups:read`, and hears private channels' messages through `groups:history` and the `message.groups` event. A private channel is invisible to the bot until someone adds it, so the bridge reports it as one the bot cannot see.

In a Slack Connect channel a sender from another workspace carries their own team. The bridge ignores a delivery only when it is for another installation of the app. Who is heard is decided by `slack.allowedUsers`, the member ids.

## Updating an existing app

When `app-manifest.json` gains a scope or an event (the private-channel ones did on 2026-09-24), an app made from the older one needs both:

1. On api.slack.com/apps, the app, App Manifest: paste the manifest `src/slack/manifest.ts` generates now, and Save.
2. Install App, Reinstall to Workspace, and allow the new scopes. The bot token normally stays the same. If Slack shows a new one, it replaces `SLACK_BOT_TOKEN` in `~/.config/agentd/slack.env`.

Then restart the bridge: `launchctl kickstart -k gui/$(id -u)/eu.polads.slack-bridge`. Until then it stops with "the Slack app lacks the scope groups:read".

## Who answers what

The four channels are shared by every agent. Each bridge acts only on messages that mention its own bot and on replies in the threads it owns.

A request in `#polads-intake` that names several agents is filed once, by the first agent it names. That agent owns the thread: the "filed" reply, the questions and every later reply there are its own. Every other agent the request names treats it as an ordinary mention, answered in the same thread, and never applies the thread's later replies as answers: a later reply there that names it is only a mention for it. People named in the request do not count: in `@nate says @eve should fix the date`, Eve files it.

An agent knows the others only through `slack.otherAgentBots`. With the list empty, a request that names two agents is filed by both.
