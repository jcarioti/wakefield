import { connectorConfigPath, appHome, expandHome } from "./paths.mjs";
import { pathExists, readJson, writeJson } from "./json-store.mjs";

export const CONNECTOR_SETUP_SLOTS = [
  {
    id: "discord",
    name: "Discord",
    implementationStatus: "available",
    status: "available",
    available: true,
    ingestAvailable: true,
    setupActionId: "setup-connector-discord",
    description: "Route Discord DMs or allowed channels into the selected Codex thread.",
    transports: [
      {
        id: "gateway",
        status: "available",
        command: ["wakefield", "discord", "listen"],
        description: "Listen for Discord DMs and configured channel messages with a bot token."
      }
    ],
    fields: [
      { id: "botTokenEnv", label: "Bot token environment variable", required: true, placeholder: "DISCORD_BOT_TOKEN", secretEnv: true },
      { id: "allowedTargets", label: "Allowed channel or DM ids", required: false, placeholder: "comma-separated ids" },
      { id: "allowedUsers", label: "Allowed Discord user ids", required: false, placeholder: "comma-separated ids" }
    ]
  },
  {
    id: "imessage",
    name: "iMessage",
    implementationStatus: "available",
    status: "available",
    available: true,
    ingestAvailable: true,
    setupActionId: "setup-connector-imessage",
    description: "Route iMessage or SMS conversations into the selected Codex thread.",
    defaultSettings: {
      databasePath: "~/Library/Messages/chat.db",
      maxMessagesPerPoll: "20"
    },
    transports: [
      {
        id: "chatdb",
        status: "available",
        command: ["wakefield", "imessage", "poll"],
        description: "Poll the local macOS Messages database after privacy access is granted."
      }
    ],
    fields: [
      { id: "databasePath", label: "Messages database", required: false, placeholder: "~/Library/Messages/chat.db", pathMustExist: true },
      { id: "allowedSenders", label: "Allowed senders", required: false, placeholder: "+15551234567,person@example.com" },
      { id: "allowedChats", label: "Allowed chat ids or GUIDs", required: false, placeholder: "comma-separated ids" },
      { id: "allowGroupChats", label: "Allow group chats", required: false, placeholder: "false" },
      { id: "maxMessagesPerPoll", label: "Max messages per poll", required: false, placeholder: "20" }
    ]
  },
  {
    id: "email",
    name: "Email",
    implementationStatus: "available",
    status: "available",
    available: true,
    ingestAvailable: true,
    setupActionId: "setup-connector-email",
    description: "Monitor an inbox as a read-first information source.",
    transports: [
      {
        id: "rfc822",
        status: "available",
        command: ["wakefield", "email", "ingest"],
        description: "Import RFC 822 .eml messages from a file or stdin."
      },
      {
        id: "imap",
        status: "available",
        command: ["wakefield", "email", "poll"],
        description: "Poll an IMAP mailbox after account setup."
      }
    ],
    fields: [
      { id: "imapHost", label: "IMAP host", required: true, placeholder: "imap.example.com" },
      { id: "username", label: "Mailbox username", required: true, placeholder: "agent@example.com" },
      { id: "passwordEnv", label: "Password environment variable", required: true, placeholder: "WAKEFIELD_EMAIL_PASSWORD", secretEnv: true },
      { id: "allowedSenders", label: "Allowed senders", required: false, placeholder: "person@example.com,@example.com" },
      { id: "mailbox", label: "Mailbox", required: false, placeholder: "INBOX" },
      { id: "processedMailbox", label: "Processed mailbox", required: false, placeholder: "Wakefield/Processed" },
      { id: "maxMessagesPerPoll", label: "Max messages per poll", required: false, placeholder: "10" }
    ]
  }
];

export async function connectorStatuses({
  home = appHome()
} = {}) {
  return Promise.all(CONNECTOR_SETUP_SLOTS.map((slot) => connectorStatus(slot.id, { home })));
}

export async function connectorStatus(connectorId, {
  home = appHome()
} = {}) {
  const slot = connectorSlot(connectorId);
  const configPath = connectorConfigPath(slot.id, home);
  const exists = await pathExists(configPath);
  const config = await readJson(configPath, defaultConnectorConfig(slot.id));
  const settings = {
    ...(slot.defaultSettings || {}),
    ...(config.settings && typeof config.settings === "object" ? config.settings : {})
  };
  const missingSettings = requiredFields(slot)
    .filter((field) => !hasSetting(settings, field.id))
    .map((field) => field.id);
  const configured = exists && missingSettings.length === 0;
  const enabled = Boolean(config.enabled);
  const missingSecrets = enabled && configured
    ? missingSecretEnvVars(slot, settings)
    : [];
  const missingPaths = enabled && configured
    ? await missingRequiredPaths(slot, settings)
    : [];

  return {
    id: slot.id,
    name: slot.name,
    implementationStatus: slot.implementationStatus,
    status: slot.implementationStatus,
    available: Boolean(slot.available),
    ingestAvailable: Boolean(slot.ingestAvailable),
    configured,
    configExists: exists,
    enabled,
    ready: Boolean(slot.available && configured && enabled && missingSecrets.length === 0 && missingPaths.length === 0),
    setupActionId: slot.setupActionId,
    description: slot.description,
    fields: slot.fields,
    transports: slot.transports || [],
    settings,
    missingSettings,
    missingSecrets,
    missingPaths,
    configPath
  };
}

