#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import {
  getAllowedOutboundAddresses,
  getAllowedOutboundChatGuids,
  getAllowedOutboundChatIds,
  loadConnectorConfig,
  parseCliArgs
} from "./config.mjs";
import { loadContactResolver } from "./contact-resolver.mjs";
import {
  assertAdvancedBridgeReady,
  markImsgRead,
  startImsgTyping,
  startImsgWatch
} from "./imsg-cli.mjs";
import {
  eventLogRecordFromImessage,
  formatImessageMessageForCodex,
  imessageReplyTargetFromMessage,
  matchesTarget
} from "./imessage-message-format.mjs";
import { startCodexFocusMonitor } from "./imessage-focus.mjs";
import { sendTextToCodexTarget } from "@wakefield/connector-shared/codex-router.mjs";
import { findThreadRolloutPath, waitForTurnCompletion } from "@wakefield/connector-shared/codex-rollout-watch.mjs";
import { acquireSingletonProcessLock } from "@wakefield/connector-shared/lock.mjs";
import { wakefieldMemoryForConnectorMessage } from "@wakefield/connector-shared/wakefield-memory.mjs";

const args = parseCliArgs();
if (args.help) {
  console.log("Usage: imessage-codex-bot --config packages/imessage-spectrum/config.local.json");
  process.exit(0);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
const contacts = await loadContactResolver(config.identity.contactsPath);
console.log(`iMessage Codex connector starting with imsg at ${config.imessage.imsgPath}.`);
console.log(`Allowed outbound iMessage addresses: ${[...getAllowedOutboundAddresses(config)].join(", ") || "(none)"}`);
console.log(`Allowed outbound iMessage chat ids: ${[...getAllowedOutboundChatIds(config)].join(", ") || "(none)"}`);
console.log(`Allowed outbound iMessage chat GUIDs: ${[...getAllowedOutboundChatGuids(config)].join(", ") || "(none)"}`);
const advancedBridge = await assertAdvancedBridgeReady({ imessage: config.imessage });
if (advancedBridge.required) {
  console.log("iMessage advanced bridge ready for typing indicators and read receipts.");
}
const releaseProcessLock = await acquireSingletonProcessLock(botProcessLockName(config), {
  lockRoot: config.bot.processLockRoot,
  staleMs: config.bot.processLockStaleMs
});
const state = await readState(config.imessage.statePath);
let stopFocusMonitor = () => {};
let stopWatch = () => {};

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

stopFocusMonitor = startCodexFocusMonitor({
  targets: config.targets,
  focus: config.imessage.focus
});
stopWatch = startImsgWatch({
  imessage: config.imessage,
  state,
  onMessage: (message) => {
    handleImessage(message).catch((error) => {
      console.error(`Failed to route iMessage row ${message?.id ?? "unknown"}: ${error.stack || error.message}`);
    });
  },
  onExit: ({ code, signal }) => {
    if (code !== 0 && signal == null) {
      console.error(`imsg watch exited with code ${code}.`);
    }
  }
});
console.log("iMessage Codex connector online.");

async function handleImessage(message) {
  const matchedTargets = config.targets.filter((target) => matchesTarget(message, target));
  if (matchedTargets.length === 0) {
    await advanceState(message.id);
    return;
  }

  for (const target of matchedTargets) {
    const replyTarget = imessageReplyTargetFromMessage(message);
    const memory = await connectorMemoryForImessage({ message, target });
    const text = formatImessageMessageForCodex({
      message,
      target,
      contacts,
      connectorGuidance: config.codex.connectorSkillPrompt,
      memory
    });
    let stopTyping = () => {};
    try {
      const routeResult = await sendTextToCodexTarget({
        target,
        text,
        mode: "auto",
        codex: config.codex
      });
      await maybeMarkRead({ message, replyTarget });
      // Read follows successful injection; typing follows a tracked Codex turn.
      if (routeResult.turnId) {
        stopTyping = startImsgTyping({
          imessage: config.imessage,
          target: replyTarget
        });
      }
      await keepTypingUntilTurnCompletes({ target, routeResult, message });
      await appendEventLog(target, eventLogRecordFromImessage({ message, target, routeResult, contacts }));
      await advanceState(message.id);
      console.log(`Routed iMessage row ${message.id} to ${target.id} via Codex ${routeResult.action}.`);
    } finally {
      stopTyping();
    }
  }
}

async function connectorMemoryForImessage({ message, target }) {
  try {
    return await wakefieldMemoryForConnectorMessage({
      target,
      query: [
        message.text,
        (message.attachments || []).map((attachment) => attachment.transfer_name || attachment.filename || attachment.converted_mime_type || attachment.mime_type)
      ].flat().filter(Boolean).join("\n"),
      scope: {
        connector: "imessage",
        sender: message.sender || null,
        conversation: message.chat_guid || message.chat_identifier || (message.chat_id == null ? null : String(message.chat_id)),
        channel: message.chat_guid || message.chat_identifier || (message.chat_id == null ? null : String(message.chat_id)),
        room: message.is_group ? message.chat_guid || message.chat_identifier || (message.chat_id == null ? null : String(message.chat_id)) : null
      }
    });
  } catch (error) {
    console.warn(`Wakefield memory unavailable for iMessage row ${message.id}: ${error.message}`);
    return "";
  }
}

async function maybeMarkRead({ message, replyTarget }) {
  if (!config.imessage.sendReadReceipts) {
    return;
  }
  try {
    await markImsgRead({
      imessage: config.imessage,
      target: replyTarget
    });
  } catch (error) {
    console.warn(`iMessage read receipt unavailable for row ${message.id}: ${error.message}`);
  }
}

async function keepTypingUntilTurnCompletes({ target, routeResult, message }) {
  if (!routeResult.turnId) {
    return;
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
    console.log(`Codex turn ${routeResult.turnId} completed for iMessage row ${message.id}.`);
  } else if (status.outboundToolCallEnded) {
    console.log(`Stopped iMessage typing for row ${message.id} after ${status.toolCall.server}/${status.toolCall.tool}.`);
  } else {
    console.warn(`Stopped waiting for Codex turn ${routeResult.turnId} (${status.reason}) for iMessage row ${message.id}.`);
  }
}

async function appendEventLog(target, record) {
  if (!target.eventLogPath) {
    return;
  }
  await fs.mkdir(path.dirname(target.eventLogPath), { recursive: true });
  await fs.appendFile(target.eventLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function readState(statePath) {
  if (!statePath) {
    return {};
  }
  try {
    return JSON.parse(await fs.readFile(statePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") {
      return {};
    }
    throw new Error(`Failed to read iMessage connector state at ${statePath}: ${error.message}`);
  }
}

async function advanceState(rowId) {
  const numericRowId = Number(rowId);
  if (!Number.isFinite(numericRowId) || numericRowId <= Number(state.lastRowId || 0)) {
    return;
  }
  state.lastRowId = numericRowId;
  state.updatedAt = new Date().toISOString();
  if (!config.imessage.statePath) {
    return;
  }
  await fs.mkdir(path.dirname(config.imessage.statePath), { recursive: true });
  await fs.writeFile(config.imessage.statePath, `${JSON.stringify(state, null, 2)}\n`, "utf8");
}

async function shutdown(signal) {
  console.log(`iMessage Codex connector shutting down after ${signal}.`);
  try {
    stopWatch();
    await stopFocusMonitor();
    await releaseProcessLock();
  } finally {
    process.exit(0);
  }
}

function botProcessLockName(config) {
  const targetKey = config.targets
    .map((target) => `${target.id}:${target.threadId}`)
    .sort()
    .join(",");
  return `imessage-codex-bot:${targetKey || "no-targets"}`;
}
