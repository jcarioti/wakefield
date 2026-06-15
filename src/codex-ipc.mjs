import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";

const SOCKET_DIR = "codex-ipc";
const DEFAULT_DEEP_LINK_WAKE_WAIT_MS = 30000;
const DEFAULT_DEEP_LINK_WAKE_POLL_MS = 1000;
const DEFAULT_DEEP_LINK_WAKE_REOPEN_MS = 6000;
const execFileAsync = promisify(execFile);

export class CodexIpcError extends Error {
  constructor(message, { code = "codex-ipc-error", method = null, details = null } = {}) {
    super(message);
    this.name = "CodexIpcError";
    this.code = code;
    this.method = method;
    this.details = details;
  }
}

export class FrameDecoder {
  #buffer = Buffer.alloc(0);

  push(chunk) {
    this.#buffer = Buffer.concat([this.#buffer, chunk]);
    const messages = [];
    while (this.#buffer.length >= 4) {
      const frameLength = this.#buffer.readUInt32LE(0);
      if (this.#buffer.length < frameLength + 4) break;
      messages.push(JSON.parse(this.#buffer.subarray(4, frameLength + 4).toString("utf8")));
      this.#buffer = this.#buffer.subarray(frameLength + 4);
    }
    return messages;
  }
}

export function encodeFrame(message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const header = Buffer.alloc(4);
  header.writeUInt32LE(payload.length, 0);
  return Buffer.concat([header, payload]);
}

export function createTextInput(text) {
  return [{ type: "text", text, text_elements: [] }];
}

export function createRestoreMessage({ text, cwd, id = randomUUID(), createdAt = Date.now() }) {
  return {
    id,
    text,
    cwd,
    createdAt,
    responsesapiClientMetadata: null,
    context: {
      prompt: text,
      addedFiles: [],
      fileAttachments: [],
      imageAttachments: [],
      commentAttachments: [],
      ideContext: null,
      workspaceRoots: [cwd],
      collaborationMode: null
    }
  };
}

export async function routePromptToCodex({
  threadId,
  cwd,
  prompt,
  mode = "auto",
  client = null,
  socketPath = null,
  permissions = null,
  deepLinkWake = null,
  wakeThread = null,
  logger = console
}) {
  if (!threadId) throw new Error("Codex dispatch needs a threadId.");
  if (!cwd) throw new Error("Codex dispatch needs a cwd.");
  if (!prompt || typeof prompt !== "string") throw new Error("Codex dispatch needs prompt text.");

  const ownsClient = client == null;
  const codexClient = client || new CodexIpcClient({ socketPath });
  try {
    const action = await routeWithClientWithWake(codexClient, {
      threadId,
      cwd,
      prompt,
      mode,
      permissions,
      deepLinkWake,
      wakeThread,
      logger
    });
    return {
      ...action,
      mode,
      threadId,
      cwd
    };
  } finally {
    if (ownsClient) codexClient.disconnect();
  }
}

async function routeWithClientWithWake(client, {
  threadId,
  cwd,
  prompt,
  mode,
  permissions,
  deepLinkWake,
  wakeThread,
  logger
}) {
  try {
    return await routeWithClient(client, { threadId, cwd, prompt, mode, permissions });
  } catch (error) {
    if (!isMissingCodexIpcError(error) || !deepLinkWakeEnabled(deepLinkWake)) throw error;
  }

  let wakeResult = await wakeCodexThreadForFollower({
    threadId,
    deepLinkWake,
    wakeThread,
    logger
  });
  const deadline = Date.now() + wakeResult.waitMs;
  let lastOpenAt = Date.now();
  let lastError = null;

  do {
    try {
      const action = await routeWithClient(client, { threadId, cwd, prompt, mode, permissions });
      logger?.info?.(`Codex follower route recovered for ${threadId} after deep-link wake.`);
      return action;
    } catch (error) {
      if (!isMissingCodexIpcError(error)) throw error;
      lastError = error;
      if (Date.now() >= deadline) break;
      if (wakeResult.reopenMs > 0 && Date.now() - lastOpenAt >= wakeResult.reopenMs) {
        wakeResult = await wakeCodexThreadForFollower({
          threadId,
          deepLinkWake,
          wakeThread,
          logger,
          reason: "retry"
        });
        lastOpenAt = Date.now();
      }
      await sleep(Math.min(wakeResult.pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);

  logger?.error?.(`Codex follower still missing for ${threadId} after deep-link wake.`);
  throw lastError;
}

export async function wakeCodexThreadForFollower({
  threadId,
  deepLinkWake = null,
  wakeThread = null,
  logger = console,
  reason = "initial"
}) {
  const wakeConfig = normalizeDeepLinkWake(deepLinkWake);
  const url = codexThreadDeepLink(threadId);
  const wakeVerb = reason === "retry" ? "re-opening" : "opening";
  logger?.info?.(`Codex follower client missing for ${threadId}; ${wakeVerb} ${url} to load the app-owned thread follower.`);
  if (wakeThread) {
    await wakeThread({ threadId, url, waitMs: wakeConfig.waitMs, pollMs: wakeConfig.pollMs, reopenMs: wakeConfig.reopenMs, reason });
  } else {
    await openCodexDeepLink(url, wakeConfig);
  }
  logger?.info?.(`Codex deep-link wake command completed for ${threadId}; polling up to ${wakeConfig.waitMs}ms for follower registration.`);
  return { url, waitMs: wakeConfig.waitMs, pollMs: wakeConfig.pollMs, reopenMs: wakeConfig.reopenMs };
}

export function codexThreadDeepLink(threadId) {
  if (!threadId || typeof threadId !== "string") throw new Error("Codex thread deep link needs a threadId.");
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

export async function resolveCodexIpcSocket({
  socketPath = null,
  env = process.env,
  tmpdir = os.tmpdir()
} = {}) {
  const explicit = socketPath || env.CODEX_IPC_SOCKET;
  if (explicit) return explicit;

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const directory = path.join(tmpdir, SOCKET_DIR);
  const preferred = path.join(directory, uid == null ? "ipc.sock" : `ipc-${uid}.sock`);
  if (await isSocket(preferred)) return preferred;

  let entries;
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw new CodexIpcError(`Codex app IPC socket directory does not exist at ${directory}.`, {
        code: "socket-directory-missing"
      });
    }
    throw error;
  }

  const candidates = [];
  for (const entry of entries) {
    if (!entry.startsWith("ipc-") || !entry.endsWith(".sock")) continue;
    const candidate = path.join(directory, entry);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isSocket()) candidates.push({ candidate, mtimeMs: stat.mtimeMs });
    } catch {
      // Stale socket entries are expected after app restarts.
    }
  }
  candidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  if (candidates[0]) return candidates[0].candidate;

  throw new CodexIpcError(`No Codex app IPC socket found under ${directory}.`, {
    code: "socket-missing"
  });
}

export class CodexIpcClient {
  constructor({
    socketPath = null,
    clientType = "wakefield",
    connectTimeoutMs = 10000,
    requestTimeoutMs = 30000,
    logger = console
  } = {}) {
    this.socketPath = socketPath;
    this.clientType = clientType;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.clientId = randomUUID();
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
  }

  async connect() {
    if (this.socket) return;
    const resolvedSocketPath = await resolveCodexIpcSocket({ socketPath: this.socketPath });
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(resolvedSocketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new CodexIpcError(`Timed out connecting to Codex IPC socket ${resolvedSocketPath}.`, {
          code: "connect-timeout"
        }));
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.socketPath = resolvedSocketPath;
        socket.on("data", (chunk) => this.#handleData(chunk));
        socket.on("error", (error) => this.logger.error?.(`Codex IPC socket error: ${error.message}`));
        socket.on("close", () => this.#handleClose());
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(new CodexIpcError(`Failed to connect to Codex IPC socket ${resolvedSocketPath}: ${error.message}`, {
          code: "connect-failed",
          details: error
        }));
      });
    });

    const result = await this.request("initialize", { clientType: this.clientType }, { version: 0 });
    if (result?.clientId) this.clientId = result.clientId;
  }

  disconnect() {
    if (this.socket) {
      this.socket.destroy();
      this.socket = null;
    }
    this.#rejectPending(new CodexIpcError("Codex IPC connection closed.", { code: "connection-closed" }));
  }

  async steerThreadFollowerTurn({ conversationId, cwd, text }) {
    return this.request(
      "thread-follower-steer-turn",
      {
        conversationId,
        input: createTextInput(text),
        attachments: [],
        restoreMessage: createRestoreMessage({ text, cwd })
      },
      { version: 1 }
    );
  }

  async startThreadFollowerTurn({ conversationId, cwd, text, permissions = null }) {
    return this.request(
      "thread-follower-start-turn",
      {
        conversationId,
        turnStartParams: {
          cwd,
          input: createTextInput(text),
          ...normalizePermissions(permissions)
        }
      },
      { version: 1 }
    );
  }

  async request(method, params, { version = 0, timeoutMs = this.requestTimeoutMs } = {}) {
    if (!this.socket && method !== "initialize") await this.connect();
    if (!this.socket) throw new CodexIpcError("Codex IPC client is not connected.", { code: "not-connected", method });

    const requestId = randomUUID();
    const payload = {
      type: "request",
      requestId,
      sourceClientId: this.clientId,
      version,
      method,
      params
    };

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(requestId);
        reject(new CodexIpcError(`Timed out waiting for Codex IPC method ${method}.`, {
          code: "request-timeout",
          method
        }));
      }, timeoutMs);
      this.pending.set(requestId, { resolve, reject, timeout, method });
      this.socket.write(encodeFrame(payload));
    });
  }

  #handleData(chunk) {
    let messages = [];
    try {
      messages = this.decoder.push(chunk);
    } catch (error) {
      this.logger.error?.(`Failed to decode Codex IPC frame: ${error.message}`);
      return;
    }
    for (const message of messages) this.#handleMessage(message);
  }

  #handleMessage(message) {
    if (message.type === "response" && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) return;
      clearTimeout(pending.timeout);
      this.pending.delete(message.requestId);
      if (message.resultType === "error" || message.error) {
        pending.reject(toCodexIpcError(message.error || message, pending.method));
      } else {
        pending.resolve(message.result ?? message.response ?? message);
      }
      return;
    }

    if (message.type === "client-discovery-request" && message.requestId) {
      this.socket?.write(encodeFrame({
        type: "client-discovery-response",
        requestId: message.requestId,
        sourceClientId: this.clientId,
        result: { canHandle: false }
      }));
    }
  }

  #handleClose() {
    this.socket = null;
    this.#rejectPending(new CodexIpcError("Codex IPC socket closed.", { code: "socket-closed" }));
  }

  #rejectPending(error) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexIpcError(error.message, {
        code: error.code,
        method: pending.method,
        details: error.details
      }));
    }
    this.pending.clear();
  }
}