export async function configureConnector(connectorId, {
  home = appHome(),
  enabled = null,
  settings = {},
  unset = []
} = {}) {
  const slot = connectorSlot(connectorId);
  const configPath = connectorConfigPath(slot.id, home);
  const current = await readJson(configPath, defaultConnectorConfig(slot.id));
  const now = new Date().toISOString();
  const nextSettings = {
    ...(current.settings || {}),
    ...settings
  };
  for (const key of unset || []) delete nextSettings[key];

  const next = {
    id: slot.id,
    enabled: enabled == null ? Boolean(current.enabled) : Boolean(enabled),
    settings: nextSettings,
    createdAt: current.createdAt || now,
    updatedAt: now
  };

  await writeJson(configPath, next);
  return connectorStatus(slot.id, { home });
}

export async function connectorWizard(connectorId, {
  home = appHome()
} = {}) {
  const slot = connectorSlot(connectorId);
  const status = await connectorStatus(slot.id, { home });
  const settingsCommand = ["wakefield", "connectors", "configure", slot.id, "--enable"];
  for (const field of slot.fields || []) {
    settingsCommand.push("--set", `${field.id}=$${field.id}`);
  }

  return {
    schemaVersion: 1,
    id: `connector-wizard-${slot.id}`,
    connectorId: slot.id,
    name: slot.name,
    title: `Configure ${slot.name}`,
    description: slot.description,
    available: status.available,
    configured: status.configured,
    enabled: status.enabled,
    ready: status.ready,
    status,
    fields: wizardFields(slot, status),
    steps: [
      {
        id: "settings",
        title: "Connection settings",
        status: status.configured ? "complete" : "needs_input",
        description: "Collect local connector settings without storing raw secrets.",
        command: settingsCommand,
        fields: wizardFields(slot, status)
      },
      {
        id: "readiness",
        title: "Readiness check",
        status: status.ready ? "complete" : "needs_attention",
        description: readinessDescription(status),
        command: ["wakefield", "connectors", "status", "--json"],
        checks: connectorReadinessChecks(status)
      },
      {
        id: "run",
        title: "Run transport",
        status: status.ready ? "available" : "blocked",
        description: status.ready ? "The connector transport can run now." : "Finish readiness checks before running this connector.",
        commands: transportCommands(status)
      }
    ],
    nextAction: connectorNextAction(status)
  };
}

export async function connectorWizards({
  home = appHome()
} = {}) {
  return Promise.all(CONNECTOR_SETUP_SLOTS.map((slot) => connectorWizard(slot.id, { home })));
}

export function formatConnectorWizard(wizard) {
  const lines = [
    `${wizard.title}`,
    `state: ${wizard.ready ? "ready" : wizard.configured ? "configured" : "needs setup"}`,
    `next: ${wizard.nextAction.label}`,
    ""
  ];
  for (const step of wizard.steps) {
    lines.push(`${step.status}: ${step.title} - ${step.description}`);
  }
  return lines.join("\n");
}

export function formatConnectorStatuses(connectors) {
  return connectors
    .map((connector) => {
      const state = connector.ready
        ? "ready"
        : connector.configured
          ? connector.enabled ? "configured, transport unavailable" : "configured, disabled"
          : "needs setup";
      const missing = connector.missingSettings.length > 0
        ? ` missing: ${connector.missingSettings.join(", ")}`
        : "";
      const secrets = connector.missingSecrets?.length > 0
        ? ` missing env: ${connector.missingSecrets.join(", ")}`
        : "";
      const paths = connector.missingPaths?.length > 0
        ? ` missing file: ${connector.missingPaths.join(", ")}`
        : "";
      const transports = (connector.transports || []).filter((transport) => transport.status === "available");
      const transportText = transports.length > 0
        ? ` transports: ${transports.map((transport) => transport.id).join(", ")}`
        : "";
      return `${connector.id}: ${state}${missing}${secrets}${paths}${transportText}`;
    })
    .join("\n");
}

export function parseSettings(values = []) {
  const settings = {};
  for (const value of asArray(values)) {
    const text = String(value);
    const index = text.indexOf("=");
    if (index <= 0) throw new Error(`Expected key=value for --set, got: ${text}`);
    settings[text.slice(0, index)] = text.slice(index + 1);
  }
  return settings;
}

