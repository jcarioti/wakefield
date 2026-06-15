import assert from "node:assert/strict";
import test from "node:test";
import {
  codexThreadDeepLink,
  extractTurnId,
  isActiveTurnError,
  isInactiveTurnError,
  isMissingFollowerClientError,
  sendTextToCodexTarget
} from "../src/codex-router.mjs";

const target = {
  id: "rick",
  threadId: "thread-1",
  cwd: "/tmp/project"
};

test("auto route steers an active follower run first", async () => {
  const calls = [];
  const client = {
    async steerThreadFollowerTurn(params) {
      calls.push(["steer", params]);
      return { turnId: "turn-1" };
    },
    async startThreadFollowerTurn(params) {
      calls.push(["start", params]);
      return { turnId: "turn-2" };
    }
  };

  const result = await sendTextToCodexTarget({ client, target, text: "hello", useLock: false });
  assert.equal(result.action, "steer");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.threadId, "thread-1");
  assert.deepEqual(calls.map(([name]) => name), ["steer"]);
  assert.equal(calls[0][1].conversationId, "thread-1");
  assert.equal(calls[0][1].cwd, "/tmp/project");
  assert.equal(calls[0][1].text, "hello");
});

test("auto route does not wake Codex when follower IPC is already available", async () => {
  const client = {
    async steerThreadFollowerTurn() {
      return { turnId: "turn-1" };
    },
    async startThreadFollowerTurn() {
      throw new Error("unexpected start");
    }
  };

  const result = await sendTextToCodexTarget({
    client,
    target,
    text: "hello",
    useLock: false,
    wakeThread() {
      throw new Error("unexpected wake");
    }
  });

  assert.equal(result.action, "steer");
});

test("follower-auto route steers an active run first", async () => {
  const calls = [];
  const client = {
    async steerThreadFollowerTurn(params) {
      calls.push(["steer", params]);
      return { turnId: "turn-1" };
    },
    async startThreadFollowerTurn(params) {
      calls.push(["start", params]);
      return { turnId: "turn-2" };
    }
  };

  const result = await sendTextToCodexTarget({ client, target, text: "hello", mode: "follower-auto", useLock: false });
  assert.equal(result.action, "steer");
  assert.equal(result.turnId, "turn-1");
  assert.equal(result.threadId, "thread-1");
  assert.deepEqual(calls.map(([name]) => name), ["steer"]);
  assert.equal(calls[0][1].conversationId, "thread-1");
  assert.equal(calls[0][1].cwd, "/tmp/project");
  assert.equal(calls[0][1].text, "hello");
});

test("follower-auto route starts when no run is active", async () => {
  const calls = [];
  const client = {
    async steerThreadFollowerTurn() {
      calls.push("steer");
      throw new Error("No active turn for conversation");
    },
    async startThreadFollowerTurn(params) {
      calls.push(["start", params]);
      return { turnId: "turn-2" };
    }
  };

  const result = await sendTextToCodexTarget({
    client,
    target: { ...target, codexPermissions: { mode: "full-access" } },
    text: "hello",
    mode: "follower-auto",
    useLock: false
  });
  assert.equal(result.action, "start");
  assert.deepEqual(calls, [
    "steer",
    ["start", {
      conversationId: "thread-1",
      cwd: "/tmp/project",
      permissions: { mode: "full-access" },
      text: "hello"
    }]
  ]);
});

test("follower-auto route retries steering if start loses a race to another active run", async () => {
  const calls = [];
  const client = {
    async steerThreadFollowerTurn() {
      calls.push("steer");
      if (calls.length === 1) {
        throw new Error("No active turn for conversation");
      }
      return { turnId: "turn-3" };
    },
    async startThreadFollowerTurn() {
      calls.push("start");
      throw new Error("thread already has an active turn");
    }
  };

  const result = await sendTextToCodexTarget({ client, target, text: "hello", mode: "follower-auto", useLock: false });
  assert.equal(result.action, "steer");
  assert.deepEqual(calls, ["steer", "start", "steer"]);
});