async function routeWithClient(client, { threadId, cwd, prompt, mode, permissions }) {
  if (mode === "steer") return action("steer", await steer(client, threadId, cwd, prompt));
  if (mode === "start") return action("start", await start(client, threadId, cwd, prompt, permissions));
  if (mode !== "auto" && mode !== "ipc") throw new Error(`Unsupported Codex dispatch mode: ${mode}`);

  try {
    return action("steer", await steer(client, threadId, cwd, prompt));
  } catch (error) {
    if (!isInactiveTurnError(error)) throw error;
  }

  try {
    return action("start", await start(client, threadId, cwd, prompt, permissions));
  } catch (error) {
    if (!isActiveTurnError(error)) throw error;
  }

  return action("steer", await steer(client, threadId, cwd, prompt));
}

function steer(client, threadId, cwd, prompt) {
  return client.steerThreadFollowerTurn({ conversationId: threadId, cwd, text: prompt });
}

function start(client, threadId, cwd, prompt, permissions) {
  return client.startThreadFollowerTurn({ conversationId: threadId, cwd, text: prompt, permissions });
}

function action(actionName, result) {
  return {
    action: actionName,
    turnId: extractTurnId(result),
    result
  };
}

function normalizePermissions(permissions) {
  if (!permissions || typeof permissions !== "object") return {};
  if (permissions.mode === "full-access") {
    return {
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    };
  }
  const { approvalPolicy, approvalsReviewer, sandboxPolicy } = permissions;
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {})
  };
}

