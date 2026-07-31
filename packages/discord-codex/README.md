# Discord Codex Connector

Standalone connector for routing Discord messages into a live Codex task in the ChatGPT desktop app and giving that task tools to send Discord messages back.

It does not patch or modify ChatGPT application files. It uses the daemon-backed ChatGPT Desktop controller and fails closed unless daemon, protocol, app attachment, task, and turn ownership checks pass.

## Pieces

- `src/discord-bot.mjs`: Discord Gateway bot. It receives allowed Discord messages and routes them into Codex.
- `src/codex-desktop-controller.mjs`: Strict controller for the daemon-backed ChatGPT Desktop runtime.
- `src/codex-router.mjs`: Routes connector delivery through the controller's persistent-task start/steer APIs.
- `src/codex-rollout-watch.mjs`: Watches the target Codex rollout for turn completion so Discord typing indicators stay active while the agent is generating.
- `src/discord-presence.mjs`: Watches target Codex rollouts and sets the Discord bot status to idle while Codex is compacting context.
- `src/mcp-server.mjs`: MCP server exposing `discord_bridge_status`, `discord_read_messages`, `discord_read_recent_batch`, `discord_send_message`, and `discord_send_dm`.
- `src/codex-send.mjs`: Manual probe for sending text to a configured Codex thread.

## Install

Dependencies are installed from the repo root as part of the pnpm workspace:

```bash
cd wakefield
pnpm install
cp packages/discord-codex/config.example.json packages/discord-codex/config.local.json
```

Keep the Discord bot credential in the environment or in a local token file:

```bash
export DISCORD_BOT_TOKEN=...
```

By default, `config.example.json` points at a local token file:

```bash
~/.codex/packages/discord-codex/bot-token
```

The Discord bot needs the Message Content intent and access to the target guild/channels.

## Configure

Edit `config.local.json`:

- `bot.tokenFile`: local file containing the Discord bot token. Prefer this or `DISCORD_BOT_TOKEN`; do not put the token literal in JSON.
- `targets[].threadId`: Codex conversation id for the persistent agent personality.
- `targets[].cwd`: workspace used when starting the Codex turn. Point this at the agent workspace whose `AGENTS.md` should be active.
- `codex.desktopController`: daemon socket, Codex binary, and strict Desktop ownership settings for explicit `desktop-controller` routing.
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
tail -f ~/.codex/packages/discord-codex/logs/launchd.out.log
```

Manual Codex IPC probe:

```bash
pnpm send -- --config config.local.json --target rick --text "Discord Codex connector probe"
```

Manual daemon-backed Desktop controller probe:

```bash
pnpm send -- --config config.local.json --target rick --mode desktop-controller --text "Discord Codex Desktop controller probe"
```

Attended follower registration probe:

```bash
pnpm probe:follower -- --config config.local.json --target rick
```

This sends the follower steer method. A stale or missing rollout status can let its diagnostic text reach an active task, so use it only against a disposable or confirmed-idle target.

Codex MCP command:

```bash
node packages/discord-codex/src/mcp-server.mjs --config packages/discord-codex/config.local.json
```

## Runtime Rules

- The connector routes delivery only through `desktop-controller`; missing route mode is normalized to that value and any legacy mode is rejected during config loading.
- Controller routing steers the single owned active turn or starts a turn when the persistent task is idle. A short local file lock protects that decision across connectors and scheduled work.
- `pnpm probe:follower` checks follower registration without starting a turn. When Rick is idle, `follower-present-idle` is the healthy result; `no-client-found` means the visible app has not registered an owner for the pinned thread.
- Discord typing indicators are sent immediately and refreshed while the matching Codex turn is in progress, then stopped when the rollout records `task_complete` or the configured timeout is reached. Outbound Discord MCP sends also emit a typing pulse before sending so scheduled or multi-reply sessions have a visible activity hint.
- Discord prompts put the new message first, then routing fields. Use `discord_read_recent_batch` for ambiguous follow-ups that need the last logical time chunk of channel or DM context.
- The persistent bot polls target rollout files for manual compact turns and `context_compacted`. If any target is actively compacting or compacted within the configured hold window, the Discord bot status is set to `idle` with a visible `Watching Codex compact` activity and periodically refreshed; it returns to `online` and clears the activity after the compacted turn completes, aborts, or rolls back and the hold window expires.
- `desktop-controller` is the only controller mode. It accepts only the supported `0.146` daemon when `initialize` identifies the matching macOS Codex Desktop runtime and the app reports complete connected ownership metadata.