test("app-server and remote-control modes use Codex remote control app-server", async () => {
  for (const mode of ["app-server", "remote-control"]) {
    const calls = [];
    const appServerClient = {
      async routeTextToThread(params) {
        calls.push([mode, params]);
        return { action: "start-app-server", turnId: `turn-${mode}` };
      }
    };

    const result = await sendTextToCodexTarget({
      appServerClient,
      target: { ...target, codexPermissions: { mode: "full-access" } },
      text: "hello",
      mode,
      useLock: false
    });
    assert.equal(result.action, "start-app-server");
    assert.equal(result.turnId, `turn-${mode}`);
    assert.deepEqual(calls, [
      [mode, {
        threadId: "thread-1",
        cwd: "/tmp/project",
        permissions: { mode: "full-access" },
        text: "hello"
      }]
    ]);
  }
});

test("auto route wakes the Codex thread once after no-client-found and retries follower IPC", async () => {
  const calls = [];
  const wakeCalls = [];
  const client = {
    async steerThreadFollowerTurn() {
      calls.push("steer");
      if (calls.length === 1) {
        throw new Error("no-client-found");
      }
      throw new Error("No active turn for conversation");
    },
    async startThreadFollowerTurn() {
      calls.push("start");
      return { turnId: "turn-after-wake" };
    }
  };

  const result = await sendTextToCodexTarget({
    client,
    target,
    text: "hello",
    codex: { deepLinkWake: { enabled: true, waitMs: 0 } },
    logger: null,
    useLock: false,
    wakeThread(params) {
      wakeCalls.push(params);
    }
  });

  assert.equal(result.action, "start");
  assert.equal(result.turnId, "turn-after-wake");
  assert.deepEqual(calls, ["steer", "steer", "start"]);
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].url, codexThreadDeepLink("thread-1"));
});

test("auto route treats a missing Codex app IPC socket as wakeable and polls until the follower registers", async () => {
  const calls = [];
  const wakeCalls = [];
  const client = {
    async steerThreadFollowerTurn() {
      calls.push("steer");
      if (calls.length < 3) {
        throw new Error("No Codex app IPC socket found under /tmp/codex-ipc. Start the Codex app and open the target thread.");
      }
      throw new Error("No active turn for conversation");
    },
    async startThreadFollowerTurn() {
      calls.push("start");
      return { turnId: "turn-after-cold-start" };
    }
  };

  const result = await sendTextToCodexTarget({
    client,
    target,
    text: "hello",
    codex: { deepLinkWake: { enabled: true, waitMs: 50, pollMs: 1 } },
    logger: null,
    useLock: false,
    wakeThread(params) {
      wakeCalls.push(params);
    }
  });

  assert.equal(result.action, "start");
  assert.equal(result.turnId, "turn-after-cold-start");
  assert.deepEqual(calls, ["steer", "steer", "steer", "start"]);
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].url, codexThreadDeepLink("thread-1"));
  assert.equal(wakeCalls[0].pollMs, 1);
});

test("auto route treats a follower steer IPC timeout as wakeable", async () => {
  const calls = [];
  const wakeCalls = [];
  let disconnects = 0;
  const client = {
    async steerThreadFollowerTurn() {
      calls.push("steer");
      if (calls.length === 1) {
        const error = new Error("Timed out waiting for Codex IPC method thread-follower-steer-turn.");
        error.code = "request-timeout";
        error.method = "thread-follower-steer-turn";
        throw error;
      }
      throw new Error("No active turn for conversation");
    },
    async startThreadFollowerTurn() {
      calls.push("start");
      return { turnId: "turn-after-timeout-wake" };
    },
    disconnect() {
      disconnects += 1;
    }
  };

  const result = await sendTextToCodexTarget({
    client,
    target,
    text: "hello",
    codex: { deepLinkWake: { enabled: true, waitMs: 0 } },
    logger: null,
    useLock: false,
    wakeThread(params) {
      wakeCalls.push(params);
    }
  });

  assert.equal(result.action, "start");
  assert.equal(result.turnId, "turn-after-timeout-wake");
  assert.deepEqual(calls, ["steer", "steer", "start"]);
  assert.equal(wakeCalls.length, 1);
  assert.equal(wakeCalls[0].url, codexThreadDeepLink("thread-1"));
  assert.equal(disconnects, 1);
});

