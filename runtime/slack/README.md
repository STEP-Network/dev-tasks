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
5. `/invite @eve` in `#polads-agents`, `#polads-questions`, `#polads-intake` and `#polads-releases`. The bridge refuses to start while the bot is missing from any of them.

The four channels are shared by every agent. Each bridge acts only on messages that mention its own bot and on replies in the threads it opened. So mention one agent per request: a message in `#polads-intake` that names two bots is filed by both, as two issues, and both then take the replies in its thread.
