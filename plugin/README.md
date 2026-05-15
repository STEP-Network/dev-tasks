# monday-task-flow plugin

Claude Code plugin: stdio MCP server (37 tools) for Monday-driven task-first development.

## Requirements

- Node.js 20+ (LTS)
- `MONDAY_API_KEY` must be exported in the shell that launches Claude Code. The `.mcp.json` cannot interpolate env vars (Claude Code limitation), so the key must come from the parent process environment. Add to your `~/.zshrc` / `~/.bashrc`:
  ```sh
  export MONDAY_API_KEY="..."
  ```

## Install

From any project where you want the tools available:

```sh
/plugin marketplace add /Users/nate/dev-tasks-mcp
/plugin install monday-task-flow@monday-task-flow-marketplace
/reload-plugins
```

## Layout

```
plugin/
├── .claude-plugin/plugin.json     # plugin manifest
├── .mcp.json                      # registers the monday-tasks stdio server
├── package.json                   # @modelcontextprotocol/sdk + zod + tsx
├── tsconfig.json
└── src/
    ├── server.ts                  # stdio MCP entry — registers all 37 tools
    ├── monday-client.ts           # Monday GraphQL client (reads MONDAY_API_KEY)
    ├── constants.ts               # board / column / status maps
    ├── schemas.ts                 # Zod schemas for all 37 tools
    └── tools/                     # one file per tool, plus utils + index
```

## Dev

```sh
cd plugin && npm install     # install deps
npm run typecheck            # tsc --noEmit
npm start                    # run the stdio server (responds on stdin/stdout)
```

After editing **MCP code**, you must fully restart Claude Code — `/reload-plugins` does not kill the MCP process. Skills / hooks / rules are filesystem-rescanned on `/reload-plugins`.

## Tools

37 tools across these phases: Discovery, Context, Execution, Creation, Shipping, Communication, Epic Management, Feedback & Requests, Retrospectives, Public Roadmap, Structured Changelog, UAT Docs. See `src/server.ts` for the full registration list with descriptions.
