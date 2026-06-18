import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";
import { CodexRemoteControlAppServerClient } from "../src/codex-remote-control-app-server-client.mjs";

test("app-server turn start carries full-access target permissions", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.connect = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") {
      return { thread: { status: { type: "idle" } } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const result = await client.routeTextToThread({
    threadId: "thread-1",
    cwd: "/tmp/project",
    text: "hello",
    permissions: { mode: "full-access" }
  });

  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(calls.at(-1), {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  });
});

test("remote-control app-server MCP reload reassembles chunked status", async () => {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-remote-control-test-"));
  const fakeToken = fakeJwt({
    "https://api.openai.com/auth": {
      chatgpt_account_id: "account-1",
      chatgpt_account_user_id: "account-user-1"
    }
  });
  await fs.writeFile(path.join(tmp, "auth.json"), JSON.stringify({
    tokens: {
      access_token: fakeToken,
      account_id: "account-1"
    }
  }));
  const calls = [];
  let socket = null;
  const client = new CodexRemoteControlAppServerClient({
    codexHome: tmp,
    environmentId: "env-live",
    verifyEnvironment: false,
    requestTimeoutMs: 1000,
    webSocketFactory: () => {
      socket = new FakeRemoteControlSocket((envelope) => {
        calls.push(envelope.message.method);
        respondToRemoteControlEnvelope(socket, envelope);
      });
      return socket;
    },
    logger: quietLogger()
  });

  const result = await client.reloadMcpServers({ timeoutMs: 1000, pollMs: 1 });

  assert.deepEqual(calls, [
    "initialize",
    "initialized",
    "remoteControl/status/read",
    "mcpServerStatus/list",
    "config/mcpServer/reload",
    "mcpServerStatus/list"
  ]);
  assert.equal(result.transport, "remote-control");
  assert.deepEqual(result.events, [{ serverName: "wakefield-memory" }]);
  assert.deepEqual(result.after, { servers: [{ name: "wakefield-memory", status: "running" }] });
});

class FakeRemoteControlSocket extends EventEmitter {
  readyState = 0;

  constructor(onSend) {
    super();
    this.onSend = onSend;
    setImmediate(() => {
      this.readyState = 1;
      this.emit("open");
    });
  }

  send(text) {
    this.onSend(JSON.parse(text));
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function respondToRemoteControlEnvelope(socket, envelope) {
  const { message } = envelope;
  if (message.method === "initialized") {
    return;
  }
  if (message.method === "initialize") {
    emitServerMessage(socket, envelope, {
      id: message.id,
      result: {
        userAgent: "Codex Desktop/test",
        codexHome: "/tmp/codex"
      }
    });
    return;
  }
  if (message.method === "remoteControl/status/read") {
    emitServerMessage(socket, envelope, {
      id: message.id,
      result: {
        status: "connected",
        serverName: "test-host"
      }
    });
    return;
  }
  if (message.method === "config/mcpServer/reload") {
    emitServerMessage(socket, envelope, {
      method: "mcpServer/startupStatus/updated",
      params: {
        serverName: "wakefield-memory"
      }
    });
    emitServerMessage(socket, envelope, {
      id: message.id,
      result: {}
    });
    return;
  }
  if (message.method === "mcpServerStatus/list") {
    emitChunkedServerMessage(socket, envelope, {
      id: message.id,
      result: {
        servers: [{ name: "wakefield-memory", status: "running" }]
      }
    });
    return;
  }
  throw new Error(`Unexpected remote-control method ${message.method}`);
}

function emitServerMessage(socket, envelope, message) {
  socket.emit("message", JSON.stringify({
    type: "server_message",
    client_id: envelope.client_id,
    stream_id: envelope.stream_id,
    env_id: envelope.env_id,
    seq_id: envelope.seq_id,
    message
  }));
}

function emitChunkedServerMessage(socket, envelope, message) {
  const payload = Buffer.from(JSON.stringify(message), "utf8");
  const split = Math.ceil(payload.length / 2);
  const chunks = [payload.subarray(0, split), payload.subarray(split)];
  chunks.forEach((chunk, index) => {
    socket.emit("message", JSON.stringify({
      type: "server_message_chunk",
      client_id: envelope.client_id,
      stream_id: envelope.stream_id,
      env_id: envelope.env_id,
      seq_id: envelope.seq_id,
      segment_id: index,
      segment_count: chunks.length,
      message_size_bytes: payload.length,
      message_chunk_base64: chunk.toString("base64")
    }));
  });
}

function fakeJwt(payload) {
  return [
    Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url"),
    Buffer.from(JSON.stringify(payload)).toString("base64url"),
    "signature"
  ].join(".");
}

function quietLogger() {
  return {
    warn() {},
    error() {}
  };
}
