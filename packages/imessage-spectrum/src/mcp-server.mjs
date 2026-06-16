#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getAllowedOutboundAddresses,
  getAllowedOutboundChatGuids,
  getAllowedOutboundChatIds,
  getAllowedOutboundSpaceIds,
  loadConnectorConfig,
  normalizeAddress,
  normalizeChatId,
  parseCliArgs
} from "./config.mjs";
import {
  advancedBridgeReadyFromStatusRows,
  imsgStatus,
  readImsgHistory,
  sendImsgMessage,
  startImsgTyping,
  stopImsgTyping
} from "./imsg-cli.mjs";
import { readReceiptStatus } from "./imessage-receipts.mjs";
import { listPhotonMessagesInChat } from "./photon-history.mjs";
import { sendSpectrumBridgeRequest } from "./spectrum-ipc.mjs";
import {
  buildRecentMessageBatches,
  normalizeEventLogRecord,
  readJsonlRecords
} from "@wakefield/connector-shared/message-batches.mjs";

const args = parseCliArgs();
if (args.help) {
  console.log("Usage: imessage-codex-mcp --config packages/imessage-spectrum/config.local.json");
  process.exit(0);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
const allowedAddresses = getAllowedOutboundAddresses(config);
const allowedChatIds = getAllowedOutboundChatIds(config);
const allowedChatGuids = getAllowedOutboundChatGuids(config);
const allowedSpaceIds = getAllowedOutboundSpaceIds(config);
const activeImsgTypingStops = new Map();

const server = new McpServer({
  name: "imessage-codex-connector",
  version: "0.1.0"
});

server.registerTool(
  "imessage_bridge_status",
  {
    title: "iMessage Bridge Status",
    description: "Show the configured iMessage connector allowlists and imsg advanced-feature status.",
    inputSchema: {}
  },
  async () => {
    let imsg = null;
    let imsgError = null;
    let spectrumBridge = null;
    let spectrumBridgeError = null;
    if (config.imessage.provider === "imsg") {
      try {
        imsg = await imsgStatus({ imessage: config.imessage });
      } catch (error) {
        imsgError = error.message;
      }
    } else {
      try {
        spectrumBridge = await sendSpectrumBridgeRequest({
          spectrum: config.imessage.spectrum,
          request: { method: "status" },
          timeoutMs: 3000
        });
      } catch (error) {
        spectrumBridgeError = error.message;
      }
    }
    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          provider: config.imessage.provider,
          imsgPath: config.imessage.imsgPath,
          databasePath: config.imessage.databasePath,
          spectrum: {
            projectIdConfigured: Boolean(config.imessage.spectrum.projectId),
            projectSecretConfigured: Boolean(config.imessage.spectrum.projectSecret),
            ipcSocketPath: config.imessage.spectrum.ipcSocketPath,
            attachmentDir: config.imessage.spectrum.attachmentDir,
            allowOutboundToKnownSpaces: config.imessage.spectrum.allowOutboundToKnownSpaces
          },
          outboundAddresses: [...allowedAddresses],
          outboundChatIds: [...allowedChatIds],
          outboundChatGuids: [...allowedChatGuids],
          outboundSpaceIds: [...allowedSpaceIds],
          advancedBridgeRequired: config.imessage.advancedBridgeRequired,
          advancedBridgeReady: imsg ? advancedBridgeReadyFromStatusRows(imsg) : null,
          typingEnabled: config.imessage.typing.enabled,
          typingShowsWhileThinking: config.imessage.typing.showWhileThinking,
          sendReadReceipts: config.imessage.sendReadReceipts,
          imsgStatus: imsg,
          imsgStatusError: imsgError,
          spectrumBridge,
          spectrumBridgeError,
          targets: config.targets.map((target) => ({
            id: target.id,
            threadId: target.threadId,
            allowedAddresses: target.allowedAddresses,
            allowedChatIds: target.allowedChatIds,
            allowedChatGuids: target.allowedChatGuids,
            allowedSpaceIds: target.allowedSpaceIds,
            allowGroupChats: target.allowGroupChats
          }))
        }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "imessage_read_messages",
  {
    title: "Read iMessage Messages",
    description: "Read recent messages from an allowed iMessage chat id.",
    inputSchema: {
      chatId: z.union([z.string().min(1), z.number().int().positive()]),
      limit: z.number().int().min(1).max(100).optional(),
      includeAttachments: z.boolean().optional()
    }
  },
  async ({ chatId, limit = 20, includeAttachments = true }) => {
    if (config.imessage.provider === "spectrum") {
      throw new Error("For Photon/Spectrum history, use imessage_read_recent_batch with spaceId or chatGuid. The legacy imessage_read_messages tool is only for the local imsg provider.");
    }
    assertAllowed(allowedChatIds, normalizeChatId(chatId), "chat id");
    const rows = await readImsgHistory({
      imessage: config.imessage,
      chatId,
      limit,
      includeAttachments
    });
    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }]
    };
  }
);

