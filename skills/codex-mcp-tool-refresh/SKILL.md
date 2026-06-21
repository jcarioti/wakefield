---
name: codex-mcp-tool-refresh
description: Use after installing or changing any Codex MCP server, or when debugging why MCP tools are not visible in the live Codex Desktop app.
metadata:
  short-description: Refresh and debug Codex MCP tools
---

# Codex MCP Tool Refresh

Use this skill after installing, removing, or changing any MCP server in Codex, regardless of which project owns that server. Also use it when the MCP config looks correct but tools are missing, stale, or showing the wrong shape in live Codex.

Wakefield provides the reload command, but the refresh target is generic: the live Codex Desktop MCP runtime.

## Rule

After an MCP install or config change succeeds, refresh the live Codex Desktop MCP runtime before telling the user to quit or reopen Codex:

```sh
wakefield mcp reload --json
```

If Wakefield is being run from a project dependency instead of a global command, use the package manager form already used in that project, such as:

```sh
pnpm exec wakefield mcp reload --json
npm exec wakefield -- mcp reload --json
yarn exec wakefield mcp reload --json
```

Run the refresh even when the installer says the config is already present if the user expects the tool to be available now.

## Use For Debugging

Use this command when:

- a newly installed MCP server does not appear in Codex tools
- a tool list is stale after changing an MCP command, args, env, or config file
- Codex shows an MCP server but exposes zero tools
- a tool namespace appears missing even though the config file contains the server

## Interpret The Result

- If the command reports `ok: true`, say the MCP tools were refreshed in the live Codex app.
- If it reports a server with zero exposed tools, inspect that MCP server command, startup logs, env, and schema registration before retrying.
- If remote control is unavailable, ask the user to open Codex or enable remote control, then retry the refresh.
- Recommend restarting Codex only after this live MCP refresh path is unavailable or still cannot make a correct MCP config appear.

This refresh is for MCP tools. It does not replace hook trust review, connector setup, secret entry, or fixing a broken MCP server command.
