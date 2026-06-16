import crypto from "node:crypto";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createTextInput, normalizeCodexPermissions } from "./codex-ipc-client.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_CLIENT_NAME = "wakefield-connector";
const DEFAULT_CLIENT_VERSION = "0.1.0";

export class CodexAppServerError extends Error {
  constructor(message, { code = "codex-app-server-error", method = null, details = null } = {}) {
    super(message);
    this.name = "CodexAppServerError";
    this.code = code;
    this.method = method;
    this.details = details;
  }
}

export class CodexAppServerClient {
  constructor({
    socketPath = null,
    codexPath = null,
    ensureDaemon = true,
    requireRemoteControlConnected = true,
    connectTimeoutMs = 10000,
    requestTimeoutMs = 30000,
    startupTimeoutMs = 15000,
    clientName = DEFAULT_CLIENT_NAME,
    clientVersion = DEFAULT_CLIENT_VERSION,
    logger = console
  } = {}) {
    this.socketPath = socketPath || defaultControlSocketPath();
    this.codexPath = codexPath || defaultCodexPath();
    this.ensureDaemon = ensureDaemon !== false;
    this.requireRemoteControlConnected = requireRemoteControlConnected !== false;
    this.connectTimeoutMs = connectTimeoutMs;
    this.requestTimeoutMs = requestTimeoutMs;
    this.startupTimeoutMs = startupTimeoutMs;
    this.clientName = clientName;
    this.clientVersion = clientVersion;
    this.logger = logger;
    this.socket = null;
    this.buffer = Buffer.alloc(0);
    this.handshaken = false;
    this.nextRequestId = 1;
    this.pending = new Map();
    this.remoteControlStatus = null;
  }

