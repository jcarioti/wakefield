import { execFile } from "node:child_process";
import { setTimeout as sleep } from "node:timers/promises";
import { promisify } from "node:util";
import { CodexIpcClient } from "./codex-ipc-client.mjs";
import { CodexAppServerClient } from "./codex-app-server-client.mjs";
import { withFileLock } from "./lock.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_DEEP_LINK_WAKE_WAIT_MS = 30000;
const DEFAULT_DEEP_LINK_WAKE_POLL_MS = 1000;
const DEFAULT_DEEP_LINK_WAKE_REOPEN_MS = 6000;

export async function sendTextToCodexTarget({
  client = null,
  appServerClient = null,
  wakeThread = null,
  target,
  text,
  mode = "auto",
  codex = {},
  logger = console,
  useLock = true
}) {
  assertTarget(target);
  if (!text || typeof text !== "string") {
    throw new Error("Codex routed text must be a non-empty string.");
  }

  const run = async () => {
    if (isAppServerMode(mode)) {
      const ownsAppServerClient = appServerClient == null;
      const codexAppServerClient = appServerClient || createAppServerClient(codex);
      try {
        return withTarget(await routeViaAppServer(codexAppServerClient, target, text), target);
      } finally {
        if (ownsAppServerClient) {
          codexAppServerClient.disconnect();
        }
      }
    }

    if (!isFollowerMode(mode)) {
      throw new Error(`Unsupported Codex routing mode: ${mode}`);
    }

    const ownsClient = client == null;
    const codexClient = client || new CodexIpcClient({
      socketPath: codex.socketPath,
      connectTimeoutMs: codex.connectTimeoutMs,
      requestTimeoutMs: codex.requestTimeoutMs
    });
    try {
      if (mode === "follower-steer" || mode === "steer") {
        return withTarget(await steer(codexClient, target, text), target);
      }
      if (mode === "follower-start" || mode === "start") {
        return withTarget(await start(codexClient, target, text), target);
      }
      return withTarget(await autoRoute(codexClient, target, text, { codex, wakeThread, logger }), target);
    } finally {
      if (ownsClient) {
        codexClient.disconnect();
      }
    }
  };

  if (!useLock) {
    return run();
  }

  return withFileLock(
    `codex-thread-${target.threadId}`,
    {
      timeoutMs: codex.lockTimeoutMs,
      staleMs: codex.lockStaleMs
    },
    run
  );
}

async function autoRoute(client, target, text, { codex = {}, wakeThread = null, logger = console } = {}) {
  let wakeResult = null;
  try {
    return await autoRouteOnce(client, target, text);
  } catch (error) {
    if (!isMissingFollowerClientError(error) || !isDeepLinkWakeEnabled(codex)) {
      throw error;
    }
    resetUnresponsiveFollowerClient(client, error);
    wakeResult = await wakeCodexThreadForFollower({ target, codex, wakeThread, logger });
  }

  const waitMs = wakeResult?.waitMs ?? 0;
  const pollMs = wakeResult?.pollMs ?? DEFAULT_DEEP_LINK_WAKE_POLL_MS;
  const reopenMs = wakeResult?.reopenMs ?? DEFAULT_DEEP_LINK_WAKE_REOPEN_MS;
  let lastOpenAt = Date.now();
  const deadline = Date.now() + waitMs;
  let lastError = null;
  do {
    try {
      const result = await autoRouteOnce(client, target, text);
      logger?.info?.(`Codex follower route recovered for ${target.id || target.threadId} after deep-link wake.`);
      return result;
    } catch (error) {
      if (!isMissingFollowerClientError(error)) {
        throw error;
      }
      lastError = error;
      resetUnresponsiveFollowerClient(client, error);
      if (Date.now() >= deadline) {
        break;
      }
      if (reopenMs > 0 && Date.now() - lastOpenAt >= reopenMs) {
        wakeResult = await wakeCodexThreadForFollower({
          target,
          codex,
          wakeThread,
          logger,
          reason: "retry"
        });
        lastOpenAt = Date.now();
      }
      await sleep(Math.min(pollMs, Math.max(0, deadline - Date.now())));
    }
  } while (Date.now() <= deadline);

  logger?.error?.(`Codex follower still missing for ${target.id || target.threadId} after deep-link wake; refusing non-IPC fallback.`);
  throw lastError;
}

