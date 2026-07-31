import { CodexDesktopController, CodexDesktopControllerError, defaultControlSocketPath } from "../packages/connector-shared/src/codex-desktop-controller.mjs";

export async function reloadCodexMcpServers({
  client = null,
  threadId = null,
  expectedServers = [],
  timeoutMs = 30000,
  pollMs = 1000,
  throwOnError = false
} = {}) {
  const ownsClient = client == null;
  const controller = client || createCodexMcpReloadController({
    timeoutMs
  });
  try {
    const result = await controller.reloadMcpServers({
      threadId,
      timeoutMs,
      pollMs
    });
    const before = summarizeMcpServerStatus(result.before);
    const reload = summarizeMcpReloadResult(result.reload);
    const after = summarizeMcpServerStatus(result.after);
    const events = summarizeMcpStartupEvents(result.events);
    const wakefieldMcp = wakefieldMcpHealth(after, { expectedServers });
    const ok = wakefieldMcp.issues.length === 0;
    return {
      ok,
      action: "mcp-reload",
      refreshed: true,
      transport: "desktop-daemon",
      daemon: result.daemon || controller.daemonInfo || null,
      desktop: result.desktop || controller.remoteControlStatus || null,
      before,
      reload,
      after,
      events,
      wakefieldMcp,
      diagnosis: ok ? null : {
        code: "wakefield-mcp-tools-unavailable",
        message: "Codex refreshed MCP servers, but an expected Wakefield MCP is missing or has no tools."
      }
    };
  } catch (error) {
    if (throwOnError) throw error;
    return {
      ok: false,
      action: "mcp-reload",
      refreshed: false,
      transport: "desktop-daemon",
      daemon: controller.daemonInfo || null,
      desktop: controller.remoteControlStatus || null,
      error: controllerErrorSummary(error),
      diagnosis: diagnoseMcpReloadFailure(error)
    };
  } finally {
    if (ownsClient) {
      controller.disconnect();
    }
  }
}

export function formatCodexMcpReload(result) {
  if (result.ok) {
    const count = countMcpServers(result.after);
    const suffix = count == null ? "" : ` (${count} server${count === 1 ? "" : "s"})`;
    const wakefieldTools = formatWakefieldToolCounts(result.wakefieldMcp);
    const wakefieldSuffix = wakefieldTools ? ` ${wakefieldTools}` : "";
    const transport = result.transport === "desktop-daemon"
      ? " through the daemon-backed ChatGPT Desktop runtime"
      : "";
    return `Codex refreshed MCP tools${transport}${suffix}.${wakefieldSuffix}`;
  }
  if (result.diagnosis?.code === "wakefield-mcp-tools-unavailable") {
    return [
      "Codex refreshed MCP servers, but Wakefield tools are not ready in the live desktop runtime.",
      ...result.wakefieldMcp.issues.map((issue) => `${issue.name}: ${issue.message}`)
    ].join("\n");
  }
  const message = result.error?.message || "Codex Desktop MCP reload was unavailable.";
  if (result.diagnosis?.code === "daemon-socket-missing") {
    return [
      "Could not refresh the live ChatGPT Desktop MCP runtime.",
      result.diagnosis.message
    ].join("\n");
  }
  if (result.diagnosis?.code === "desktop-not-attached") {
    return [
      "Could not refresh the live ChatGPT Desktop MCP runtime because the app is not attached to its Codex daemon.",
      "Open ChatGPT Desktop and load Codex, then retry."
    ].join("\n");
  }
  return [
    `Could not refresh the live ChatGPT Desktop MCP runtime: ${message}`,
    "Run `wakefield doctor` for the daemon socket, protocol, attachment, and live MCP checks."
  ].join("\n");
}

export function createCodexMcpReloadController({
  controlSocketPath = defaultControlSocketPath(),
  timeoutMs = 30000
} = {}) {
  return new CodexDesktopController({
    socketPath: controlSocketPath,
    ensureDaemon: true,
    requireRemoteControlConnected: true,
    requireDesktopOwnership: true,
    requestTimeoutMs: timeoutMs,
    logger: quietLogger()
  });
}

export function summarizeMcpServerStatus(status) {
  if (status == null) return status;
  if (Array.isArray(status)) {
    return {
      count: status.length,
      servers: status.map((server) => summarizeMcpServer(server))
    };
  }
  if (Array.isArray(status?.data)) {
    return {
      count: status.data.length,
      servers: status.data.map((server) => summarizeMcpServer(server))
    };
  }
  if (Array.isArray(status?.servers)) {
    return {
      count: status.servers.length,
      servers: status.servers.map((server) => summarizeMcpServer(server))
    };
  }
  if (status?.mcpServers && typeof status.mcpServers === "object") {
    const servers = Object.entries(status.mcpServers).map(([name, server]) => summarizeMcpServer({
      name,
      ...server
    }));
    return {
      count: servers.length,
      servers
    };
  }
  if (status?.servers && typeof status.servers === "object") {
    const servers = Object.entries(status.servers).map(([name, server]) => summarizeMcpServer({
      name,
      ...server
    }));
    return {
      count: servers.length,
      servers
    };
  }
  if (status?.error) {
    return { error: status.error };
  }
  return {
    count: countMcpServers(status)
  };
}