test("auto route re-opens the deep link while polling after a cold Codex launch", async () => {
  const calls = [];
  const wakeCalls = [];
  const client = {
    async steerThreadFollowerTurn() {
      calls.push("steer");
      if (calls.length < 5) {
        throw new Error("no-client-found");
      }
      throw new Error("No active turn for conversation");
    },
    async startThreadFollowerTurn() {
      calls.push("start");
      return { turnId: "turn-after-reopen" };
    }
  };

  const result = await sendTextToCodexTarget({
    client,
    target,
    text: "hello",
    codex: { deepLinkWake: { enabled: true, waitMs: 80, pollMs: 1, reopenMs: 1 } },
    logger: null,
    useLock: false,
    wakeThread(params) {
      wakeCalls.push(params);
    }
  });

  assert.equal(result.action, "start");
  assert.equal(result.turnId, "turn-after-reopen");
  assert.deepEqual(calls, ["steer", "steer", "steer", "steer", "steer", "start"]);
  assert.ok(wakeCalls.length >= 2);
  assert.equal(wakeCalls[0].reason, "initial");
  assert.equal(wakeCalls[1].reason, "retry");
});

test("auto route preserves no-client-found after deep-link wake retry fails", async () => {
  const wakeCalls = [];
  const client = {
    async steerThreadFollowerTurn() {
      throw new Error("no-client-found");
    },
    async startThreadFollowerTurn() {
      throw new Error("no-client-found");
    }
  };

  await assert.rejects(
    () => sendTextToCodexTarget({
      client,
      target,
      text: "hello",
      codex: { deepLinkWake: { enabled: true, waitMs: 0 } },
      logger: null,
      wakeThread(params) {
        wakeCalls.push(params);
      },
      useLock: false
    }),
    /no-client-found/
  );
  assert.equal(wakeCalls.length, 1);
});

test("follower-auto preserves no-client-found after deep-link wake retry fails", async () => {
  const wakeCalls = [];
  const client = {
    async steerThreadFollowerTurn() {
      throw new Error("no-client-found");
    },
    async startThreadFollowerTurn() {
      throw new Error("no-client-found");
    }
  };

  await assert.rejects(
    () => sendTextToCodexTarget({
      client,
      target,
      text: "hello",
      mode: "follower-auto",
      codex: { deepLinkWake: { enabled: true, waitMs: 0 } },
      logger: null,
      wakeThread(params) {
        wakeCalls.push(params);
      },
      useLock: false
    }),
    /no-client-found/
  );
  assert.equal(wakeCalls.length, 1);
});

test("error classifiers distinguish inactive and active run failures", () => {
  assert.equal(isInactiveTurnError(new Error("conversation is not being streamed")), true);
  assert.equal(isInactiveTurnError(new Error("no-client-found")), false);
  assert.equal(isActiveTurnError(new Error("thread already has an active turn")), true);
  assert.equal(isActiveTurnError(new Error("permission denied")), false);
  assert.equal(isMissingFollowerClientError(new Error("no-client-found")), true);
  assert.equal(isMissingFollowerClientError(new Error("No Codex app IPC socket found under /tmp/codex-ipc")), true);
  assert.equal(isMissingFollowerClientError(new Error("socket-directory-missing")), true);
  assert.equal(isMissingFollowerClientError(new Error("Failed to connect to Codex IPC socket /tmp/codex-ipc/ipc.sock: ECONNREFUSED")), true);
  assert.equal(isMissingFollowerClientError(new Error("Timed out waiting for Codex IPC method thread-follower-steer-turn.")), true);
  assert.equal(isMissingFollowerClientError(Object.assign(new Error("Timed out waiting for Codex IPC method route-text-to-thread."), {
    code: "request-timeout",
    method: "route-text-to-thread"
  })), false);
  assert.equal(isMissingFollowerClientError(new Error("permission denied")), false);
});

test("extractTurnId handles app IPC result shapes", () => {
  assert.equal(extractTurnId({ turnId: "a" }), "a");
  assert.equal(extractTurnId({ turn: { id: "b" } }), "b");
  assert.equal(extractTurnId({ result: { turnId: "c" } }), "c");
  assert.equal(extractTurnId({ result: { result: { turn: { id: "d" } } } }), "d");
  assert.equal(extractTurnId({ nope: true }), null);
});