async function autoRouteOnce(client, target, text) {
  try {
    return await steer(client, target, text);
  } catch (error) {
    if (!isInactiveTurnError(error)) {
      throw error;
    }
  }

  try {
    return await start(client, target, text);
  } catch (error) {
    if (!isActiveTurnError(error)) {
      throw error;
    }
  }

  return steer(client, target, text);
}

export async function wakeCodexThreadForFollower({
  target,
  codex = {},
  wakeThread = null,
  logger = console,
  reason = "initial"
}) {
  const wakeConfig = normalizeDeepLinkWake(codex);
  const url = codexThreadDeepLink(target.threadId);
  const wakeVerb = reason === "retry" ? "re-opening" : "opening";
  logger?.info?.(`Codex follower client missing for ${target.id || target.threadId}; ${wakeVerb} ${url} to load the app-owned thread follower.`);
  if (wakeThread) {
    await wakeThread({ target, url, waitMs: wakeConfig.waitMs, pollMs: wakeConfig.pollMs, reopenMs: wakeConfig.reopenMs, reason });
  } else {
    await openCodexDeepLink(url, wakeConfig);
  }
  logger?.info?.(`Codex deep-link wake command completed for ${target.id || target.threadId}; polling up to ${wakeConfig.waitMs}ms for follower registration.`);
  return { url, waitMs: wakeConfig.waitMs, pollMs: wakeConfig.pollMs, reopenMs: wakeConfig.reopenMs };
}

export function codexThreadDeepLink(threadId) {
  if (!threadId || typeof threadId !== "string") {
    throw new Error("Codex thread deep link needs a threadId.");
  }
  return `codex://threads/${encodeURIComponent(threadId)}`;
}

async function steer(client, target, text) {
  const result = await client.steerThreadFollowerTurn({
    conversationId: target.threadId,
    cwd: target.cwd,
    text
  });
  return { action: "steer", result, turnId: extractTurnId(result) };
}

async function start(client, target, text) {
  const result = await client.startThreadFollowerTurn({
    conversationId: target.threadId,
    cwd: target.cwd,
    permissions: target.codexPermissions || null,
    text
  });
  return { action: "start", result, turnId: extractTurnId(result) };
}

async function routeViaAppServer(client, target, text) {
  return client.routeTextToThread({
    threadId: target.threadId,
    cwd: target.cwd,
    permissions: target.codexPermissions || null,
    text
  });
}

export function extractTurnId(value) {
  if (value == null || typeof value !== "object") {
    return null;
  }
  if (typeof value.turnId === "string") return value.turnId;
  if (typeof value.id === "string" && value.status) return value.id;
  if (typeof value.turn?.id === "string") return value.turn.id;
  if (typeof value.result?.turnId === "string") return value.result.turnId;
  if (typeof value.result?.turn?.id === "string") return value.result.turn.id;
  if (typeof value.result?.result?.turnId === "string") return value.result.result.turnId;
  if (typeof value.result?.result?.turn?.id === "string") return value.result.result.turn.id;
  return null;
}

function withTarget(routeResult, target) {
  return {
    ...routeResult,
    threadId: target.threadId
  };
}

export function isInactiveTurnError(error) {
  const text = errorText(error);
  return [
    /no active/i,
    /not active/i,
    /not.*stream/i,
    /not.*in[- ]?progress/i,
    /no.*turn/i,
    /cannot steer/i,
    /no conversation.*stream/i
  ].some((pattern) => pattern.test(text));
}

export function isActiveTurnError(error) {
  const text = errorText(error);
  return [
    /already.*active/i,
    /already.*running/i,
    /active.*turn/i,
    /busy/i,
    /in[- ]?progress/i
  ].some((pattern) => pattern.test(text));
}

export function isMissingFollowerClientError(error) {
  const text = errorText(error);
  if (isFollowerTurnRequestTimeout(error, text)) {
    return true;
  }
  return [
    /no-client-found/i,
    /client.*not.*found/i,
    /no.*client/i,
    /socket-directory-missing/i,
    /socket-missing/i,
    /no Codex app IPC socket found/i,
    /Codex app IPC socket directory does not exist/i,
    /failed to connect to Codex IPC socket/i,
    /timed out connecting to Codex IPC socket/i
  ].some((pattern) => pattern.test(text));
}

