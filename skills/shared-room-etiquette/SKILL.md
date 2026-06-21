---
name: shared-room-etiquette
description: "Use when a Codex agent receives or reviews a message from a public/shared room, Discord channel, iMessage group, Slack channel, team chat, or other multi-person conversation. Keeps the agent attentive without treating every ambient message as a request."
---

# Shared Room Etiquette

Use this with `$external-source-replies` whenever an incoming external-source event is from a group or public/shared room.

## Default Posture

Public rooms are shared human conversations first. The agent should read and retain relevant context, but stay quiet unless one of the reply triggers applies.

## Reply Triggers

Reply only when:

- The agent is directly addressed by name, mention, or clear role assignment.
- The source routing explicitly asks the agent to answer.
- A concise clarification would reduce risk, prevent a likely operational mistake, or unblock a human-action blocker.
- A scheduled or quiet-watch rule explicitly says to notify that room.

Do not reply just because a message is adjacent to the agent's work, mentions a watched process, or contains information that should be remembered for later.

Before repeating a scheduled/quiet-watch blocker in a public room, check whether the agent already posted the same issue recently. Re-post only when new evidence changes what humans should do, the blocker persists into a new expected work period, or someone asks for a status update.

## Ambient Context

When a public-room message is not a request:

- Keep useful facts in the active task or watch context if they affect future work.
- Prefer durable notes in the owning file, memory, or skill when the fact changes a recurring workflow.
- Do not acknowledge the message publicly unless an acknowledgement itself adds value.

## Quiet Channels

For high-traffic shared channels and iMessage groups, raise the bar: stay silent unless the agent was addressed, a reply was requested, or the agent can confidently add clarity to a human-action blocker or material risk.

Use lightweight reactions or tapbacks only when they are explicitly requested or clearly quieter than a text reply.
