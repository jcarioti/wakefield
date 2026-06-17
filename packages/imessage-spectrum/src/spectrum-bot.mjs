#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAllowedOutboundAddresses,
  getAllowedOutboundSpaceIds,
  loadConnectorConfig,
  normalizeAddress,
  parseCliArgs
} from "./config.mjs";
import { loadContactResolver } from "./contact-resolver.mjs";
import {
  materializeSpectrumContent,
  mergeSpectrumHistoryContent,
  shouldEnrichSpectrumContentFromHistory,
  summarizeSpectrumMessage
} from "./spectrum-content.mjs";
import {
  createSpectrumApp,
  isPhotonBackpressureError,
  readSpectrumMessage,
  reactToSpectrumMessage,
  resolveSpectrumSpace,
  sendSpectrumMessage,
  spectrumReactionTargetMessageId,
  stopSpectrumTyping
} from "./spectrum-client.mjs";
import {
  SpectrumAppOperationGate,
  isSpectrumChannelShutdownError
} from "./spectrum-app-gate.mjs";
import {
  isSpectrumOperationTimeoutError,
  spectrumServiceStatusForReceiveLoop,
  withSpectrumOperationTimeout
} from "./spectrum-receive-loop-health.mjs";
import { startSpectrumBridgeIpcServer } from "./spectrum-ipc.mjs";
import {
  eventLogRecordFromSpectrumMessage,
  formatSpectrumMessageForCodex,
  matchesSpectrumTarget
} from "./spectrum-message-format.mjs";
import { sendTextToCodexTarget } from "@wakefield/connector-shared/codex-router.mjs";
import { findThreadRolloutPath, waitForTurnCompletion } from "@wakefield/connector-shared/codex-rollout-watch.mjs";
import { acquireSingletonProcessLock } from "@wakefield/connector-shared/lock.mjs";
import { recordWakefieldConnectorTurn } from "@wakefield/connector-shared/wakefield-memory.mjs";
import {
  createPhotonImessageClients,
  getPhotonMessage,
  listPhotonMessagesInChat,
  markPhotonChatRead,
  sendPhotonReaction,
  sendPhotonTextMessage
} from "./photon-history.mjs";
import {
  SpectrumDeliveryQueue,
  beginPendingDeliveryAttempt,
  createPendingDeliveryRecord,
  deliveredEventLogRecord,
  findEarlierPendingDeliveryInLane
} from "./spectrum-delivery-queue.mjs";
import { SpectrumDeliveryLaneScheduler } from "./spectrum-delivery-lanes.mjs";
import { wakefieldMemoryForSpectrumMessage } from "./spectrum-memory.mjs";

