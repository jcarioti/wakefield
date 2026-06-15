# iMessage Codex Connector

Standalone connector for routing iMessage/SMS messages into a live Codex app thread and giving that thread tools to send iMessage/SMS replies.

This connector supports two iMessage providers:

- `spectrum`: Photon/Spectrum cloud iMessage, the current active path.
- `imsg`: local Mac Messages bridge, kept for a later dedicated Apple ID host.

It does not use BlueBubbles.

## Pieces

- `src/spectrum-bot.mjs`: persistent Photon/Spectrum consumer. It receives allowed iMessage rows, saves inbound attachments locally, routes the message into Codex, and exposes a local IPC socket for outbound MCP sends.
- `src/imessage-bot.mjs`: parked local `imsg watch` consumer for the future dedicated Mac/iMessage account path.
- `src/mcp-server.mjs`: MCP server exposing `imessage_bridge_status`, `imessage_read_messages`, `imessage_read_recent_batch`, `imessage_lookup_message`, `imessage_send_message`, `imessage_send_reaction`, `imessage_receipt_status`, `imessage_start_typing`, and `imessage_stop_typing`.
- `src/spectrum-client.mjs` / `src/spectrum-ipc.mjs`: Spectrum SDK and local bridge helpers.
- `src/photon-history.mjs`: low-level Photon iMessage history reader used by recent-context MCP tools.
- `src/imsg-cli.mjs`: small wrapper around the `imsg` CLI.
- `src/imessage-receipts.mjs`: read-only receipt/status lookup for sent messages in `chat.db`.
- `src/imessage-focus.mjs`: optional Shortcut-based Focus/DND hook during Codex compaction or connector shutdown.

## Install

Dependencies are installed from the repo root as part of the pnpm workspace:

```bash
cd wakefield
pnpm install
```

For Photon/Spectrum, set `imessage.provider` to `spectrum` and configure Photon credentials with either `config.local.json` or environment variables:

```bash
export PHOTON_PROJECT_ID="..."
export PHOTON_SECRET_KEY="..."
# Optional, defaults to https://spectrum.photon.codes
export SPECTRUM_CLOUD_URL="..."
```

The local `imsg` bridge remains available for later. For that path, install `imsg` on the Mac signed into the iMessage account:

```bash
brew install steipete/tap/imsg
imsg --version
```

Grant permissions to the parent app that runs the connector:

- Full Disk Access, so `imsg watch` and receipt checks can read `~/Library/Messages/chat.db`.
- Automation permission for Messages.app, so `imsg send` can send text/files.
- Optional Contacts permission if you want contact-name resolution.

Typing indicators and programmatic read marking on the `imsg` provider require `imsg` advanced IMCore setup (`imsg launch`, SIP disabled, helper loaded). The `spectrum` provider uses Photon/Spectrum's cloud iMessage line instead.

## Configure

```bash
cd connectors/imessage-codex
cp config.example.json config.local.json
```

Edit `config.local.json`:

- `imessage.provider`: `spectrum` for Photon/Spectrum now, or `imsg` for the parked local Mac bridge.
- `imessage.spectrum.projectId` / `projectSecret`: Photon credentials. Prefer an ignored `config.local.json` or env vars; do not commit secrets.
- `imessage.spectrum.cloudUrl`: optional Photon/Spectrum cloud URL override. Leave unset unless testing against a non-default cloud endpoint.
- `imessage.spectrum.ipcSocketPath`: local socket used by the MCP server to send replies through the live Spectrum process.
- `imessage.spectrum.attachmentDir`: where inbound Spectrum attachments are saved before being passed to Codex.
- `imessage.imsgPath`: path to `imsg`, usually `imsg`, only for the local provider.
- `imessage.databasePath`: Messages database for receipt lookups.
- `imessage.advancedBridgeRequired`: keep this `true` when typing indicators and read receipts are part of the runtime contract.
- `imessage.typing.showWhileThinking`: defaults to `true`, matching Discord. The connector shows typing while the routed Codex turn is active, then stops when the turn completes.
- `targets[].threadId`: Codex conversation id for the persistent agent personality.
- `targets[].cwd`: workspace used when starting the Codex turn. Point this at the agent workspace whose `AGENTS.md` should be active.
- `codex.socketPath`: optional explicit Codex app IPC socket path. Leave unset to discover the active app-owned socket.
- `codex.deepLinkWake`: optional recovery for a missing app-owned follower. Defaults to opening `codex://threads/<threadId>` with `/usr/bin/open`, polling follower IPC for up to 30 seconds, and re-opening the deep link every 6 seconds while the app is still starting.
- `codex.appServer`: diagnostic-only remote-control daemon settings. Do not use this path for production iMessage routing unless Codex adds a UI-synced remote-control ingest method.
- `allowAllAddresses`: route every inbound Spectrum iMessage into the selected agent. Keep this true only for a dedicated Photon project owned by that agent.
- `allowedAddresses`, `allowedChatIds`, `allowedChatGuids`, and `allowedSpaceIds`: inbound authorization when not using `allowAllAddresses`.
- `imessage.allowedOutboundAddresses`, `allowedOutboundChatIds`, `allowedOutboundChatGuids`, and `allowedOutboundSpaceIds`: outbound MCP safety allowlists.

