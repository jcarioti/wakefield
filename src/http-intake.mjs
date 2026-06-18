import http from "node:http";
import { inspectAgentPack, installAgentPack } from "./agent-packs.mjs";
import { reloadCodexMcpServers } from "./codex-mcp-reload.mjs";
import { listRecentThreads } from "./codex-sessions.mjs";
import { configureConnector, connectorStatuses, connectorWizard, connectorWizards, CONNECTOR_SETUP_SLOTS } from "./connectors.mjs";
import { importContactsFile, loadContacts } from "./contacts.mjs";
import { doctor } from "./doctor.mjs";
import { dutyStatuses, importDuties, runDueDuties } from "./duties.mjs";
import { pollEmailImap } from "./email-imap.mjs";
import { ingestEmailRfc822 } from "./email-rfc822.mjs";
import { ingestExternalMessage } from "./external-messages.mjs";
import { dispatchExternalMessage } from "./inbox-dispatch.mjs";
import { pollImessageChatDb } from "./imessage-chatdb.mjs";
import { configureManagedConnector, initializeManagedConnectorConfig, installManagedConnectorLaunchAgent, installManagedConnectorMcp, loadManagedConnectorLaunchAgent, managedConnectorLaunchAgentStatus, managedConnectorStatus, managedConnectorStatuses, managedConnectorWizard, managedConnectorWizards, testManagedConnector, uninstallManagedConnectorLaunchAgent, unloadManagedConnectorLaunchAgent } from "./managed-connectors.mjs";
import { wakefieldManifest } from "./manifest.mjs";
import { menuSnapshot } from "./menu-snapshot.mjs";
import { liveCodexConfigPath } from "./paths.mjs";
import { loadAgent, selectThread } from "./profile.mjs";
import { runSetup } from "./setup-runner.mjs";
import { setupStatus } from "./setup.mjs";

const DEFAULT_HOST = "127.0.0.1";
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;

export async function startHttpIntakeServer({
  home,
  codexHomePath = null,
  host = DEFAULT_HOST,
  port = DEFAULT_PORT,
  token = null,
  logger = console
} = {}) {
  if (!isLoopbackHost(host) && !token) {
    throw new Error("HTTP intake requires a bearer token when binding outside localhost.");
  }
  const server = http.createServer((request, response) => {
    handleHttpRequest(request, response, { home, codexHomePath, token })
      .catch((error) => writeJson(response, 500, {
        ok: false,
        error: serializeError(error)
      }));
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(Number(port), host, resolve);
  });

  const address = server.address();
  logger?.log?.(`Wakefield HTTP intake listening on http://${address.address}:${address.port}`);
  return server;
}