const args = parseCliArgs();
if (args.help) {
  console.log("Usage: imessage-spectrum-bot --config packages/imessage-spectrum/config.local.json");
  process.exit(0);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
if (config.imessage.provider !== "spectrum") {
  console.warn(`iMessage config provider is ${config.imessage.provider}; starting Photon/Spectrum bot anyway.`);
}

const releaseProcessLock = await acquireSingletonProcessLock(botProcessLockName(config), {
  lockRoot: config.bot.processLockRoot,
  staleMs: config.bot.processLockStaleMs
});
const contacts = await loadContactResolver(config.identity.contactsPath);
const deliveryQueue = new SpectrumDeliveryQueue({
  queuePath: config.imessage.spectrum.deliveryQueuePath
});
const deliveryLanes = new SpectrumDeliveryLaneScheduler();
const previousStatus = await readJsonFile(config.imessage.spectrum.statusPath);
const knownSpaces = new Map();
const activeTypingStops = new Map();
const activeDeliveryIds = new Set();
const appOperationGate = new SpectrumAppOperationGate({
  minIntervalMs: config.imessage.spectrum.outboundRequestMinIntervalMs
});
let deliveryDrainActive = false;
let app = null;
let stopIpcServer = async () => {};
let lastInboundAt = null;
let lastMatchedInboundAt = null;
let lastInboundMessage = null;
let lastMatchedInboundMessage = null;
let statusHeartbeat = null;
let deliveryRetryTimer = null;
const startupReplayTimers = new Set();
let shuttingDown = false;
const receiveLoop = {
  state: "starting",
  startedAt: null,
  lastActivityAt: null,
  lastErrorAt: null,
  lastError: null,
  restartCount: 0,
  lastRestartReason: null,
  rotationRequestedAt: null,
  restartStartedAt: null,
  lastRestartCompletedAt: null
};

app = await createSpectrumAppWithBackoff("startup");

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

stopIpcServer = await startSpectrumBridgeIpcServer({
  spectrum: config.imessage.spectrum,
  handler: handleBridgeRequest
});
await writeCurrentStatus();
statusHeartbeat = setInterval(() => {
  writeCurrentStatus().catch((error) => {
    console.warn(`Photon/Spectrum status heartbeat failed: ${error.message}`);
  });
}, 60000);
statusHeartbeat.unref?.();

console.log(`Photon/Spectrum iMessage connector online. Outbound IPC: ${config.imessage.spectrum.ipcSocketPath}`);
console.log(`Allowed outbound iMessage addresses: ${[...getAllowedOutboundAddresses(config)].join(", ") || "(none)"}`);
console.log(`Allowed outbound Spectrum space ids: ${[...getAllowedOutboundSpaceIds(config)].join(", ") || "(none)"}`);

scheduleDeliveryRetry();
scheduleStartupHistoryReplay({ previousStatus, reason: "startup" });

superviseReceiveLoop().catch((error) => {
  receiveLoop.state = "failed";
  receiveLoop.lastErrorAt = new Date().toISOString();
  receiveLoop.lastError = error.stack || error.message;
  writeStatus("receive-loop-failed").catch(() => {});
  console.error(`Photon/Spectrum receive loop supervisor failed: ${error.stack || error.message}`);
});

async function superviseReceiveLoop() {
  let backoffMs = 1000;
  while (!shuttingDown) {
    try {
      await runReceiveLoop();
      if (shuttingDown) {
        return;
      }
      receiveLoop.state = "ended";
      if (receiveLoop.lastRestartReason === "max_age") {
        console.log("Photon/Spectrum app.messages rotated at configured max age; recreating Spectrum app.");
      } else {
        receiveLoop.lastErrorAt = new Date().toISOString();
        receiveLoop.lastError = "app.messages ended without throwing";
        receiveLoop.lastRestartReason = "ended";
        console.warn("Photon/Spectrum app.messages ended without throwing; recreating Spectrum app.");
      }
    } catch (error) {
      if (shuttingDown) {
        return;
      }
      receiveLoop.state = "errored";
      receiveLoop.lastErrorAt = new Date().toISOString();
      receiveLoop.lastError = error.stack || error.message;
      receiveLoop.lastRestartReason = "error";
      console.error(`Photon/Spectrum app.messages failed; recreating Spectrum app: ${error.stack || error.message}`);
    }

    await writeStatus("receive-loop-restarting").catch((error) => {
      console.warn(`Photon/Spectrum status update failed during receive-loop restart: ${error.message}`);
    });
    await sleep(backoffMs);
    if (shuttingDown) {
      return;
    }
    backoffMs = Math.min(backoffMs * 2, 30000);
    try {
      await recreateSpectrumApp();
    } catch (error) {
      receiveLoop.state = "errored";
      receiveLoop.lastErrorAt = new Date().toISOString();
      receiveLoop.lastError = error.stack || error.message;
      console.error(`Photon/Spectrum app recreation failed: ${error.stack || error.message}`);
    }
  }
}

async function runReceiveLoop() {
  const currentApp = app;
  const maxAgeMs = config.imessage.spectrum.receiveLoopMaxAgeMs;
  let rotationTimer = null;
  receiveLoop.state = "running";
  receiveLoop.startedAt = new Date().toISOString();
  receiveLoop.rotationRequestedAt = null;
  receiveLoop.restartStartedAt = null;
  receiveLoop.lastRestartReason = null;
  receiveLoop.lastError = null;
  receiveLoop.lastErrorAt = null;
  await writeStatus("online");

  if (maxAgeMs > 0) {
    rotationTimer = setTimeout(() => {
      if (shuttingDown) {
        return;
      }
      receiveLoop.state = "rotating";
      receiveLoop.lastRestartReason = "max_age";
      receiveLoop.rotationRequestedAt = new Date().toISOString();
      writeStatus("receive-loop-rotating").catch((error) => {
        console.warn(`Photon/Spectrum status update failed during max-age rotation: ${error.message}`);
      });
      console.log(`Photon/Spectrum app.messages reached max age ${maxAgeMs}ms; rotating subscription.`);
      queueSpectrumAppStop(currentApp, "max-age rotation");
    }, maxAgeMs);
    rotationTimer.unref?.();
  }

  try {
    for await (const [space, message] of currentApp.messages) {
      receiveLoop.lastActivityAt = new Date().toISOString();
      knownSpaces.set(space.id, space);
      lastInboundAt = receiveLoop.lastActivityAt;
      lastInboundMessage = statusMessageSummary({ space, message, seenAt: lastInboundAt });
      console.log(`Received Photon/Spectrum iMessage ${message.id} in ${space.id}.`);
      writeStatus("online").catch((error) => {
        console.warn(`Photon/Spectrum status update failed for ${message.id}: ${error.message}`);
      });
      handleSpectrumMessage({ space, message }).catch((error) => {
        console.error(`Failed to route Photon/Spectrum iMessage ${message?.id || "unknown"}: ${error.stack || error.message}`);
      });
    }
  } finally {
    if (rotationTimer) {
      clearTimeout(rotationTimer);
    }
  }
}

async function recreateSpectrumApp() {
  receiveLoop.state = "restarting";
  receiveLoop.restartCount += 1;
  receiveLoop.restartStartedAt = new Date().toISOString();
  await writeStatus("receive-loop-restarting").catch(() => {});
  await appOperationGate.run(() => recreateSpectrumAppNow("receive-loop restart"));
}

async function recreateSpectrumAppNow(context) {
  const previousApp = app;
  const replayStatus = {
    knownSpaceIds: [...knownSpaces.keys()],
    lastInboundMessage,
    lastMatchedInboundMessage
  };
  try {
    await runProviderOperation(`${context} app.stop`, () => previousApp?.stop?.());
  } catch (error) {
    console.warn(`Photon/Spectrum app stop failed during ${context}: ${error.message}`);
  }
  knownSpaces.clear();
  app = await createSpectrumAppWithBackoff(context);
  receiveLoop.restartStartedAt = null;
  receiveLoop.lastRestartCompletedAt = new Date().toISOString();
  console.log(`Photon/Spectrum app recreated after receive-loop ${receiveLoop.lastRestartReason || "restart"}; restart count ${receiveLoop.restartCount}.`);
  scheduleStartupHistoryReplay({ previousStatus: replayStatus, reason: context });
}

function queueSpectrumAppStop(targetApp, reason) {
  appOperationGate.run(async () => {
    if (app !== targetApp) {
      return;
    }
    try {
      await runProviderOperation(`${reason} app.stop`, () => targetApp?.stop?.());
    } catch (error) {
      console.warn(`Photon/Spectrum app stop failed during ${reason}: ${error.message}`);
    }
  }).catch((error) => {
    console.warn(`Photon/Spectrum queued app stop failed during ${reason}: ${error.message}`);
  });
}

async function runBridgeAppOperation(label, operation, { retryOnChannelShutdown = false } = {}) {
  return appOperationGate.run(async () => {
    try {
      return await operation();
    } catch (error) {
      if (!retryOnChannelShutdown || shuttingDown || !isSpectrumChannelShutdownError(error)) {
        receiveLoop.lastErrorAt = new Date().toISOString();
        receiveLoop.lastError = error.stack || error.message;
        receiveLoop.lastRestartReason = `${label}_error`;
        await writeCurrentStatus().catch((statusError) => {
          console.warn(`Photon/Spectrum status update failed after ${label} error: ${statusError.message}`);
        });
        throw error;
      }
      console.warn(`Photon/Spectrum ${label} hit a closed channel; recreating Spectrum app and retrying once: ${error.message}`);
      receiveLoop.lastErrorAt = new Date().toISOString();
      receiveLoop.lastError = error.stack || error.message;
      receiveLoop.lastRestartReason = `${label}_channel_shutdown`;
      receiveLoop.restartCount += 1;
      receiveLoop.restartStartedAt = new Date().toISOString();
      await writeStatus("bridge-channel-restarting").catch(() => {});
      await recreateSpectrumAppNow(`${label} channel-shutdown retry`);
      return operation();
    }
  });
}

async function createSpectrumAppWithBackoff(context) {
  let backoffMs = 5000;
  while (!shuttingDown) {
    try {
      return await runProviderOperation(
        `${context} createSpectrumApp`,
        () => createSpectrumApp({ spectrum: config.imessage.spectrum })
      );
    } catch (error) {
      if (!isSpectrumRateLimitError(error)) {
        throw error;
      }
      receiveLoop.state = "rate-limited";
      receiveLoop.lastErrorAt = new Date().toISOString();
      receiveLoop.lastError = error.stack || error.message;
      receiveLoop.lastRestartReason = "rate_limited";
      await writeStatus("rate-limited").catch((statusError) => {
        console.warn(`Photon/Spectrum status update failed during rate-limit backoff: ${statusError.message}`);
      });
      console.warn(`Photon/Spectrum app creation rate-limited during ${context}; retrying in ${backoffMs}ms: ${error.message}`);
      await sleep(backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60000);
    }
  }
  throw new Error("Photon/Spectrum app creation stopped because connector is shutting down.");
}

function isSpectrumRateLimitError(error) {
  return error?.status === 429
    || error?.code === "RATE_LIMITED"
    || /too many requests|rate.?limit/i.test(String(error?.message || ""));
}

async function handleSpectrumMessage({ space, message }) {
  const matchedTargets = config.targets.filter((target) => matchesSpectrumTarget({ space, message, target }));
  if (matchedTargets.length === 0) {
    return;
  }
  lastMatchedInboundAt = new Date().toISOString();
  lastMatchedInboundMessage = {
    ...statusMessageSummary({ space, message, seenAt: lastMatchedInboundAt }),
    targetIds: matchedTargets.map((target) => target.id)
  };

  const liveContent = await materializeSpectrumContent({
    message,
    attachmentDir: config.imessage.spectrum.attachmentDir
  });
  const content = await enrichSpectrumContentFromHistory({ space, message, content: liveContent });

  for (const target of matchedTargets) {
    const memory = await connectorMemoryForSpectrum({ space, message, content, target });
    const text = formatSpectrumMessageForCodex({
      space,
      message,
      target,
      content,
      contacts,
      connectorGuidance: config.codex.connectorSkillPrompt,
      memory
    });
    const record = await deliveryQueue.upsert(createPendingDeliveryRecord({
      target,
      space,
      message,
      codexText: text,
      eventLogRecord: eventLogRecordFromSpectrumMessage({ space, message, target, content, routeResult: null, contacts })
    }));
    await routeDeliveryRecord(record, { space, message, source: "live" });
  }
}

async function connectorMemoryForSpectrum({ space, message, content, target }) {
  return wakefieldMemoryForSpectrumMessage({ space, message, content, target });
}

async function enrichSpectrumContentFromHistory({ space, message, content }) {
  if (!shouldEnrichSpectrumContentFromHistory(content)) {
    return content;
  }
  if (!space?.id || !message?.id || String(message.id).startsWith("p:")) {
    return content;
  }
  try {
    const historyMessage = await getPhotonMessageForLiveSpectrumEvent({ space, message });
    const enriched = mergeSpectrumHistoryContent({
      liveContent: content,
      historyMessage
    });
    if (enriched !== content && enriched.text !== content.text) {
      console.log(`Enriched Photon/Spectrum attachment ${message.id} with text from Photon history.`);
    }
    return enriched;
  } catch (error) {
    if (isPhotonBackpressureError(error)) {
      console.warn(`Photon/Spectrum attachment text enrichment unavailable for ${message.id}: ${error.message}; continuing with live attachment summary to avoid a retry.`);
      return content;
    }
    console.warn(`Photon/Spectrum attachment text enrichment unavailable for ${message.id}: ${error.message}`);
    return content;
  }
}

async function getPhotonMessageForLiveSpectrumEvent({ space, message }) {
  const clientSet = await createPhotonImessageClients({
    spectrum: config.imessage.spectrum
  });
  try {
    try {
      return await getPhotonMessage({
        spectrum: config.imessage.spectrum,
        chatGuid: space.id,
        messageId: message.id,
        phone: null,
        clientSet
      });
    } catch (error) {
      if (!shouldRetryHistoryLookupWithSpacePhone({ error, space })) {
        throw error;
      }
      return await getPhotonMessage({
        spectrum: config.imessage.spectrum,
        chatGuid: space.id,
        messageId: message.id,
        phone: normalizeOptionalString(space.phone),
        clientSet
      });
    }
  } finally {
    await clientSet.closeAll();
  }
}

function shouldRetryHistoryLookupWithSpacePhone({ error, space }) {
  return Boolean(normalizeOptionalString(space?.phone))
    && /multiple iMessage numbers|pass phone/i.test(String(error?.message || ""));
}

function normalizeOptionalString(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return null;
  }
  const text = String(value).trim();
  return text || null;
}