For Spectrum replies, the agent should usually use `imessage_send_message` with the `spaceId` and optional `replyToMessageId` included in the incoming message prompt. The prompt intentionally presents these as plain `spaceId=...` / `replyToMessageId=...` routing fields instead of JSON-shaped tool calls. The live Spectrum bot only knows spaces it has seen since it started; DMs can also be addressed by E.164 `to`.

For Spectrum message lookup, use `imessage_lookup_message` with the source `spaceId` and `messageId` from the incoming prompt. This resolves one prior message through the live Spectrum bridge when Rick needs context such as "the message I replied to". For ambiguous follow-ups that need recent conversation context, use `imessage_read_recent_batch` with the source `spaceId`; it pages Photon chat history directly and returns the latest logical time chunk, plus a `nextPageToken` for older history.

For Spectrum reactions, use `imessage_send_reaction` with the source `spaceId`, `messageId`, and a tapback name (`like`, `love`, `dislike`, `laugh`, `emphasize`, or `question`) or a literal emoji. If the Codex app has not refreshed its MCP tool list and that dedicated tool is unavailable, use `imessage_send_message` with the source `spaceId`, `replyToMessageId` set to the source message id, and text like `/tapback like` or `/react love`; the MCP server translates that command into a reaction instead of sending visible text. Tapback names are normalized to the native iMessage emoji values used by `spectrum-ts@1.12.0`.

Spectrum reaction events use synthetic message ids like `<message-id>:reaction:<sequence>`. The connector routes reply and tapback prompts for those events to the original target message id so Rick does not attempt to react to the reaction event itself. The outbound reaction path also strips that suffix defensively.

For iMessage group chats, configure the Rick target with `allowGroupChats: true` and add the group `spaceId` to `allowedSpaceIds` unless this is a fully Rick-owned Photon project using `allowAllAddresses`. Replies, reactions, and typing indicators to group chats require the live Spectrum bot to have seen the group since startup; unknown group `spaceId`s fail instead of being guessed as direct-message targets.

## Run

Inbound Photon/Spectrum iMessage to Codex:

```bash
pnpm bot:spectrum -- --config config.local.json
```

Future local `imsg` bridge:

```bash
pnpm bot -- --config config.local.json
```

Codex MCP command:

```bash
node connectors/imessage-codex/src/mcp-server.mjs --config connectors/imessage-codex/config.local.json
```

## Spectrum Ingest Diagnostics

Use the diagnostic CLI when someone reports that an iMessage was delivered but the agent did not receive it:

```bash
pnpm diag:spectrum
```

The CLI treats local `imsg history` as read-only evidence. It never sends human-facing replies through `imsg`; use local `imsg` sends only when a human explicitly approves synthetic test traffic. Photon/Spectrum can be sensitive to rate limits, so add `--deep` only when a human has approved Photon cloud/API probes, and add `--restart-on-stale` only when a human has approved restarting the launch agent.

For an active monitor check, send one unique synthetic local `imsg` message and verify that the live Spectrum bridge captures the exact text for the target:

```bash
pnpm diag:spectrum -- --active-imsg-probe
```

This mode sends only to the configured local Messages chat id, then polls `spectrum-status.json` for `lastMatchedInboundMessage.text`. A successful active probe proves the live Spectrum receive loop emitted the message and the target matcher accepted it. If the probe is not seen before the timeout, add `--deep` only when Photon history/API evidence is worth the extra requests, and add `--restart-on-stale` only when restart has been approved.

On a stale finding, the CLI writes an incident artifact under `outputs/imessage-bridge-diagnostics/`, then optionally restarts the Spectrum launch agent. The artifact is meant to decide the next non-bandaid path:

- `photon_history_has_message_but_live_stream_missed_it`: Photon history can see the message, but the live `app.messages` stream did not deliver it to the connector. Escalate the Spectrum/advanced-iMessage subscription path.
- `local_sender_has_message_but_photon_history_does_not`: the local Messages database has the sent message, but Photon history for the chat does not expose it. Escalate Photon account/server delivery with the artifact and recent launchd logs.
- `photon_history_probe_failed`: fix or escalate the Photon history/API failure before classifying the live stream.

