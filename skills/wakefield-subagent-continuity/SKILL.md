---
name: wakefield-subagent-continuity
description: "Use when a Wakefield-powered Codex agent spawns, resumes, waits on, or hands work to Codex subagents during long-running sessions that may compact repeatedly. Keeps only validated short-term handles needed across compaction: subagent id, display label, responsibility, and reason."
---

# Wakefield Subagent Continuity

Use this when creating or reusing Codex subagents for a Wakefield-powered agent.

## Rule

Codex owns subagent state. The selected agent only needs short durable handles.

Treat a returned subagent id as tentative until there is proof the agent actually ran.

Proof of life is one of:

- `wait_agent` returns a completed status or useful partial/final message.
- a subagent notification reports useful completion or visible work.
- the assigned file/output scope changes as expected after the agent starts.

When a subagent has proof of life, record four things in the selected agent's short-term continuity note:

- subagent id
- Codex display label as shown in UI; use the returned nickname only when that is all you have, otherwise say `unnamed`
- responsibility or lane
- reason it exists

Before spawning a new subagent for the same recurring responsibility, check the saved handles. Try `send_input` or `resume_agent` only when the id still belongs to the current Codex subagent manager. If the tool says the agent was not found, the saved handle is stale; mark it stale in one short phrase or remove it, then spawn a fresh subagent if delegation is still warranted.

Do not assume handles survive app restarts, machine moves, closed agents, shutdown notifications, or parent-thread changes. If an agent times out without proof of life or file/output progress, stop waiting, close it when possible, and do the work in the main thread or spawn a smaller fresh task.

Keep entries short. Do not create a task database, duplicate the subagent's state, or record private reasoning.

## Storage

Use the selected agent's configured continuity location. If no project-specific location exists, use the agent profile's local memory or session summary file.

For Wakefield profiles, prefer a path under the agent's app-support state directory or the selected project cwd's ignored local state. Do not store durable handles in published docs or generated output folders.
