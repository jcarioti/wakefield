import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import WebSocket from "ws";
import { createTextInput, normalizeCodexPermissions } from "./codex-ipc-client.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_CLIENT_NAME = "wakefield-controller";
const DEFAULT_CLIENT_VERSION = "0.1.0";
const SUPPORTED_APP_SERVER_VERSION_PREFIX = "0.146.";

export class CodexDesktopControllerError extends Error {
  constructor(message, { code = "codex-desktop-controller-error", method = null, details = null } = {}) {
    super(message);
    this.name = "CodexDesktopControllerError";
    this.code = code;
    this.method = method;
    this.details = details;
  }
}

/**
 * Controller for the daemon-backed Codex runtime owned by ChatGPT Desktop.
 *
 * This is intentionally the only supported controller transport. It does not
 * fall back to the hosted remote-control API or to a standalone app-server.
 */
export class CodexDesktopController {
  constructor({
    socketPath = null,
    codexPath = null,
    ensureDaemon = true,
    requireRemoteControlConnected = true,
    requireDesktopOwnership = true,
    connectTimeoutMs = 10000,
    requestTimeoutMs = 30000,
    startupTimeoutMs = 15000,
    clientName = DEFAULT_CLIENT_NAME,
    clientVersion = DEFAULT_CLIENT_VERSION,
    logger = console,
    execFileImpl = execFileAsync,
    webSocketFactory = (url, options) => new WebSocket(url, options)
  } = {}) {
    this.socketPath = socketPath || defaultControlSocketPath();
    this.codexPath = codexPath || defaultCodexPath();
    this.ensureDaemon = ensureDaemon !== false;
    this.requireRemoteControlConnected = requireRemoteControlConnected !== false;
    this.requireDesktopOwnership = requireDesktopOwnership !== false;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.logger = logger;
    this.execFileImpl = execFileImpl;
    this.webSocketFactory = webSocketFactory;
    this.ws = null;
    this.connecting = null;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.eventHandlers = new Map();
    this.daemonInfo = null;
    this.initializeResult = null;
    this.remoteControlStatus = null;
  }

  async connect() {
    if (this.isConnected() && this.initializeResult != null) return;
    if (this.connecting != null) return this.connecting;
    this.connecting = this.connectOnce();
    try {
      await this.connecting;
    } finally {
      this.connecting = null;
    }
  }

  async connectOnce() {
    if (!(await isSocket(this.socketPath))) {
      if (!this.ensureDaemon) {
        throw new CodexDesktopControllerError(`Codex daemon control socket is not present at ${this.socketPath}.`, {
          code: "daemon-socket-missing"
        });
      }
      await this.startDaemon();
      await this.waitForSocket();
    }

    this.daemonInfo = await this.readDaemonInfo();
    if (this.requireDesktopOwnership) this.assertDaemonOwnership(this.daemonInfo);
    await this.openWebSocket();
    try {
      this.initializeResult = await this.request("initialize", {
        clientInfo: {
          name: this.clientName,
          title: null,
          version: this.clientVersion
        },
        capabilities: { experimentalApi: true }
      });
      this.notify("initialized", {});
      if (this.requireDesktopOwnership) this.assertDesktopProtocol(this.initializeResult, this.daemonInfo);
      this.remoteControlStatus = await this.request("remoteControl/status/read", {});
      if (this.requireDesktopOwnership) this.assertRemoteOwnership(this.remoteControlStatus);
      if (this.requireRemoteControlConnected && this.remoteControlStatus?.status !== "connected") {
        throw new CodexDesktopControllerError(
          `ChatGPT Desktop is not attached to the Codex daemon (remote status: ${this.remoteControlStatus?.status || "unknown"}).`,
          {
            code: "desktop-not-attached",
            method: "remoteControl/status/read",
            details: this.remoteControlStatus
          }
        );
      }
    } catch (error) {
      this.disconnect();
      throw error;
    }
  }

