import { listRecentThreads } from "./codex-sessions.mjs";
import { connectorStatuses, CONNECTOR_SETUP_SLOTS } from "./connectors.mjs";
import { loadContacts } from "./contacts.mjs";
import { doctor, formatDoctor } from "./doctor.mjs";
import { managedConnectorStatuses } from "./managed-connectors.mjs";
import { wakefieldManifest } from "./manifest.mjs";
import { codexConfigPath } from "./paths.mjs";
import { loadAgent } from "./profile.mjs";
import { serviceStatus } from "./service.mjs";

export async function setupStatus({
  home,
  codexHomePath = null,
  threadLimit = 5
} = {}) {
  const report = await doctor({ home, codexHomePath: codexHomePath || undefined });
  const agent = await loadAgent(null, home);
  const threads = await listRecentThreads({
    codexHomePath: codexHomePath || undefined,
    limit: threadLimit
  });
  const service = await serviceStatus({ home });
  const connectors = await connectorStatuses({ home });
  const managedConnectors = await managedConnectorStatuses({
    home,
    agent,
    codexConfigPath: codexConfigPath(codexHomePath || undefined)
  });
  const contacts = await loadContacts({ home });
  const actions = setupActions({ report, agent, threads, connectors, managedConnectors, service });
  const nextSteps = nextSetupSteps({ report, agent, threads });
  const manifest = await wakefieldManifest({ connectors, managedConnectors, actions });

  return {
    manifest,
    ok: report.ok,
    phase: report.ok ? "ready" : "needs_setup",
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      ownerName: agent.ownerName || null,
      agentHome: agent.agentHome || null,
      threadId: agent.threadId || null,
      cwd: agent.cwd || null,
      soulPath: agent.soulPath || null,
      bootstrapPromptPath: agent.bootstrapPromptPath || null
    } : null,
    doctor: report,
    recentThreads: threads,
    contacts: {
      total: contacts.contacts.length,
      source: contacts.source || null
    },
    connectors,
    managedConnectors,
    service,
    actions,
    nextSteps
  };
}

export function formatSetupStatus(status) {
  const lines = [
    "Wakefield setup",
    `state: ${status.phase}`,
    ""
  ];

  if (status.agent) {
    lines.push(`agent: ${status.agent.name} (${status.agent.id})`);
    lines.push(`thread: ${status.agent.threadId || "not selected"}`);
    lines.push(`cwd: ${status.agent.cwd || "not set"}`);
  } else {
    lines.push("agent: not created");
  }

  lines.push("", formatDoctor(status.doctor), "");

  if (status.recentThreads.length > 0) {
    lines.push("Recent Codex threads:");
    for (const thread of status.recentThreads) {
      const cwd = thread.cwd ? ` ${thread.cwd}` : "";
      lines.push(`- ${thread.threadId} ${thread.updatedAt}${cwd}`);
    }
    lines.push("");
  }

  lines.push("Connectors:");
  for (const connector of status.connectors) {
    lines.push(`- ${connector.name}: ${connector.status}`);
  }
  if (status.managedConnectors.length > 0) {
    lines.push("Managed connector packages:");
    for (const connector of status.managedConnectors) {
      const state = connector.ready
        ? connector.running ? "ready, running" : "ready"
        : connector.enabled ? "needs attention" : "disabled";
      lines.push(`- ${connector.name}: ${state}`);
    }
  }

  lines.push("", `Service env file: ${formatServiceEnvironment(status.service.environment)}`);
  lines.push(`Contacts: ${status.contacts.total}`);

  if (status.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of status.nextSteps) {
      lines.push(`- ${step}`);
    }
  }

  return lines.join("\n");
}

export function formatNextSteps(status) {
  if (status.nextSteps.length === 0) {
    return "Wakefield core setup is ready.";
  }
  return status.nextSteps.map((step) => `- ${step}`).join("\n");
}

export function formatActions(actions) {
  return actions
    .map((action) => {
      const state = action.enabled ? "enabled" : "disabled";
      const reason = action.reason ? ` - ${action.reason}` : "";
      return `${action.id}: ${state} - ${action.label}${reason}`;
    })
    .join("\n");
}

export function formatConnectors(connectors = CONNECTOR_SETUP_SLOTS) {
  return connectors
    .map((connector) => `${connector.id}: ${connector.status} - ${connector.description}`)
    .join("\n");
}

