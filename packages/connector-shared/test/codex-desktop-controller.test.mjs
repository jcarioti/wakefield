import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  CodexDesktopController,
  controlSocketWebSocketUrl,
  probeCodexDesktopController
} from "../src/codex-desktop-controller.mjs";

test("desktop controller uses the daemon ws+unix protocol and experimental API", async () => {
  await withControlSocket(async (socketPath) => {
    const calls = [];
    let opened = null;
    const controller = fakeController(socketPath, {
      onOpen(url, options) { opened = { url, options }; },
      onRequest(message, socket) {
        calls.push(message);
        respondToHandshake(message, socket);
      }
    });

    await controller.connect();

    assert.equal(opened.url, controlSocketWebSocketUrl(socketPath));
    assert.deepEqual(opened.options, { perMessageDeflate: false });
    assert.deepEqual(calls.map((call) => call.method), [
      "initialize",
      "initialized",
      "remoteControl/status/read"
    ]);
    assert.deepEqual(calls[0].params.capabilities, { experimentalApi: true });
    assert.equal(controller.remoteControlStatus.status, "connected");
    controller.disconnect();
  });
});

test("desktop controller accepts a matching managed daemon after a compatible runtime update", async () => {
  await withControlSocket(async (socketPath) => {
    const version = "0.147.0-alpha.1.2";
    const controller = fakeController(socketPath, {
      daemonInfo: daemonInfo(socketPath, {
        managedCodexVersion: version,
        cliVersion: version,
        appServerVersion: version
      }),
      onRequest(message, socket) {
        respondToHandshake(message, socket, { version });
      }
    });

    await controller.connect();
    assert.equal(controller.daemonInfo.appServerVersion, version);
    controller.disconnect();
  });
});

test("desktop controller recovers a stale control socket by starting the managed daemon", async () => {
  await withControlSocket(async (socketPath) => {
    const version = "0.147.0-alpha.1.2";
    let started = false;
    const calls = [];
    const controller = new CodexDesktopController({
      socketPath,
      codexPath: "/tmp/codex",
      startupTimeoutMs: 500,
      execFileImpl: async (_command, args) => {
        calls.push(args);
        if (args[2] === "start") {
          started = true;
          return { stdout: "", stderr: "" };
        }
        if (!started) throw new Error("Connection refused");
        return {
          stdout: JSON.stringify(daemonInfo(socketPath, {
            managedCodexVersion: version,
            cliVersion: version,
            appServerVersion: version
          })),
          stderr: ""
        };
      },
      webSocketFactory: () => new FakeWebSocket((message, socket) => respondToHandshake(message, socket, { version })),
      logger: quietLogger()
    });

    await controller.connect();
    assert.deepEqual(calls, [
      ["app-server", "daemon", "version"],
      ["app-server", "daemon", "start"],
      ["app-server", "daemon", "version"]
    ]);
    controller.disconnect();
  });
});

test("desktop controller creates a persistent task and starts its first turn", async () => {
  await withControlSocket(async (socketPath) => {
    const calls = [];
    const cwd = path.dirname(socketPath);
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "thread/start") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "idle" } }
          });
        } else if (message.method === "thread/resume") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "idle" } }
          });
        } else if (message.method === "turn/start") {
          respond(socket, message, { turn: { id: "turn-1" } });
        } else {
          throw new Error(`Unexpected method ${message.method}`);
        }
      }
    });

    const task = await controller.createTask({
      cwd,
      permissions: { mode: "full-access" }
    });
    const turn = await controller.startTurn({
      threadId: task.thread.id,
      cwd,
      text: "hello",
      permissions: { mode: "full-access" }
    });

    assert.equal(task.thread.ephemeral, false);
    assert.equal(turn.turn.id, "turn-1");
    const threadStart = calls.find((call) => call.method === "thread/start");
    assert.deepEqual(threadStart.params, {
      cwd,
      ephemeral: false,
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: "danger-full-access"
    });
    const turnStart = calls.find((call) => call.method === "turn/start");
    assert.deepEqual(turnStart.params, {
      threadId: "thread-1",
      cwd,
      input: [{ type: "text", text: "hello", text_elements: [] }],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    });
    controller.disconnect();
  });
});

test("desktop controller defers inbound text while a Desktop turn is active so the eventual message is visible", async () => {
  await withControlSocket(async (socketPath) => {
    const cwd = path.dirname(socketPath);
    const calls = [];
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "thread/resume") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "active" } }
          });
        }
      }
    });

    await assert.rejects(
      controller.routeTextToThread({
        threadId: "thread-1",
        cwd,
        text: "follow up"
      }),
      (error) => {
        assert.equal(error.code, "active-turn-pending");
        return true;
      }
    );
    assert.equal(calls.some((call) => call.method === "turn/steer"), false);
    controller.disconnect();
  });
});