export async function handleHttpRequest(request, response, {
  home,
  codexHomePath = null,
  token = null
} = {}) {
  const url = new URL(request.url || "/", "http://wakefield.local");
  const segments = pathSegments(url);
  if (token && !authorized(request, token)) {
    writeJson(response, 401, { ok: false, error: { message: "Unauthorized." } });
    return;
  }

  if (request.method === "GET" && url.pathname === "/manifest") {
    writeJson(response, 200, await wakefieldManifest({
      connectors: await connectorStatuses({ home }),
      managedConnectors: await managedConnectorStatuses({ home })
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/doctor") {
    writeJson(response, 200, await doctor({ home, codexHomePath }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/health") {
    const agent = await loadAgent(null, home);
    writeJson(response, 200, {
      ok: true,
      agent: agent ? {
        id: agent.id,
        name: agent.name,
        threadId: agent.threadId || null
      } : null
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/snapshot") {
    writeJson(response, 200, await menuSnapshot({ home, codexHomePath }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/setup/status") {
    writeJson(response, 200, await setupStatus({
      home,
      codexHomePath,
      threadLimit: numberParam(url, "limit", 5)
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/setup/actions") {
    const status = await setupStatus({
      home,
      codexHomePath,
      threadLimit: numberParam(url, "limit", 5)
    });
    writeJson(response, 200, { actions: status.actions });
    return;
  }

  if (request.method === "POST" && url.pathname === "/setup/run") {
    const body = await readJsonBody(request);
    writeJson(response, 200, await runSetup({
      home,
      codexHomePath,
      name: body.name || "Wakefield",
      soul: body.soul || "",
      threadId: body.threadId || null,
      latestThread: Boolean(body.latestThread || body.latest),
      cwd: body.cwd || null,
      skipHooks: Boolean(body.skipHooks),
      enableService: Boolean(body.enableService),
      intervalMinutes: body.intervalMinutes || body.interval || null,
      enableDispatch: Boolean(body.enableDispatch),
      dispatchMode: body.dispatchMode || null,
      dispatchLimit: body.dispatchLimit || null,
      envFile: body.envFile || null,
      installScheduler: Boolean(body.installLaunchAgent || body.installScheduler),
      loadScheduler: Boolean(body.loadLaunchAgent || body.loadScheduler || body.reloadLaunchAgent || body.reloadScheduler),
      reloadScheduler: Boolean(body.reloadLaunchAgent || body.reloadScheduler)
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/threads") {
    const threads = await listRecentThreads({
      codexHomePath: codexHomePath || undefined,
      limit: numberParam(url, "limit", 10)
    });
    writeJson(response, 200, { threads });
    return;
  }

  if (request.method === "GET" && url.pathname === "/contacts") {
    writeJson(response, 200, await loadContacts({ home }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/contacts/import") {
    const body = await readJsonBody(request);
    writeJson(response, 200, await importContactsFile(body.file, {
      home,
      format: body.format || "auto"
    }));
    return;
  }

  if (request.method === "GET" && url.pathname === "/duties") {
    writeJson(response, 200, await dutyStatuses({ home }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/duties/import") {
    const body = await readJsonBody(request);
    const payload = Array.isArray(body) || body.duties || body.wakeups ? body : [];
    writeJson(response, 200, await importDuties(payload, {
      home,
      source: body.source || null
    }));
    return;
  }

  if (request.method === "POST" && url.pathname === "/duties/run") {
    const agent = await requireAgent(home);
    const body = await readOptionalJsonBody(request);
    const result = await runDueDuties(agent, {
      home,
      only: body.id || body.dutyId || null,
      force: Boolean(body.force)
    });
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/pack/inspect") {
    const body = await readJsonBody(request);
    writeJson(response, 200, await inspectAgentPack(body.file || body.pack));
    return;
  }

  if (request.method === "POST" && url.pathname === "/pack/install") {
    const body = await readJsonBody(request);
    const result = await installAgentPack(body.file || body.pack, {
      home,
      codexHomePath,
      threadId: body.threadId || null,
      latestThread: Boolean(body.latestThread || body.latest),
      overwriteAgent: Boolean(body.overwriteAgent),
      skipHooks: Boolean(body.skipHooks),
      enableService: Boolean(body.enableService),
      dryRun: Boolean(body.dryRun)
    });
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/select-thread") {
    const body = await readJsonBody(request);
    const profile = await selectThread({
      threadId: body.threadId,
      cwd: body.cwd || null,
      home
    });
    writeJson(response, 200, {
      ok: true,
      agent: agentSummary(profile)
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/connectors") {
    writeJson(response, 200, {
      connectors: await connectorStatuses({ home }),
      slots: CONNECTOR_SETUP_SLOTS
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/connectors/wizards") {
    writeJson(response, 200, {
      wizards: await connectorWizards({ home })
    });
    return;
  }

  if (request.method === "GET" && segments[0] === "connectors" && segments[2] === "wizard") {
    writeJson(response, 200, await connectorWizard(segments[1], { home }));
    return;
  }

  if (request.method === "POST" && segments[0] === "connectors" && segments[2] === "configure") {
    const body = await readJsonBody(request);
    const connector = await configureConnector(segments[1], {
      home,
      enabled: body.enabled === undefined ? null : body.enabled,
      settings: body.settings || {},
      unset: body.unset || []
    });
    writeJson(response, 200, connector);
    return;
  }

  if (request.method === "GET" && url.pathname === "/managed-connectors") {
    writeJson(response, 200, {
      connectors: await managedConnectorStatuses({
        home,
        agent: await loadAgent(null, home),
        codexConfigPath: url.searchParams.get("codexConfigPath") || url.searchParams.get("codexConfig") || liveCodexConfigPath()
      })
    });
    return;
  }

  if (request.method === "GET" && url.pathname === "/managed-connectors/wizards") {
    writeJson(response, 200, {
      wizards: await managedConnectorWizards({
        home,
        agent: await loadAgent(null, home),
        codexConfigPath: url.searchParams.get("codexConfigPath") || url.searchParams.get("codexConfig") || liveCodexConfigPath()
      })
    });
    return;
  }

  if (request.method === "GET" && segments[0] === "managed-connectors" && segments[2] === "wizard") {
    writeJson(response, 200, await managedConnectorWizard(segments[1], {
      home,
      agent: await loadAgent(null, home),
      codexConfigPath: url.searchParams.get("codexConfigPath") || url.searchParams.get("codexConfig") || liveCodexConfigPath()
    }));
    return;
  }

  if (request.method === "GET" && segments[0] === "managed-connectors" && segments.length === 2) {
    writeJson(response, 200, await managedConnectorStatus(segments[1], {
      home,
      agent: await loadAgent(null, home),
      codexConfigPath: url.searchParams.get("codexConfigPath") || url.searchParams.get("codexConfig") || liveCodexConfigPath()
    }));
    return;
  }

  if (request.method === "POST" && segments[0] === "managed-connectors" && segments[2] === "configure") {
    const body = await readJsonBody(request);
    const connector = await configureManagedConnector(segments[1], {
      home,
      adapter: body.adapter || null,
      enabled: body.enabled === undefined ? null : body.enabled,
      settings: body.settings || {},
      unset: body.unset || []
    });
    writeJson(response, 200, connector);
    return;
  }

  if (request.method === "POST" && segments[0] === "managed-connectors" && segments[2] === "init-config") {
    const body = await readOptionalJsonBody(request);
    const result = await initializeManagedConnectorConfig(segments[1], {
      home,
      agent: await loadAgent(null, home),
      settings: body.settings || {},
      overwrite: Boolean(body.overwrite)
    });
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (request.method === "POST" && segments[0] === "managed-connectors" && segments[2] === "mcp" && segments[3] === "install") {
    const body = await readOptionalJsonBody(request);
    const result = await installManagedConnectorMcp(segments[1], {
      home,
      agent: await loadAgent(null, home),
      codexConfigPath: body.codexConfigPath || body.codexConfig || liveCodexConfigPath(),
      dryRun: Boolean(body.dryRun)
    });
    if (!body.dryRun && result.changed) {
      result.codexMcpReload = await reloadCodexMcpServers();
    }
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (request.method === "POST" && segments[0] === "managed-connectors" && segments[2] === "test") {
    const body = await readOptionalJsonBody(request);
    const result = await testManagedConnector(segments[1], {
      home,
      kind: body.kind || url.searchParams.get("kind") || "status",
      agent: await loadAgent(null, home)
    });
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (request.method === "GET" && segments[0] === "managed-connectors" && segments[2] === "launch-agent") {
    writeJson(response, 200, await managedConnectorLaunchAgentStatus(segments[1], { home }));
    return;
  }

  if (request.method === "POST" && segments[0] === "managed-connectors" && segments[2] === "launch-agent") {
    const action = segments[3] || "install";
    const body = await readOptionalJsonBody(request);
    if (action === "install") {
      const result = await installManagedConnectorLaunchAgent(segments[1], {
        home,
        dryRun: Boolean(body.dryRun),
        load: Boolean(body.load || body.reload || body.loadNow),
        reload: Boolean(body.reload)
      });
      writeJson(response, result.dryRun || result.status ? 200 : 409, result);
      return;
    }
    if (action === "load" || action === "reload") {
      const result = await loadManagedConnectorLaunchAgent(segments[1], {
        home,
        dryRun: Boolean(body.dryRun),
        reload: action === "reload" || Boolean(body.reload)
      });
      writeJson(response, result.ok ? 200 : 409, result);
      return;
    }
    if (action === "unload") {
      const result = await unloadManagedConnectorLaunchAgent(segments[1], {
        home,
        dryRun: Boolean(body.dryRun)
      });
      writeJson(response, result.ok ? 200 : 409, result);
      return;
    }
    if (action === "uninstall") {
      const result = await uninstallManagedConnectorLaunchAgent(segments[1], {
        home,
        dryRun: Boolean(body.dryRun),
        unload: Boolean(body.unload)
      });
      writeJson(response, 200, result);
      return;
    }
    writeJson(response, 404, {
      ok: false,
      error: { message: `Unknown managed connector LaunchAgent action: ${action}` }
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/messages") {
    const agent = await requireAgent(home);
    const body = await readJsonBody(request);
    const ingested = await ingestExternalMessage(agent, {
      home,
      connector: body.connector,
      conversationId: body.conversationId || body.conversation || body.channelId || null,
      sender: body.sender || body.from || null,
      text: body.text,
      messageId: body.messageId || null,
      subject: body.subject || null,
      url: body.url || null,
      metadata: body.metadata || {}
    });
    const dispatched = await maybeDispatch(agent, ingested, body.dispatchMode || url.searchParams.get("dispatchMode"));
    writeJson(response, 202, {
      ok: true,
      ingest: ingested,
      dispatch: dispatched
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/email") {
    const agent = await requireAgent(home);
    const raw = await readTextBody(request);
    const ingested = await ingestEmailRfc822(agent, {
      home,
      raw,
      sourceFile: "http-intake"
    });
    const dispatched = await maybeDispatch(agent, ingested, url.searchParams.get("dispatchMode"));
    writeJson(response, 202, {
      ok: true,
      ingest: ingested,
      dispatch: dispatched
    });
    return;
  }

  if (request.method === "POST" && url.pathname === "/email/poll") {
    const agent = await requireAgent(home);
    const body = await readOptionalJsonBody(request);
    const result = await pollEmailImap(agent, {
      home,
      limit: body.limit || url.searchParams.get("limit") || null
    });
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  if (request.method === "POST" && url.pathname === "/imessage/poll") {
    const agent = await requireAgent(home);
    const body = await readOptionalJsonBody(request);
    const result = await pollImessageChatDb(agent, {
      home,
      limit: body.limit || url.searchParams.get("limit") || null,
      dispatchMode: body.dispatchMode || url.searchParams.get("dispatchMode") || null
    });
    writeJson(response, result.ok ? 200 : 409, result);
    return;
  }

  writeJson(response, 404, {
    ok: false,
    error: { message: "Route not found." }
  });
}

export function httpIntakeUrl({ host = DEFAULT_HOST, port = DEFAULT_PORT } = {}) {
  return `http://${host}:${port}`;
}

function agentSummary(profile) {
  return {
    id: profile.id,
    name: profile.name,
    threadId: profile.threadId || null,
    cwd: profile.cwd || null,
    soulPath: profile.soulPath || null
  };
}

async function requireAgent(home) {
  const agent = await loadAgent(null, home);
  if (!agent) throw new Error("No Wakefield agent is initialized yet.");
  return agent;
}

async function maybeDispatch(agent, ingested, dispatchMode) {
  if (!dispatchMode) return null;
  return dispatchExternalMessage(agent, {
    id: ingested.message.id,
    mode: dispatchMode
  });
}

function authorized(request, token) {
  const expected = `Bearer ${token}`;
  return request.headers.authorization === expected;
}

function isLoopbackHost(host) {
  return ["127.0.0.1", "::1", "localhost"].includes(String(host || ""));
}

function pathSegments(url) {
  return url.pathname.split("/").filter(Boolean).map((segment) => decodeURIComponent(segment));
}

function numberParam(url, key, fallback) {
  const value = url.searchParams.get(key);
  return value == null ? fallback : Number(value);
}

async function readJsonBody(request) {
  const text = await readTextBody(request);
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON request body: ${error.message}`);
  }
}

async function readOptionalJsonBody(request) {
  const text = await readTextBody(request);
  if (!text.trim()) return {};
  try {
    return JSON.parse(text);
  } catch (error) {
    throw new Error(`Invalid JSON request body: ${error.message}`);
  }
}

async function readTextBody(request) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    const buffer = Buffer.from(chunk);
    size += buffer.length;
    if (size > MAX_BODY_BYTES) throw new Error("Request body is too large.");
    chunks.push(buffer);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function writeJson(response, statusCode, body) {
  response.writeHead(statusCode, {
    "content-type": "application/json; charset=utf-8"
  });
  response.end(`${JSON.stringify(body, null, 2)}\n`);
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null
  };
}
