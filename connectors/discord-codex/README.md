# Discord Codex Connector

Standalone connector for routing Discord messages into a live Codex app thread and giving that thread tools to send Discord messages back.

It does not patch or modify Codex application files. It talks to the app-owned thread follower IPC socket because that is the route that keeps the visible Codex conversation in sync.

## Pieces

- `src/discord-bot.mjs`: Discord Gateway bot. It receives allowed Discord messages and routes them into Codex.
- `src/codex-ipc-client.mjs`: Length-prefixed JSON IPC client for the Codex app-owned thread follower socket.
- `src/codex-app-server-client.mjs`: Remote-control daemon client for diagnostics only. It can route turns, but that path is not used for production external messages because it does not update the visible app conversation.
- `src/codex-router.mjs`: IPC follower routing. `auto` tries to steer an active UI-owned run, starts a run when no run is active, and retries steering if another process wins the start race.
- `src/codex-rollout-watch.mjs`: Watches the target Codex rollout for turn completion so Discord typing indicators stay active while the agent is generating.
- `src/discord-presence.mjs`: Watches target Codex rollouts and sets the Discord bot status to idle while Codex is compacting context.
- `src/mcp-server.mjs`: MCP server exposing `discord_bridge_status`, `discord_read_messages`, `discord_read_recent_batch`, `discord_send_message`, and `discord_send_dm`.
- `src/codex-send.mjs`: Manual probe for sending text to a configured Codex thread.

## Install

Dependencies are installed from the repo root as part of the pnpm workspace:

```bash
cd wakefield
pnpm install
cp connectors/discord-codex/config.example.json connectors/discord-codex/config.local.json
```

Keep the Discord bot credential in the environment or in a local token file:

```bash
export DISCORD_BOT_TOKEN=...
```

By default, `config.example.json` points at a local token file:

```bash
~/.codex/connectors/discord-codex/bot-token
```

The Discord bot needs the Message Content intent and access to the target guild/channels.

## Configure

Edit `config.local.json`:

- `bot.tokenFile`: local file containing the Discord bot token. Prefer this or `DISCORD_BOT_TOKEN`; do not put the token literal in JSON.
- `targets[].threadId`: Codex conversation id for the persistent agent personality.
- `targets[].cwd`: workspace used when starting the Codex turn. Point this at the agent workspace whose `AGENTS.md` should be active.
- `codex.socketPath`: optional explicit Codex app IPC socket path. Leave unset to discover the active app-owned socket.
- `codex.deepLinkWake`: optional recovery for a missing app-owned follower. Defaults to opening `codex://threads/<threadId>` with `/usr/bin/open`, polling follower IPC for up to 30 seconds, and re-opening the deep link every 6 seconds while the app is still starting.
- `codex.appServer`: diagnostic-only remote-control daemon settings. Do not use this path for production external messages unless Codex adds a UI-synced remote-control ingest method.
- `allowedChannelIds`, `allowedUserIds`, and `requiredRoleIds`: inbound authorization.
- `discord.allowedOutboundChannelIds` and `discord.allowedDmUserIds`: outbound MCP safety allowlists.

## Run

Inbound Discord to Codex:

```bash
pnpm bot -- --config config.local.json
```

Persistent launchd service on this Mac:

```bash
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/com.wakefield.discord-codex-connector.plist
launchctl bootout gui/$(id -u) ~/Library/LaunchAgents/com.wakefield.discord-codex-connector.plist
tail -f ~/.codex/connectors/discord-codex/logs/launchd.out.log
```

Manual Codex IPC probe:

```bash
pnpm send -- --config config.local.json --target rick --mode auto --text "Discord Codex connector probe"
```

Manual remote-control diagnostic probe:

```bash
pnpm send -- --config config.local.json --target rick --mode app-server --text "Discord Codex app-server diagnostic probe"
```

Safe follower registration probe:

```bash
pnpm probe:follower -- --config config.local.json --target rick
```

Codex MCP command:

```bash
node connectors/discord-codex/src/mcp-server.mjs --config connectors/discord-codex/config.local.json
```

## Runtime Rules

- The connector routes through the Codex app-owned thread follower IPC socket so the desktop conversation stays in sync. If the app socket is missing or reports `no-client-found`, `auto` routing opens `codex://threads/<threadId>` to launch/load the app-owned follower, then polls the same follower IPC path for up to 30 seconds. While the app is still starting, it re-opens the deep link periodically because a cold Codex launch can accept app activation before it is ready to navigate to the target thread. If the follower still does not register, routing fails loudly and the message must not be silently sent through app-server.
- `auto` routing means steer first, start only if no turn is active. A short local file lock only protects that decision so Discord and scheduled wakes can inject into the same active run instead of interrupting each other.
- `pnpm probe:follower` checks follower registration without starting a turn. When Rick is idle, `follower-present-idle` is the healthy result; `no-client-found` means the visible app has not registered an owner for the pinned thread.
- Discord typing indicators are sent immediately and refreshed while the matching Codex turn is in progress, then stopped when the rollout records `task_complete` or the configured timeout is reached. Outbound Discord MCP sends also emit a typing pulse before sending so scheduled or multi-reply sessions have a visible activity hint.
- Discord prompts put the new message first, then routing fields. Use `discord_read_recent_batch` for ambiguous follow-ups that need the last logical time chunk of channel or DM context.
- The persistent bot polls target rollout files for manual compact turns and `context_compacted`. If any target is actively compacting or compacted within the configured hold window, the Discord bot status is set to `idle` with a visible `Watching Codex compact` activity and periodically refreshed; it returns to `online` and clears the activity after the compacted turn completes, aborts, or rolls back and the hold window expires.
- `app-server` and `remote-control` modes are diagnostics only. The live test on 2026-05-23 showed that daemon-routed turns can produce replies without updating the visible Codex app conversation.
- If the Codex app still does not register the thread follower after the one-shot deep-link wake, the connector fails loudly instead of writing transcript files through a detached app-server process.