After known bad local test/fallback rows, baseline the diagnostic state so the monitor does not keep reporting old evidence:

```bash
pnpm diag:spectrum -- --baseline-current
```

For a Photon-facing minimal repro that avoids Wakefield, Codex, and local `imsg`, run:

```bash
pnpm repro:photon-live -- --config config.local.json --chat-guid 'any;-;+13307669880' --text 'photon-live-repro 2026-05-24T20:30:00Z' --out /tmp/photon-live-repro.json
```

Then send the exact `--text` value from the other iMessage account during the wait window. Use a fresh unique text for each run; by default the harness only looks five seconds before its own start time to avoid matching stale history. The harness opens raw `@photon-ai/advanced-imessage` `messages.subscribeEvents()`, checks `messages.listInChat()` for the same text, timeboxes `events.catchUp(0)`, and writes a redacted JSON packet. A `history_visible_live_missed` conclusion is the compact upstream bug report: Photon history saw the message but the live subscription did not emit it.

For a self-triggered local repro, open the raw Photon subscription first and then have the harness send the exact text through local `imsg`:

```bash
pnpm repro:photon-live -- --config config.local.json --chat-guid 'any;-;+13307669880' --send-via-imsg --imsg-chat-id 1111 --out /tmp/photon-live-repro.json
```

This still avoids Wakefield and Codex as the assertion layer; local `imsg` is only the sender that creates the inbound message.

## Runtime Rules

- The connector uses the same app-owned thread follower IPC route as the Discord connector so the visible Codex conversation stays in sync. If the app socket is missing or reports `no-client-found`, `auto` routing opens `codex://threads/<threadId>` to launch/load the app-owned follower, then polls the same follower IPC path for up to 30 seconds. While the app is still starting, it re-opens the deep link periodically because a cold Codex launch can accept app activation before it is ready to navigate to the target thread. If the follower still does not register, routing fails loudly and the message must not be silently sent through app-server.
- Spectrum inbound messages are handled concurrently. Each prompt carries the source sender, space id, message id, and reply target so the selected agent can answer different people and scheduled wakeups in the same persistent thread without mixing recipients.
- Spectrum prompts put the new message or reaction event first, then any replied-to or reacted-to message history that Spectrum supplied, then compact internal routing fields. Use `imessage_read_recent_batch` only when that inline context is still ambiguous.
- Spectrum read receipts are sent after Codex accepts the message into the agent conversation. They are not sent for messages that fail authorization or fail to route, and they do not wait for the model turn to finish.
- Spectrum group-chat prompts include the group space id and the quiet-room rule so the agent can retain context without automatically chiming in.
- Spectrum reaction-event prompts include the original target message id for replies and tapbacks, not the synthetic reaction-event id.
- Spectrum inbound attachments are saved under `imessage.spectrum.attachmentDir` and passed to Codex as local file paths.
- Spectrum outbound MCP sends, reactions, and typing indicators use the local bridge IPC socket. Keep `src/spectrum-bot.mjs` running whenever the agent should be able to reply by iMessage.
- Spectrum recent-context reads use Photon history directly, not the local routed-event log, so they can recover messages that were not captured while the connector process was awake.
- Spectrum shows typing while the routed Codex turn is active, matching Discord's typing behavior. Explicit `imessage_start_typing` / `imessage_stop_typing` calls remain available for manual or tool-driven typing control.
- `imsg watch` starts at the newest message on first run. After it sees messages, the connector stores `state.lastRowId` and resumes with `--since-rowid`.
- Inbound attachments are passed to Codex as local file paths from `imsg` metadata. With `convertAttachments` enabled, CAF audio and GIF images include model-friendlier converted paths when `ffmpeg` is available.
- Outbound MCP sends support text and local file attachments. Multiple attachments are sent as separate Messages sends; the text rides with the first attachment.
- Outbound Spectrum reactions support native iMessage tapback names and arbitrary emoji reactions when the target message can be resolved in the live space. The compatibility command `/tapback <name>` or `/react <name>` through `imessage_send_message` is treated as a reaction when `replyToMessageId` is present.
- Delivered/read receipt status is best-effort and local to `chat.db` fields for the sent message row. The connector reports raw sent/delivered/read timestamps when Messages stores them. Photon/Spectrum inbound reads are chat-level markers implemented through Spectrum/iMessage's read control action.
- Local `imsg` typing indicators and marking messages read require the advanced IMCore bridge when `advancedBridgeRequired` is `true`; the bot will not start until `imsg status --json` reports them ready.
- Focus/DND during compaction is optional. Configure local Shortcuts by name in `imessage.focus`; the connector can run one shortcut while compacting, another when online, and an offline shortcut at shutdown.