export function setupActions({ report, agent, threads, connectors = [], managedConnectors = [], service = null }) {
  const check = (label) => report.checks.find((item) => item.label === label);
  const hookReady = Boolean(check("Codex hook config")?.ok && check("Codex hook command")?.ok);
  const skillsReady = Boolean(check("Codex Wakefield skills")?.ok);

  return [
    {
      id: "create-agent",
      kind: "command",
      label: "Create Wakefield agent",
      enabled: !agent,
      command: ["wakefield", "install", "--name", "$name", "--soul", "$soul"],
      fields: [
        { id: "name", label: "Agent name", required: true, placeholder: "Mira" },
        { id: "soul", label: "Soul", required: false, placeholder: "A calm personal research companion." }
      ],
      reason: agent ? "Agent already exists." : null
    },
    {
      id: "install-hooks",
      kind: "command",
      label: "Install Codex hooks",
      enabled: Boolean(agent && !hookReady),
      command: ["wakefield", "install"],
      fields: [],
      reason: !agent ? "Create an agent first." : hookReady ? "Hooks already installed." : null
    },
    {
      id: "install-base-skills",
      kind: "command",
      label: "Install Wakefield base skills",
      enabled: Boolean(agent && !skillsReady),
      command: ["wakefield", "install"],
      fields: [],
      reason: !agent ? "Create an agent first." : skillsReady ? "Wakefield base skills already installed." : null
    },
    {
      id: "select-latest-thread",
      kind: "command",
      label: "Select newest Codex thread",
      enabled: Boolean(agent && !agent.threadId && threads.length > 0),
      command: ["wakefield", "select-thread", "--latest"],
      fields: [],
      reason: !agent
        ? "Create an agent first."
        : agent.threadId
          ? "Codex thread already selected."
          : threads.length === 0
            ? "Open or create a Codex thread first."
            : null
    },
    {
      id: "select-thread",
      kind: "command",
      label: "Select Codex thread",
      enabled: Boolean(agent),
      command: ["wakefield", "select-thread", "--thread-id", "$threadId"],
      fields: [
        { id: "threadId", label: "Codex thread", required: true, options: threads.map(threadOption) }
      ],
      reason: agent ? null : "Create an agent first."
    },
    {
      id: "review-hooks",
      kind: "codex-command",
      label: "Review Codex hook trust",
      enabled: Boolean(agent && check("Codex hook config")?.ok),
      command: "/hooks",
      fields: [],
      reason: !agent
        ? "Create an agent first."
        : check("Codex hook config")?.ok
          ? null
          : "Install hooks first."
    },
    {
      id: "refresh-codex-mcp",
      kind: "command",
      label: "Refresh Codex MCP tools",
      enabled: Boolean(agent),
      command: ["wakefield", "mcp", "reload"],
      fields: [],
      reason: agent ? null : "Create an agent first."
    },
    {
      id: "enable-service",
      kind: "command",
      label: "Enable Wakefield service tick",
      enabled: Boolean(agent && !service?.enabled),
      command: ["wakefield", "service", "configure", "--enable"],
      fields: [],
      reason: !agent ? "Create an agent first." : service?.enabled ? "Service tick already enabled." : null
    },
    {
      id: "configure-service-env-file",
      kind: "command",
      label: "Choose service secrets file",
      enabled: Boolean(agent && serviceEnvFileNeedsAttention(service?.environment)),
      command: ["wakefield", "service", "configure", "--envFile", "$envFile"],
      fields: [
        { id: "envFile", label: "Service secrets file", required: true, placeholder: "~/.wakefield.env" }
      ],
      reason: !agent
        ? "Create an agent first."
        : serviceEnvFileReason(service?.environment)
    },
    {
      id: "run-service-once",
      kind: "command",
      label: "Run Wakefield service once",
      enabled: Boolean(agent),
      command: ["wakefield", "service", "run-once"],
      fields: [],
      reason: agent ? null : "Create an agent first."
    },
    {
      id: "enable-external-dispatch",
      kind: "command",
      label: "Enable external message dispatch",
      enabled: Boolean(agent && !service?.externalDispatch?.enabled),
      command: ["wakefield", "service", "configure", "--enable", "--enable-dispatch", "--dispatch-mode", "$dispatchMode"],
      fields: [
        {
          id: "dispatchMode",
          label: "Dispatch mode",
          required: true,
          options: [
            { value: "ipc", label: "Codex app IPC" },
            { value: "dry-run", label: "Dry run" },
            { value: "manual", label: "Manual handoff" }
          ]
        }
      ],
      reason: !agent
        ? "Create an agent first."
        : service?.externalDispatch?.enabled
          ? "External message dispatch is already enabled."
          : null
    },
    {
      id: "install-launch-agent",
      kind: "command",
      label: "Install and load macOS LaunchAgent",
      enabled: Boolean(agent && service?.scheduler?.supported && !service?.scheduler?.installed),
      command: ["wakefield", "service", "launch-agent", "install", "--load"],
      fields: [],
      reason: !agent
        ? "Create an agent first."
        : !service?.scheduler?.supported
          ? "LaunchAgent scheduler is only available on macOS."
          : service?.scheduler?.installed
            ? "LaunchAgent already installed."
            : null
    },
    {
      id: "load-launch-agent",
      kind: "command",
      label: "Load macOS LaunchAgent",
      enabled: Boolean(agent && service?.scheduler?.installed && service?.scheduler?.loaded === false && service?.scheduler?.canLoad),
      command: ["wakefield", "service", "launch-agent", "load"],
      fields: [],
      reason: !agent
        ? "Create an agent first."
        : !service?.scheduler?.installed
          ? "Install the LaunchAgent first."
          : !service?.scheduler?.canLoad
            ? "launchctl is only available on macOS."
            : service?.scheduler?.loaded
              ? "LaunchAgent already loaded."
              : service?.scheduler?.loaded == null
                ? "LaunchAgent load state is unknown."
                : null
    },
    {
      id: "reload-launch-agent",
      kind: "command",
      label: "Reload macOS LaunchAgent",
      enabled: Boolean(agent && service?.scheduler?.installed && service?.scheduler?.canLoad),
      command: ["wakefield", "service", "launch-agent", "reload"],
      fields: [],
      reason: !agent
        ? "Create an agent first."
        : !service?.scheduler?.installed
          ? "Install the LaunchAgent first."
          : !service?.scheduler?.canLoad
            ? "launchctl is only available on macOS."
            : null
    },
    {
      id: "uninstall-launch-agent",
      kind: "command",
      label: "Remove macOS LaunchAgent",
      enabled: Boolean(service?.scheduler?.installed),
      command: ["wakefield", "service", "launch-agent", "uninstall", "--unload"],
      fields: [],
      reason: service?.scheduler?.installed ? null : "LaunchAgent is not installed."
    },
    ...connectors.map(connectorAction),
    ...managedConnectors.map(managedConnectorAction)
  ];
}

