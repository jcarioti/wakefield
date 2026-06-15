#!/usr/bin/env node
import { CodexIpcClient } from "./codex-ipc-client.mjs";
import {
  findThreadRolloutPath,
  readLatestThreadStatus
} from "./codex-rollout-watch.mjs";
import {
  extractTurnId,
  isInactiveTurnError,
  isMissingFollowerClientError
} from "./codex-router.mjs";
import { getTarget, loadConnectorConfig, parseCliArgs } from "./config.mjs";

const PROBE_TEXT = "[DIAGNOSTIC ONLY] Codex follower registration probe. No reply needed.";

const args = parseCliArgs();
if (args.help) {
  console.log("Usage: discord-codex-probe-follower --config connectors/discord-codex/config.local.json --target rick");
  process.exit(0);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
const target = getTarget(config, args.targetId);
const result = await probeThreadFollower({ target, codex: config.codex });
console.log(JSON.stringify(result, null, 2));
if (result.status === "no-client-found") {
  process.exitCode = 3;
} else if (result.status === "error") {
  process.exitCode = 2;
}

export async function probeThreadFollower({ target, codex = {} }) {
  const rolloutPath = target.rolloutPath || await findThreadRolloutPath(target.threadId);
  const threadStatus = rolloutPath
    ? await readLatestThreadStatus({ rolloutPath })
    : { active: false, reason: "rollout-not-found", rolloutPath: null };

  if (threadStatus.active) {
    return {
      status: "unknown-active-turn",
      follower: "unknown",
      safeToRoute: true,
      safeProbeSkipped: true,
      reason: "active-turn",
      targetId: target.id || null,
      threadId: target.threadId,
      rolloutPath,
      threadStatus
    };
  }

  const client = new CodexIpcClient({
    socketPath: codex.socketPath,
    clientType: "wakefield-follower-probe",
    connectTimeoutMs: codex.connectTimeoutMs,
    requestTimeoutMs: codex.requestTimeoutMs
  });

  try {
    const steerResult = await client.steerThreadFollowerTurn({
      conversationId: target.threadId,
      cwd: target.cwd,
      text: PROBE_TEXT
    });
    return {
      status: "follower-present-steered",
      follower: "present",
      safeToRoute: true,
      safeProbeSkipped: false,
      reason: "steer-succeeded",
      targetId: target.id || null,
      threadId: target.threadId,
      rolloutPath,
      threadStatus,
      turnId: extractTurnId(steerResult),
      result: steerResult
    };
  } catch (error) {
    if (isInactiveTurnError(error)) {
      return {
        status: "follower-present-idle",
        follower: "present",
        safeToRoute: true,
        safeProbeSkipped: false,
        reason: "inactive-turn",
        targetId: target.id || null,
        threadId: target.threadId,
        rolloutPath,
        threadStatus,
        error: serializeError(error)
      };
    }
    if (isMissingFollowerClientError(error)) {
      return {
        status: "no-client-found",
        follower: "missing",
        safeToRoute: false,
        safeProbeSkipped: false,
        reason: "no-client-found",
        targetId: target.id || null,
        threadId: target.threadId,
        rolloutPath,
        threadStatus,
        error: serializeError(error)
      };
    }
    return {
      status: "error",
      follower: "unknown",
      safeToRoute: false,
      safeProbeSkipped: false,
      reason: error?.code || "probe-failed",
      targetId: target.id || null,
      threadId: target.threadId,
      rolloutPath,
      threadStatus,
      error: serializeError(error)
    };
  } finally {
    client.disconnect();
  }
}

function serializeError(error) {
  return {
    name: error?.name || null,
    code: error?.code || null,
    message: error?.message || String(error),
    details: error?.details || null
  };
}
