import { CodexAppServerError } from "../packages/connector-shared/src/codex-app-server-client.mjs";
import { CodexRemoteControlAppServerClient } from "../packages/connector-shared/src/codex-remote-control-app-server-client.mjs";

export async function reloadCodexMcpServers({
  client = null,
  timeoutMs = 30000,
  pollMs = 1000,
  waitForStatus = true,
  requireRemoteControlConnected = true,
  throwOnError = false
} = {}) {
  const ownsClient = client == null;
  const appServerClient = client || new CodexRemoteControlAppServerClient({
    requireRemoteControlConnected,
    requestTimeoutMs: timeoutMs,
    logger: quietLogger()
  });
  try {
    const result = await appServerClient.reloadMcpServers({
      timeoutMs,
      pollMs,
      waitForStatus
    });
    const before = summarizeMcpServerStatus(result.before);
    const reload = summarizeMcpReloadResult(result.reload);
    const after = summarizeMcpServerStatus(result.after);
    const events = summarizeMcpStartupEvents(result.events);
    const wakefieldMcp = wakefieldMcpHealth(after);
    const ok = wakefieldMcp.issues.length === 0;
    return {
      ok,
      action: "mcp-reload",
      refreshed: true,
      transport: "remote-control",
      environment: result.environment || null,
      remoteControlStatus: appServerClient.remoteControlStatus,
      before,
      reload,
      after,
      events,
      wakefieldMcp,
      diagnosis: ok ? null : {
        code: "wakefield-mcp-tools-unavailable",
        message: "Codex refreshed MCP servers, but at least one Wakefield MCP is present without tools."
      }
    };
  } catch (error) {
    if (throwOnError) throw error;
    return {
      ok: false,
      action: "mcp-reload",
      refreshed: false,
      transport: "remote-control",
      remoteControlStatus: appServerClient.remoteControlStatus,
      error: appServerErrorSummary(error),
      diagnosis: diagnoseMcpReloadFailure(error)
    };
  } finally {
    if (ownsClient) {
      appServerClient.disconnect();
    }
  }
}

export function formatCodexMcpReload(result) {
  if (result.ok) {
    const count = countMcpServers(result.after);
    const suffix = count == null ? "" : ` (${count} server${count === 1 ? "" : "s"})`;
    const wakefieldTools = formatWakefieldToolCounts(result.wakefieldMcp);
    const wakefieldSuffix = wakefieldTools ? ` ${wakefieldTools}` : "";
    const transport = result.transport === "remote-control"
      ? " through the live Codex desktop runtime"
      : "";
    return `Codex refreshed MCP tools${transport}${suffix}.${wakefieldSuffix}`;
  }
  if (result.diagnosis?.code === "wakefield-mcp-tools-unavailable") {
    return [
      "Codex refreshed MCP servers, but Wakefield tools are not ready in the live desktop runtime.",
      ...result.wakefieldMcp.issues.map((issue) => `${issue.name}: ${issue.message}`)
    ].join("\n");
  }
  const message = result.error?.message || "Codex app-server reload was unavailable.";
  if (result.diagnosis?.code === "remote-control-environment-unavailable") {
    return [
      "Could not refresh the live Codex desktop MCP runtime from Wakefield.",
      result.diagnosis.message,
      "Open Codex and make sure remote control is enabled, then try again."
    ].join("\n");
  }
  return [
    `Could not refresh the live Codex desktop MCP runtime: ${message}`,
    "Open Codex and make sure remote control is enabled, then try again."
  ].join("\n");
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

function wakefieldMcpHealth(status) {
  const servers = Array.isArray(status?.servers) ? status.servers : [];
  const names = new Set(["wakefield-memory", "discord-codex", "imessage-codex"]);
  const present = servers
    .filter((server) => names.has(server.name))
    .map((server) => ({
      name: server.name,
      tools: Number.isInteger(server.tools) ? server.tools : null,
      status: server.status || null,
      authStatus: server.authStatus || null,
      error: server.error || null
    }));
  const issues = present
    .filter((server) => server.tools === 0)
    .map((server) => ({
      name: server.name,
      code: "no-tools",
      message: "server is present, but Codex reports 0 tools"
    }));
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

function appServerErrorSummary(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || (error instanceof CodexAppServerError ? error.code : null),
    method: error?.method || null
  };
}

function diagnoseMcpReloadFailure(error) {
  if (error?.code === "remote-control-environment-unavailable") {
    return {
      code: "remote-control-environment-unavailable",
      message: "Codex remote control is reachable, but no online Codex Desktop environment for this Mac was found."
    };
  }
  if (error?.code === "auth-unavailable" || error?.code === "auth-token-unavailable" || error?.code === "auth-rejected") {
    return {
      code: "remote-control-auth-unavailable",
      message: "Wakefield could not use the current Codex ChatGPT login to reach the live desktop runtime."
    };
  }
  if (error?.code === "connect-timeout") {
    return {
      code: "remote-control-connect-timeout",
      message: "Codex remote control did not open a live stream to the desktop runtime in time."
    };
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