function nextSetupSteps({ report, agent, threads }) {
  const steps = [];
  const check = (label) => report.checks.find((item) => item.label === label);

  if (!agent) {
    steps.push('Create an agent: pnpm wakefield install --name "Mira" --soul "A short description."');
    return steps;
  }

  if (!check("Codex hook config")?.ok || !check("Codex hook command")?.ok) {
    steps.push("Install Wakefield hooks: pnpm wakefield install");
  }

  if (!agent.threadId) {
    if (threads.length > 0) {
      steps.push("Select the newest local Codex thread: pnpm wakefield select-thread --latest");
    } else {
      steps.push(`Open Codex in the agent workspace (${agent.cwd}), create the chat that should be this agent's personality, then run: pnpm wakefield select-thread --latest`);
    }
  }

  if (check("Codex hook config")?.ok) {
    steps.push("In Codex, run /hooks and trust the Wakefield hook if Codex asks for review.");
  }
  return [...new Set(steps)];
}

function threadOption(thread) {
  return {
    value: thread.threadId,
    label: thread.cwd ? `${thread.threadId} - ${thread.cwd}` : thread.threadId
  };
}

function serviceEnvFileNeedsAttention(environment = {}) {
  return !environment.configured || environment.exists === false || environment.secure === false;
}

function serviceEnvFileReason(environment = {}) {
  if (!environment.configured) return null;
  if (environment.exists === false) return "Configured service secrets file does not exist.";
  if (environment.secure === false) return "Service secrets file is readable by group or other users.";
  return "Service secrets file already configured.";
}

function formatServiceEnvironment(environment = {}) {
  if (!environment.configured) return "not configured";
  if (environment.exists === false) return `${environment.path} (missing)`;
  if (environment.loaded) return `${environment.path} (${environment.loadedKeys?.length || 0} loaded)`;
  return `${environment.path} (configured)`;
}

function connectorAction(connector) {
  const command = ["wakefield", "connectors", "configure", connector.id, "--enable"];
  for (const field of connector.fields || []) {
    command.push("--set", `${field.id}=$${field.id}`);
  }

  return {
    id: connector.setupActionId,
    kind: "connector-config",
    connectorId: connector.id,
    label: `Configure ${connector.name}`,
    enabled: true,
    command,
    fields: connector.fields || [],
    reason: connector.ready
      ? null
      : connector.available
        ? connector.missingSettings.length > 0
          ? `Missing: ${connector.missingSettings.join(", ")}.`
          : connector.missingSecrets?.length > 0
            ? `Missing environment variable: ${connector.missingSecrets.join(", ")}.`
            : connector.missingPaths?.length > 0
              ? `Missing readable file: ${connector.missingPaths.join(", ")}.`
            : null
        : "Configuration can be saved now; connector transport is planned."
  };
}

function managedConnectorAction(connector) {
  return {
    id: `setup-managed-connector-${connector.id}`,
    kind: "managed-connector-config",
    connectorId: connector.id,
    label: `Configure ${connector.name}`,
    enabled: true,
    command: ["wakefield", "managed-connectors", "wizard", connector.id, "--json"],
    fields: [
      { id: "packagePath", label: "Connector package", required: true, value: connector.package.path || "" },
      { id: "configPath", label: "Connector config", required: true, value: connector.connectorConfig.path || "" },
      ...(connector.setupFields || [])
    ],
    reason: connector.ready
      ? null
      : connector.nextAction?.reason || "Connector package needs attention."
  };
}
