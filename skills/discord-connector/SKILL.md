---
name: discord-connector
description: Use when handling Discord messages routed into Codex or using Discord connector tools, including channel replies, DMs, and recent context lookup.
metadata:
  short-description: Use Discord connector tools safely
---

# Discord Connector

This skill owns Discord transport behavior only. Keep the selected Codex thread's personality and domain skills in charge of the content.

Use `$external-source-replies` for source-thread reply scope, stale-event checks, and private-reasoning boundaries. If the Discord source is a shared channel, also use `$shared-room-etiquette`.

## Routing Rules

- For a same-channel reply, call `discord_send_message` with `channelId`, `content`, and `replyToMessageId` when replying to a specific message.
- For a direct message, call `discord_send_dm` with `userId` and `content`.
- Use `discord_read_recent_batch` with `channelId` or `userId` when more context is needed. Use `discord_read_messages` only for precise paging.
- Reply through the source Discord route unless the prompt or contact record clearly names another preferred reply connector.

## Conversation Behavior

- In public or shared channels, assume the response is visible to the room and keep it concise.
- Do not expose channel ids, user ids, tool names, or routing mechanics to people unless debugging was explicitly requested.
- Do not claim a message was sent unless the connector tool succeeds.
