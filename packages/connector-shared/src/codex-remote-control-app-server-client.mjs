import crypto from "node:crypto";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import WebSocket from "ws";
import { CodexAppServerError } from "./codex-app-server-client.mjs";

const DEFAULT_CLIENT_NAME = "wakefield-connector";
const DEFAULT_CLIENT_VERSION = "0.1.0";
const DEFAULT_API_BASE_URL = "https://chatgpt.com/backend-api";
const GLOBAL_STATE_LOCAL_ENV_KEY = "electron-local-remote-control-environment-id";
const REMOTE_CONTROL_WS_PATH = "/codex/remote/control/client";
const REMOTE_CONTROL_ENVIRONMENTS_PATH = "/codex/remote/control/environments?limit=50";
const REMOTE_CONTROL_PROTOCOL_VERSION = "3";

export class CodexRemoteControlAppServerClient {
  constructor({
    codexHome = defaultCodexHome(),
    authPath = null,
    globalStatePath = null,
    apiBaseUrl = process.env.CODEX_API_BASE_URL || DEFAULT_API_BASE_URL,
    environmentId = process.env.CODEX_REMOTE_CONTROL_ENV_ID || null,
    verifyEnvironment = true,
    requireRemoteControlConnected = true,
    connectTimeoutMs = 10000,
    requestTimeoutMs = 30000,
    clientName = DEFAULT_CLIENT_NAME,
    clientVersion = DEFAULT_CLIENT_VERSION,
    logger = console,
    fetchFn = fetch,
    webSocketFactory = (url, options) => new WebSocket(url, options)
  } = {}) {
    this.codexHome = codexHome;
    this.authPath = authPath || path.join(codexHome, "auth.json");
    this.globalStatePath = globalStatePath || path.join(codexHome, ".codex-global-state.json");
    this.apiBaseUrl = apiBaseUrl.replace(/\/+$/, "");
    this.environmentId = environmentId;
    this.verifyEnvironment = verifyEnvironment !== false;
    this.requireRemoteControlConnected = requireRemoteControlConnected !== false;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.logger = logger;
    this.fetchFn = fetchFn;
    this.webSocketFactory = webSocketFactory;
    this.ws = null;
    this.clientId = `wakefield-${crypto.randomUUID()}`;
    this.streamId = crypto.randomUUID();
    this.nextSeqId = 1;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.chunkAssemblies = new Map();
    this.remoteControlStatus = null;
    this.resolvedEnvironment = null;
  }

  async connect() {
    if (this.isConnected()) {
      return;
    }
    const auth = await this.loadAuth();
    const environment = await this.resolveEnvironment(auth);
    this.environmentId = environment.envId;
    this.resolvedEnvironment = environment;
    await this.openWebSocket(auth);
    await this.request("initialize", {
      clientInfo: {
        name: this.clientName,
        title: null,
        version: this.clientVersion
      },
      capabilities: {
        experimentalApi: true,
        requestAttestation: false
      }
    });
    this.notify("initialized", {});
    const status = await this.request("remoteControl/status/read", {});
    this.remoteControlStatus = status;
    if (this.requireRemoteControlConnected && status?.status !== "connected") {
      throw new CodexAppServerError(
        `Codex remote control is ${status?.status || "unknown"} for ${environment.displayName || environment.envId}.`,
        {
          code: "remote-control-not-connected",
          method: "remoteControl/status/read",
          details: status
        }
      );
    }
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    if (ws != null && ws.readyState !== WebSocket.CLOSED) {
      ws.close();
    }
    this.rejectPending("Codex remote-control app-server connection closed.", "connection-closed");
  }

  async listMcpServerStatus({ timeoutMs = this.requestTimeoutMs } = {}) {
    await this.connect();
    return this.request("mcpServerStatus/list", {}, { timeoutMs });
  }

