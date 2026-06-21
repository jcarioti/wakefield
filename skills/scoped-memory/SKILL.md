---
name: scoped-memory
description: "Use when inspecting, recalling, creating, updating, resolving, archiving, or debugging scoped agent memory: durable notes, temporary active-context matters, memory capture, and Codex-hook/dreamer memory behavior."
---

# Scoped Memory

## Overview

Scoped memory is a small stage-manager layer around a persistent Codex chat. Codex owns the visible transcript and compaction; memory stores only the outside context that should be available later without replaying chat history.

## Memory Types

- Use notes for stable durable facts, preferences, and standing operating rules.
- Use matters for temporary active context: unresolved support cases, RMAs, incidents, connector outages, cross-channel follow-ups, and task blockers.
- Prefer updating an existing matter when a fact changes. Create a new matter only for a genuinely separate situation.
- Resolve or archive a matter only when the whole temporary situation no longer needs to appear in future turns.
- If one blocker clears but the case still has a next step, update the matter summary, status, and next action instead of resolving it.

## Commands

Run these from the selected agent project unless the prompt says otherwise:

```bash
pnpm wakefield memory notes list
pnpm wakefield memory matters list --all
pnpm wakefield memory matters upsert --id <id> --title "<title>" --summary "<summary>" --status active|waiting|resolved|archived --person <person> --task <task> --case <case>
pnpm wakefield memory matters archive <id> --reason "<reason>"
pnpm wakefield memory recall --query "<query>" --person <person> --task <task> --case <case>
pnpm wakefield memory capture --dry-run --json
pnpm wakefield memory capture-log --json
```

Do not insert `--` after `pnpm wakefield`; project scripts pass arguments directly to the CLI wrapper.

## Capture And Dreaming

Memory capture reviews compact dream summaries after turns. Treat it as advisory automation, not as the source of truth.

- Use `wakefield memory capture --dry-run --json` to inspect what the reviewer would apply without mutating memory.
- Use `wakefield memory capture-log --json` after service or dreamer runs to inspect what summary was reviewed, which existing notes/matters were shown, what deltas were returned, what was applied, and what was skipped.
- Use the capture `rationale`, `applied` list, and skipped/ignored deltas to diagnose why a turn did or did not change memory.
- The capture process reviews newer summaries first and skips updates to existing memories when the target memory was already updated after the reviewed turn.
- Do not manually replay chat history or inject soul/personality content to fix memory.
- Do not store "the assistant replied" or politeness facts.
- If capture misses a meaningful update, improve the capture rules or matching evidence rather than patching around the symptom with duplicate memory.

## External Turns

For Discord, iMessage, email, or scheduled wakeups, recall should stay scoped to the source:

- Person follow-ups should recall that person's relevant notes and active matters across connectors.
- Scheduled wakeups should recall duty/task context, not every recent human conversation.
- Shared rooms should keep ambient useful facts only when they affect a future task or active matter.
- Recent facts from the current uncompacted chat normally do not need reinjection; the memory layer suppresses same-session memory where possible.