function isFollowerTurnRequestTimeout(error, text = errorText(error)) {
  const method = String(error?.method || error?.details?.method || "");
  return (
    error?.code === "request-timeout" &&
    /^thread-follower-(?:steer|start)-turn$/.test(method)
  ) || /Timed out waiting for Codex IPC method thread-follower-(?:steer|start)-turn/i.test(text);
}

function resetUnresponsiveFollowerClient(client, error) {
  if (isFollowerTurnRequestTimeout(error) && typeof client?.disconnect === "function") {
    client.disconnect();
  }
}

function errorText(error) {
  return [
    error?.code,
    error?.method,
    error?.message,
    typeof error?.details === "string" ? error.details : null,
    error?.details?.method,
    error?.details?.message
  ].filter(Boolean).join(" ");
}

function isAppServerMode(mode) {
  return mode === "app-server" || mode === "remote-control";
}

function isFollowerMode(mode) {
  return mode === "auto" || mode === "follower-auto" || mode === "follower-steer" || mode === "follower-start" ||
    mode === "steer" || mode === "start";
}

function isDeepLinkWakeEnabled(codex) {
  return normalizeDeepLinkWake(codex).enabled;
}

function normalizeDeepLinkWake(codex = {}) {
  const raw = codex.deepLinkWake;
  if (raw === false) {
    return { enabled: false, command: null, args: null, waitMs: 0 };
  }
  const source = raw && typeof raw === "object" ? raw : {};
  return {
    enabled: source.enabled !== false,
    command: source.command || defaultDeepLinkOpenCommand(),
    args: Array.isArray(source.args) ? source.args : null,
    waitMs: normalizePositiveInteger(source.waitMs, DEFAULT_DEEP_LINK_WAKE_WAIT_MS),
    pollMs: normalizePositiveInteger(source.pollMs, DEFAULT_DEEP_LINK_WAKE_POLL_MS),
    reopenMs: normalizePositiveInteger(source.reopenMs, DEFAULT_DEEP_LINK_WAKE_REOPEN_MS)
  };
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function defaultDeepLinkOpenCommand() {
  return process.platform === "darwin" ? "/usr/bin/open" : null;
}

async function openCodexDeepLink(url, { command, args }) {
  if (!command) {
    throw new Error("Codex deep-link wake is enabled, but no open command is configured for this platform.");
  }
  const commandArgs = args == null
    ? [url]
    : args.map((arg) => arg === "{url}" ? url : arg);
  await execFileAsync(command, commandArgs, { timeout: 10000 });
}

function createAppServerClient(codex) {
  const legacyFallback = codex?.appServerFallback && codex.appServerFallback !== true
    ? codex.appServerFallback
    : {};
  const appServer = mergeDefined(
    legacyFallback,
    codex?.appServer && codex.appServer !== true ? codex.appServer : {}
  );
  return new CodexAppServerClient({
    socketPath: appServer.controlSocketPath || appServer.socketPath,
    codexPath: appServer.codexPath,
    ensureDaemon: appServer.ensureDaemon,
    requireRemoteControlConnected: appServer.requireRemoteControlConnected,
    connectTimeoutMs: appServer.connectTimeoutMs ?? codex?.connectTimeoutMs,
    requestTimeoutMs: appServer.requestTimeoutMs ?? codex?.requestTimeoutMs,
    startupTimeoutMs: appServer.startupTimeoutMs
  });
}

function mergeDefined(...sources) {
  const result = {};
  for (const source of sources) {
    if (source == null || typeof source !== "object") {
      continue;
    }
    for (const [key, value] of Object.entries(source)) {
      if (value !== undefined && value !== null) {
        result[key] = value;
      }
    }
  }
  return result;
}

function assertTarget(target) {
  if (!target?.threadId) {
    throw new Error("Codex target needs a threadId.");
  }
  if (!target?.cwd) {
    throw new Error(`Codex target ${target.id || target.threadId} needs a cwd.`);
  }
}
