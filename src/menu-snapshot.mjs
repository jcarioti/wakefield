import { listExternalMessages } from "./external-messages.mjs";
import { compact } from "./memory.mjs";
import { loadAgent } from "./profile.mjs";
import { setupStatus } from "./setup.mjs";

export async function menuSnapshot({
  home,
  codexHomePath = null,
  threadLimit = 5,
  messageLimit = 5
} = {}) {
  const setup = await setupStatus({ home, codexHomePath, threadLimit });
  const agent = setup.agent ? await loadAgent(setup.agent.id, home) : null;
  const pendingMessages = agent
    ? await listExternalMessages(agent, { status: "pending", limit: messageLimit })
    : [];

  return {
    schemaVersion: 1,
    app: setup.manifest.app,
    phase: setup.phase,
    ready: setup.ok,
    headline: headline(setup),
    agent: setup.agent,
    readiness: readiness(setup.doctor.checks),
    service: serviceSummary(setup.service),
    duties: dutySummary(setup.service.duties),
    contacts: setup.contacts,
    inbox: {
      pending: setup.service.externalDispatch?.pending || pendingMessages.length,
      recent: pendingMessages.map(messageSummary)
    },
    threads: {
      selectedThreadId: setup.agent?.threadId || null,
      recent: setup.recentThreads.map(threadSummary)
    },
    connectors: setup.connectors.map(connectorSummary),
    managedConnectors: setup.managedConnectors.map(managedConnectorSummary),
    actions: setup.actions.map(actionSummary),
    enabledActionIds: setup.actions.filter((action) => action.enabled).map((action) => action.id),
    nextSteps: setup.nextSteps
  };
}

export function formatMenuSnapshot(snapshot) {
  const lines = [
    `Wakefield menu snapshot: ${snapshot.headline}`,
    `agent: ${snapshot.agent ? snapshot.agent.name : "not created"}`,
    `service: ${snapshot.service.enabled ? "enabled" : "disabled"}`,
    `env file: ${formatServiceEnvironment(snapshot.service.environment)}`,
    `duties: ${snapshot.duties.enabled}/${snapshot.duties.total} enabled, ${snapshot.duties.due} due`,
    `scheduler: ${snapshot.service.scheduler.installed ? "installed" : "not installed"}${snapshot.service.scheduler.loaded == null ? "" : snapshot.service.scheduler.loaded ? ", loaded" : ", not loaded"}`,
    `pending inbox: ${snapshot.inbox.pending}`,
    `enabled actions: ${snapshot.enabledActionIds.length === 0 ? "none" : snapshot.enabledActionIds.join(", ")}`
  ];
  if (snapshot.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of snapshot.nextSteps) lines.push(`- ${step}`);
  }
  return lines.join("\n");
}

function headline(setup) {
  if (!setup.agent) return "Create an agent";
  if (!setup.agent.threadId) return "Select a Codex thread";
  if (!setup.ok) return "Review setup";
  if (setup.service.externalDispatch?.pending > 0) return `${setup.service.externalDispatch.pending} message${setup.service.externalDispatch.pending === 1 ? "" : "s"} pending`;
  return "Ready";
}

function readiness(checks) {
  const failed = checks.filter((check) => !check.ok && !check.optional);
  const warnings = checks.filter((check) => !check.ok && check.optional);
  return {
    ok: failed.length === 0,
    failed: failed.length,
    warnings: warnings.length,
    checks: checks.map((check) => ({
      label: check.label,
      ok: check.ok,
      optional: Boolean(check.optional),
      detail: check.detail
    }))
  };
}

function serviceSummary(service) {
  return {
    enabled: service.enabled,
    intervalMinutes: service.intervalMinutes,
    lastRunAt: service.lastRunAt,
    nextRunAt: service.nextRunAt,
    externalDispatch: service.externalDispatch,
    environment: service.environment,
    duties: service.duties,
    scheduler: {
      supported: service.scheduler.supported,
      canLoad: service.scheduler.canLoad,
      installed: service.scheduler.installed,
      loaded: service.scheduler.loaded,
      label: service.scheduler.label,
      plistPath: service.scheduler.plistPath
    }
  };
}

function dutySummary(duties = {}) {
  return {
    total: duties.total || 0,
    enabled: duties.enabled || 0,
    due: duties.due || 0,
    items: duties.items || []
  };
}

function formatServiceEnvironment(environment = {}) {
  if (!environment.configured) return "not configured";
  if (environment.exists === false) return "missing";
  if (environment.loaded) return `loaded ${environment.loadedKeys?.length || 0}/${environment.keys?.length || 0}`;
  return "configured";
}

function connectorSummary(connector) {
  return {
    id: connector.id,
    name: connector.name,
    status: connector.status,
    configured: connector.configured,
    enabled: connector.enabled,
    ready: connector.ready,
    missingSettings: connector.missingSettings,
    missingSecrets: connector.missingSecrets || [],
    missingPaths: connector.missingPaths || [],
    transports: connector.transports || [],
    setupActionId: connector.setupActionId
  };
}

function managedConnectorSummary(connector) {
  return {
    id: connector.id,
    name: connector.name,
    adapter: connector.adapter,
    connectorId: connector.connectorId,
    enabled: connector.enabled,
    configured: connector.configured,
    ready: connector.ready,
    running: connector.running,
    capabilities: connector.capabilities || [],
    nextAction: connector.nextAction,
    package: {
      path: connector.package?.path || null,
      ok: Boolean(connector.package?.ok)
    },
    connectorConfig: {
      path: connector.connectorConfig?.path || null,
      ok: Boolean(connector.connectorConfig?.ok),
      targetId: connector.connectorConfig?.targetId || null,
      provider: connector.connectorConfig?.provider || null
    },
    mcp: {
      ok: Boolean(connector.mcp?.ok),
      serverName: connector.mcp?.serverName || null,
      tools: connector.mcp?.tools || []
    },
    launchAgent: {
      label: connector.launchAgent?.label || null,
      installed: Boolean(connector.launchAgent?.installed),
      loaded: connector.launchAgent?.loaded ?? null,
      plistPath: connector.launchAgent?.plistPath || null
    }
  };
}

function actionSummary(action) {
  return {
    id: action.id,
    kind: action.kind,
    label: action.label,
    enabled: action.enabled,
    command: action.command,
    fields: action.fields || [],
    reason: action.reason || null,
    connectorId: action.connectorId || null
  };
}

function threadSummary(thread) {
  return {
    threadId: thread.threadId,
    title: thread.title || null,
    updatedAt: thread.updatedAt,
    cwd: thread.cwd || null
  };
}

function messageSummary(message) {
  return {
    id: message.id,
    connector: message.connector,
    sender: message.sender,
    subject: message.subject,
    at: message.at,
    text: compact(message.text, 220)
  };
}