async function routeDeliveryRecord(record, { space = null, message = null, source = "retry" } = {}) {
  return deliveryLanes.run(record, () => routeDeliveryRecordNow(record, { space, message, source }));
}

async function routeDeliveryRecordNow(record, { space = null, message = null, source = "retry" } = {}) {
  if (activeDeliveryIds.has(record.id)) {
    return null;
  }
  const earlierPending = await findEarlierPendingDeliveryInLane(deliveryQueue, record);
  if (earlierPending) {
    console.log(`Deferring Photon/Spectrum iMessage ${record.messageId}; earlier same-chat message ${earlierPending.messageId} is still pending.`);
    return null;
  }
  activeDeliveryIds.add(record.id);
  const target = targetForDelivery(record);
  try {
    const deliveryRecord = await beginPendingDeliveryAttempt(deliveryQueue, record);
    if (!deliveryRecord) {
      console.log(`Skipping Photon/Spectrum iMessage ${record.messageId}; delivery is no longer pending.`);
      return null;
    }
    if (await deliveryAlreadyLogged(target, deliveryRecord)) {
      await deliveryQueue.markDelivered(deliveryRecord.id, { action: "already-delivered", turnId: null });
      console.log(`Skipping Photon/Spectrum iMessage ${deliveryRecord.messageId}; delivery was already logged.`);
      return null;
    }
    const routeResult = await sendTextToCodexTarget({
      target,
      text: deliveryRecord.codexText,
      mode: "auto",
      codex: config.codex
    });
    await appendEventLog(target, deliveredEventLogRecord(deliveryRecord, routeResult));
    await deliveryQueue.markDelivered(deliveryRecord.id, routeResult);
    console.log(`Routed Photon/Spectrum iMessage ${deliveryRecord.messageId} to ${target.id} via Codex ${routeResult.action}${source === "live" ? "" : ` (${source} replay)`}.`);
    if (space && message) {
      schedulePostRouteEffects({ target, routeResult, space, message, prompt: deliveryRecord.codexText });
    } else {
      scheduleReplayPostRouteEffects({ record: deliveryRecord });
    }
    return routeResult;
  } catch (error) {
    await deliveryQueue.markAttemptFailed(record.id, error).catch((queueError) => {
      console.warn(`Failed to record delivery failure for ${record.id}: ${queueError.message}`);
    });
    throw error;
  } finally {
    activeDeliveryIds.delete(record.id);
  }
}

