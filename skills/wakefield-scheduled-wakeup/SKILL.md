---
name: wakefield-scheduled-wakeup
description: Use when a Wakefield scheduled wakeup turn is injected into a persistent Codex thread. Applies the generic rules for wakeup envelopes, duty skill loading, scoped execution, blocked-duty reporting, and compact scheduled-run summaries.
---

# Wakefield Scheduled Wakeup

Use this skill when a Wakefield wakeup message asks the selected agent to run one or more scheduled duties.

## Rules

1. Treat the wakeup message as the event envelope. It provides the wakeup ID, due slot, duty IDs, duty skills, and required tools.
2. Load each listed duty skill before acting. The duty skill owns the domain workflow and output contract.
3. Follow the selected agent's operating context and personality. Wakefield supplies scheduling mechanics, not the agent's business policy.
4. Keep the turn scoped to the listed scheduled duties. Do not use a wakeup as permission for broad unrelated cleanup.
5. If a required tool, connector, credential, or live system is unavailable, mark only the affected duty as blocked with the exact blocker. Do not pretend the duty ran.
6. If multiple duties are listed, run them as one coordinated check and avoid duplicating shared setup work.

## Finish With

- Duties checked
- Actions taken
- Blockers
- Human notifications sent or needed
- Memory or state updates made or recommended