export function extractTurnId(value) {
  if (!value || typeof value !== "object") return null;
  if (typeof value.turnId === "string") return value.turnId;
  if (typeof value.id === "string" && value.status) return value.id;
  if (typeof value.turn?.id === "string") return value.turn.id;
  if (typeof value.result?.turnId === "string") return value.result.turnId;
  if (typeof value.result?.turn?.id === "string") return value.result.turn.id;
  return null;
}

export function isInactiveTurnError(error) {
  return [/no active/i, /not active/i, /cannot steer/i, /no.*turn/i]
    .some((pattern) => pattern.test(errorText(error)));
}

export function isActiveTurnError(error) {
  return [/already.*active/i, /already.*running/i, /active.*turn/i, /busy/i]
    .some((pattern) => pattern.test(errorText(error)));
}

export function isMissingCodexIpcError(error) {
  return [
    /socket-directory-missing/i,
    /socket-missing/i,
    /connect-timeout/i,
    /connect-failed/i,
    /no-client-found/i,
    /no.*client/i
  ].some((pattern) => pattern.test(errorText(error)));
}

function errorText(error) {
  return [
    error?.code,
    error?.method,
    error?.message,
    typeof error?.details === "string" ? error.details : null,
    error?.details?.code,
    error?.details?.message
  ].filter(Boolean).join(" ");
}

