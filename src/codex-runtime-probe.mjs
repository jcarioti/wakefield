import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { CodexIpcClient } from "./codex-ipc.mjs";

const UNAVAILABLE_CODES = new Set([
  "connect-timeout",
  "socket-directory-missing",
  "socket-missing",
  "ECONNREFUSED",
  "ENOENT",
  "ENOTSOCK"
]);

export function defaultCodexSessionsPath({
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
} = {}) {
  return path.join(codexHome, "sessions");
}

export async function probeCodexRuntime({
  socketPath = process.env.CODEX_IPC_SOCKET || null,
  sessionsPath = defaultCodexSessionsPath(),
  connectTimeoutMs = 10000,
  requestTimeoutMs = 10000,
  clientFactory = (options) => new CodexIpcClient(options)
} = {}) {
  const sessionsReadable = await isReadableDirectory(sessionsPath);
  const client = clientFactory({
    socketPath,
    clientType: "wakefield-runtime-probe",
    connectTimeoutMs,
    requestTimeoutMs
  });

  try {
    await client.connect();
    return {
      status: "compatible",
      reason: "initialize-succeeded",
      scope: "socket-and-initialize-only",
      followerProtocolTested: false,
      socketPath: client.socketPath || socketPath,
      sessionsPath,
      sessionsReadable,
      error: null
    };
  } catch (error) {
    const status = isUnavailableRuntimeError(error) ? "unavailable" : "incompatible";
    return {
      status,
      reason: runtimeFailureReason(error),
      scope: "socket-and-initialize-only",
      followerProtocolTested: false,
      socketPath: client.socketPath || socketPath,
      sessionsPath,
      sessionsReadable,
      error: serializeError(error)
    };
  } finally {
    client.disconnect();
  }
}

export function codexRuntimeProbeExitCode(status) {
  if (status === "compatible") return 0;
  return status === "unavailable" ? 3 : 2;
}

export function formatCodexRuntimeProbe(result) {
  return [
    "ChatGPT/Codex runtime",
    `status: ${result.status}`,
    `reason: ${result.reason}`,
    `scope: ${result.scope}`,
    `follower protocol tested: ${result.followerProtocolTested ? "yes" : "no"}`,
    `socket: ${result.socketPath || "not found"}`,
    `sessions: ${result.sessionsPath} (${result.sessionsReadable ? "readable" : "not readable"})`
  ].join("\n");
}

function isUnavailableRuntimeError(error) {
  return [error?.code, error?.details?.code].some((code) => UNAVAILABLE_CODES.has(code));
}

function runtimeFailureReason(error) {
  return error?.details?.code || error?.code || "runtime-probe-failed";
}

async function isReadableDirectory(directory) {
  try {
    const stat = await fs.stat(directory);
    if (!stat.isDirectory()) return false;
    await fs.access(directory, fs.constants.R_OK);
    return true;
  } catch {
    return false;
  }
}

function serializeError(error) {
  return {
    name: error?.name || null,
    code: error?.code || null,
    causeCode: error?.details?.code || null,
    message: error?.message || String(error)
  };
}