function schedulePostRouteEffects({ target, routeResult, space, message, prompt = "" }) {
  Promise.resolve()
    .then(() => maybeMarkRead({ space, message }))
    .catch((error) => {
      console.warn(`Photon/Spectrum read receipt failed after routing ${message.id}: ${error.message}`);
    });

  if (!routeResult.turnId) {
    return;
  }

  const stopTyping = startTypingWhileThinking({ space, typing: config.imessage.typing });
  Promise.resolve()
    .then(() => keepTypingUntilTurnCompletes({ target, routeResult, message }))
    .then((completionStatus) => recordSpectrumConnectorTurn({ target, routeResult, completionStatus, space, message, prompt }))
    .catch((error) => {
      console.warn(`Photon/Spectrum typing watcher failed after routing ${message.id}: ${error.message}`);
    })
    .finally(stopTyping);
}

async function drainPendingDeliveries(reason) {
  if (deliveryDrainActive) {
    return;
  }
  deliveryDrainActive = true;
  try {
    const pending = await deliveryQueue.pending();
    if (pending.length === 0) {
      return;
    }
    console.log(`Replaying ${pending.length} pending Photon/Spectrum iMessage deliver${pending.length === 1 ? "y" : "ies"} after ${reason}.`);
    for (const record of pending) {
      if (shuttingDown) {
        return;
      }
      try {
        await routeDeliveryRecord(record, { source: reason });
      } catch (error) {
        console.warn(`Pending Photon/Spectrum iMessage ${record.messageId} still not delivered to ${record.targetId}: ${error.message}`);
      }
    }
    await writeCurrentStatus().catch(() => {});
  } finally {
    deliveryDrainActive = false;
  }
}

function scheduleDeliveryRetry() {
  const retryMs = config.imessage.spectrum.deliveryRetryMs;
  if (!retryMs || retryMs <= 0) {
    return;
  }
  deliveryRetryTimer = setInterval(() => {
    drainPendingDeliveries("timer").catch((error) => {
      console.warn(`Photon/Spectrum pending delivery retry failed: ${error.message}`);
    });
  }, retryMs);
  deliveryRetryTimer.unref?.();
}

function scheduleStartupHistoryReplay({ previousStatus, reason }) {
  if (!config.imessage.spectrum.startupReplayEnabled) {
    return;
  }
  runStartupHistoryReplay({ previousStatus, reason }).catch((error) => {
    console.warn(`Photon/Spectrum startup replay unavailable after ${reason}: ${error.message}`);
  });

  const delayMs = config.imessage.spectrum.startupReplayDelayMs;
  if (!delayMs || delayMs <= 0) {
    return;
  }
  const timer = setTimeout(() => {
    startupReplayTimers.delete(timer);
    runStartupHistoryReplay({ previousStatus, reason: `${reason} delayed ${delayMs}ms` }).catch((error) => {
      console.warn(`Photon/Spectrum delayed startup replay unavailable after ${reason}: ${error.message}`);
    });
  }, delayMs);
  startupReplayTimers.add(timer);
  timer.unref?.();
}

async function runStartupHistoryReplay({ previousStatus, reason }) {
  await enqueueStartupHistoryReplay({ previousStatus });
  await drainPendingDeliveries(reason);
}

async function enqueueStartupHistoryReplay({ previousStatus: status }) {
  if (!config.imessage.spectrum.startupReplayEnabled) {
    return;
  }
  await enqueuePreviousStatusReplay({ previousStatus: status });

  const candidateSpaceIds = startupReplaySpaceIds({ config, previousStatus: status });
  if (candidateSpaceIds.length === 0) {
    return;
  }

  const clientSet = await createPhotonImessageClients({
    spectrum: config.imessage.spectrum
  });
  try {
    for (const target of config.targets) {
      const delivered = await readDeliveredMessages(target);
      const after = new Date(Date.now() - config.imessage.spectrum.startupReplayLookbackMs).toISOString();
      for (const spaceId of candidateSpaceIds) {
        let page = null;
        try {
          page = await listPhotonMessagesInChat({
            spectrum: config.imessage.spectrum,
            chatGuid: spaceId,
            pageSize: config.imessage.spectrum.startupReplayPageSize,
            after,
            clientSet
          });
        } catch (error) {
          console.warn(`Photon/Spectrum startup replay could not read ${spaceId}: ${error.message}`);
          continue;
        }
        const messages = [...(page.messages || [])]
          .filter((record) => record?.messageId && !delivered.messageIds.has(record.messageId))
          .sort((left, right) => Date.parse(left.receivedAt || 0) - Date.parse(right.receivedAt || 0));
        for (const photonRecord of messages) {
          const replay = spectrumReplayMessageFromPhotonRecord(photonRecord);
          if (!matchesSpectrumTarget({ space: replay.space, message: replay.message, target })) {
            continue;
          }
          const content = await materializeSpectrumContent({
            message: replay.message,
            attachmentDir: config.imessage.spectrum.attachmentDir
          });
          const memory = await connectorMemoryForSpectrum({
            space: replay.space,
            message: replay.message,
            content,
            target
          });
          const text = formatSpectrumMessageForCodex({
            space: replay.space,
            message: replay.message,
            target,
            content,
            contacts,
            connectorGuidance: config.codex.connectorSkillPrompt,
            memory
          });
          const queued = await deliveryQueue.upsert(createPendingDeliveryRecord({
            target,
            space: replay.space,
            message: replay.message,
            codexText: text,
            eventLogRecord: eventLogRecordFromSpectrumMessage({
              space: replay.space,
              message: replay.message,
              target,
              content,
              routeResult: null,
              contacts
            }),
            source: "startup-history"
          }));
          console.log(`Queued undelivered Photon/Spectrum iMessage ${queued.messageId} for ${target.id} from startup history.`);
        }
      }
    }
  } finally {
    await clientSet.closeAll();
  }
}