async function isSocket(candidate) {
  try {
    return (await fs.stat(candidate)).isSocket();
  } catch {
    return false;
  }
}

function deepLinkWakeEnabled(deepLinkWake) {
  return normalizeDeepLinkWake(deepLinkWake).enabled;
}

function normalizeDeepLinkWake(value) {
  if (value === false) {
    return { enabled: false, command: null, args: null, waitMs: 0, pollMs: 0, reopenMs: 0 };
  }
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: source.enabled !== false,
    command: source.command || defaultDeepLinkOpenCommand(),
    args: Array.isArray(source.args) ? source.args : null,
    waitMs: normalizePositiveInteger(source.waitMs, DEFAULT_DEEP_LINK_WAKE_WAIT_MS),
    pollMs: normalizePositiveInteger(source.pollMs, DEFAULT_DEEP_LINK_WAKE_POLL_MS),
    reopenMs: normalizePositiveInteger(source.reopenMs, DEFAULT_DEEP_LINK_WAKE_REOPEN_MS)
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function defaultDeepLinkOpenCommand() {
  return process.platform === "darwin" ? "/usr/bin/open" : null;
}

async function openCodexDeepLink(url, { command, args }) {
  if (!command) {
    throw new Error("Codex deep-link wake is enabled, but no open command is configured for this platform.");
  }
  const commandArgs = args == null
    ? [url]
    : args.map((arg) => arg === "{url}" ? url : arg);
  await execFileAsync(command, commandArgs, { timeout: 10000 });
}

function toCodexIpcError(error, method) {
  const message = typeof error === "string"
    ? error
    : error?.message || error?.error || JSON.stringify(error);
  return new CodexIpcError(message, {
    code: error?.code || "codex-ipc-request-failed",
    method,
    details: error
  });
}