  async startDaemon() {
    try {
      await this.execFileImpl(
        this.codexPath,
        ["app-server", "daemon", "start"],
        { timeout: this.startupTimeoutMs, maxBuffer: 1024 * 1024 }
      );
    } catch (error) {
      throw new CodexDesktopControllerError(`Failed to ensure the Codex app-server daemon: ${error.message}`, {
        code: "daemon-start-failed",
        details: error
      });
    }
  }

  async waitForSocket() {
    const deadline = Date.now() + this.startupTimeoutMs;
    do {
      if (await isSocket(this.socketPath)) return;
      await sleep(Math.min(100, Math.max(1, deadline - Date.now())));
    } while (Date.now() < deadline);
    throw new CodexDesktopControllerError(`Codex daemon did not create its control socket at ${this.socketPath}.`, {
      code: "daemon-socket-timeout"
    });
  }

  async readDaemonInfo() {
    let result;
    try {
      result = await this.execFileImpl(
        this.codexPath,
        ["app-server", "daemon", "version"],
        { timeout: this.connectTimeoutMs, maxBuffer: 1024 * 1024 }
      );
    } catch (error) {
      throw new CodexDesktopControllerError(`Could not identify the Codex daemon: ${error.message}`, {
        code: "daemon-identity-unavailable",
        details: error
      });
    }
    try {
      return JSON.parse(result.stdout || "");
    } catch (error) {
      throw new CodexDesktopControllerError("Codex daemon returned invalid version metadata.", {
        code: "daemon-identity-invalid",
        details: { stdout: result.stdout || "", error: error.message }
      });
    }
  }

  assertDaemonOwnership(info) {
    const expectedSocket = path.resolve(this.socketPath);
    const actualSocket = typeof info?.socketPath === "string" ? path.resolve(info.socketPath) : null;
    const versions = [info?.managedCodexVersion, info?.cliVersion, info?.appServerVersion];
    if (
      info?.status !== "running" ||
      info?.backend !== "pid" ||
      actualSocket !== expectedSocket ||
      versions.some((value) => typeof value !== "string" || !value.startsWith(SUPPORTED_APP_SERVER_VERSION_PREFIX)) ||
      new Set(versions).size !== 1
    ) {
      throw new CodexDesktopControllerError(
        `The control socket is not owned by the supported Codex ${SUPPORTED_APP_SERVER_VERSION_PREFIX.slice(0, -1)} daemon.`,
        { code: "daemon-ownership-mismatch", details: info }
      );
    }
  }

  assertDesktopProtocol(initializeResult, daemonInfo) {
    const expectedAgent = `Codex Desktop/${daemonInfo.appServerVersion}`;
    if (
      typeof initializeResult?.userAgent !== "string" ||
      !initializeResult.userAgent.startsWith(expectedAgent) ||
      initializeResult?.platformFamily !== "unix" ||
      initializeResult?.platformOs !== "macos"
    ) {
      throw new CodexDesktopControllerError(
        "The daemon protocol endpoint is not the supported ChatGPT Desktop Codex runtime.",
        { code: "desktop-protocol-mismatch", method: "initialize", details: initializeResult }
      );
    }
  }

  assertRemoteOwnership(status) {
    if (
      status?.status === "connected" &&
      (!nonEmpty(status.serverName) || !nonEmpty(status.installationId) || !nonEmpty(status.environmentId))
    ) {
      throw new CodexDesktopControllerError(
        "ChatGPT Desktop reported a connected remote runtime without complete ownership metadata.",
        { code: "desktop-ownership-incomplete", method: "remoteControl/status/read", details: status }
      );
    }
  }