export function countMcpServers(status) {
  if (Array.isArray(status)) return status.length;
  if (Number.isInteger(status?.count)) return status.count;
  if (Array.isArray(status?.servers)) return status.servers.length;
  if (Array.isArray(status?.data)) return status.data.length;
  if (status && typeof status === "object") {
    if (status.mcpServers && typeof status.mcpServers === "object") return Object.keys(status.mcpServers).length;
    if (status.servers && typeof status.servers === "object") return Object.keys(status.servers).length;
  }
  return null;
}

function summarizeMcpServer(server) {
  if (typeof server === "string") {
    return { name: server };
  }
  const tools = countServerCollection(server?.tools);
  const resources = countServerCollection(server?.resources);
  const resourceTemplates = countServerCollection(server?.resourceTemplates);
  return Object.fromEntries(Object.entries({
    name: server?.name || server?.serverName || null,
    title: server?.serverInfo?.title || server?.title || null,
    status: server?.status || server?.startupStatus || null,
    authStatus: server?.authStatus || null,
    tools,
    resources,
    resourceTemplates,
    error: server?.error || null
  }).filter(([, value]) => value != null));
}

function summarizeMcpReloadResult(reload) {
  if (reload == null) return reload;
  if (typeof reload !== "object") return reload;
  const serialized = JSON.stringify(reload);
  if (serialized.length <= 2000) return reload;
  return {
    keys: Object.keys(reload),
    omitted: "large reload payload"
  };
}

function summarizeMcpStartupEvents(events) {
  if (!Array.isArray(events)) return [];
  return events.slice(-20).map((event) => Object.fromEntries(Object.entries({
    serverName: event?.serverName || event?.name || null,
    status: event?.status || event?.startupStatus || null,
    error: event?.error || null
  }).filter(([, value]) => value != null)));
}

function countServerCollection(value) {
  if (Number.isInteger(value)) return value;
  if (Array.isArray(value)) return value.length;
  if (value && typeof value === "object") return Object.keys(value).length;
  return null;
}

function wakefieldMcpHealth(status, { expectedServers = [] } = {}) {
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  const names = new Set(["wakefield-memory", "discord-codex", "imessage-codex", ...expectedServers]);
  const present = servers
    .filter((server) => names.has(server.name))
    .map((server) => ({
      name: server.name,
      tools: Number.isInteger(server.tools) ? server.tools : null,
      status: server.status || null,
      authStatus: server.authStatus || null,
      error: server.error || null
    }));
  const issues = expectedServers
    .filter((name) => !present.some((server) => server.name === name))
    .map((name) => ({
      name,
      code: "missing",
      message: "server is configured, but is absent from the live ChatGPT Desktop MCP runtime"
    }));
  issues.push(...present
    .filter((server) => server.tools === 0)
    .map((server) => ({
      name: server.name,
      code: "no-tools",
      message: "server is present, but Codex reports 0 tools"
    })));
  return {
    servers: present,
    issues
  };
}

function formatWakefieldToolCounts(health) {
  const servers = health?.servers || [];
  if (servers.length === 0) return "";
  const parts = servers
    .filter((server) => Number.isInteger(server.tools))
    .map((server) => `${server.name}: ${server.tools}`);
  return parts.length === 0 ? "" : `Wakefield tools: ${parts.join(", ")}.`;
}

function controllerErrorSummary(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || (error instanceof CodexDesktopControllerError ? error.code : null),
    method: error?.method || null
  };
}

function diagnoseMcpReloadFailure(error) {
  if (error?.code === "daemon-socket-missing" || error?.code === "daemon-socket-timeout") {
    return {
      code: "daemon-socket-missing",
      message: "The supported Codex daemon control socket is unavailable."
    };
  }
  if (error?.code === "desktop-not-attached") {
    return {
      code: "desktop-not-attached",
      message: "ChatGPT Desktop is not connected to the local Codex daemon."
    };
  }
  if (error?.code === "daemon-ownership-mismatch" || error?.code === "desktop-protocol-mismatch" || error?.code === "desktop-ownership-incomplete") {
    return { code: error.code, message: "The live endpoint failed Wakefield's daemon/Desktop ownership checks." };
  }
  return null;
}

function quietLogger() {
  return {
    info() {},
    warn() {},
    error() {}
  };
}
