# Wakefield

Turn one persistent Codex thread into a local, always-reachable agent.

Wakefield is a small local runtime for people who want a personal or team agent that can be reached through Discord, iMessage, email, local scripts, and scheduled wakeups while still working inside the visible Codex app conversation.

It is built around a simple idea: pick one long-lived Codex thread as the personality, give it a name and operating context, then let Wakefield handle connectors, memory hooks, schedules, and background service wiring around it.

## Highlights

- **Persistent personality**: select a Codex thread and keep using it as the agent's ongoing mind.
- **Local-first state**: profiles, inbox, memory, dreams, contacts, and schedule state live in normal app support storage.
- **Connector-ready**: Discord, Photon/Spectrum iMessage, email, local HTTP intake, and a transport-neutral inbox are included.
- **Scheduled wakeups**: define named wakeups like `08:00 morning-ops`, then attach reusable duties to each wakeup.
- **Skill-backed duties**: keep scheduled prompts compact by pointing duties at Codex skills instead of pasting large prompt blobs.
- **Scoped memory**: stable notes plus temporary active context are recalled only when they match the current person, room, task, case, or topic.
- **Installer-friendly API**: JSON commands, setup actions, wizards, and a local HTTP API make it practical to build a menu bar or desktop setup flow.
- **No secret storage by default**: Wakefield stores environment variable names and local file references, not raw tokens.

## Mental Model

Wakefield has a few first-class objects:

| Object | Purpose |
| --- | --- |
| **Agent** | Name, soul, selected Codex thread, and workspace. |
| **Thread** | The persistent Codex chat that carries the personality over time. |
| **Contacts** | Deterministic identity records for Discord users, phone numbers, email addresses, roles, and reply preferences. |
| **Skills** | Reusable instruction packs installed into Codex. |
| **Duties** | Reusable units of scheduled work, usually backed by one or more skills. |
| **Wakeups** | Local clock events that run one or more duties together in a single Codex turn. |
| **Connectors** | Inbound and outbound bridges for Discord, iMessage, email, HTTP, and local scripts. |
| **Memory** | Durable notes, temporary active context, local journals, dreams, and hook-produced state. |
| **Service** | A background tick that runs dreams, due wakeups, connector polls, and optional pending-message dispatch. |
| **Agent Packs** | Portable recipes that install an agent profile, contacts, skills, duties, wakeups, connectors, and service defaults. |

## Requirements

- Node.js 20 or newer
- pnpm for Wakefield development
- npm, pnpm, or yarn for projects that consume Wakefield as a dependency
- Codex desktop app for IPC-routed turns and visible conversation sync
- macOS for LaunchAgent helpers and local Messages database polling
- Optional connector credentials:
  - Discord bot token
  - Photon/Spectrum iMessage project credentials
  - IMAP credentials for email polling

Wakefield can still run local verification, memory, HTTP intake, dry-run dispatch, and pack inspection without live connector credentials.

## Quick Start

```bash
git clone git@github.com:jcarioti/wakefield.git
cd wakefield
pnpm install
pnpm verify
```

Use this path when you want to contribute to Wakefield itself. In a checkout of this repo, run the CLI through the local script:

```bash
pnpm wakefield manifest --json
pnpm wakefield setup status
```

## Use In An Agent Project

You do not need to clone Wakefield to build a new agent. Create a small agent repo that carries the agent pack, soul, contacts, and skills, then install Wakefield as a dependency.

```json
{
  "dependencies": {
    "wakefield": "^0.1.0"
  },
  "optionalDependencies": {
    "@wakefield/discord-codex": "^0.1.0",
    "@wakefield/imessage-spectrum": "^0.1.0"
  },
  "scripts": {
    "wakefield": "wakefield",
    "verify": "wakefield verify",
    "install-agent": "wakefield pack install --file wakefield-pack.json"
  }
}
```

Then run Wakefield through your package manager:

```bash
pnpm wakefield setup status
npm exec wakefield -- setup status
yarn wakefield setup status
```

The core `wakefield` package is intentionally light. Managed connector packages are optional:

- `@wakefield/discord-codex` for the Discord Gateway/MCP connector
- `@wakefield/imessage-spectrum` for the Photon/Spectrum iMessage connector

