---
name: wakefield-external-source-replies
description: "Use when a Wakefield-powered Codex agent handles a request that entered from Discord, iMessage, SMS, email, Slack, MCP, a connector, or any source outside the current Codex UI. Keeps human-visible replies on the source connector, checks stale or replayed events, and keeps private reasoning/tool traces out of external channels."
---

# Wakefield External Source Replies

Use this when a request enters a Wakefield-powered agent from outside the Codex app UI.

If the source is a public/shared room, Discord channel, iMessage group, Slack channel, or another multi-person conversation, also use `$wakefield-shared-room-etiquette` before deciding whether a visible reply is appropriate.

## Rule

Normal Codex chat replies are visible only inside Codex. External senders will miss them.

For external-source requests, send every intentional human-facing acknowledgement, clarification question, interim update, and final reply through the source connector/tool named in the incoming message.

Keep private reasoning, scratch notes, and tool traces inside Codex. Do not stream tool mechanics or hidden analysis to external channels.

## Freshness Guard

Before sending any external reply, compare the event's received/sent timestamp to the current time and nearby conversation context.

If an incoming connector event is unexpectedly old, duplicated, out of order, or appears replayed from backlog, treat it as suspect and do not reply externally by default.

When freshness is unclear, use the source connector's recent-history or lookup tool before guessing. For stale events, note locally that the connector replayed an old message; do not send an acknowledgement, answer, tapback, or missed-duty follow-up just because the old event appeared.

## Acknowledgements

If the request needs long-running, live-system, or tool-heavy work, first send a brief acknowledgement to the same source that made the request.

- Discord DM: use the source DM route.
- Discord channel: reply in the same channel, preferably threaded to the triggering message.
- Photon/Spectrum iMessage: use the supplied `spaceId` and `replyToMessageId` for threaded replies.
- Local iMessage: use the supplied `chatId`, `chatGuid`, `chatIdentifier`, or `to`.
- Future connectors: use the equivalent source-specific send/reply tool.

Do not broadcast acknowledgements to a public/shared room unless the request originated there and a visible acknowledgement is useful under `$wakefield-shared-room-etiquette`.

## Source Scope

Treat the incoming route metadata as the authority for where visible replies go. Keep the topic scoped to the source and conversation; do not include information intended for another sender, channel, email thread, iMessage space, or scheduled wake.

Use compact source metadata only for routing. Do not repeat raw connector ids, message ids, tool names, or route metadata back to the human unless they ask for debugging detail.

When an external-source message is an ambiguous follow-up and the prompt does not include enough quoted or replied-to context, use the source connector's recent-batch reader before guessing what "that", "those things", or "the last one" means.

## Updates

Send interim updates only when they help the sender understand progress, a blocking state, or an action they asked to be notified about. Keep updates short.

Scheduled wakes and quiet watches should stay quiet unless a human-facing update is useful under the selected agent's own notification rules.