server.registerTool(
  "imessage_lookup_message",
  {
    title: "Lookup iMessage Message",
    description: "Look up one Photon/Spectrum iMessage by message id in an allowed space.",
    inputSchema: {
      to: z.string().min(1).optional(),
      chatIdentifier: z.string().min(1).optional(),
      chatGuid: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      messageId: z.string().min(1)
    }
  },
  async ({ to, chatIdentifier, chatGuid, spaceId, phone, messageId }) => {
    const target = normalizeSendTarget({ to, chatIdentifier, chatGuid, spaceId, phone });
    if (config.imessage.provider !== "spectrum") {
      throw new Error("Photon/Spectrum message lookup is only exposed for the Spectrum iMessage provider.");
    }
    assertAllowedSpectrumSendTarget(target);
    const result = await sendSpectrumBridgeRequest({
      spectrum: config.imessage.spectrum,
      request: {
        method: "lookupMessage",
        target: spectrumTargetFromSendTarget(target),
        messageId
      },
      timeoutMs: 30000
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.registerTool(
  "imessage_read_recent_batch",
  {
    title: "Read Recent iMessage Batch",
    description: "Read the most recent logical chunk of prior iMessage context for an allowed conversation.",
    inputSchema: {
      to: z.string().min(1).optional(),
      chatId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
      chatIdentifier: z.string().min(1).optional(),
      chatGuid: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      pageToken: z.string().min(1).optional(),
      before: z.string().min(1).optional(),
      after: z.string().min(1).optional(),
      historyPageSize: z.number().int().min(1).max(100).optional(),
      batches: z.number().int().min(1).max(5).optional(),
      gapMinutes: z.number().min(5).max(240).optional(),
      maxMessages: z.number().int().min(1).max(100).optional()
    }
  },
  async ({
    to,
    chatId,
    chatIdentifier,
    chatGuid,
    spaceId,
    phone,
    pageToken,
    before,
    after,
    historyPageSize,
    batches = 1,
    gapMinutes = 45,
    maxMessages = 25
  }) => {
    const target = normalizeSendTarget({ to, chatId, chatIdentifier, chatGuid, spaceId, phone });
    if (config.imessage.provider === "spectrum") {
      assertAllowedSpectrumSendTarget(target);
      const photonPage = await listPhotonMessagesInChat({
        spectrum: config.imessage.spectrum,
        chatGuid: photonChatGuidFromTarget(target),
        phone: target.phone,
        pageSize: historyPageSize || defaultHistoryPageSize({ batches, maxMessages }),
        pageToken,
        before,
        after
      });
      const recentBatches = buildRecentMessageBatches(photonPage.messages, {
        batchCount: batches,
        gapMinutes,
        maxMessages
      });
      return {
        content: [{
          type: "text",
          text: JSON.stringify({
            status: recentBatches.length > 0 ? "found" : "not_found",
            provider: "spectrum",
            historySource: "photon",
            source: publicTarget(target),
            page: {
              chatGuid: photonPage.chatGuid,
              phone: photonPage.phone,
              pageSize: photonPage.pageSize,
              pageToken: photonPage.pageToken,
              nextPageToken: photonPage.nextPageToken,
              messagesFetched: photonPage.messages.length
            },
            chunking: {
              gapMinutes,
              maxMessages,
              batches
            },
            batches: recentBatches
          }, null, 2)
        }]
      };
    } else {
      assertAllowedImsgSendTarget(target);
    }

    const eventLogPaths = config.targets.map((configuredTarget) => configuredTarget.eventLogPath).filter(Boolean);
    const records = await readJsonlRecords(eventLogPaths);
    const messages = records
      .filter((record) => matchesImessageEventRecord(record, target))
      .map(normalizeEventLogRecord);
    const recentBatches = buildRecentMessageBatches(messages, {
      batchCount: batches,
      gapMinutes,
      maxMessages
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: recentBatches.length > 0 ? "found" : "not_found",
          provider: "imsg",
          historySource: "event_log",
          source: publicTarget(target),
          chunking: {
            gapMinutes,
            maxMessages,
            batches
          },
          batches: recentBatches
        }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "imessage_send_message",
  {
    title: "Send iMessage Message",
    description: "Send text and/or local file attachments to an allowed iMessage address or chat.",
    inputSchema: {
      to: z.string().min(1).optional(),
      chatId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
      chatIdentifier: z.string().min(1).optional(),
      chatGuid: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      replyToMessageId: z.string().min(1).optional(),
      text: z.string().optional(),
      attachments: z.array(z.string().min(1)).max(10).optional()
    }
  },
  async ({ to, chatId, chatIdentifier, chatGuid, spaceId, phone, replyToMessageId, text = "", attachments = [] }) => {
    const target = normalizeSendTarget({ to, chatId, chatIdentifier, chatGuid, spaceId, phone, replyToMessageId });
    if (config.imessage.provider === "spectrum") {
      assertAllowedSpectrumSendTarget(target);
      const reaction = parseReactionSendText(text);
      if (reaction) {
        if (!target.replyToMessageId) {
          throw new Error("Photon/Spectrum reaction sends require replyToMessageId.");
        }
        if (attachments.length > 0) {
          throw new Error("Photon/Spectrum reaction sends cannot include attachments.");
        }
        const result = await sendSpectrumBridgeRequest({
          spectrum: config.imessage.spectrum,
          request: {
            method: "react",
            target: spectrumTargetFromSendTarget(target),
            messageId: target.replyToMessageId,
            reaction
          },
          timeoutMs: 30000
        });
        return {
          content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
        };
      }
      const result = await sendSpectrumBridgeRequest({
        spectrum: config.imessage.spectrum,
        request: {
          method: "send",
          target: spectrumTargetFromSendTarget(target),
          text,
          attachments
        },
        timeoutMs: 120000
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }

    assertAllowedImsgSendTarget(target);
    const stopTyping = startImsgTyping({
      imessage: config.imessage,
      target
    });
    try {
      const sent = await sendImsgMessage({
        imessage: config.imessage,
        target,
        text,
        files: attachments
      });
      const receipts = [];
      for (const result of sent) {
        if (result.id || result.guid) {
          receipts.push(await readReceiptStatus({
            databasePath: config.imessage.databasePath,
            messageId: result.id,
            messageGuid: result.guid
          }).catch((error) => ({ found: false, error: error.message, id: result.id, guid: result.guid })));
        }
      }
      return {
        content: [{
          type: "text",
          text: JSON.stringify({ sent, receipts }, null, 2)
        }]
      };
    } finally {
      stopTyping();
    }
  }
);

server.registerTool(
  "imessage_send_reaction",
  {
    title: "Send iMessage Reaction",
    description: "Send a Photon/Spectrum iMessage tapback or emoji reaction to a specific message.",
    inputSchema: {
      to: z.string().min(1).optional(),
      chatIdentifier: z.string().min(1).optional(),
      chatGuid: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      messageId: z.string().min(1),
      reaction: z.string().min(1).describe("Tapback name such as like/love/laugh/question, or a literal emoji.")
    }
  },
  async ({ to, chatIdentifier, chatGuid, spaceId, phone, messageId, reaction }) => {
    const target = normalizeSendTarget({ to, chatIdentifier, chatGuid, spaceId, phone });
    if (config.imessage.provider !== "spectrum") {
      throw new Error("Programmatic reactions are only exposed for the Photon/Spectrum iMessage provider.");
    }
    assertAllowedSpectrumSendTarget(target);
    const result = await sendSpectrumBridgeRequest({
      spectrum: config.imessage.spectrum,
      request: {
        method: "react",
        target: spectrumTargetFromSendTarget(target),
        messageId,
        reaction
      },
      timeoutMs: 30000
    });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

server.registerTool(
  "imessage_receipt_status",
  {
    title: "iMessage Receipt Status",
    description: "Check local sent/delivered/read receipt fields for a specific Messages row id or GUID.",
    inputSchema: {
      messageId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
      messageGuid: z.string().min(1).optional()
    }
  },
  async ({ messageId, messageGuid }) => {
    if (config.imessage.provider === "spectrum") {
      throw new Error("Photon/Spectrum delivered/read receipt lookup is not exposed by this connector yet.");
    }
    const status = await readReceiptStatus({
      databasePath: config.imessage.databasePath,
      messageId,
      messageGuid
    });
    return {
      content: [{ type: "text", text: JSON.stringify(status, null, 2) }]
    };
  }
);

server.registerTool(
  "imessage_start_typing",
  {
    title: "Start iMessage Typing",
    description: "Start or refresh a typing indicator for an allowed iMessage target.",
    inputSchema: {
      to: z.string().min(1).optional(),
      chatId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
      chatIdentifier: z.string().min(1).optional(),
      chatGuid: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      phone: z.string().min(1).optional(),
      durationMs: z.number().int().positive().max(1800000).optional()
    }
  },
  async ({ to, chatId, chatIdentifier, chatGuid, spaceId, phone, durationMs }) => {
    const target = normalizeSendTarget({ to, chatId, chatIdentifier, chatGuid, spaceId, phone });
    if (config.imessage.provider === "spectrum") {
      assertAllowedSpectrumSendTarget(target);
      const result = await sendSpectrumBridgeRequest({
        spectrum: config.imessage.spectrum,
        request: {
          method: "startTyping",
          target: spectrumTargetFromSendTarget(target),
          durationMs
        },
        timeoutMs: 10000
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }

    assertAllowedImsgSendTarget(target);
    stopStoredImsgTyping(target);
    const stop = startImsgTyping({
      imessage: config.imessage,
      target
    });
    activeImsgTypingStops.set(typingTargetKey(target), stop);
    return {
      content: [{
        type: "text",
        text: JSON.stringify({ status: "started", target: publicTarget(target) }, null, 2)
      }]
    };
  }
);

server.registerTool(
  "imessage_stop_typing",
  {
    title: "Stop iMessage Typing",
    description: "Stop the iMessage typing indicator for an allowed target when the IMCore bridge is enabled.",
    inputSchema: {
      to: z.string().min(1).optional(),
      chatId: z.union([z.string().min(1), z.number().int().positive()]).optional(),
      chatIdentifier: z.string().min(1).optional(),
      chatGuid: z.string().min(1).optional(),
      spaceId: z.string().min(1).optional(),
      phone: z.string().min(1).optional()
    }
  },
  async ({ to, chatId, chatIdentifier, chatGuid, spaceId, phone }) => {
    const target = normalizeSendTarget({ to, chatId, chatIdentifier, chatGuid, spaceId, phone });
    if (config.imessage.provider === "spectrum") {
      assertAllowedSpectrumSendTarget(target);
      const result = await sendSpectrumBridgeRequest({
        spectrum: config.imessage.spectrum,
        request: {
          method: "stopTyping",
          target: spectrumTargetFromSendTarget(target)
        },
        timeoutMs: 10000
      });
      return {
        content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
      };
    }

    assertAllowedImsgSendTarget(target);
    const stoppedActiveLoop = stopStoredImsgTyping(target);
    const result = stoppedActiveLoop
      ? { status: "stopped" }
      : await stopImsgTyping({ imessage: config.imessage, target });
    return {
      content: [{ type: "text", text: JSON.stringify(result, null, 2) }]
    };
  }
);

await server.connect(new StdioServerTransport());

function normalizeSendTarget({ to, chatId, chatIdentifier, chatGuid, spaceId, phone, replyToMessageId }) {
  const present = [to, chatId, chatIdentifier, chatGuid, spaceId].filter((value) => value != null && String(value).trim()).length;
  if (present !== 1) {
    throw new Error("Specify exactly one iMessage target: to, chatId, chatIdentifier, chatGuid, or spaceId.");
  }
  const extra = {
    phone: phone ? String(phone).trim() : null,
    replyToMessageId: replyToMessageId ? String(replyToMessageId).trim() : null
  };
  if (to) return { to: String(to).trim(), ...extra };
  if (chatId != null) return { chatId: normalizeChatId(chatId), ...extra };
  if (chatIdentifier) return { chatIdentifier: String(chatIdentifier).trim(), ...extra };
  if (chatGuid) return { chatGuid: String(chatGuid).trim(), ...extra };
  return { spaceId: String(spaceId).trim(), ...extra };
}

function assertAllowedImsgSendTarget(target) {
  if (target.to) {
    assertAllowed(allowedAddresses, normalizeAddress(target.to), "address");
    return;
  }
  if (target.chatId) {
    assertAllowed(allowedChatIds, normalizeChatId(target.chatId), "chat id");
    return;
  }
  if (target.chatGuid) {
    assertAllowed(allowedChatGuids, target.chatGuid, "chat GUID");
    return;
  }
  if (target.chatIdentifier) {
    assertAllowed(allowedChatGuids, target.chatIdentifier, "chat identifier/GUID");
  }
  if (target.spaceId) {
    throw new Error("spaceId is only supported by the Photon/Spectrum iMessage provider.");
  }
}

function assertAllowedSpectrumSendTarget(target) {
  const spaceId = target.spaceId || target.chatGuid || target.chatIdentifier;
  if (spaceId) {
    if (config.imessage.spectrum.allowOutboundToKnownSpaces) {
      return;
    }
    assertAllowed(allowedSpaceIds, spaceId, "space id");
    return;
  }
  if (target.to) {
    assertAllowed(allowedAddresses, normalizeAddress(target.to), "address");
    return;
  }
  throw new Error("Photon/Spectrum iMessage sends require to or spaceId.");
}

function spectrumTargetFromSendTarget(target) {
  return {
    to: target.to || null,
    spaceId: target.spaceId || target.chatGuid || target.chatIdentifier || null,
    sender: target.to || null,
    phone: target.phone || null,
    replyToMessageId: target.replyToMessageId || null
  };
}

function photonChatGuidFromTarget(target) {
  if (target.spaceId) return target.spaceId;
  if (target.chatGuid) return target.chatGuid;
  if (target.chatIdentifier) return target.chatIdentifier;
  if (target.chatId) return target.chatId;
  if (target.to) return `any;-;${normalizeAddress(target.to)}`;
  throw new Error("Photon/Spectrum history requires to, chatGuid, chatIdentifier, or spaceId.");
}

function defaultHistoryPageSize({ batches, maxMessages }) {
  return Math.min(100, Math.max(maxMessages, maxMessages * batches * 3));
}

function parseReactionSendText(text) {
  const value = String(text || "").trim();
  const match = value.match(/^\/(?:tapback|react)\s+(.+)$/i);
  return match ? match[1].trim() : null;
}

function typingTargetKey(target) {
  return target.spaceId
    || target.chatGuid
    || target.chatIdentifier
    || target.chatId
    || normalizeAddress(target.to)
    || JSON.stringify(target);
}

function stopStoredImsgTyping(target) {
  const key = typingTargetKey(target);
  const stop = activeImsgTypingStops.get(key);
  if (!stop) {
    return false;
  }
  activeImsgTypingStops.delete(key);
  stop();
  return true;
}

function matchesImessageEventRecord(record, target) {
  if (record.platform !== "imessage") {
    return false;
  }
  if (target.spaceId) {
    return record.space_id === target.spaceId || record.chat_id === target.spaceId;
  }
  if (target.chatGuid) {
    return record.chat_id === target.chatGuid || record.space_id === target.chatGuid;
  }
  if (target.chatIdentifier) {
    return record.chat_id === target.chatIdentifier || record.space_id === target.chatIdentifier;
  }
  if (target.chatId) {
    return normalizeChatId(record.chat_id) === target.chatId;
  }
  if (target.to) {
    return normalizeAddress(record.user_id) === normalizeAddress(target.to);
  }
  return false;
}

function publicTarget(target) {
  return {
    to: target.to || null,
    chatId: target.chatId || null,
    chatIdentifier: target.chatIdentifier || null,
    chatGuid: target.chatGuid || null,
    spaceId: target.spaceId || null,
    phone: target.phone || null
  };
}

function assertAllowed(allowedValues, value, label) {
  if (allowedValues.size === 0) {
    throw new Error(`No outbound iMessage ${label}s are configured.`);
  }
  if (!allowedValues.has(value)) {
    throw new Error(`iMessage ${label} ${value} is not allowed by connector config.`);
  }
}