async function enqueuePreviousStatusReplay({ previousStatus: status }) {
  const summaries = previousStatusReplayMessages(status);
  if (summaries.length === 0) {
    return;
  }
  const lookbackCutoff = Date.now() - config.imessage.spectrum.startupReplayLookbackMs;

  for (const summary of summaries) {
    const receivedTime = Date.parse(summary.receivedAt || summary.seenAt || 0);
    if (Number.isFinite(receivedTime) && receivedTime < lookbackCutoff) {
      continue;
    }
    const replay = spectrumReplayMessageFromStatusSummary(summary);
    for (const target of targetsForStatusReplay(summary)) {
      const delivered = await readDeliveredMessages(target);
      if (delivered.messageIds.has(replay.message.id)) {
        continue;
      }
      if (!matchesSpectrumTarget({ space: replay.space, message: replay.message, target })) {
        continue;
      }
      const content = await materializeSpectrumContent({
        message: replay.message,
        attachmentDir: config.imessage.spectrum.attachmentDir
      });
      const memory = await connectorMemoryForSpectrum({
        space: replay.space,
        message: replay.message,
        content,
        target
      });
      const text = formatSpectrumMessageForCodex({
        space: replay.space,
        message: replay.message,
        target,
        content,
        contacts,
        connectorGuidance: config.codex.connectorSkillPrompt,
        memory
      });
      const queued = await deliveryQueue.upsert(createPendingDeliveryRecord({
        target,
        space: replay.space,
        message: replay.message,
        codexText: text,
        eventLogRecord: eventLogRecordFromSpectrumMessage({
          space: replay.space,
          message: replay.message,
          target,
          content,
          routeResult: null,
          contacts
        }),
        source: "startup-status"
      }));
      console.log(`Queued undelivered Photon/Spectrum iMessage ${queued.messageId} for ${target.id} from startup status.`);
    }
  }
}

function targetForDelivery(record) {
  return config.targets.find((target) => target.id === record.targetId) || {
    id: record.targetId,
    threadId: record.targetThreadId,
    cwd: record.targetCwd,
    eventLogPath: record.eventLogRecord?.eventLogPath || null
  };
}

async function handleBridgeRequest(request) {
  if (request.method === "status") {
    return {
      status: "online",
      knownSpaceIds: [...knownSpaces.keys()],
      lastInboundAt,
      lastMatchedInboundAt,
      receiveLoop: receiveLoopStatus()
    };
  }
  if (request.method === "send") {
    const sent = await runBridgeAppOperation("send", () => sendSpectrumMessage({
      app,
      target: request.target || {},
      text: request.text || "",
      files: request.attachments || [],
      knownSpaces,
      typing: config.imessage.typing,
      photonFallback: createPhotonFallback()
    }), { retryOnChannelShutdown: true });
    return {
      status: "sent",
      sent: summarizeSent(sent)
    };
  }
  if (request.method === "react") {
    return runBridgeAppOperation("react", () => reactToSpectrumMessage({
      app,
      target: request.target || {},
      messageId: request.messageId,
      reaction: request.reaction,
      knownSpaces,
      photonFallback: createPhotonFallback()
    }), { retryOnChannelShutdown: true });
  }
  if (request.method === "lookupMessage") {
    return runBridgeAppOperation("lookupMessage", () => lookupSpectrumMessage({
      target: request.target || {},
      messageId: request.messageId
    }), { retryOnChannelShutdown: true });
  }
  if (request.method === "startTyping") {
    const space = await runBridgeAppOperation("startTyping", () => resolveSpectrumSpace({
      app,
      target: request.target || {},
      knownSpaces
    }), { retryOnChannelShutdown: true });
    const key = space.id;
    stopActiveTyping(key);
    const stop = startSpectrumTypingLoop({
      space,
      typing: config.imessage.typing,
      maxMs: request.durationMs,
      onStop: () => activeTypingStops.delete(key)
    });
    activeTypingStops.set(key, stop);
    return { status: "started", spaceId: space.id };
  }
  if (request.method === "stopTyping") {
    const result = await runBridgeAppOperation("stopTyping", () => stopSpectrumTyping({
      app,
      target: request.target || {},
      knownSpaces
    }), { retryOnChannelShutdown: true });
    stopActiveTyping(result.spaceId);
    return result;
  }
  throw new Error(`Unsupported Photon/Spectrum bridge method: ${request.method}`);
}

async function lookupSpectrumMessage({ target, messageId }) {
  const cleanedMessageId = spectrumReactionTargetMessageId(messageId);
  if (!cleanedMessageId) {
    throw new Error("Photon/Spectrum message lookup requires messageId.");
  }
  const space = await resolveSpectrumSpace({
    app,
    target,
    knownSpaces
  });
  if (typeof space.getMessage !== "function") {
    return lookupPhotonMessageFallback({
      target,
      messageId: cleanedMessageId,
      reason: new Error(`Photon/Spectrum space ${space.id} does not expose message lookup.`)
    });
  }
  let found = null;
  try {
    found = await space.getMessage(cleanedMessageId);
  } catch (error) {
    if (isPhotonBackpressureError(error)) {
      throw new Error(`Photon/Spectrum could not load message ${cleanedMessageId} in ${space.id}: ${error.message}`);
    }
    return lookupPhotonMessageFallback({
      target,
      messageId: cleanedMessageId,
      reason: new Error(`Photon/Spectrum could not load message ${cleanedMessageId} in ${space.id}: ${error.message}`)
    });
  }
  if (!found) {
    return lookupPhotonMessageFallback({
      target,
      messageId: cleanedMessageId,
      reason: new Error(`Photon/Spectrum message ${cleanedMessageId} was not found in ${space.id}.`),
      notFoundStatus: {
        status: "not_found",
        spaceId: space.id,
        messageId: cleanedMessageId
      }
    });
  }
  return {
    status: "found",
    spaceId: space.id,
    message: await summarizeSpectrumMessage({
      message: found,
      attachmentDir: config.imessage.spectrum.attachmentDir
    })
  };
}