The Photon/Spectrum package includes native/transitive provider dependencies. npm and yarn run those builds as part of install; pnpm may ask you to approve the native builds before first use.

Create or reuse a local agent:

```bash
pnpm exec wakefield setup run \
  --name Mira \
  --soul "A calm personal research companion." \
  --latest-thread \
  --enable-service
```

Check the install:

```bash
pnpm exec wakefield setup status
pnpm exec wakefield doctor
pnpm exec wakefield menu snapshot --json
```

If you are building an installer or menu bar, prefer JSON commands:

```bash
pnpm exec wakefield manifest --json
pnpm exec wakefield setup actions --json
pnpm exec wakefield connectors wizards --json
pnpm exec wakefield managed-connectors wizards --json
```

## State Layout

Wakefield stores runtime state outside the project:

- macOS: `~/Library/Application Support/Wakefield`
- Linux: `$XDG_DATA_HOME/wakefield` or `~/.local/share/wakefield`
- Windows: `%APPDATA%/Wakefield`

Use `WAKEFIELD_HOME` only for tests, isolated experiments, or advanced relocation.

Each agent gets an app-support folder with:

- `AGENTS.md` for the generated soul
- local memory files: `notes.json`, `matters.json`, `inbox.jsonl`, `journal.jsonl`, `dreams.jsonl`, `external-messages.jsonl`, `state.json`
- profile and selected thread metadata
- schedule, contacts, connector, and service state

## Agent Packs

An agent pack is the portable recipe for a Wakefield-powered agent.

```json
{
  "schemaVersion": 1,
  "id": "mira",
  "agent": {
    "name": "Mira",
    "cwd": ".",
    "soulFile": "AGENTS.md"
  },
  "contacts": {
    "file": "contacts.json",
    "format": "auto"
  },
  "skills": {
    "install": [
      { "path": "skills/morning-review" }
    ]
  },
  "duties": [
    {
      "id": "morning-review",
      "label": "Morning Review",
      "skill": "morning-review"
    }
  ],
  "wakeups": [
    {
      "id": "morning",
      "label": "Morning",
      "times": ["08:00"],
      "dispatchMode": "ipc",
      "duties": ["morning-review"]
    }
  ]
}
```

Inspect and install:

```bash
pnpm exec wakefield pack inspect --file ./wakefield-pack.json
pnpm exec wakefield pack install --file ./wakefield-pack.json --thread-id <codex-thread-id>
```

Packs should contain app-specific identity and policy. Wakefield itself stays generic.

## Duties And Wakeups

Duties are reusable work definitions. Wakeups are the scheduled events that decide when groups of duties run together.

```bash
pnpm exec wakefield duties configure inbox-review \
  --skill inbox-review

pnpm exec wakefield duties configure followups \
  --skill followup-check

pnpm exec wakefield wakeups configure morning-ops \
  --enable \
  --time 08:00 \
  --dispatch-mode dry-run \
  --duty inbox-review \
  --duty followups

pnpm exec wakefield wakeups list
pnpm exec wakefield wakeups run morning-ops --force
```

The generated Codex prompt stays compact:

```text
Scheduled Wakefield wakeup: Morning Ops
Use $wakefield-scheduled-wakeup.

Wakeup ID: morning-ops
Wake schedule: 08:00 local
Duties: inbox-review, followups
Duty skills: $inbox-review, $followup-check

Run these scheduled duties in this turn:
- inbox-review: $inbox-review
- followups: $followup-check
```

This keeps long-running agents easy to maintain: update the skill when the operating rules change, not every schedule entry.

## Connectors

Wakefield supports two connector levels.

**Simple connectors** are built into the core CLI:

- Discord Gateway listener
- read-only macOS Messages database poller
- RFC 822 email import
- IMAP email polling
- local HTTP intake
- transport-neutral external inbox

**Managed connector packages** are supervised connector runtimes with MCP reply tools and LaunchAgent wiring:

- `@wakefield/discord-codex` (`discord-codex` adapter id)
- `@wakefield/imessage-spectrum` (`imessage-spectrum` adapter id)

Check connector state:

```bash
pnpm exec wakefield connectors status
pnpm exec wakefield managed-connectors status
```

Run setup wizards:

```bash
pnpm exec wakefield connectors wizards --json
pnpm exec wakefield managed-connectors wizard discord-codex --json
pnpm exec wakefield managed-connectors wizard imessage-spectrum --json
```

Install MCP entries for managed connectors:

```bash
pnpm exec wakefield managed-connectors mcp install discord-codex --json
pnpm exec wakefield managed-connectors mcp install imessage-spectrum --json
```

Install background connector daemons on macOS:

```bash
pnpm exec wakefield managed-connectors launch-agent install discord-codex --load
pnpm exec wakefield managed-connectors launch-agent install imessage-spectrum --load
```

### Discord

Wakefield stores the Discord token environment variable name or token-file path, not the token itself.

```bash
export DISCORD_BOT_TOKEN="..."

pnpm exec wakefield connectors configure discord \
  --enable \
  --set botTokenEnv=DISCORD_BOT_TOKEN \
  --set allowedTargets=channel-id \
  --set allowedUsers=user-id

pnpm exec wakefield discord listen
```

The managed `discord-codex` package adds production-style Gateway routing, Codex follower probing, typing indicators, presence during compaction, and MCP tools for replies.

### iMessage

Wakefield includes:

- a read-only local Messages database poller for simple inbound intake
- a managed Photon/Spectrum iMessage connector for production-style receive, reply, reaction, typing, recent-context, and read-receipt behavior

Photon/Spectrum credentials should come from environment variables or ignored local config:

```bash
export PHOTON_PROJECT_ID="..."
export PHOTON_SECRET_KEY="..."

pnpm exec wakefield managed-connectors init-config imessage-spectrum --json
pnpm exec wakefield managed-connectors test imessage-spectrum --kind spectrum-bridge --json
```

### Email

Import `.eml` files:

```bash
pnpm exec wakefield email ingest --file message.eml
cat message.eml | pnpm exec wakefield email ingest --json
```

Poll IMAP:

```bash
export WAKEFIELD_EMAIL_PASSWORD="app-specific-password"

pnpm exec wakefield connectors configure email \
  --enable \
  --set imapHost=imap.example.com \
  --set username=agent@example.com \
  --set passwordEnv=WAKEFIELD_EMAIL_PASSWORD

pnpm exec wakefield email poll --json
```

## Memory And Dreaming

Wakefield treats Codex as the owner of the persistent chat, compaction, and personality. It does not rewrite transcripts, replay old messages, or refresh the soul during compaction. Instead, it keeps a small local memory ledger and hands Codex a relevant note card only when a turn needs outside context.

The two first-class memory types are:

- `notes`: stable durable facts and preferences.
- `matters`: temporary active context for a person, room, task, case, or topic. Matters can be `active`, `waiting`, `resolved`, or `archived`.

Wakefield installs Codex lifecycle hooks and uses routed-turn metadata:

- `UserPromptSubmit`: records user prompts and injects only memory that matches the current request
- external Discord, iMessage, email, and HTTP turns: recall by connector, contact, room, sender, conversation, and likely topic
- scheduled wakeups: recall by wakeup, duty, skill, task, and topic
- `SessionStart`: records a lifecycle edge without injecting the soul or memory
- `PostToolUse`: records meaningful tool activity for change-based memory
- `PreCompact` / `PostCompact`: records compaction boundaries for bookkeeping only
- `Stop`: records the latest assistant output and queues background memory review

Inspect and edit scoped memory:

```bash
pnpm exec wakefield memory notes list
pnpm exec wakefield memory notes add --id reply-style --text "Use concise package updates." --person joe --topic package

pnpm exec wakefield memory matters list
pnpm exec wakefield memory matters upsert \
  --id joe-package \
  --summary "Joe is waiting for a package tracking follow-up." \
  --person joe \
  --topic package

pnpm exec wakefield memory recall --query "tracking package" --person joe
pnpm exec wakefield memory matters archive joe-package --reason "Tracking sent."
```

Run background memory processing:

```bash
pnpm exec wakefield dream
pnpm exec wakefield memory capture --dry-run --json
```

`wakefield dream` first builds deterministic turn summaries from hook evidence. If `OPENAI_API_KEY` is configured, Wakefield then runs a small structured capture pass that can create or update notes and active-context matters. The default capture model is `gpt-5.4-mini`; set `WAKEFIELD_MEMORY_MODEL` to use a different model. Set `WAKEFIELD_OPENAI_API_KEY` if you want Wakefield to use a key that is separate from the rest of your shell.

