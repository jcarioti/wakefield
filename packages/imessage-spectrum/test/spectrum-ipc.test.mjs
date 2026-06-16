import assert from "node:assert/strict";
import fs from "node:fs/promises";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  sendSpectrumBridgeRequest,
  startSpectrumBridgeIpcServer
} from "../src/spectrum-ipc.mjs";

test("Spectrum bridge IPC reports a closed socket without waiting for timeout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-ipc-test-"));
  const socketPath = path.join(root, "bridge.sock");
  const server = net.createServer((socket) => {
    socket.destroy();
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(socketPath, resolve);
  });
  try {
    await assert.rejects(
      () => sendSpectrumBridgeRequest({
        spectrum: { ipcSocketPath: socketPath },
        request: { method: "send" },
        timeoutMs: 10000
      }),
      /closed before response/
    );
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("Spectrum bridge IPC server handles sequential requests on separate sockets", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-ipc-server-test-"));
  const socketPath = path.join(root, "bridge.sock");
  let calls = 0;
  const stop = await startSpectrumBridgeIpcServer({
    spectrum: { ipcSocketPath: socketPath },
    handler: async (request) => ({ method: request.method, calls: ++calls })
  });

  try {
    assert.deepEqual(
      await sendSpectrumBridgeRequest({
        spectrum: { ipcSocketPath: socketPath },
        request: { method: "first" }
      }),
      { method: "first", calls: 1 }
    );
    assert.deepEqual(
      await sendSpectrumBridgeRequest({
        spectrum: { ipcSocketPath: socketPath },
        request: { method: "second" }
      }),
      { method: "second", calls: 2 }
    );
  } finally {
    await stop();
  }
});