async function maybeMarkRead({ space, message }) {
  if (!config.imessage.sendReadReceipts) {
    return;
  }
  try {
    const result = await readSpectrumMessage({ space, message });
    console.log(`Marked Photon/Spectrum iMessage ${message.id} read via ${result.method}.`);
  } catch (error) {
    if (isPhotonBackpressureError(error)) {
      console.warn(`Photon/Spectrum read receipt unavailable for ${message.id}: ${error.message}; Photon fallback skipped to avoid another upstream request.`);
      return;
    }
    try {
      const result = await markPhotonChatRead({
        spectrum: config.imessage.spectrum,
        chatGuid: space.id,
        phone: space.phone
      });
      console.log(`Marked Photon/Spectrum iMessage ${message.id} read via ${result.method}.`);
    } catch (fallbackError) {
      console.warn(`Photon/Spectrum read receipt unavailable for ${message.id}: ${error.message}; Photon fallback failed: ${fallbackError.message}`);
    }
  }
}

function scheduleReplayPostRouteEffects({ record }) {
  Promise.resolve()
    .then(() => maybeMarkReadRecord({ record }))
    .catch((error) => {
      console.warn(`Photon/Spectrum replay read receipt failed after routing ${record.messageId}: ${error.message}`);
    });
}

async function maybeMarkReadRecord({ record }) {
  if (!config.imessage.sendReadReceipts || !record.spaceId) {
    return;
  }
  const result = await markPhotonChatRead({
    spectrum: config.imessage.spectrum,
    chatGuid: record.spaceId,
    phone: null
  });
  console.log(`Marked replayed Photon/Spectrum iMessage ${record.messageId} read via ${result.method}.`);
}

function createPhotonFallback() {
  return {
    sendTextReply: sendPhotonTextReplyFallback,
    react: sendPhotonReactionFallback
  };
}

async function sendPhotonTextReplyFallback({ target, text, replyToMessageId, reason }) {
  const chatGuid = photonChatGuidFromSpectrumTarget(target);
  if (!chatGuid) {
    throw reason || new Error("Photon/Spectrum reply fallback requires to or spaceId.");
  }
  const sent = await sendPhotonTextMessage({
    spectrum: config.imessage.spectrum,
    chatGuid,
    phone: target.phone,
    text,
    replyToMessageId
  });
  console.warn(`Photon/Spectrum reply used Photon native fallback in ${chatGuid}: ${reason?.message || "Spectrum reply target was unavailable"}`);
  return sent;
}

async function sendPhotonReactionFallback({ target, messageId, reaction, reason }) {
  const chatGuid = photonChatGuidFromSpectrumTarget(target);
  if (!chatGuid) {
    throw reason || new Error("Photon/Spectrum reaction fallback requires to or spaceId.");
  }
  const result = await sendPhotonReaction({
    spectrum: config.imessage.spectrum,
    chatGuid,
    phone: target.phone,
    messageId,
    reaction
  });
  console.warn(`Photon/Spectrum reaction used Photon native fallback in ${chatGuid}: ${reason?.message || "Spectrum reaction target was unavailable"}`);
  return result;
}

async function lookupPhotonMessageFallback({ target, messageId, reason, notFoundStatus = null }) {
  const chatGuid = photonChatGuidFromSpectrumTarget(target);
  try {
    const found = await getPhotonMessage({
      spectrum: config.imessage.spectrum,
      chatGuid,
      messageId,
      phone: target.phone
    });
    return {
      status: "found",
      historySource: "photon",
      fallbackReason: reason?.message || null,
      spaceId: found.conversationId || chatGuid || null,
      messageId,
      message: found
    };
  } catch (error) {
    if (notFoundStatus) {
      return {
        ...notFoundStatus,
        photonFallbackError: error.message,
        fallbackReason: reason?.message || null
      };
    }
    throw new Error(`${reason?.message || `Photon/Spectrum could not load message ${messageId}`}; Photon fallback failed: ${error.message}`);
  }
}

function startSpectrumTypingLoop({ space, typing, maxMs = null, onStop = null }) {
  if (!typing?.enabled || typeof space.startTyping !== "function") {
    return () => {};
  }
  let stopped = false;
  let interval = null;

  const pulse = async () => {
    if (stopped) return;
    try {
      await space.startTyping();
    } catch (error) {
      console.warn(`Photon/Spectrum typing indicator unavailable for ${space.id}: ${error.message}`);
      stop();
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval != null) clearInterval(interval);
    if (typeof space.stopTyping === "function") {
      space.stopTyping().catch((error) => {
        console.warn(`Photon/Spectrum typing stop failed for ${space.id}: ${error.message}`);
      });
    }
    onStop?.();
  };

  pulse();
  interval = setInterval(pulse, typing.intervalMs || 6000);
  setTimeout(stop, normalizeDurationMs(maxMs, typing.maxMs || 1800000));
  return stop;
}

function startTypingWhileThinking({ space, typing }) {
  if (typing?.showWhileThinking !== true) {
    return () => {};
  }
  return startSpectrumTypingLoop({ space, typing });
}

function stopActiveTyping(spaceId) {
  if (!spaceId || !activeTypingStops.has(spaceId)) {
    return;
  }
  activeTypingStops.get(spaceId)();
}