Install Wakefield memory tools into the selected Codex config:

```bash
pnpm exec wakefield mcp memory install
pnpm exec wakefield mcp memory status
```

This exposes:

- `wakefield_memory_recall`
- `wakefield_memory_list_notes`
- `wakefield_memory_get_note`
- `wakefield_memory_upsert_note`
- `wakefield_memory_list_matters`
- `wakefield_memory_get_matter`
- `wakefield_memory_upsert_matter`
- `wakefield_memory_archive_matter`
- `wakefield_memory_forget`
- `wakefield_memory_status`

Use these tools when Codex needs to deliberately inspect or maintain memory beyond the tiny note card Wakefield injects automatically. The app-support JSON files are Wakefield's storage layer, not the agent-facing API.

The journal/dreamer path is the background layer:

```bash
pnpm exec wakefield dream
pnpm exec wakefield recall --query "morning summaries"
```

Without an API key, it still summarizes queued hook events into local state. With an API key, it also reviews those summaries for meaningful memory deltas. The reviewer is deliberately stingy: it should save unresolved incidents, cross-channel continuity, changed statuses, and durable preferences, while skipping ordinary chat and completed one-off work.

## Service Tick

The service tick is the background loop:

1. load the configured env file
2. process queued dreams
3. run due wakeups
4. poll ready connector transports
5. optionally dispatch pending external messages
6. record service status

Configure it:

```bash
pnpm exec wakefield service configure \
  --enable \
  --interval-minutes 15 \
  --env-file ~/.wakefield.env
```

Run once:

```bash
pnpm exec wakefield service run-once
```

Install as a macOS LaunchAgent:

```bash
pnpm exec wakefield service launch-agent install --load
pnpm exec wakefield service launch-agent status
```

External message dispatch is opt-in:

```bash
pnpm exec wakefield service configure \
  --enable-dispatch \
  --dispatch-mode ipc \
  --dispatch-limit 3
```

Use `dry-run` or `manual` while testing. Use `ipc` when the Codex app is running and the selected persistent thread is available.

## Local HTTP API

Wakefield can expose the same setup and intake surfaces over localhost:

```bash
pnpm exec wakefield http serve --port 8787
```

Useful endpoints:

- `GET /health`
- `GET /manifest`
- `GET /doctor`
- `GET /snapshot`
- `GET /setup/actions`
- `GET /threads`
- `GET /contacts`
- `GET /duties`
- `GET /managed-connectors`
- `POST /setup/run`
- `POST /pack/inspect`
- `POST /pack/install`
- `POST /duties/import`
- `POST /duties/run`
- `POST /messages`
- `POST /email`
- `POST /email/poll`
- `POST /imessage/poll`

The server binds to `127.0.0.1` by default. If you bind outside localhost, pass `--token-env ENV_NAME`; requests must include `Authorization: Bearer <token>`.

## Security Posture

Wakefield is intentionally conservative:

- Connector settings store secret references, not raw secrets.
- Service env files are checked for missing or overly broad permissions.
- HTTP intake requires a bearer token outside localhost.
- Managed connector wizards report factual readiness instead of optimistic migration state.
- IPC dispatch fails loudly when the visible Codex app thread is unavailable.
- External messages stay pending when dispatch fails, so they can be retried.

## Project Status

Wakefield is an early local-first runtime. The core profile, hooks, scoped memory, wakeups, service tick, connector setup contracts, Discord connector, Photon/Spectrum iMessage connector, email intake, HTTP API, and macOS LaunchAgent paths are implemented.

Still intentionally out of scope for this slice:

- native menu bar UI
- Honcho provider sync
- packaged installer
- public agent-pack registry
- hosted cloud runtime

## Development

```bash
pnpm install
pnpm test
pnpm run check
pnpm verify
```

Run connector tests directly:

```bash
pnpm run test:shared
pnpm run test:discord
pnpm run test:imessage
```

Package smoke test:

```bash
npm pack --dry-run
pnpm --dir packages/connector-shared pack --dry-run
pnpm --dir packages/discord-codex pack --dry-run
pnpm --dir packages/imessage-spectrum pack --dry-run
```

## License

MIT