  async reloadMcpServers({
    timeoutMs = this.requestTimeoutMs,
    waitForStatus = true,
    pollMs = 1000
  } = {}) {
    await this.connect();
    const events = [];
    const unsubscribe = this.on("mcpServer/startupStatus/updated", (params) => {
      events.push(params);
    });
    try {
      const before = await this.request("mcpServerStatus/list", {}, {
        timeoutMs: Math.min(timeoutMs, 5000)
      }).catch((error) => ({ error: appServerErrorSummary(error) }));
      const reload = await this.request("config/mcpServer/reload", {}, { timeoutMs });
      const after = waitForStatus
        ? await this.pollMcpServerStatus({ timeoutMs, pollMs, events })
        : null;
      return {
        action: "mcp-reload",
        transport: "remote-control",
        environment: this.resolvedEnvironment,
        before,
        reload,
        after,
        events
      };
    } finally {
      unsubscribe();
    }
  }

  async pollMcpServerStatus({
    timeoutMs = this.requestTimeoutMs,
    pollMs = 1000,
    events = []
  } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let lastError = null;
    do {
      try {
        last = await this.request("mcpServerStatus/list", {}, {
          timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now()))
        });
        if (events.length > 0 || !mcpStatusLooksBusy(last)) {
          return last;
        }
      } catch (error) {
        lastError = error;
      }
      const remaining = deadline - Date.now();
      if (remaining <= 0) break;
      await sleep(Math.min(pollMs, remaining));
    } while (Date.now() < deadline);
    if (last != null) return last;
    if (lastError) throw lastError;
    return null;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.isConnected()) {
      throw new CodexAppServerError("Codex remote-control app-server client is not connected.", {
        code: "not-connected",
        method
      });
    }
    const id = this.nextRequestId;
    this.nextRequestId += 1;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexAppServerError(`Timed out waiting for Codex app-server method ${method}.`, {
          code: "request-timeout",
          method
        }));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout, method });
      try {
        this.send({ id, method, params });
      } catch (error) {
        clearTimeout(timeout);
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method, params = {}) {
    this.send({ method, params });
  }

  on(method, handler) {
    const handlers = this.eventHandlers.get(method) || new Set();
    handlers.add(handler);
    this.eventHandlers.set(method, handlers);
    return () => {
      const current = this.eventHandlers.get(method);
      if (!current) return;
      current.delete(handler);
      if (current.size === 0) {
        this.eventHandlers.delete(method);
      }
    };
  }

  send(message) {
    if (!this.isConnected()) {
      throw new CodexAppServerError("Codex remote-control app-server socket is closed.", {
        code: "socket-closed"
      });
    }
    this.ws.send(JSON.stringify({
      type: "client_message",
      client_id: this.clientId,
      stream_id: this.streamId,
      env_id: this.environmentId,
      skip_history: false,
      message,
      seq_id: this.nextSeqId++
    }));
  }

  isConnected() {
    return this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  async openWebSocket(auth) {
    const wsUrl = this.remoteControlWebSocketUrl();
    const ws = this.webSocketFactory(wsUrl, {
      headers: {
        ...this.authHeaders(auth),
        "x-codex-client-id": this.clientId,
        "x-codex-protocol-version": REMOTE_CONTROL_PROTOCOL_VERSION
      },
      perMessageDeflate: false
    });
    this.ws = ws;
    ws.on("message", (data) => this.handleWebSocketMessage(String(data)));
    ws.on("error", (error) => this.handleWebSocketError(error));
    ws.on("close", () => this.handleWebSocketClose());
    await new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        reject(new CodexAppServerError("Timed out connecting to Codex remote-control app-server.", {
          code: "connect-timeout"
        }));
      }, this.connectTimeoutMs);
      ws.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timeout);
        reject(new CodexAppServerError(`Failed to connect to Codex remote-control app-server: ${error.message}`, {
          code: "connect-failed",
          details: error
        }));
      });
    });
  }

  handleWebSocketMessage(text) {
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch (error) {
      this.logger.warn?.(`Ignoring non-JSON Codex remote-control message: ${error.message}`);
      return;
    }
    this.handleEnvelope(envelope);
  }

  handleEnvelope(envelope) {
    if (envelope?.type === "ack" || envelope?.type === "pong") {
      return;
    }
    if (envelope?.type === "server_message") {
      this.handleServerMessage(envelope.message);
      return;
    }
    if (envelope?.type === "server_message_chunk") {
      const message = this.observeServerMessageChunk(envelope);
      if (message != null) {
        this.handleServerMessage(message);
      }
      return;
    }
    this.logger.warn?.(`Ignoring unsupported Codex remote-control envelope: ${envelope?.type || "unknown"}`);
  }

  observeServerMessageChunk(envelope) {
    const segmentId = envelope.segment_id ?? 0;
    const segmentCount = envelope.segment_count ?? 1;
    const key = `${envelope.env_id}:${envelope.stream_id}:${envelope.seq_id}`;
    let assembly = this.chunkAssemblies.get(key);
    if (assembly == null) {
      assembly = {
        segmentCount,
        messageSizeBytes: envelope.message_size_bytes,
        chunks: Array(segmentCount).fill(null)
      };
      this.chunkAssemblies.set(key, assembly);
    }
    if (assembly.segmentCount !== segmentCount || segmentId < 0 || segmentId >= segmentCount) {
      this.chunkAssemblies.delete(key);
      this.logger.warn?.("Dropping invalid Codex remote-control message chunk.");
      return null;
    }
    assembly.chunks[segmentId] = envelope.message_chunk_base64;
    if (assembly.chunks.some((chunk) => chunk == null)) {
      return null;
    }
    this.chunkAssemblies.delete(key);
    const payload = Buffer.concat(assembly.chunks.map((chunk) => Buffer.from(chunk, "base64")));
    if (payload.length !== assembly.messageSizeBytes) {
      this.logger.warn?.("Dropping Codex remote-control chunk assembly with mismatched size.");
      return null;
    }
    try {
      const message = JSON.parse(payload.toString("utf8"));
      if (message && typeof message === "object" && !Array.isArray(message)) {
        return message;
      }
    } catch (error) {
      this.logger.warn?.(`Dropping invalid Codex remote-control chunk payload: ${error.message}`);
    }
    return null;
  }

  handleServerMessage(message) {
    if (message?.method === "remoteControl/status/changed") {
      this.remoteControlStatus = message.params;
    }
    if (message?.id == null) {
      this.emitEvent(message?.method, message?.params);
      return;
    }
    const pending = this.pending.get(message.id);
    if (!pending) {
      return;
    }
    clearTimeout(pending.timeout);
    this.pending.delete(message.id);
    if (message.error) {
      pending.reject(new CodexAppServerError(message.error.message || `Codex app-server method ${pending.method} failed.`, {
        code: message.error.code || "request-failed",
        method: pending.method,
        details: message.error
      }));
    } else {
      pending.resolve(message.result);
    }
  }

  emitEvent(method, params) {
    if (!method) return;
    const handlers = this.eventHandlers.get(method);
    if (!handlers) return;
    for (const handler of [...handlers]) {
      try {
        handler(params);
      } catch (error) {
        this.logger.warn?.(`Codex app-server event handler for ${method} failed: ${error.message}`);
      }
    }
  }

  handleWebSocketError(error) {
    this.logger.warn?.(`Codex remote-control app-server socket error: ${error.message}`);
  }

  handleWebSocketClose() {
    this.ws = null;
    this.rejectPending("Codex remote-control app-server socket closed.", "socket-closed");
  }

  rejectPending(message, code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerError(message, { code, method: pending.method }));
    }
    this.pending.clear();
  }

  async loadAuth() {
    let auth;
    try {
      auth = JSON.parse(await fs.readFile(this.authPath, "utf8"));
    } catch (error) {
      throw new CodexAppServerError(`Could not read Codex auth at ${this.authPath}: ${error.message}`, {
        code: "auth-unavailable",
        details: error
      });
    }
    const accessToken = auth?.tokens?.access_token;
    if (!accessToken) {
      throw new CodexAppServerError("Codex auth does not include a ChatGPT access token.", {
        code: "auth-token-unavailable"
      });
    }
    return {
      accessToken,
      accountId: auth?.tokens?.account_id || accountIdFromAccessToken(accessToken),
      raw: auth
    };
  }

  async resolveEnvironment(auth) {
    const requestedEnvId = this.environmentId || await this.readLocalEnvironmentId();
    if (!this.verifyEnvironment && requestedEnvId) {
      return { envId: requestedEnvId, displayName: requestedEnvId, hostName: null, online: null };
    }
    const environments = await this.listRemoteControlEnvironments(auth);
    const byRequested = requestedEnvId
      ? environments.find((environment) => environment.envId === requestedEnvId)
      : null;
    if (byRequested?.online) {
      return byRequested;
    }
    const hostname = os.hostname();
    const byHost = environments.find((environment) =>
      environment.online &&
      environment.clientType === "CODEX_DESKTOP_APP" &&
      [environment.hostName, environment.displayName, environment.name].includes(hostname)
    );
    if (byHost != null) {
      return byHost;
    }
    const firstOnline = environments.find((environment) =>
      environment.online && environment.clientType === "CODEX_DESKTOP_APP"
    );
    if (firstOnline != null) {
      return firstOnline;
    }
    throw new CodexAppServerError("No online Codex Desktop remote-control environment was found.", {
      code: "remote-control-environment-unavailable",
      details: environments.map((environment) => ({
        envId: environment.envId,
        displayName: environment.displayName,
        hostName: environment.hostName,
        online: environment.online,
        clientType: environment.clientType
      }))
    });
  }

  async readLocalEnvironmentId() {
    try {
      const state = JSON.parse(await fs.readFile(this.globalStatePath, "utf8"));
      return typeof state?.[GLOBAL_STATE_LOCAL_ENV_KEY] === "string"
        ? state[GLOBAL_STATE_LOCAL_ENV_KEY]
        : null;
    } catch {
      return null;
    }
  }

  async listRemoteControlEnvironments(auth) {
    const response = await this.fetchFn(this.apiUrl(REMOTE_CONTROL_ENVIRONMENTS_PATH), {
      headers: this.authHeaders(auth)
    });
    if (response.status === 401) {
      throw new CodexAppServerError("Codex auth was rejected by the remote-control API.", {
        code: "auth-rejected"
      });
    }
    if (!response.ok) {
      throw new CodexAppServerError(`Remote-control environment lookup failed (${response.status}): ${await safeResponseText(response)}`, {
        code: "remote-control-environment-lookup-failed"
      });
    }
    const body = await response.json();
    return (body?.items || []).map((item) => ({
      envId: item.env_id,
      displayName: item.display_name || item.name || item.host_name || item.env_id,
      hostName: item.host_name || null,
      name: item.name || null,
      online: item.online === true,
      busy: item.busy === true,
      clientType: item.client_type || null,
      appServerVersion: item.app_server_version || null,
      lastSeenAt: item.last_seen_at || null
    })).filter((item) => typeof item.envId === "string");
  }

  authHeaders(auth) {
    return Object.fromEntries(Object.entries({
      Authorization: `Bearer ${auth.accessToken}`,
      "ChatGPT-Account-Id": auth.accountId || null,
      originator: "Codex Desktop",
      "User-Agent": wakefieldUserAgent()
    }).filter(([, value]) => value != null && value !== ""));
  }

  apiUrl(suffix) {
    return `${this.apiBaseUrl}/${suffix.replace(/^\/+/, "")}`;
  }

  remoteControlWebSocketUrl() {
    const url = new URL(this.apiUrl(REMOTE_CONTROL_WS_PATH));
    url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
    return url.toString();
  }
}

function defaultCodexHome() {
  return process.env.CODEX_HOME || path.join(os.homedir(), ".codex");
}

function accountIdFromAccessToken(token) {
  try {
    const payload = JSON.parse(Buffer.from(token.split(".")[1], "base64url").toString("utf8"));
    const auth = payload?.["https://api.openai.com/auth"];
    return auth?.chatgpt_account_id || auth?.account_id || null;
  } catch {
    return null;
  }
}

function wakefieldUserAgent() {
  const platform = process.platform === "darwin" ? "Macintosh" : process.platform;
  return `Wakefield/${DEFAULT_CLIENT_VERSION} (${platform}; ${process.arch})`;
}

async function safeResponseText(response) {
  try {
    return (await response.text()).slice(0, 500);
  } catch {
    return response.statusText || "Unknown error";
  }
}

function mcpStatusLooksBusy(value) {
  return JSON.stringify(value || {}).toLowerCase().match(/\b(starting|pending|loading|restarting)\b/) != null;
}

function appServerErrorSummary(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    method: error?.method || null
  };
}
