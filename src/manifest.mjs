import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PACKAGE_PATH = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "package.json");

let cachedPackage = null;

export async function wakefieldManifest({
  connectors = [],
  managedConnectors = [],
  actions = []
} = {}) {
  const pkg = await readPackageJson();
  return {
    schemaVersion: 1,
    app: {
      name: "Wakefield",
      packageName: pkg.name,
      version: pkg.version,
      description: pkg.description,
      license: pkg.license
    },
    runtime: {
      node: process.versions.node,
      binary: "wakefield",
      stateEnv: "WAKEFIELD_HOME",
      codexHomeEnv: "CODEX_HOME"
    },
    setup: {
      jsonCommands: [
        ["wakefield", "manifest", "--json"],
        ["wakefield", "verify", "--json"],
        ["wakefield", "self-test", "--json"],
        ["wakefield", "setup", "status", "--json"],
        ["wakefield", "setup", "actions", "--json"],
        ["wakefield", "setup", "run", "--json"],
        ["wakefield", "setup", "connector", "$connectorId", "--json"],
        ["wakefield", "pack", "inspect", "--file", "$packFile", "--json"],
        ["wakefield", "pack", "install", "--file", "$packFile", "--json"],
        ["wakefield", "menu", "snapshot", "--json"],
        ["wakefield", "threads", "list", "--json"],
        ["wakefield", "connectors", "list", "--json"],
        ["wakefield", "connectors", "status", "--json"],
        ["wakefield", "connectors", "wizards", "--json"],
        ["wakefield", "connectors", "wizard", "discord", "--json"],
        ["wakefield", "managed-connectors", "status", "--json"],
        ["wakefield", "managed-connectors", "setup", "$connectorId", "--json"],
        ["wakefield", "managed-connectors", "wizards", "--json"],
        ["wakefield", "managed-connectors", "init-config", "$connectorId", "--json"],
        ["wakefield", "managed-connectors", "mcp", "status", "$connectorId", "--json"],
        ["wakefield", "managed-connectors", "mcp", "install", "$connectorId", "--json"],
        ["wakefield", "mcp", "memory", "status", "--json"],
        ["wakefield", "mcp", "memory", "install", "--json"],
        ["wakefield", "managed-connectors", "test", "$connectorId", "--kind", "status", "--json"],
        ["wakefield", "managed-connectors", "launch-agent", "status", "$connectorId", "--json"],
        ["wakefield", "managed-connectors", "launch-agent", "install", "$connectorId", "--load", "--json"],
        ["wakefield", "contacts", "list", "--json"],
        ["wakefield", "contacts", "import", "--file", "$contactsFile", "--json"],
        ["wakefield", "duties", "list", "--json"],
        ["wakefield", "duties", "run", "--force", "--json"],
        ["wakefield", "wakeups", "list", "--json"],
        ["wakefield", "wakeups", "run", "--force", "--json"],
        ["wakefield", "discord", "listen"],
        ["wakefield", "email", "ingest", "--json"],
        ["wakefield", "email", "poll", "--json"],
        ["wakefield", "imessage", "poll", "--json"],
        ["wakefield", "inbox", "pending", "--json"],
        ["wakefield", "inbox", "dispatch", "--mode", "dry-run", "--json"],
        ["wakefield", "memory", "notes", "list", "--json"],
        ["wakefield", "memory", "matters", "list", "--json"],
        ["wakefield", "memory", "recall", "--query", "$query", "--json"],
        ["wakefield", "memory", "matters", "archive", "$matterId", "--json"],
        ["wakefield", "memory", "capture", "--dry-run", "--json"],
        ["wakefield", "dream", "--json"],
        ["wakefield", "service", "status", "--json"],
        ["wakefield", "service", "configure", "--envFile", "$envFile", "--json"],
        ["wakefield", "service", "run-once", "--json"],
        ["wakefield", "service", "launch-agent", "status", "--json"],
        ["wakefield", "service", "launch-agent", "install", "--load", "--json"],
        ["wakefield", "service", "launch-agent", "load", "--json"],
        ["wakefield", "service", "launch-agent", "reload", "--json"],
        ["wakefield", "service", "launch-agent", "uninstall", "--unload", "--json"],
        ["wakefield", "doctor", "--json"]
      ],
      actionContract: {
        schemaVersion: 1,
        fields: ["id", "kind", "label", "enabled", "command", "fields", "reason"]
      }
    },
    core: [
      feature("agent-profile", "available", "Create a named local agent profile."),
      feature("soul", "available", "Store durable identity in a generated AGENTS.md soul file."),
      feature("thread-selection", "available", "Attach one persistent Codex thread as the agent personality."),
      feature("agent-packs", "available", "Install reusable agent packs that define cwd, contacts, duties, wakeups, and connector setup."),
      feature("codex-hooks", "available", "Install Codex lifecycle hooks for manual and routed turns."),
      feature("contacts", "available", "Resolve connector source metadata into deterministic local contacts."),
      feature("local-memory", "available", "Record inbox, journal, dreams, and state in local app support storage."),
      feature("scoped-memory-notes", "available", "Store stable durable facts and preferences as scoped notes."),
      feature("active-context-matters", "available", "Track temporary person, room, task, and case context that can resolve or archive."),
      feature("scoped-memory-recall", "available", "Inject small relevant memory cards into connector, wakeup, and prompt turns."),
      feature("memory-mcp-tools", "available", "Expose scoped memory recall, notes, and matters as MCP tools for deliberate agent lookup and maintenance."),
      feature("local-dreamer", "available", "Process queued hook events into summaries and Codex-assisted memory capture."),
      feature("external-message-ingest", "available", "Queue normalized connector messages and return Codex routing metadata."),
      feature("discord-gateway", "available", "Listen for configured Discord bot messages and queue them into Wakefield."),
      feature("email-rfc822-ingest", "available", "Import RFC 822 email messages from .eml files or stdin."),
      feature("email-imap-poll", "available", "Poll a configured IMAP mailbox into the Wakefield inbox."),
      feature("imessage-chatdb-poll", "available", "Poll the local macOS Messages database into the Wakefield inbox."),
      feature("http-intake", "available", "Run a local HTTP intake for external message and email handoff."),
      feature("http-setup-api", "available", "Expose local setup, thread, and connector endpoints for an installer or menu bar."),
      feature("external-message-dispatch", "available", "Dispatch pending connector messages through dry-run, manual, or Codex app IPC modes."),
      feature("service-tick", "available", "Run one scheduled service tick for dreaming and future connector polling."),
      feature("scheduled-duties", "available", "Run named wakeups that bundle reusable duties on service ticks through dry-run, manual, or Codex IPC dispatch."),
      feature("service-env-file", "available", "Load a local secrets env file before service ticks and readiness checks."),
      feature("service-external-dispatch", "available", "Let service ticks dispatch pending connector messages when explicitly enabled."),
      feature("macos-launch-agent", "available", "Generate, install, load, reload, and remove a user LaunchAgent for service ticks on macOS."),
      feature("setup-actions", "available", "Expose stable setup actions for a menu bar or installer."),
      feature("menu-snapshot", "available", "Expose one read-only JSON payload for a menu bar or setup UI."),
      feature("clone-self-test", "available", "Exercise the install, memory, email, service, menu, and scheduler paths in temporary state."),
      feature("clone-verify", "available", "Run a package-level verification gate for clone installs and installer smoke checks."),
      feature("one-command-setup", "available", "Run the core setup path idempotently for installers and first-run flows."),
      feature("connector-config", "available", "Save local connector setup state without storing raw secrets."),
      feature("connector-wizards", "available", "Expose connector-specific setup wizard contracts for menu bars and installers."),
      feature("managed-connector-packages", "available", "Supervise mature connector packages for Discord and Photon/Spectrum iMessage without embedding app-specific logic."),
      feature("managed-connector-wizards", "available", "Expose setup, MCP, daemon, and smoke-test contracts for mature connector packages."),
      feature("managed-connector-config-init", "available", "Generate local mature connector config files from the selected persistent Codex thread without storing raw secrets."),
      feature("managed-connector-mcp-install", "available", "Install or update the named mature connector MCP server in the selected Codex config."),
      feature("managed-connector-launch-agents", "available", "Generate, install, load, reload, and remove user LaunchAgents for managed connector daemons.")
    ],
    connectors: connectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      status: connector.status || connector.implementationStatus,
      implementationStatus: connector.implementationStatus || connector.status,
      available: Boolean(connector.available),
      ingestAvailable: Boolean(connector.ingestAvailable),
      configured: Boolean(connector.configured),
      enabled: Boolean(connector.enabled),
      ready: Boolean(connector.ready),
      transports: connector.transports || [],
      setupActionId: connector.setupActionId || null,
      description: connector.description,
      missingSettings: connector.missingSettings || [],
      missingSecrets: connector.missingSecrets || [],
      missingPaths: connector.missingPaths || []
    })),
    managedConnectors: managedConnectors.map((connector) => ({
      id: connector.id,
      name: connector.name,
      adapter: connector.adapter,
      connectorId: connector.connectorId,
      enabled: Boolean(connector.enabled),
      configured: Boolean(connector.configured),
      ready: Boolean(connector.ready),
      running: Boolean(connector.running),
      capabilities: connector.capabilities || [],
      mcp: {
        serverName: connector.mcp?.serverName || null,
        ok: Boolean(connector.mcp?.ok),
        tools: connector.mcp?.tools || []
      },
      launchAgent: {
        label: connector.launchAgent?.label || null,
        installed: Boolean(connector.launchAgent?.installed),
        loaded: connector.launchAgent?.loaded ?? null
      }
    })),
    actionCount: actions.length
  };
}

export function formatManifest(manifest) {
  const lines = [
    `${manifest.app.name} ${manifest.app.version}`,
    manifest.app.description,
    "",
    "Core:"
  ];

  for (const item of manifest.core) {
    lines.push(`- ${item.id}: ${item.status}`);
  }

  lines.push("", "Connectors:");
  for (const connector of manifest.connectors) {
    lines.push(`- ${connector.id}: ${connector.status}`);
  }

  if (manifest.managedConnectors.length > 0) {
    lines.push("", "Managed Connectors:");
    for (const connector of manifest.managedConnectors) {
      lines.push(`- ${connector.id}: ${connector.ready ? "ready" : connector.enabled ? "needs attention" : "disabled"}`);
    }
  }

  lines.push("", "Setup JSON:");
  for (const command of manifest.setup.jsonCommands) {
    lines.push(`- ${command.join(" ")}`);
  }

  return lines.join("\n");
}

function feature(id, status, description) {
  return { id, status, description };
}

async function readPackageJson() {
  if (cachedPackage) return cachedPackage;
  cachedPackage = JSON.parse(await fs.readFile(PACKAGE_PATH, "utf8"));
  return cachedPackage;
}