  async openWebSocket() {
    const url = controlSocketWebSocketUrl(this.socketPath);
    await new Promise((resolve, reject) => {
      const ws = this.webSocketFactory(url, { perMessageDeflate: false });
      this.ws = ws;
      const timeout = setTimeout(() => {
        ws.close?.();
        reject(new CodexDesktopControllerError(`Timed out connecting to ${this.socketPath}.`, {
          code: "connect-timeout"
        }));
      }, this.connectTimeoutMs);
      ws.on("message", (data) => this.handleMessageText(String(data)));
      ws.on("close", () => this.handleSocketClose());
      ws.once("open", () => {
        clearTimeout(timeout);
        resolve();
      });
      ws.once("error", (error) => {
        clearTimeout(timeout);
        reject(new CodexDesktopControllerError(`Failed to connect to ${this.socketPath}: ${error.message}`, {
          code: "connect-failed",
          details: error
        }));
      });
    });
  }

  disconnect() {
    const ws = this.ws;
    this.ws = null;
    this.initializeResult = null;
    if (ws != null && ws.readyState !== WebSocket.CLOSED) ws.close();
    this.rejectPending("Codex desktop controller connection closed.", "connection-closed");
  }

  async createTask({
    cwd,
    permissions = null,
    model = null,
    serviceTier = null,
    developerInstructions = null,
    baseInstructions = null,
    config = null
  } = {}) {
    if (!nonEmpty(cwd)) throw new Error("Creating a Codex Desktop task requires cwd.");
    await this.connect();
    const params = compactObject({
      cwd: path.resolve(cwd),
      ephemeral: false,
      model,
      serviceTier,
      developerInstructions,
      baseInstructions,
      config,
      ...normalizeThreadPermissions(permissions)
    });
    const result = await this.request("thread/start", params);
    this.assertPersistentTask(result?.thread, params.cwd);
    return result;
  }

  async attachTask({ threadId, cwd = null } = {}) {
    if (!nonEmpty(threadId)) throw new Error("Attaching a Codex Desktop task requires threadId.");
    await this.connect();
    const result = await this.request("thread/resume", compactObject({
      threadId,
      cwd: cwd ? path.resolve(cwd) : null,
      excludeTurns: true,
      persistExtendedHistory: false
    }));
    this.assertPersistentTask(result?.thread, cwd ? path.resolve(cwd) : null, threadId);
    return result;
  }

  async startTurn({ threadId, cwd = null, text = null, input = null, permissions = null } = {}) {
    const attached = await this.attachTask({ threadId, cwd });
    if (attached.thread?.status?.type === "active") {
      throw new CodexDesktopControllerError(`Codex Desktop task ${threadId} already has an active turn.`, {
        code: "turn-already-active",
        method: "turn/start",
        details: attached.thread.status
      });
    }
    const result = await this.request("turn/start", compactObject({
      threadId,
      cwd: cwd ? path.resolve(cwd) : null,
      input: input || createTextInput(text),
      ...normalizeCodexPermissions(permissions)
    }));
    if (!nonEmpty(extractAppServerTurnId(result))) {
      throw new CodexDesktopControllerError("Codex Desktop did not return a turn id.", {
        code: "turn-start-invalid",
        method: "turn/start",
        details: result
      });
    }
    return result;
  }

  async steerTurn({ threadId, turnId, text = null, input = null } = {}) {
    if (!nonEmpty(threadId) || !nonEmpty(turnId)) {
      throw new Error("Steering a Codex Desktop turn requires threadId and turnId.");
    }
    await this.connect();
    const result = await this.request("turn/steer", {
      threadId,
      expectedTurnId: turnId,
      input: input || createTextInput(text)
    });
    const returnedTurnId = extractAppServerTurnId(result);
    if (returnedTurnId != null && returnedTurnId !== turnId) {
      throw new CodexDesktopControllerError("Codex Desktop steered a different turn than requested.", {
        code: "turn-ownership-mismatch",
        method: "turn/steer",
        details: result
      });
    }
    return result;
  }