test("desktop controller can explicitly steer an active human connector turn", async () => {
  await withControlSocket(async (socketPath) => {
    const cwd = path.dirname(socketPath);
    const calls = [];
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "thread/resume") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "active" } }
          });
        } else if (message.method === "thread/turns/list") {
          respond(socket, message, { data: [{ id: "turn-active", status: "inProgress" }] });
        } else if (message.method === "thread/settings/update") {
          respond(socket, message, {});
        } else if (message.method === "turn/steer") {
          respond(socket, message, { turnId: "turn-active" });
        }
      }
    });

    const result = await controller.routeTextToThread({
      threadId: "thread-1",
      cwd,
      text: "Are you there?",
      serviceTier: "priority",
      activeTurnPolicy: "steer"
    });
    assert.equal(result.action, "steer-desktop");
    assert.equal(result.turnId, "turn-active");
    assert.deepEqual(calls.find((call) => call.method === "thread/settings/update")?.params, {
      threadId: "thread-1",
      serviceTier: "priority"
    });
    assert.deepEqual(calls.find((call) => call.method === "turn/steer")?.params, {
      threadId: "thread-1",
      expectedTurnId: "turn-active",
      input: [{ type: "text", text: "Are you there?", text_elements: [] }]
    });
    controller.disconnect();
  });
});

test("desktop controller starts a normal Desktop turn for inbound text when the task is idle", async () => {
  await withControlSocket(async (socketPath) => {
    const cwd = path.dirname(socketPath);
    const calls = [];
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "thread/resume") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "idle" } }
          });
        } else if (message.method === "turn/start") {
          respond(socket, message, { turn: { id: "turn-visible" } });
        }
      }
    });

    const result = await controller.routeTextToThread({
      threadId: "thread-1",
      cwd,
      text: "follow up"
    });

    assert.equal(result.action, "start-desktop");
    assert.equal(result.turnId, "turn-visible");
    assert.deepEqual(calls.find((call) => call.method === "turn/start").params, {
      threadId: "thread-1",
      cwd,
      input: [{ type: "text", text: "follow up", text_elements: [] }]
    });
    controller.disconnect();
  });
});

test("desktop controller starts Fast turns and can restore the Standard tier", async () => {
  await withControlSocket(async (socketPath) => {
    const cwd = path.dirname(socketPath);
    const calls = [];
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "thread/resume") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "idle" } }
          });
        } else if (message.method === "turn/start") {
          respond(socket, message, { turn: { id: "turn-fast" } });
        } else if (message.method === "thread/settings/update") {
          respond(socket, message, { thread: { id: "thread-1", serviceTier: null } });
        }
      }
    });

    const result = await controller.routeTextToThread({
      threadId: "thread-1",
      cwd,
      text: "reply quickly",
      serviceTier: "priority"
    });
    await controller.setThreadServiceTier({ threadId: "thread-1", serviceTier: null });

    assert.equal(result.serviceTier, "priority");
    assert.equal(calls.find((call) => call.method === "turn/start").params.serviceTier, "priority");
    assert.deepEqual(calls.find((call) => call.method === "thread/settings/update").params, {
      threadId: "thread-1",
      serviceTier: null
    });
    controller.disconnect();
  });
});

test("desktop controller can identify the newest active turn when Desktop retains stale interrupted turns", async () => {
  await withControlSocket(async (socketPath) => {
    const cwd = path.dirname(socketPath);
    const calls = [];
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "thread/resume") {
          respond(socket, message, {
            thread: { id: "thread-1", cwd, ephemeral: false, status: { type: "active" } }
          });
        } else if (message.method === "thread/turns/list") {
          respond(socket, message, {
            data: [
              { id: "turn-current", status: "inProgress" },
              { id: "turn-stale-1", status: "inProgress" },
              { id: "turn-completed", status: "completed" }
            ]
          });
        }
      }
    });

    const attached = await controller.attachTask({ threadId: "thread-1", cwd });
    assert.equal(await controller.findActiveTurnId("thread-1", attached.thread), "turn-current");
    controller.disconnect();
  });
});