function normalizeDurationMs(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function keepTypingUntilTurnCompletes({ target, routeResult, message }) {
  if (!routeResult.turnId) {
    return null;
  }
  const rolloutPath = target.rolloutPath || await findThreadRolloutPath(target.threadId);
  const status = await waitForTurnCompletion({
    rolloutPath,
    turnId: routeResult.turnId,
    timeoutMs: config.imessage.typing.completionTimeoutMs,
    pollMs: config.imessage.typing.completionPollMs,
    stopOnToolCallEnd: [{
      server: "imessage-codex",
      tools: ["imessage_send_message", "imessage_send_reaction"]
    }]
  });
  if (status.completed) {
    console.log(`Codex turn ${routeResult.turnId} completed for Photon/Spectrum iMessage ${message.id}.`);
    return status;
  } else if (status.outboundToolCallEnded) {
    console.log(`Stopped Photon/Spectrum typing for ${message.id} after ${status.toolCall.server}/${status.toolCall.tool}.`);
    const finalStatus = await waitForTurnCompletion({
      rolloutPath,
      turnId: routeResult.turnId,
      timeoutMs: Math.min(config.imessage.typing.completionTimeoutMs, 120000),
      pollMs: config.imessage.typing.completionPollMs
    });
    if (finalStatus.completed) {
      console.log(`Codex turn ${routeResult.turnId} completed for Photon/Spectrum iMessage ${message.id}.`);
      return finalStatus;
    }
    return status;
  } else {
    console.warn(`Stopped waiting for Codex turn ${routeResult.turnId} (${status.reason}) for Photon/Spectrum iMessage ${message.id}.`);
    return status;
  }
}

async function recordSpectrumConnectorTurn({ target, routeResult, completionStatus, space, message, prompt }) {
  try {
    const result = await recordWakefieldConnectorTurn({
      target,
      connector: "imessage",
      messageId: message.id,
      prompt,
      routeResult,
      completionStatus,
      scope: {
        connector: "imessage",
        sender: message.sender?.id || null,
        conversation: space?.id || null,
        channel: space?.id || null,
        room: spectrumSpaceType(space) === "group" ? space?.id || null : null
      }
    });
    if (!result.ok) {
      console.warn(`Wakefield memory record skipped for Photon/Spectrum iMessage ${message.id}: ${result.reason}`);
    }
  } catch (error) {
    console.warn(`Wakefield memory record failed for Photon/Spectrum iMessage ${message.id}: ${error.message}`);
  }
}

async function appendEventLog(target, record) {
  if (!target.eventLogPath) {
    return;
  }
  await fs.mkdir(path.dirname(target.eventLogPath), { recursive: true });
  await fs.appendFile(target.eventLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function deliveryAlreadyLogged(target, record) {
  if (!record.messageId) {
    return false;
  }
  const delivered = await readDeliveredMessages(target);
  return delivered.messageIds.has(record.messageId);
}

async function readDeliveredMessages(target) {
  const result = {
    messageIds: new Set(),
    latestReceivedAt: null
  };
  if (!target.eventLogPath) {
    return result;
  }
  let text = "";
  try {
    text = await fs.readFile(target.eventLogPath, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") {
      return result;
    }
    throw error;
  }
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      continue;
    }
    let record = null;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (record?.platform !== "imessage" || record?.provider !== "spectrum" || record?.target_id !== target.id) {
      continue;
    }
    if (record.message_id) {
      result.messageIds.add(record.message_id);
    }
    if (record.received_at) {
      const current = Date.parse(record.received_at);
      const previous = Date.parse(result.latestReceivedAt || 0);
      if (Number.isFinite(current) && (!Number.isFinite(previous) || current > previous)) {
        result.latestReceivedAt = new Date(current).toISOString();
      }
    }
  }
  return result;
}

async function readJsonFile(filePath) {
  if (!filePath) {
    return null;
  }
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return null;
    }
    throw error;
  }
}

function summarizeSent(sent) {
  const values = Array.isArray(sent) ? sent : [sent];
  return values.filter(Boolean).map((message) => ({
    id: message.id,
    platform: message.platform,
    timestamp: message.timestamp instanceof Date ? message.timestamp.toISOString() : message.timestamp
  }));
}

async function writeStatus(status) {
  const statusPath = config.imessage.spectrum.statusPath;
  if (!statusPath) return;
  const pendingDeliveryCount = await deliveryQueue.countPending().catch(() => null);
  await fs.mkdir(path.dirname(statusPath), { recursive: true });
  await fs.writeFile(statusPath, `${JSON.stringify({
    status,
    updatedAt: new Date().toISOString(),
    provider: "spectrum",
    ipcSocketPath: config.imessage.spectrum.ipcSocketPath,
    knownSpaceIds: [...knownSpaces.keys()],
    lastInboundAt,
    lastMatchedInboundAt,
    lastInboundMessage,
    lastMatchedInboundMessage,
    pendingDeliveryCount,
    receiveLoop: receiveLoopStatus()
  }, null, 2)}\n`, "utf8");
}

async function writeCurrentStatus() {
  await writeStatus(spectrumServiceStatusForReceiveLoop(receiveLoop.state));
}

async function runProviderOperation(label, operation) {
  try {
    return await withSpectrumOperationTimeout(operation, {
      label,
      timeoutMs: config.imessage.spectrum.appOperationTimeoutMs
    });
  } catch (error) {
    if (isSpectrumOperationTimeoutError(error)) {
      await failReceiveLoopAndExit(error);
      return new Promise(() => {});
    }
    throw error;
  }
}

async function failReceiveLoopAndExit(error) {
  receiveLoop.state = "failed";
  receiveLoop.lastErrorAt = new Date().toISOString();
  receiveLoop.lastError = error.stack || error.message;
  receiveLoop.lastRestartReason = "operation_timeout";
  await writeStatus("receive-loop-failed").catch((statusError) => {
    console.warn(`Photon/Spectrum status update failed during fatal receive-loop timeout: ${statusError.message}`);
  });
  console.error(`Photon/Spectrum receive loop timed out; exiting for launchd restart: ${error.stack || error.message}`);
  await releaseProcessLock().catch((lockError) => {
    console.warn(`Photon/Spectrum process lock release failed during fatal timeout: ${lockError.message}`);
  });
  process.exit(1);
}

async function shutdown(signal) {
  console.log(`Photon/Spectrum iMessage connector shutting down after ${signal}.`);
  shuttingDown = true;
  receiveLoop.state = "stopping";
  try {
    if (statusHeartbeat) {
      clearInterval(statusHeartbeat);
    }
    if (deliveryRetryTimer) {
      clearInterval(deliveryRetryTimer);
    }
    for (const timer of startupReplayTimers) {
      clearTimeout(timer);
    }
    startupReplayTimers.clear();
    await writeStatus("offline");
    await stopIpcServer();
    await app?.stop?.();
    await releaseProcessLock();
  } finally {
    process.exit(0);
  }
}

function startupReplaySpaceIds({ config, previousStatus }) {
  const values = new Set();
  for (const value of previousStatus?.knownSpaceIds || []) {
    addSpaceId(values, value);
  }
  addSpaceId(values, previousStatus?.lastInboundMessage?.spaceId);
  addSpaceId(values, previousStatus?.lastMatchedInboundMessage?.spaceId);
  for (const value of getAllowedOutboundSpaceIds(config)) {
    addSpaceId(values, value);
  }
  for (const target of config.targets || []) {
    for (const value of target.allowedSpaceIds || []) {
      addSpaceId(values, value);
    }
    for (const value of target.allowedChatGuids || []) {
      addSpaceId(values, value);
    }
    for (const value of target.allowedAddresses || []) {
      addDirectSpaceForAddress(values, value);
    }
  }
  for (const value of getAllowedOutboundAddresses(config)) {
    addDirectSpaceForAddress(values, value);
  }
  return [...values];
}

