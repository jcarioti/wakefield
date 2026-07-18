import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { resolveCodexCli } from "../src/codex-app.mjs";
import { codexDreamerConfig } from "../src/codex-dreamer.mjs";
import {
  createClientDiscoveryResponse,
  CodexIpcClient,
  encodeFrame,
  FrameDecoder,
  resolveCodexIpcSocket
} from "../src/codex-ipc.mjs";
import {
  codexRuntimeProbeExitCode,
  probeCodexRuntime
} from "../src/codex-runtime-probe.mjs";

const CHATGPT_CODEX_PATH = "/Applications/ChatGPT.app/Contents/Resources/codex";

test("runtime probe performs only the initialize handshake", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-runtime-probe-"));
  const socketPath = path.join(root, "ipc.sock");
  const sessionsPath = path.join(root, "sessions");
  await fs.mkdir(sessionsPath);
  const requests = [];
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) {
        requests.push(request);
        socket.write(encodeFrame({
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          result: { clientId: "probe-client" }
        }));
      }
    });
  });
  await listen(server, socketPath);
  t.after(async () => {
    await close(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await probeCodexRuntime({ socketPath, sessionsPath });

  assert.equal(result.status, "compatible");
  assert.equal(result.reason, "initialize-succeeded");
  assert.equal(result.scope, "socket-and-initialize-only");
  assert.equal(result.followerProtocolTested, false);
  assert.equal(result.socketPath, socketPath);
  assert.equal(result.sessionsReadable, true);
  assert.deepEqual(requests.map(({ method, version }) => ({ method, version })), [
    { method: "initialize", version: 0 }
  ]);
  assert.equal(codexRuntimeProbeExitCode(result.status), 0);
});

test("runtime probe distinguishes unavailable and incompatible sockets", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-runtime-probe-"));
  t.after(() => fs.rm(root, { recursive: true, force: true }));

  const unavailable = await probeCodexRuntime({
    socketPath: path.join(root, "missing.sock"),
    sessionsPath: path.join(root, "missing-sessions"),
    connectTimeoutMs: 50,
    requestTimeoutMs: 50
  });
  assert.equal(unavailable.status, "unavailable");
  assert.equal(unavailable.reason, "ENOENT");
  assert.equal(codexRuntimeProbeExitCode(unavailable.status), 3);

  const incompatible = await probeCodexRuntime({
    socketPath: "/restricted/ipc.sock",
    sessionsPath: "/restricted/sessions",
    clientFactory(options) {
      return {
        socketPath: options.socketPath,
        async connect() {
          const error = new Error("Permission denied");
          error.code = "connect-failed";
          error.details = { code: "EACCES" };
          throw error;
        },
        disconnect() {}
      };
    }
  });
  assert.equal(incompatible.status, "incompatible");
  assert.equal(incompatible.reason, "EACCES");
  assert.equal(incompatible.error.causeCode, "EACCES");
  assert.equal(codexRuntimeProbeExitCode(incompatible.status), 2);
});

test("runtime probe rejects a reachable socket with an incompatible handshake", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-runtime-probe-"));
  const socketPath = path.join(root, "ipc.sock");
  const server = net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) {
        socket.write(encodeFrame({
          type: "response",
          requestId: request.requestId,
          resultType: "error",
          error: { code: "protocol-mismatch", message: "Unsupported initialize protocol." }
        }));
      }
    });
  });
  await listen(server, socketPath);
  t.after(async () => {
    await close(server);
    await fs.rm(root, { recursive: true, force: true });
  });

  const result = await probeCodexRuntime({
    socketPath,
    sessionsPath: path.join(root, "missing-sessions"),
    requestTimeoutMs: 100
  });

  assert.equal(result.status, "incompatible");
  assert.equal(result.reason, "protocol-mismatch");
  assert.equal(codexRuntimeProbeExitCode(result.status), 2);
});

test("client discovery response matches the ChatGPT/Codex envelope", () => {
  assert.deepEqual(createClientDiscoveryResponse({ requestId: "request-1" }), {
    type: "client-discovery-response",
    requestId: "request-1",
    response: { canHandle: false }
  });
});

