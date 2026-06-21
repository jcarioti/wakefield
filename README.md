# Wakefield

Turn a Codex chat into an always-on personal AI assistant.

Wakefield makes a Codex conversation reachable through familiar channels like
iMessage and Discord, then gives it scheduled wakeups and repeatable duties so
it can keep working even when you are not sitting in front of Codex.

Wakefield is built for macOS. Runtime files live in Application Support, and
secret values stay in env files or ignored local files.

## Installation

Install Wakefield as a dev dependency inside an agent project:

```bash
pnpm add -D wakefield
npm install --save-dev wakefield
yarn add --dev wakefield
```

Add connector packages only for the channels you plan to use:

```bash
pnpm add -D @wakefield/discord-codex @wakefield/imessage-spectrum
npm install --save-dev @wakefield/discord-codex @wakefield/imessage-spectrum
yarn add --dev @wakefield/discord-codex @wakefield/imessage-spectrum
```

Run Wakefield with your package manager's exec command:

```bash
pnpm exec wakefield setup status
npm exec wakefield -- setup status
yarn exec wakefield setup status
```

The examples below use `pnpm exec wakefield`. With npm, use `npm exec
wakefield --` in the same position. With Yarn, use `yarn exec wakefield`.

## Create An Agent

Create or reuse a local agent by giving it a name, a soul, and a Codex chat:

Use a built-in soul preset (`friendly`, `gamer`, `fantasy`, or `operator`) or
write a custom `--soul`.

```bash
pnpm exec wakefield setup run \
  --name Mira \
  --soul-preset friendly \
  --latest-thread \
  --enable-service
```

Check the install:

```bash
pnpm exec wakefield setup status
pnpm exec wakefield doctor
```

The selected Codex chat is the personality. Wakefield does not replace the
Codex app; it routes work into that same conversation.

For a new assistant, open Codex in the agent workspace shown by
`wakefield setup status`, start the chat there, then select it with
`wakefield select-thread --latest`. That workspace contains the generated
`AGENTS.md` soul.

After Wakefield installs Codex tools, it asks the live Codex Desktop runtime to
refresh MCP servers through Codex's remote-control stream, then verifies the
loaded MCP server status before continuing.

## Connectors

Wakefield has three primary connectors: Discord, iMessage, and email.

Check current connector state at any time:

```bash
pnpm exec wakefield managed-connectors status
pnpm exec wakefield connectors status
```

### Discord

Use Discord when you want the agent in a server channel or DM.

You will need:

- a Discord application and bot from the Discord Developer Portal
- the bot token, exposed as an environment variable such as `DISCORD_BOT_TOKEN`
- the channel IDs and/or DM user IDs the agent is allowed to read and reply to

Setup:

```bash
pnpm exec wakefield setup connector discord \
  --envFile .env.wakefield \
  --set tokenEnv=DISCORD_BOT_TOKEN \
  --set allowedChannelIds=<discord-channel-id>
```

### iMessage

Use iMessage when you want the agent reachable from Messages through
Photon/Spectrum.

You will need:

- a Photon project
- a Spectrum bridge for the iMessage account
- `PHOTON_PROJECT_ID` and `PHOTON_SECRET_KEY` environment variables
- shared Photon project users for the people who may message the agent

Setup:

```bash
pnpm exec wakefield setup connector imessage \
  --envFile .env.wakefield \
  --set projectIdEnv=PHOTON_PROJECT_ID \
  --set projectSecretEnv=PHOTON_SECRET_KEY
```

Wakefield reads the Photon project users and automatically allows those phone
numbers. Spectrum space IDs are optional for advanced direct-space targeting.

### Email

Use email when you want inbound messages to become agent context. Email is an
intake connector; it does not make Wakefield send email replies by default.

You will need:

- an IMAP host and username
- an app-specific password, exposed through an environment variable such as `WAKEFIELD_EMAIL_PASSWORD`
- optional allowed senders such as `person@example.com` or `@example.com`

Setup:

```bash
pnpm exec wakefield connectors configure email \
  --enable \
  --set imapHost=imap.example.com \
  --set username=agent@example.com \
  --set passwordEnv=WAKEFIELD_EMAIL_PASSWORD \
  --set allowedSenders=@example.com

pnpm exec wakefield email poll --json
```

You can also import a single message:

```bash
pnpm exec wakefield email ingest --file message.eml
```

## Duties And Wakeups

Once the agent is reachable, give it recurring work.

Duties are reusable work definitions. Wakeups are scheduled events that run
groups of duties together in one Codex turn.

```bash
pnpm exec wakefield duties configure inbox-review --skill inbox-review
pnpm exec wakefield duties configure followups --skill followup-check

pnpm exec wakefield wakeups configure morning-ops \
  --enable \
  --time 08:00 \
  --dispatch-mode ipc \
  --duty inbox-review \
  --duty followups

pnpm exec wakefield wakeups list
pnpm exec wakefield wakeups run morning-ops --force
```

The generated Codex prompt stays compact and points at skills instead of pasting
large duty instructions. When the operating rules change, update the skill, not
every schedule entry.

## Memory

Wakefield memory is intentionally small. Codex keeps the conversation; Wakefield
keeps a couple of side lists it can mention when they are relevant.

The two memory types are:

- `notes`: stable facts, preferences, and standing policies.
- `matters`: active situations for a person, room, task, case, or topic.

Inspect and edit memory:

```bash
pnpm exec wakefield memory notes list
pnpm exec wakefield memory notes add --id reply-style --text "Use concise package updates." --person joe --topic package

pnpm exec wakefield memory matters list --all
pnpm exec wakefield memory matters upsert \
  --id joe-package \
  --summary "Joe is waiting for a package tracking follow-up." \
  --person joe \
  --topic package

pnpm exec wakefield memory recall --query "tracking package" --person joe
pnpm exec wakefield memory matters archive joe-package --reason "Tracking sent."
```

### Hooks, Summaries, And Dreaming

Wakefield installs Codex lifecycle hooks for bookkeeping:

- `UserPromptSubmit` records prompts for later bookkeeping.
- `PostToolUse` records tool activity.
- `Stop` records the assistant response and queues a turn summary.
- `PreCompact` and `PostCompact` record compaction boundaries only.
- `SessionStart` records startup/resume/compact edges.

Turn summaries are routine post-turn bookkeeping. They are not the same thing as
Codex compaction, and they are not all "dreams" in the human sense.

The slower memory-review path is:

```text
turn ends -> summary queued -> service writes a turn summary -> capture decides whether notes/matters should change
```

Run the background review manually:

```bash
pnpm exec wakefield dream
pnpm exec wakefield memory capture --dry-run --json
```

`wakefield dream` builds deterministic turn summaries from hook evidence, then
optionally runs a small structured capture pass through `codex exec
--ephemeral`. That capture worker uses the user's existing Codex auth, runs
read-only, disables hooks, and returns strict JSON deltas for notes and matters.

Useful capture worker overrides:

```bash
export WAKEFIELD_DREAM_CODEX_PATH="/absolute/path/to/codex"
export WAKEFIELD_DREAM_MODEL="gpt-5.4-mini"
export WAKEFIELD_DREAM_REASONING_EFFORT="low"
export WAKEFIELD_DREAM_CODEX_HOME="$HOME/.codex"
```

For LaunchAgent use, put these in the Wakefield service env file if `codex` is
not available on the launchd `PATH`.

## Service

The Wakefield service tick is the background loop:

1. process queued turn summaries and memory capture
2. run due wakeups
3. poll ready connector transports
4. optionally dispatch pending external messages
5. record service status

Configure it:

```bash
pnpm exec wakefield service configure \
  --enable \
  --interval-minutes 15 \
  --envFile ~/.wakefield.env

pnpm exec wakefield service run-once
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

Use `dry-run` or `manual` while testing. Use `ipc` when the Codex app is running
and the selected Codex chat is available.

## Package For Reuse

After an agent has a useful soul, contacts, skills, duties, and wakeups, turn it
into an agent pack. A pack is the portable recipe for recreating the same
Wakefield-powered agent in another checkout or on another machine.

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

Inspect and install a pack:

```bash
pnpm exec wakefield pack inspect --file ./wakefield-pack.json
pnpm exec wakefield pack install --file ./wakefield-pack.json --thread-id <codex-chat-id>
```

## Menu Bar

Wakefield includes a native macOS menu bar app. It is a thin client over the
same CLI and JSON surfaces.

On first launch, it opens the control window so you can name the agent and pick
a soul style before connecting channels.

From a Wakefield checkout:

```bash
pnpm run menubar:install
```

For development:

```bash
pnpm run menubar:build
pnpm run menubar:run
```

The menu bar can show runtime and connector status, start and stop the runtime,
start and stop managed connectors, launch connector setup, edit wakeup times and
duty selections, and select a recent Codex chat.

## Local HTTP API

Wakefield can expose setup, status, and intake over localhost:

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

The server binds to `127.0.0.1` by default. If you bind outside localhost, pass
`--token-env ENV_NAME`; requests must include `Authorization: Bearer <token>`.

## State Layout

Wakefield stores runtime state outside the project:

`~/Library/Application Support/Wakefield`

Use `WAKEFIELD_HOME` for tests, isolated experiments, or advanced relocation.

Each agent gets its own folder there with the generated soul, profile, selected
chat, contacts, connectors, schedules, and memory files.

## Concepts

The terms are intentionally small:

| Object | Purpose |
| --- | --- |
| Agent | Name, soul, selected Codex chat, and workspace. |
| Codex Chat | The conversation Wakefield sends work into. |
| Contacts | People, rooms, channels, and reply preferences. |
| Skills | Reusable instruction packs for Codex. |
| Duties | Reusable jobs the agent can run. |
| Wakeups | Times that run one or more duties. |
| Connectors | Discord, iMessage, email, HTTP, and scripts. |
| Memory | Notes and active situations Wakefield can bring up when relevant. |
| Service | The background runner for summaries, wakeups, and connector polling. |
| Agent Packs | Shareable recipes for recreating an agent. |

Wakefield is the reusable runtime. Agent packs carry the personality, contacts,
domain skills, duties, wakeups, and operating policy.

## Requirements

- macOS
- Node.js 20 or newer
- Codex desktop app
- npm, pnpm, or yarn
- Optional connector credentials for Discord, Photon/Spectrum, or IMAP

Wakefield can still run pack inspection, local memory, HTTP intake, dry-run
dispatch, and verification without live connector credentials.

## Security Posture

- Connector settings store secret references, not raw secrets.
- Service env files are checked for missing or overly broad permissions.
- HTTP intake requires a bearer token outside localhost.
- IPC dispatch fails loudly when the selected Codex chat is unavailable.
- External messages stay pending when dispatch fails, so they can be retried.

## Status

Wakefield is an early macOS runtime. Agent setup, hooks, memory, wakeups, the
background service, connector setup, Discord, Photon/Spectrum iMessage, email,
the local HTTP API, LaunchAgents, and the menu bar are implemented.

Still intentionally out of scope for this slice:

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