  async connect() {
    if (this.socket != null) {
      return;
    }
    if (this.ensureDaemon && !(await isSocket(this.socketPath))) {
      await this.startDaemon();
    }
    await this.openWebSocket();
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
        `Codex remote control is ${status?.status || "unknown"}; open the Codex app before routing external messages.`,
        {
          code: "remote-control-not-connected",
          method: "remoteControl/status/read",
          details: status
        }
      );
    }
  }

  async startDaemon() {
    try {
      await execFileAsync(
        this.codexPath,
        ["app-server", "daemon", "start"],
        { timeout: this.startupTimeoutMs, maxBuffer: 1024 * 1024 }
      );
    } catch (error) {
      throw new CodexAppServerError(`Failed to start Codex app-server daemon: ${error.message}`, {
        code: "daemon-start-failed",
        details: error
      });
    }
  }

  async openWebSocket() {
    await new Promise((resolve, reject) => {
      const socket = net.createConnection(this.socketPath);
      const timeout = setTimeout(() => {
        socket.destroy();
        reject(new CodexAppServerError(`Timed out connecting to Codex app-server socket ${this.socketPath}`, {
          code: "connect-timeout"
        }));
      }, this.connectTimeoutMs);

      socket.once("connect", () => {
        const key = crypto.randomBytes(16).toString("base64");
        socket.write([
          "GET / HTTP/1.1",
          "Host: localhost",
          "Upgrade: websocket",
          "Connection: Upgrade",
          `Sec-WebSocket-Key: ${key}`,
          "Sec-WebSocket-Version: 13",
          "",
          ""
        ].join("\r\n"));
      });

      socket.on("data", (chunk) => {
        this.buffer = Buffer.concat([this.buffer, chunk]);
        if (!this.handshaken) {
          const split = this.buffer.indexOf("\r\n\r\n");
          if (split === -1) {
            return;
          }
          const header = this.buffer.subarray(0, split).toString("utf8");
          this.buffer = this.buffer.subarray(split + 4);
          if (!/^HTTP\/1\.1 101\b/.test(header)) {
            clearTimeout(timeout);
            socket.destroy();
            reject(new CodexAppServerError(`Codex app-server WebSocket handshake failed: ${header.split("\r\n")[0]}`, {
              code: "websocket-handshake-failed",
              details: header
            }));
            return;
          }
          clearTimeout(timeout);
          this.handshaken = true;
          this.socket = socket;
          socket.on("error", (error) => this.handleSocketError(error));
          socket.on("close", () => this.handleSocketClose());
          resolve();
        }
        this.parseFrames();
      });

      socket.once("error", (error) => {
        clearTimeout(timeout);
        reject(new CodexAppServerError(`Failed to connect to Codex app-server socket ${this.socketPath}: ${error.message}`, {
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
    this.rejectPending("Codex app-server connection closed.", "connection-closed");
  }

  async routeTextToThread({ threadId, cwd, text, input = createTextInput(text), permissions = null }) {
    await this.connect();
    const resumeResult = await this.request("thread/resume", {
      threadId,
      cwd,
      excludeTurns: true,
      persistExtendedHistory: false
    });
    const activeTurnId = await this.findActiveTurnId(threadId, resumeResult?.thread);
    if (activeTurnId) {
      const steerResult = await this.request("turn/steer", {
        threadId,
        expectedTurnId: activeTurnId,
        input
      });
      return { action: "steer-app-server", result: steerResult, turnId: extractAppServerTurnId(steerResult) || activeTurnId };
    }
    const startResult = await this.request("turn/start", {
      threadId,
      cwd,
      input,
      ...normalizeCodexPermissions(permissions)
    });
    return { action: "start-app-server", result: startResult, turnId: extractAppServerTurnId(startResult) };
  }

  async findActiveTurnId(threadId, thread = null) {
    const status = thread?.status;
    if (status?.type !== "active") {
      return null;
    }
    const turns = await this.request("thread/turns/list", {
      threadId,
      limit: 5,
      sortDirection: "desc",
      itemsView: "summary"
    });
    return (turns?.data || []).find((turn) => turn?.status === "inProgress")?.id || null;
  }

  request(method, params = {}, { timeoutMs = this.requestTimeoutMs } = {}) {
    if (this.socket == null) {
      throw new CodexAppServerError("Codex app-server client is not connected.", {
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

  send(message) {
    if (this.socket == null || this.socket.destroyed) {
      throw new CodexAppServerError("Codex app-server socket is closed.", { code: "socket-closed" });
    }
    this.socket.write(encodeWebSocketFrame(`${JSON.stringify(message)}\n`));
  }

  parseFrames() {
    while (this.buffer.length >= 2) {
      const frame = decodeWebSocketFrame(this.buffer);
      if (frame == null) {
        return;
      }
      this.buffer = this.buffer.subarray(frame.frameLength);
      if (frame.opcode === 0x1) {
        const text = frame.payload.toString("utf8").trim();
        if (text) {
          for (const line of text.split("\n")) {
            if (line.trim()) {
              this.handleMessageText(line.trim());
            }
          }
        }
      } else if (frame.opcode === 0x8) {
        this.disconnect();
        return;
      } else if (frame.opcode === 0x9) {
        this.socket?.write(encodeWebSocketFrame(frame.payload, { opcode: 0xA }));
      }
    }
  }

  handleMessageText(text) {
    let message;
    try {
      message = JSON.parse(text);
    } catch (error) {
      this.logger.warn?.(`Ignoring non-JSON Codex app-server WebSocket message: ${error.message}`);
      return;
    }
    if (message.method === "remoteControl/status/changed") {
      this.remoteControlStatus = message.params;
    }
    if (message.id == null) {
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

  handleSocketError(error) {
    this.logger.error?.(`Codex app-server socket error: ${error.message}`);
  }

  handleSocketClose() {
    this.socket = null;
    this.rejectPending("Codex app-server socket closed.", "socket-closed");
  }

  rejectPending(message, code) {
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new CodexAppServerError(message, { code, method: pending.method }));
    }
    this.pending.clear();
  }
}

export function extractAppServerTurnId(value) {
  if (value == null || typeof value !== "object") {
    return null;
  }
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

export async function isSocket(candidate) {
  try {
    return (await fs.stat(candidate)).isSocket();
  } catch {
    return false;
  }
}

export function encodeWebSocketFrame(textOrBuffer, { opcode = 0x1 } = {}) {
  const payload = Buffer.isBuffer(textOrBuffer) ? textOrBuffer : Buffer.from(String(textOrBuffer), "utf8");
  const mask = crypto.randomBytes(4);
  const header = [0x80 | opcode];
  if (payload.length < 126) {
    header.push(0x80 | payload.length);
  } else if (payload.length < 65536) {
    header.push(0x80 | 126, (payload.length >> 8) & 0xff, payload.length & 0xff);
  } else {
    const length = BigInt(payload.length);
    header.push(0x80 | 127);
    for (let shift = 56n; shift >= 0n; shift -= 8n) {
      header.push(Number((length >> shift) & 0xffn));
    }
  }
  const out = Buffer.concat([Buffer.from(header), mask, payload]);
  const payloadStart = out.length - payload.length;
  for (let i = 0; i < payload.length; i += 1) {
    out[payloadStart + i] ^= mask[i % 4];
  }
  return out;
}

export function decodeWebSocketFrame(buffer) {
  if (buffer.length < 2) {
    return null;
  }
  const first = buffer[0];
  const second = buffer[1];
  const opcode = first & 0x0f;
  let offset = 2;
  let length = second & 0x7f;
  if (length === 126) {
    if (buffer.length < offset + 2) return null;
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) return null;
    const bigLength = buffer.readBigUInt64BE(offset);
    if (bigLength > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new CodexAppServerError("Codex app-server WebSocket frame is too large.", { code: "frame-too-large" });
    }
    length = Number(bigLength);
    offset += 8;
  }
  const masked = Boolean(second & 0x80);
  const maskOffset = offset;
  if (masked) {
    offset += 4;
  }
  if (buffer.length < offset + length) {
    return null;
  }
  const payload = Buffer.from(buffer.subarray(offset, offset + length));
  if (masked) {
    const mask = buffer.subarray(maskOffset, maskOffset + 4);
    for (let i = 0; i < payload.length; i += 1) {
      payload[i] ^= mask[i % 4];
    }
  }
  return {
    opcode,
    payload,
    frameLength: offset + length
  };
}