test("generic IPC routing prefers the current ChatGPT socket over legacy discovery", async (t) => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-current-ipc-"));
  const codexHome = path.join(root, ".codex");
  const currentSocket = path.join(codexHome, "ipc", "ipc.sock");
  const legacySocket = path.join(root, "tmp", "codex-ipc", "ipc-501.sock");
  await fs.mkdir(path.dirname(currentSocket), { recursive: true });
  await fs.mkdir(path.dirname(legacySocket), { recursive: true });
  const currentServer = net.createServer();
  const legacyServer = net.createServer();
  await listen(currentServer, currentSocket);
  await listen(legacyServer, legacySocket);
  t.after(async () => {
    await close(currentServer);
    await close(legacyServer);
    await fs.rm(root, { recursive: true, force: true });
  });

  const resolved = await resolveCodexIpcSocket({
    codexHome,
    tmpdir: path.join(root, "tmp"),
    env: {}
  });

  assert.equal(resolved, currentSocket);
});

test("IPC client falls back to a responsive legacy socket when the current socket is stale", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfif-"));
  const codexHome = path.join(root, ".codex");
  const currentSocket = path.join(codexHome, "ipc", "ipc.sock");
  const legacySocket = path.join(root, "tmp", "codex-ipc", "ipc-501.sock");
  await fs.mkdir(path.dirname(currentSocket), { recursive: true });
  await fs.mkdir(path.dirname(legacySocket), { recursive: true });
  const currentServer = trackConnections(net.createServer((socket) => {
    socket.once("data", () => socket.destroy());
  }));
  const legacyServer = initializeServer();
  await listen(currentServer, currentSocket);
  await listen(legacyServer, legacySocket);

  const client = new CodexIpcClient({
    connectTimeoutMs: 100,
    requestTimeoutMs: 100,
    logger: { error() {} },
    socketDiscovery: { codexHome, tmpdir: path.join(root, "tmp"), env: {} }
  });
  try {
    await client.connect();
    assert.equal(client.socketPath, legacySocket);
  } finally {
    client.disconnect();
    await close(currentServer);
    await close(legacyServer);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("IPC client rediscovers a replacement socket after its prior connection closes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wfir-"));
  const codexHome = path.join(root, ".codex");
  const currentSocket = path.join(codexHome, "ipc", "ipc.sock");
  const legacySocket = path.join(root, "tmp", "codex-ipc", "ipc-501.sock");
  await fs.mkdir(path.dirname(currentSocket), { recursive: true });
  await fs.mkdir(path.dirname(legacySocket), { recursive: true });
  const currentServer = initializeServer();
  await listen(currentServer, currentSocket);
  let legacyServer = null;
  const client = new CodexIpcClient({
    connectTimeoutMs: 100,
    requestTimeoutMs: 100,
    logger: { error() {} },
    socketDiscovery: { codexHome, tmpdir: path.join(root, "tmp"), env: {} }
  });
  try {
    await client.connect();
    assert.equal(client.socketPath, currentSocket);
    client.disconnect();
    await close(currentServer);
    legacyServer = initializeServer();
    await listen(legacyServer, legacySocket);

    await client.connect();
    assert.equal(client.socketPath, legacySocket);
  } finally {
    client.disconnect();
    await close(currentServer);
    if (legacyServer) await close(legacyServer);
    await fs.rm(root, { recursive: true, force: true });
  }
});

test("Codex executable discovery prefers the ChatGPT app bundle", async () => {
  const checked = [];
  const resolved = await resolveCodexCli(null, {
    env: {},
    access: async (candidate) => {
      checked.push(candidate);
      if (candidate !== CHATGPT_CODEX_PATH) {
        const error = new Error("missing");
        error.code = "ENOENT";
        throw error;
      }
    }
  });

  assert.equal(resolved, CHATGPT_CODEX_PATH);
  assert.deepEqual(checked, [CHATGPT_CODEX_PATH]);
  assert.equal(codexDreamerConfig({}, {
    exists: (candidate) => candidate === CHATGPT_CODEX_PATH
  }).codexPath, CHATGPT_CODEX_PATH);
});

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    for (const socket of server.wakefieldConnections || []) socket.destroy();
    server.closeAllConnections?.();
    server.close((error) => error && error.code !== "ERR_SERVER_NOT_RUNNING" ? reject(error) : resolve());
  });
}

function initializeServer() {
  return trackConnections(net.createServer((socket) => {
    const decoder = new FrameDecoder();
    socket.on("data", (chunk) => {
      for (const request of decoder.push(chunk)) {
        socket.write(encodeFrame({
          type: "response",
          requestId: request.requestId,
          resultType: "success",
          result: { clientId: "test-client" }
        }));
      }
    });
  }));
}

function trackConnections(server) {
  const connections = new Set();
  server.on("connection", (socket) => {
    connections.add(socket);
    socket.once("close", () => connections.delete(socket));
  });
  server.wakefieldConnections = connections;
  return server;
}