test("desktop controller reloads and verifies the complete live MCP inventory", async () => {
  await withControlSocket(async (socketPath) => {
    const calls = [];
    let listCount = 0;
    const controller = fakeController(socketPath, {
      onRequest(message, socket) {
        calls.push(message);
        if (respondToHandshake(message, socket)) return;
        if (message.method === "mcpServerStatus/list") {
          listCount += 1;
          if (message.params.cursor == null) {
            respond(socket, message, {
              data: [{ name: "wakefield-memory", tools: { recall: {} } }],
              nextCursor: "page-2"
            });
          } else {
            respond(socket, message, {
              data: [{ name: "discord-codex", tools: { reply: {} } }],
              nextCursor: null
            });
          }
        } else if (message.method === "config/mcpServer/reload") {
          socket.emit("message", JSON.stringify({
            method: "mcpServer/startupStatus/updated",
            params: { serverName: "wakefield-memory", status: "ready" }
          }));
          respond(socket, message, {});
        }
      }
    });

    const result = await controller.reloadMcpServers({
      threadId: "thread-1",
      timeoutMs: 1000,
      pollMs: 1
    });

    assert.equal(result.transport, "desktop-daemon");
    assert.equal(result.before.data.length, 2);
    assert.equal(result.after.data.length, 2);
    assert.equal(listCount, 4);
    assert.deepEqual(result.events, [{ serverName: "wakefield-memory", status: "ready" }]);
    assert.ok(calls
      .filter((call) => call.method === "mcpServerStatus/list")
      .every((call) => !("threadId" in call.params)));
    controller.disconnect();
  });
});

test("desktop controller fails closed when daemon ownership does not match", async () => {
  await withControlSocket(async (socketPath) => {
    const controller = fakeController(socketPath, {
      daemonInfo: daemonInfo(socketPath, {
        managedCodexVersion: "0.147.0-alpha.1.2",
        cliVersion: "0.147.0-alpha.1.2",
        appServerVersion: "0.145.0"
      }),
      onRequest() { throw new Error("WebSocket should not open"); }
    });
    await assert.rejects(controller.connect(), (error) => {
      assert.equal(error.code, "daemon-ownership-mismatch");
      return true;
    });
  });
});

test("desktop controller probe keeps socket, protocol, attachment, and MCP health distinct", async () => {
  await withControlSocket(async (socketPath) => {
    const report = await probeCodexDesktopController({
      socketPath,
      controllerFactory: () => fakeController(socketPath, {
        onRequest(message, socket) {
          if (respondToHandshake(message, socket)) return;
          if (message.method === "mcpServerStatus/list") {
            respond(socket, message, { data: [{ name: "wakefield-memory", tools: {} }], nextCursor: null });
          }
        }
      })
    });
    assert.equal(report.ok, true);
    assert.equal(report.socket.ok, true);
    assert.equal(report.daemon.ok, true);
    assert.equal(report.protocol.ok, true);
    assert.equal(report.remote.ok, true);
    assert.equal(report.mcp.count, 1);
  });
});

function fakeController(socketPath, {
  daemonInfo: identity = daemonInfo(socketPath),
  onOpen = null,
  onRequest
} = {}) {
  return new CodexDesktopController({
    socketPath,
    ensureDaemon: false,
    requireRemoteControlConnected: true,
    requireDesktopOwnership: true,
    requestTimeoutMs: 1000,
    execFileImpl: async (_command, args) => {
      assert.deepEqual(args, ["app-server", "daemon", "version"]);
      return { stdout: JSON.stringify(identity), stderr: "" };
    },
    webSocketFactory: (url, options) => {
      onOpen?.(url, options);
      return new FakeWebSocket((message, socket) => onRequest(message, socket));
    },
    logger: quietLogger()
  });
}

function respondToHandshake(message, socket, { version = "0.146.0-alpha.9.2" } = {}) {
  if (message.method === "initialize") {
    respond(socket, message, {
      userAgent: `Codex Desktop/${version} (Mac OS 26.5; arm64)`,
      codexHome: "/tmp/codex",
      platformFamily: "unix",
      platformOs: "macos"
    });
    return true;
  }
  if (message.method === "initialized") return true;
  if (message.method === "remoteControl/status/read") {
    respond(socket, message, {
      status: "connected",
      serverName: "test.local",
      installationId: "install-1",
      environmentId: "env-1"
    });
    return true;
  }
  return false;
}

function daemonInfo(socketPath, overrides = {}) {
  const version = overrides.appServerVersion || "0.146.0-alpha.9.2";
  return {
    status: "running",
    backend: "pid",
    managedCodexPath: "/tmp/codex",
    managedCodexVersion: version,
    socketPath,
    cliVersion: version,
    appServerVersion: version,
    ...overrides
  };
}

class FakeWebSocket extends EventEmitter {
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
    this.onSend(JSON.parse(text), this);
  }

  close() {
    this.readyState = 3;
    this.emit("close");
  }
}

function respond(socket, request, result) {
  socket.emit("message", JSON.stringify({ id: request.id, result }));
}

async function withControlSocket(run) {
  const tmp = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-controller-test-"));
  const socketPath = path.join(tmp, "control.sock");
  const server = net.createServer();
  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    return await run(socketPath);
  } finally {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(tmp, { recursive: true, force: true });
  }
}

function quietLogger() {
  return { info() {}, warn() {}, error() {} };
}
