---
name: scheduler-management
description: Use when an agent is asked to add, edit, delete, review, or propose its own duties and wakeups. Covers safe self-management of recurring work through scheduler MCP tools or CLI fallback commands.
---

# Scheduler Management

Use this skill when the selected agent needs to manage recurring duties or wakeups through conversation.

## Rules

1. Treat duties as reusable work definitions, and wakeups as schedules that run one or more duties.
2. Create or change a duty before attaching it to a wakeup.
3. Ask before scheduling work that may notify other people, spend money, change accounts, use credentials, or touch an external system with side effects.
4. Keep generated duty IDs stable, lowercase, and readable, such as `morning-check` or `inventory-watch`.
5. Before deleting a duty, check whether wakeups reference it and remove those references or ask before deleting both.
6. Prefer small, reviewable changes: one duty and one wakeup at a time unless the user asks for a larger setup.

## Preferred MCP Tools

Use the scheduler MCP tools when they are available. They mutate the agent's scheduler state directly, instead of trying to create Codex automations:

- `wakefield_scheduler_status`
- `wakefield_scheduler_configure_duty`
- `wakefield_scheduler_configure_wakeup`
- `wakefield_scheduler_delete_duty`
- `wakefield_scheduler_delete_wakeup`

Create or change a duty before attaching it to a wakeup. Use `dispatchMode: "ipc"` for real scheduled delivery to the selected Codex thread, and `dispatchMode: "dry-run"` for review/testing.

## CLI Fallback

Review current duties and wakeups:

```sh
wakefield duties list --json
wakefield wakeups list --json
```

Create or edit a duty:

```sh
wakefield duties configure DUTY_ID --label "Label" --skill skill-name --prompt "What to do" --enable --json
```

Disable or delete a duty:

```sh
wakefield duties configure DUTY_ID --disable --json
wakefield duties delete DUTY_ID --remove-references --json
```

Create or edit a wakeup after the duty exists:

```sh
wakefield wakeups configure WAKEUP_ID --time HH:mm --duty DUTY_ID --dispatch-mode ipc --json
```

Delete a wakeup:

```sh
wakefield wakeups delete WAKEUP_ID --json
```

## Finish With

- What changed
- When it will run
- Which duties are attached
- Any permissions or external effects the human still needs to approve