  async routeTextToThread({ threadId, cwd, text, input = null, permissions = null }) {
    const attached = await this.attachTask({ threadId, cwd });
    if (attached.thread?.status?.type === "active") {
      // `turn/steer` alters the current response without adding a user-message
      // item to the Desktop conversation. Connectors must keep inbound text
      // pending until a normal `turn/start` can render it and sync it to Remote.
      throw new CodexDesktopControllerError(
        `Codex Desktop task ${threadId} has an active turn; defer this inbound message until the task is idle.`,
        {
          code: "active-turn-pending",
          method: "turn/start",
          details: attached.thread.status
        }
      );
    }
    const result = await this.request("turn/start", {
      threadId,
      cwd: path.resolve(cwd),
      input: input || createTextInput(text),
      ...normalizeCodexPermissions(permissions)
    });
    const turnId = extractAppServerTurnId(result);
    if (!nonEmpty(turnId)) {
      throw new CodexDesktopControllerError("Codex Desktop did not return a turn id.", {
        code: "turn-start-invalid",
        method: "turn/start",
        details: result
      });
    }
    return { action: "start-desktop", result, turnId };
  }

  async findActiveTurnId(threadId, thread = null) {
    if (thread?.status?.type !== "active") return null;
    const turns = await this.request("thread/turns/list", {
      threadId,
      limit: 5,
      sortDirection: "desc",
      itemsView: "summary"
    });
    // Desktop's history can retain interrupted older turns as `inProgress`.
    // `sortDirection: desc` makes the first current in-progress turn the one
    // attached to this active task; treating historical remnants as ambiguous
    // would leave the live connector queue permanently blocked.
    const active = (turns?.data || []).find((turn) => turn?.status === "inProgress");
    if (!nonEmpty(active?.id)) {
      throw new CodexDesktopControllerError(`Could not establish ownership of the active turn for ${threadId}.`, {
        code: "active-turn-ownership-ambiguous",
        method: "thread/turns/list",
        details: turns
      });
    }
    return active.id;
  }

  assertPersistentTask(thread, expectedCwd = null, expectedThreadId = null) {
    const actualCwd = typeof thread?.cwd === "string" ? path.resolve(thread.cwd) : null;
    if (
      !nonEmpty(thread?.id) ||
      thread?.ephemeral !== false ||
      (expectedThreadId != null && thread.id !== expectedThreadId) ||
      (expectedCwd != null && actualCwd !== path.resolve(expectedCwd))
    ) {
      throw new CodexDesktopControllerError("Codex Desktop did not return the requested persistent task.", {
        code: "task-ownership-mismatch",
        method: expectedThreadId == null ? "thread/start" : "thread/resume",
        details: { expectedThreadId, expectedCwd, thread }
      });
    }
  }

  async listMcpServerStatus({
    detail = "toolsAndAuthOnly",
    limit = 100,
    timeoutMs = this.requestTimeoutMs
  } = {}) {
    await this.connect();
    const data = [];
    let cursor = null;
    do {
      const page = await this.request("mcpServerStatus/list", compactObject({
        detail,
        limit,
        cursor
      }), { timeoutMs });
      data.push(...(Array.isArray(page?.data) ? page.data : []));
      cursor = nonEmpty(page?.nextCursor) ? page.nextCursor : null;
    } while (cursor != null);
    return { data, nextCursor: null };
  }

  async reloadMcpServers({
    timeoutMs = this.requestTimeoutMs,
    pollMs = 1000
  } = {}) {
    await this.connect();
    const events = [];
    const unsubscribe = this.on("mcpServer/startupStatus/updated", (params) => events.push(params));
    try {
      // MCP configuration and server lifecycle belong to the Desktop daemon,
      // not to a task. Querying status with an active task id can block behind
      // that task's turn, which makes a global reload appear to hang.
      const before = await this.listMcpServerStatus({ timeoutMs: Math.min(timeoutMs, 5000) })
        .catch((error) => ({ error: controllerErrorSummary(error) }));
      const reload = await this.request("config/mcpServer/reload", {}, { timeoutMs });
      const after = await this.pollMcpServerStatus({ timeoutMs, pollMs });
      return {
        action: "mcp-reload",
        transport: "desktop-daemon",
        daemon: this.daemonInfo,
        desktop: this.remoteControlStatus,
        before,
        reload,
        after,
        events
      };
    } finally {
      unsubscribe();
    }
  }

