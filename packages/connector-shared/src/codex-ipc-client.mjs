import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_CLIENT_TYPE = "discord-codex-connector";
const SOCKET_DIR = "codex-ipc";

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
      if (this.#buffer.length < frameLength + 4) {
        break;
      }
      const payload = this.#buffer.subarray(4, frameLength + 4).toString("utf8");
      messages.push(JSON.parse(payload));
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

export function createClientDiscoveryResponse({ requestId, canHandle = false }) {
  return {
    type: "client-discovery-response",
    requestId,
    response: { canHandle }
  };
}

export function fullAccessTurnSettings() {
  return {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  };
}

export function normalizeCodexPermissions(permissions = null) {
  if (permissions == null) {
    return null;
  }
  if (permissions.mode === "full-access") {
    return fullAccessTurnSettings();
  }
  const { approvalPolicy, approvalsReviewer, sandboxPolicy } = permissions;
  if (!approvalPolicy && !approvalsReviewer && !sandboxPolicy) {
    return null;
  }
  return {
    ...(approvalPolicy ? { approvalPolicy } : {}),
    ...(approvalsReviewer ? { approvalsReviewer } : {}),
    ...(sandboxPolicy ? { sandboxPolicy } : {})
  };
}

export function createTurnStartParams({ cwd, input, permissions = null }) {
  return {
    cwd,
    input,
    ...normalizeCodexPermissions(permissions)
  };
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

export async function resolveCodexIpcSocket({
  socketPath = null,
  env = process.env,
  tmpdir = os.tmpdir(),
  codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex")
} = {}) {
  return (await listCodexIpcSocketCandidates({ socketPath, env, tmpdir, codexHome }))[0];
}

export async function listCodexIpcSocketCandidates({
  socketPath = null,
  env = process.env,
  tmpdir = os.tmpdir(),
  codexHome = env.CODEX_HOME || path.join(os.homedir(), ".codex")
} = {}) {
  const explicit = socketPath || env.CODEX_IPC_SOCKET;
  if (explicit) {
    return [explicit];
  }

  // Keep the known current and legacy locations in priority order. Connecting
  // below performs the real liveness check; a socket filesystem entry alone
  // can survive a desktop restart.
  const currentSocket = path.join(codexHome, "ipc", "ipc.sock");
  const candidates = [];
  if (await isSocket(currentSocket)) {
    candidates.push(currentSocket);
  }

  const uid = typeof process.getuid === "function" ? process.getuid() : null;
  const directory = path.join(tmpdir, SOCKET_DIR);
  const preferred = path.join(directory, uid == null ? "ipc.sock" : `ipc-${uid}.sock`);
  if (await isSocket(preferred)) {
    candidates.push(preferred);
  }

  let entries = [];
  try {
    entries = await fs.readdir(directory);
  } catch (error) {
    if (error?.code === "ENOENT") {
      if (candidates.length > 0) {
        return candidates;
      }
      throw new CodexIpcError(
        `No current Codex IPC socket at ${currentSocket}, and the legacy socket directory does not exist at ${directory}. Open ChatGPT desktop and load the target Codex task.`,
        { code: "socket-directory-missing" }
      );
    }
    throw error;
  }

  const legacyCandidates = [];
  for (const entry of entries) {
    if (!entry.startsWith("ipc-") || !entry.endsWith(".sock")) {
      continue;
    }
    const candidate = path.join(directory, entry);
    try {
      const stat = await fs.stat(candidate);
      if (stat.isSocket() && !candidates.includes(candidate)) {
        legacyCandidates.push({ candidate, mtimeMs: stat.mtimeMs });
      }
    } catch {
      // Ignore stale directory entries.
    }
  }

  legacyCandidates.sort((left, right) => right.mtimeMs - left.mtimeMs);
  candidates.push(...legacyCandidates.map(({ candidate }) => candidate));
  if (candidates.length > 0) {
    return candidates;
  }

  throw new CodexIpcError(
    `No Codex IPC socket found at ${currentSocket} or under ${directory}. Open ChatGPT desktop and load the target Codex task.`,
    { code: "socket-missing" }
  );
}

export class CodexIpcClient {
  constructor({
    socketPath = null,
    clientType = DEFAULT_CLIENT_TYPE,
    connectTimeoutMs = 10000,
    requestTimeoutMs = 30000,
    logger = console,
    socketDiscovery = null
  } = {}) {
    this.explicitSocketPath = socketPath;
    this.socketPath = socketPath;
    this.clientType = clientType;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.logger = logger;
    this.socketDiscovery = socketDiscovery && typeof socketDiscovery === "object" ? socketDiscovery : {};
    this.clientId = randomUUID();
    this.socket = null;
    this.decoder = new FrameDecoder();
    this.pending = new Map();
  }

  async connect() {
    if (this.socket != null) {
      return;
    }

    const candidates = await listCodexIpcSocketCandidates({ ...this.socketDiscovery, socketPath: this.explicitSocketPath });
    const failures = [];
    let lastError = null;
    for (const candidate of candidates) {
      try {
        await this.#connectSocket(candidate);
        const result = await this.request("initialize", { clientType: this.clientType }, { version: 0 });
        if (result?.clientId) {
          this.clientId = result.clientId;
        }
        return;
      } catch (error) {
        lastError = error;
        failures.push({ socketPath: candidate, code: error?.code || null, message: error?.message || String(error) });
        this.disconnect();
      }
    }

    if (failures.length === 1 && lastError) throw lastError;
    const lastFailure = failures.at(-1);
    throw new CodexIpcError(
      `No responsive Codex IPC socket found. Tried: ${failures.map(({ socketPath }) => socketPath).join(", ")}.`,
      {
        code: "connect-failed",
        details: { code: lastError?.details?.code || lastError?.code || null, attempts: failures, lastFailure }
      }
    );
  }

  async #connectSocket(resolvedSocketPath) {
    this.decoder = new FrameDecoder();
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(resolvedSocketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new CodexIpcError(`Timed out connecting to Codex IPC socket ${resolvedSocketPath}`, {
          code: "connect-timeout"
        }));
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        clearTimeout(timeout);
        this.socket = socket;
        this.socketPath = resolvedSocketPath;
        socket.on("data", (chunk) => this.#handleData(chunk));
        socket.on("error", (error) => this.#handleSocketError(error));
        socket.on("close", () => this.#handleSocketClose());
        resolve();
      });
      socket.once("error", (error) => {
        clearTimeout(timeout);
        socket.destroy();
        reject(new CodexIpcError(`Failed to connect to Codex IPC socket ${resolvedSocketPath}: ${error.message}`, {
          code: "connect-failed",
          details: error
        }));
      });
    });
  }

  disconnect() {
    if (this.socket != null) {
      this.socket.destroy();
      this.socket = null;
    }
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexIpcError("Codex IPC connection closed.", { code: "connection-closed" }));
    }
    this.pending.clear();
  }

  async startThreadFollowerTurn({ conversationId, cwd, text, input = createTextInput(text), permissions = null }) {
    return this.request(
      "thread-follower-start-turn",
      {
        conversationId,
        turnStartParams: createTurnStartParams({ cwd, input, permissions })
      },
      { version: 1 }
    );
  }

  async steerThreadFollowerTurn({ conversationId, cwd, text, input = createTextInput(text) }) {
    return this.request(
      "thread-follower-steer-turn",
      {
        conversationId,
        input,
        attachments: [],
        restoreMessage: createRestoreMessage({ text, cwd })
      },
      { version: 1 }
    );
  }

  async request(method, params, { version = methodVersion(method), timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.socket == null && method !== "initialize") {
      await this.connect();
    }
    if (this.socket == null) {
      throw new CodexIpcError("Codex IPC client is not connected.", { code: "not-connected", method });
    }

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

    for (const message of messages) {
      this.#handleMessage(message);
    }
  }

  #handleMessage(message) {
    if (message.type === "response" && message.requestId) {
      const pending = this.pending.get(message.requestId);
      if (!pending) {
        return;
      }
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
      this.#send(createClientDiscoveryResponse({
        requestId: message.requestId,
      }));
    }
  }

  #send(message) {
    if (this.socket != null && !this.socket.destroyed) {
      this.socket.write(encodeFrame(message));
    }
  }

  #handleSocketError(error) {
    this.logger.error?.(`Codex IPC socket error: ${error.message}`);
  }

  #handleSocketClose() {
    this.socket = null;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexIpcError("Codex IPC socket closed.", {
        code: "socket-closed",
        method: pending.method
      }));
    }
    this.pending.clear();
  }
}

export function methodVersion(method) {
  switch (method) {
    case "thread-follower-start-turn":
    case "thread-follower-steer-turn":
    case "thread-follower-submit-user-input":
      return 1;
    case "thread-follower-interrupt-turn":
      return 2;
    default:
      return 0;
  }
}

async function isSocket(candidate) {
  try {
    return (await fs.stat(candidate)).isSocket();
  } catch {
    return false;
  }
}

function toCodexIpcError(error, method) {
  if (error instanceof CodexIpcError) {
    return error;
  }
  const message = typeof error === "string"
    ? error
    : error?.message || error?.error || JSON.stringify(error);
  return new CodexIpcError(message, {
    code: error?.code || "codex-ipc-request-failed",
    method,
    details: error
  });
}
