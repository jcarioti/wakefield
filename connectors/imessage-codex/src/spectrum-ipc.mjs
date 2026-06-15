import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import net from "node:net";
import path from "node:path";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 30000;

function bridgeIpcFailure(error) {
  if (!error) {
    return new Error("Photon/Spectrum bridge IPC closed before response.");
  }
  const message = String(error.message || error);
  if (["EPIPE", "ECONNRESET", "ERR_STREAM_DESTROYED"].includes(error.code) || /pipe|closed|destroyed/i.test(message)) {
    return new Error("Photon/Spectrum bridge IPC closed before response.");
  }
  return new Error(`Photon/Spectrum bridge IPC failed: ${message}`);
}

export async function startSpectrumBridgeIpcServer({
  spectrum,
  handler,
  logger = console
}) {
  if (!spectrum.ipcSocketPath) {
    return async () => {};
  }
  await fs.mkdir(path.dirname(spectrum.ipcSocketPath), { recursive: true });
  await fs.rm(spectrum.ipcSocketPath, { force: true });

  const server = net.createServer((socket) => {
    const lines = readline.createInterface({ input: socket });
    lines.on("line", async (line) => {
      if (!line.trim()) return;
      let request;
      try {
        request = JSON.parse(line);
        const result = await handler(request);
        socket.write(`${JSON.stringify({ id: request.id || null, ok: true, result })}\n`);
      } catch (error) {
        socket.write(`${JSON.stringify({
          id: request?.id || null,
          ok: false,
          error: error.message
        })}\n`);
      }
    });
    socket.on("error", (error) => {
      logger.warn?.(`Spectrum IPC socket error: ${error.message}`);
    });
  });

  await new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(spectrum.ipcSocketPath, () => {
      server.off("error", reject);
      resolve();
    });
  });

  return async () => {
    await new Promise((resolve) => server.close(resolve));
    await fs.rm(spectrum.ipcSocketPath, { force: true }).catch(() => {});
  };
}

export function sendSpectrumBridgeRequest({
  spectrum,
  request,
  timeoutMs = DEFAULT_TIMEOUT_MS
}) {
  if (!spectrum.ipcSocketPath) {
    return Promise.reject(new Error("Photon/Spectrum bridge IPC socket path is not configured."));
  }

  const id = request.id || randomUUID();
  const payload = { ...request, id };
  return new Promise((resolve, reject) => {
    const socket = net.createConnection(spectrum.ipcSocketPath);
    let settled = false;
    let lines;
    const cleanup = () => {
      clearTimeout(timer);
      lines?.close();
    };
    const fail = (error) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.destroy();
      reject(error);
    };
    const timer = setTimeout(() => {
      fail(new Error(`Timed out waiting for Photon/Spectrum bridge response after ${timeoutMs}ms.`));
    }, timeoutMs);

    socket.once("connect", () => {
      setImmediate(() => {
        if (settled) return;
        if (socket.destroyed || !socket.writable) {
          fail(new Error("Photon/Spectrum bridge IPC closed before response."));
          return;
        }
        try {
          socket.write(`${JSON.stringify(payload)}\n`, (error) => {
            if (error) {
              fail(bridgeIpcFailure(error));
            }
          });
        } catch (error) {
          fail(bridgeIpcFailure(error));
        }
      });
    });
    socket.on("error", (error) => {
      fail(bridgeIpcFailure(error));
    });
    socket.once("close", () => {
      fail(new Error("Photon/Spectrum bridge IPC closed before response."));
    });
    socket.once("end", () => {
      fail(new Error("Photon/Spectrum bridge IPC closed before response."));
    });

    lines = readline.createInterface({ input: socket });
    lines.on("error", (error) => {
      fail(bridgeIpcFailure(error));
    });
    lines.once("line", (line) => {
      if (settled) return;
      settled = true;
      cleanup();
      socket.end();
      try {
        const response = JSON.parse(line);
        if (!response.ok) {
          reject(new Error(response.error || "Photon/Spectrum bridge request failed."));
          return;
        }
        resolve(response.result);
      } catch (error) {
        reject(new Error(`Photon/Spectrum bridge returned invalid JSON: ${error.message}`));
      }
    });
  });
}