export function asArray(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function connectorSlot(connectorId) {
  const slot = CONNECTOR_SETUP_SLOTS.find((item) => item.id === connectorId);
  if (!slot) throw new Error(`Unknown connector: ${connectorId}`);
  return slot;
}

function defaultConnectorConfig(connectorId) {
  return {
    id: connectorId,
    enabled: false,
    settings: {}
  };
}

function requiredFields(slot) {
  return (slot.fields || []).filter((field) => field.required);
}

function missingSecretEnvVars(slot, settings) {
  return (slot.fields || [])
    .filter((field) => field.secretEnv)
    .map((field) => settings[field.id])
    .filter((envName) => envName && !process.env[String(envName)]);
}

function wizardFields(slot, status) {
  return (slot.fields || []).map((field) => {
    const envName = field.secretEnv ? status.settings[field.id] || null : null;
    return {
      id: field.id,
      label: field.label,
      required: Boolean(field.required),
      placeholder: field.placeholder || null,
      secretEnv: Boolean(field.secretEnv),
      pathMustExist: Boolean(field.pathMustExist),
      value: field.secretEnv ? envName : status.settings[field.id] || "",
      envSet: envName ? Boolean(process.env[String(envName)]) : null,
      missing: status.missingSettings.includes(field.id)
        || (envName && status.missingSecrets.includes(String(envName)))
        || (field.pathMustExist && status.missingPaths.includes(String(status.settings[field.id])))
    };
  });
}

function readinessDescription(status) {
  if (status.ready) return "Connector settings, secrets, and local files are ready.";
  if (status.missingSettings.length > 0) return `Missing settings: ${status.missingSettings.join(", ")}.`;
  if (!status.configExists) return "Connector settings have not been saved yet.";
  if (status.missingSecrets.length > 0) return `Missing environment variable: ${status.missingSecrets.join(", ")}.`;
  if (status.missingPaths.length > 0) return `Missing readable file: ${status.missingPaths.join(", ")}.`;
  if (!status.enabled) return "Connector is configured but disabled.";
  return "Connector is not ready yet.";
}

function connectorReadinessChecks(status) {
  return [
    { id: "available", ok: status.available, detail: status.available ? "transport available" : "transport unavailable" },
    { id: "configured", ok: status.configured, detail: status.configured ? "settings complete" : status.configExists ? missingDetail(status.missingSettings) : "settings not saved" },
    { id: "enabled", ok: status.enabled, detail: status.enabled ? "enabled" : "disabled" },
    { id: "secrets", ok: status.missingSecrets.length === 0, detail: missingDetail(status.missingSecrets) },
    { id: "paths", ok: status.missingPaths.length === 0, detail: missingDetail(status.missingPaths) }
  ];
}

function connectorNextAction(status) {
  if (status.missingSettings.length > 0) {
    return {
      id: "enter-settings",
      label: "Enter connector settings",
      reason: `Missing: ${status.missingSettings.join(", ")}.`
    };
  }
  if (!status.configExists) {
    return {
      id: "save-settings",
      label: "Save connector settings",
      reason: "Connector settings have not been saved yet."
    };
  }
  if (status.missingSecrets.length > 0) {
    return {
      id: "set-environment",
      label: "Set environment variable",
      reason: `Missing: ${status.missingSecrets.join(", ")}.`
    };
  }
  if (status.missingPaths.length > 0) {
    return {
      id: "grant-file-access",
      label: "Grant file access",
      reason: `Missing readable file: ${status.missingPaths.join(", ")}.`
    };
  }
  if (!status.enabled) {
    return {
      id: "enable-connector",
      label: "Enable connector",
      reason: "Connector is configured but disabled."
    };
  }
  if (status.ready) {
    return {
      id: "run-connector",
      label: "Run connector",
      reason: "Connector is ready."
    };
  }
  return {
    id: "review-status",
    label: "Review connector status",
    reason: "Connector needs attention."
  };
}

function transportCommands(status) {
  return (status.transports || [])
    .filter((transport) => transport.status === "available")
    .map((transport) => ({
      id: transport.id,
      command: jsonTransportCommand(transport.command || []),
      description: transport.description
    }));
}

function jsonTransportCommand(command) {
  if (command.length === 0) return command;
  if (["listen", "serve"].includes(command[command.length - 1])) return command;
  return command.includes("--json") ? command : [...command, "--json"];
}

function missingDetail(missing) {
  return missing.length === 0 ? "complete" : `missing: ${missing.join(", ")}`;
}

async function missingRequiredPaths(slot, settings) {
  const paths = [];
  for (const field of slot.fields || []) {
    if (!field.pathMustExist) continue;
    const value = settings[field.id];
    if (!value) continue;
    if (!await pathExists(expandHome(String(value)))) paths.push(String(value));
  }
  return paths;
}

function hasSetting(settings, key) {
  return settings[key] != null && String(settings[key]).trim() !== "";
}