  async pollMcpServerStatus({ timeoutMs = this.requestTimeoutMs, pollMs = 1000 } = {}) {
    const deadline = Date.now() + timeoutMs;
    let last = null;
    let lastError = null;
    do {
      try {
        last = await this.listMcpServerStatus({
          timeoutMs: Math.min(5000, Math.max(1, deadline - Date.now()))
        });
        if (!mcpStatusLooksBusy(last)) return last;
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

  async callMcpTool({ threadId, server, tool, arguments: toolArguments = {}, meta = null } = {}) {
    if (![threadId, server, tool].every(nonEmpty)) {
      throw new Error("Calling a desktop MCP tool requires threadId, server, and tool.");
    }
    await this.attachTask({ threadId });
    return this.request("mcpServer/tool/call", compactObject({
      threadId,
      server,
      tool,
      arguments: toolArguments,
      _meta: meta
    }));
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.isConnected()) {
      throw new CodexDesktopControllerError("Codex desktop controller is not connected.", {
        code: "not-connected",
        method
      });
    }
    const id = this.nextRequestId++;
    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new CodexDesktopControllerError(`Timed out waiting for Codex app-server method ${method}.`, {
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
      current?.delete(handler);
      if (current?.size === 0) this.eventHandlers.delete(method);
    };
  }

  send(message) {
    if (!this.isConnected()) {
      throw new CodexDesktopControllerError("Codex desktop controller socket is closed.", {
        code: "socket-closed"
      });
    }
    this.ws.send(JSON.stringify(message));
  }

  isConnected() {
    return this.ws != null && this.ws.readyState === WebSocket.OPEN;
  }

  handleMessageText(text) {
    for (const line of text.trim().split("\n")) {
      if (!line.trim()) continue;
      let message;
      try {
        message = JSON.parse(line);
      } catch (error) {
        this.logger.warn?.(`Ignoring non-JSON Codex desktop message: ${error.message}`);
        continue;
      }
      if (message.method === "remoteControl/status/changed") this.remoteControlStatus = message.params;
      if (message.id == null) {
        for (const handler of this.eventHandlers.get(message.method) || []) handler(message.params);
        continue;
      }
      const pending = this.pending.get(message.id);
      if (!pending) continue;
      clearTimeout(pending.timeout);
      this.pending.delete(message.id);
      if (message.error) {
        pending.reject(new CodexDesktopControllerError(
          message.error.message || `Codex app-server method ${pending.method} failed.`,
          {
            code: message.error.code || "request-failed",
            method: pending.method,
            details: message.error
          }
        ));
      } else {
        pending.resolve(message.result);
      }
    }
  }

  handleSocketClose() {
    this.ws = null;
    this.initializeResult = null;
    this.rejectPending("Codex desktop controller socket closed.", "socket-closed");
  }

  rejectPending(message, code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexDesktopControllerError(message, { code, method: pending.method }));
    }
    this.pending.clear();
  }
}

export async function probeCodexDesktopController({
  socketPath = defaultControlSocketPath(),
  controllerFactory = (options) => new CodexDesktopController(options)
} = {}) {
  const socketPresent = await isSocket(socketPath);
  const result = {
    ok: false,
    socket: { ok: socketPresent, path: socketPath },
    daemon: { ok: false, detail: socketPresent ? "not checked" : "socket missing" },
    protocol: { ok: false, detail: socketPresent ? "not checked" : "socket missing" },
    remote: { ok: false, status: "unknown", detail: socketPresent ? "not checked" : "socket missing" },
    mcp: { ok: false, count: null, detail: socketPresent ? "not checked" : "socket missing" }
  };
  if (!socketPresent) return result;

  const controller = controllerFactory({
    socketPath,
    ensureDaemon: false,
    requireRemoteControlConnected: false,
    requireDesktopOwnership: true,
    connectTimeoutMs: 3000,
    requestTimeoutMs: 5000,
    logger: quietLogger()
  });
  try {
    await controller.connect();
    result.daemon = {
      ok: true,
      detail: `${controller.daemonInfo.appServerVersion}; ${controller.daemonInfo.backend}`,
      info: controller.daemonInfo
    };
    result.protocol = {
      ok: true,
      detail: controller.initializeResult.userAgent,
      initialize: controller.initializeResult
    };
    result.remote = {
      ok: controller.remoteControlStatus?.status === "connected",
      status: controller.remoteControlStatus?.status || "unknown",
      detail: controller.remoteControlStatus?.status === "connected"
        ? `${controller.remoteControlStatus.serverName}; ${controller.remoteControlStatus.environmentId}`
        : "ChatGPT Desktop is not attached",
      ownership: controller.remoteControlStatus
    };
    const mcp = await controller.listMcpServerStatus({ timeoutMs: 5000 });
    result.mcp = {
      ok: Array.isArray(mcp.data),
      count: mcp.data.length,
      detail: `${mcp.data.length} live server${mcp.data.length === 1 ? "" : "s"}`
    };
  } catch (error) {
    const stage = error?.code?.startsWith("daemon-") ? "daemon" :
      error?.method === "initialize" || error?.code === "desktop-protocol-mismatch" ? "protocol" :
        error?.method === "remoteControl/status/read" || error?.code?.startsWith("desktop-") ? "remote" :
          error?.method?.startsWith("mcpServer") ? "mcp" : "protocol";
    result[stage] = { ok: false, detail: error.message, error: controllerErrorSummary(error) };
  } finally {
    controller.disconnect();
  }
  result.ok = result.socket.ok && result.daemon.ok && result.protocol.ok && result.remote.ok && result.mcp.ok;
  return result;
}

export function extractAppServerTurnId(value) {
  if (value == null || typeof value !== "object") return null;
  if (typeof value.turnId === "string") return value.turnId;
  if (typeof value.turn?.id === "string") return value.turn.id;
  return null;
}

export function defaultControlSocketPath() {
  return process.env.CODEX_APP_SERVER_CONTROL_SOCKET ||
    path.join(os.homedir(), ".codex", "app-server-control", "app-server-control.sock");
}

export function defaultCodexPath() {
  return process.env.CODEX_BIN ||
    path.join(os.homedir(), ".codex", "packages", "standalone", "current", "codex");
}

export function controlSocketWebSocketUrl(socketPath) {
  return `ws+unix://${socketPath}:/`;
}

export async function isSocket(candidate) {
  try {
    return (await fs.stat(candidate)).isSocket();
  } catch {
    return false;
  }
}

function normalizeThreadPermissions(permissions) {
  const turn = normalizeCodexPermissions(permissions) || {};
  const sandbox = turn.sandboxPolicy?.type === "dangerFullAccess" ? "danger-full-access" :
    turn.sandboxPolicy?.type === "readOnly" ? "read-only" :
      turn.sandboxPolicy?.type === "workspaceWrite" ? "workspace-write" : null;
  return compactObject({
    approvalPolicy: turn.approvalPolicy,
    approvalsReviewer: turn.approvalsReviewer,
    sandbox
  });
}

function compactObject(value) {
  return Object.fromEntries(Object.entries(value).filter(([, item]) => item !== null && item !== undefined));
}

function nonEmpty(value) {
  return typeof value === "string" && value.length > 0;
}

function mcpStatusLooksBusy(value) {
  return /\b(starting|pending|loading|restarting)\b/.test(JSON.stringify(value || {}).toLowerCase());
}

function controllerErrorSummary(error) {
  return {
    message: error?.message || String(error),
    code: error?.code || null,
    method: error?.method || null
  };
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}
