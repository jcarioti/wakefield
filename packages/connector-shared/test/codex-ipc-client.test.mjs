import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  FrameDecoder,
  createClientDiscoveryResponse,
  createTurnStartParams,
  createRestoreMessage,
  createTextInput,
  encodeFrame,
  normalizeCodexPermissions,
  methodVersion,
  resolveCodexIpcSocket
} from "../src/codex-ipc-client.mjs";

test("encodeFrame writes a four byte little-endian length prefix", () => {
  const message = { type: "request", requestId: "abc" };
  const frame = encodeFrame(message);
  const length = frame.readUInt32LE(0);
  assert.equal(length, frame.length - 4);
  assert.deepEqual(JSON.parse(frame.subarray(4).toString("utf8")), message);
});

test("FrameDecoder accepts split frames", () => {
  const decoder = new FrameDecoder();
  const first = encodeFrame({ one: true });
  const second = encodeFrame({ two: true });
  const combined = Buffer.concat([first, second]);

  assert.deepEqual(decoder.push(combined.subarray(0, 3)), []);
  assert.deepEqual(decoder.push(combined.subarray(3, first.length + 2)), [{ one: true }]);
  assert.deepEqual(decoder.push(combined.subarray(first.length + 2)), [{ two: true }]);
});

test("createRestoreMessage matches the renderer steering shape", () => {
  const message = createRestoreMessage({
    id: "restore-1",
    text: "hello",
    cwd: "/tmp/project",
    createdAt: 123
  });

  assert.equal(message.id, "restore-1");
  assert.equal(message.cwd, "/tmp/project");
  assert.equal(message.text, "hello");
  assert.equal(message.createdAt, 123);
  assert.equal(message.context.prompt, "hello");
  assert.deepEqual(message.context.workspaceRoots, ["/tmp/project"]);
  assert.deepEqual(createTextInput("hello"), [{ type: "text", text: "hello", text_elements: [] }]);
});

test("client discovery response matches the ChatGPT/Codex envelope", () => {
  assert.deepEqual(createClientDiscoveryResponse({ requestId: "request-1" }), {
    type: "client-discovery-response",
    requestId: "request-1",
    response: { canHandle: false }
  });
});

test("full-access target permissions become Codex turn settings", () => {
  assert.deepEqual(normalizeCodexPermissions({ mode: "full-access" }), {
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  });

  assert.deepEqual(createTurnStartParams({
    cwd: "/tmp/project",
    input: createTextInput("hello"),
    permissions: { mode: "full-access" }
  }), {
    cwd: "/tmp/project",
    input: [{ type: "text", text: "hello", text_elements: [] }],
    approvalPolicy: "never",
    approvalsReviewer: "user",
    sandboxPolicy: { type: "dangerFullAccess" }
  });
});

test("thread follower methods use app IPC protocol version 1", () => {
  assert.equal(methodVersion("thread-follower-start-turn"), 1);
  assert.equal(methodVersion("thread-follower-steer-turn"), 1);
  assert.equal(methodVersion("thread-follower-submit-user-input"), 1);
});

test("thread follower interrupt uses app IPC protocol version 2", () => {
  assert.equal(methodVersion("thread-follower-interrupt-turn"), 2);
  assert.equal(methodVersion("initialize"), 0);
});

test("current ChatGPT IPC socket takes precedence over a stale legacy socket", async (t) => {
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

function listen(server, socketPath) {
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
}

function close(server) {
  return new Promise((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
}
