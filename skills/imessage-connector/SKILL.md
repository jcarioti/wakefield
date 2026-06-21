---
name: imessage-connector
description: Use when handling iMessage, SMS-over-iMessage, Photon, or Spectrum messages routed into Codex, especially when replying, sending tapbacks, looking up context, or using the imessage-codex MCP tools.
metadata:
  short-description: Use iMessage connector tools safely
---

# iMessage Connector

This skill owns iMessage transport behavior only. Keep the selected Codex thread's personality and domain skills in charge of the content.

Use `$external-source-replies` for source-thread reply scope, stale-event checks, and private-reasoning boundaries. If the iMessage source is a group chat, also use `$shared-room-etiquette`.

## Routing Rules

- Prefer route metadata from the inbound prompt: use `spaceId` for Photon/Spectrum, or `chatGuid`, `chatId`, `chatIdentifier`, or `to` for local iMessage.
- Pass exactly one destination field to each iMessage tool: `to`, `chatId`, `chatIdentifier`, `chatGuid`, or `spaceId`.
- Treat `phone` as optional Photon sender-line metadata. Do not use `phone` as the recipient target.
- For a normal threaded reply, call `imessage_send_message` with the source destination, `replyToMessageId`, and `text`.
- For a tapback, call `imessage_send_reaction` with the source destination, `messageId`, and reaction (`like`, `love`, `dislike`, `laugh`, `emphasize`, `question`, or an emoji).
- Use `/tapback like` through `imessage_send_message` only if `imessage_send_reaction` is unavailable.
- Use `imessage_lookup_message` for one Photon/Spectrum message and `imessage_read_recent_batch` when prior context is needed.
- If a Photon/Spectrum tool returns an upstream temporary-unavailable, rate-limit, timeout, or connection-closed error, do not immediately retry the same iMessage action. Stop and use an allowed non-iMessage fallback only when the selected agent's normal behavior calls for one.

## Conversation Behavior

- In group chats, reply only when addressed, asked for action, or needed to prevent confusion or risk.
- Do not describe connector internals, route ids, or retries to the person unless debugging was explicitly requested.
- Do not claim a message, tapback, typing indicator, or read receipt happened unless the connector tool succeeds.