function addSpaceId(values, value) {
  const normalized = String(value || "").trim();
  if (normalized) {
    values.add(normalized);
  }
}

function addDirectSpaceForAddress(values, value) {
  const address = normalizeAddress(value);
  if (address) {
    values.add(`any;-;${directSpaceAddress(address)}`);
  }
}

function photonChatGuidFromSpectrumTarget(target = {}) {
  if (target.spaceId) {
    return target.spaceId;
  }
  const address = normalizeAddress(target.to || target.sender);
  if (address) {
    return `any;-;${directSpaceAddress(address)}`;
  }
  return null;
}

function directSpaceAddress(address) {
  if (address.startsWith("+") || address.includes("@")) {
    return address;
  }
  const digits = address.replace(/\D/g, "");
  if (digits.length === 10) {
    return `+1${digits}`;
  }
  if (digits.length === 11 && digits.startsWith("1")) {
    return `+${digits}`;
  }
  return address;
}

function previousStatusReplayMessages(status) {
  const seen = new Set();
  const result = [];
  for (const summary of [status?.lastInboundMessage, status?.lastMatchedInboundMessage]) {
    if (!summary?.messageId || !summary?.spaceId || summary.direction === "outbound") {
      continue;
    }
    const key = `${summary.spaceId}:${summary.messageId}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    result.push(summary);
  }
  return result;
}

function targetsForStatusReplay(summary) {
  const targetIds = new Set((summary.targetIds || []).filter(Boolean));
  if (targetIds.size === 0) {
    return config.targets;
  }
  return config.targets.filter((target) => targetIds.has(target.id));
}

function spectrumReplayMessageFromPhotonRecord(record) {
  const space = {
    id: record.conversationId,
    type: record.chatType || (String(record.conversationId || "").includes(";+;") ? "group" : "dm"),
    phone: null
  };
  const reaction = record.reactionTo || null;
  const content = reaction
    ? {
        type: "reaction",
        emoji: reaction.reaction || "unknown",
        target: {
          id: reaction.messageId,
          direction: "inbound",
          platform: "iMessage",
          timestamp: null,
          sender: null,
          content: reaction.text ? { type: "text", text: reaction.text } : { type: "custom", raw: { terminal_type: "reaction-target" } }
        }
      }
    : { type: "text", text: record.text || "" };
  return {
    space,
    message: {
      id: record.messageId,
      direction: record.sender === "agent" || record.senderId === "me" ? "outbound" : "inbound",
      platform: "iMessage",
      timestamp: record.receivedAt,
      sender: record.senderId ? { id: record.senderId } : null,
      content
    }
  };
}

function spectrumReplayMessageFromStatusSummary(summary) {
  const space = {
    id: summary.spaceId,
    type: String(summary.spaceId || "").includes(";+;") ? "group" : "dm",
    phone: null
  };
  return {
    space,
    message: {
      id: summary.messageId,
      direction: summary.direction || "inbound",
      platform: "iMessage",
      timestamp: summary.receivedAt || summary.seenAt || new Date().toISOString(),
      sender: summary.sender ? { id: summary.sender } : null,
      content: contentFromStatusSummary(summary)
    }
  };
}

function contentFromStatusSummary(summary) {
  if (summary.contentType === "reaction" || /:reaction:/.test(summary.messageId)) {
    const targetId = String(summary.messageId).split(":reaction:")[0] || null;
    return {
      type: "reaction",
      emoji: reactionEmojiFromStatusText(summary.text) || "unknown",
      target: {
        id: targetId,
        direction: "inbound",
        platform: "iMessage",
        timestamp: null,
        sender: null,
        content: { type: "custom", raw: { terminal_type: "reaction-target" } }
      }
    };
  }
  return { type: "text", text: summary.text || "" };
}

function reactionEmojiFromStatusText(text) {
  const match = String(text || "").match(/^\[Reaction:\s*(.+?)\]$/);
  return match?.[1] || null;
}

function botProcessLockName(config) {
  const targetKey = config.targets
    .map((target) => `${target.id}:${target.threadId}`)
    .sort()
    .join(",");
  return `imessage-spectrum-bot:${targetKey || "no-targets"}`;
}

function receiveLoopStatus() {
  return {
    state: receiveLoop.state,
    startedAt: receiveLoop.startedAt,
    lastActivityAt: receiveLoop.lastActivityAt,
    lastErrorAt: receiveLoop.lastErrorAt,
    lastError: receiveLoop.lastError,
    restartCount: receiveLoop.restartCount,
    maxAgeMs: config.imessage.spectrum.receiveLoopMaxAgeMs,
    appOperationTimeoutMs: config.imessage.spectrum.appOperationTimeoutMs,
    lastRestartReason: receiveLoop.lastRestartReason,
    rotationRequestedAt: receiveLoop.rotationRequestedAt,
    restartStartedAt: receiveLoop.restartStartedAt,
    lastRestartCompletedAt: receiveLoop.lastRestartCompletedAt
  };
}

function statusMessageSummary({ space, message, seenAt }) {
  return {
    messageId: message.id || null,
    spaceId: space.id || null,
    receivedAt: normalizeStatusTimestamp(message.timestamp),
    seenAt,
    direction: message.direction || null,
    sender: message.sender?.id || null,
    contentType: message.content?.type || null,
    text: statusTextFromContent(message.content)
  };
}

function statusTextFromContent(content) {
  if (!content) {
    return "";
  }
  if (content.type === "text") {
    return content.text || "";
  }
  if (content.type === "reply") {
    return statusTextFromContent(content.content);
  }
  if (content.type === "group") {
    return (content.items || [])
      .map((item) => statusTextFromContent(item.content || item))
      .filter(Boolean)
      .join("\n");
  }
  if (content.type === "reaction") {
    return `[Reaction: ${content.emoji || "unknown"}]`;
  }
  if (content.type === "attachment" || content.type === "voice") {
    return `[${content.type === "voice" ? "Voice note" : "Attachment"}: ${content.name || "attachment"}]`;
  }
  return "";
}

function normalizeStatusTimestamp(value) {
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (value) {
    const date = new Date(value);
    if (Number.isFinite(date.getTime())) {
      return date.toISOString();
    }
  }
  return null;
}
