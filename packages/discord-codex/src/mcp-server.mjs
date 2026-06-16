#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import {
  getAllowedDmUserIds,
  getAllowedOutboundChannelIds,
  getDiscordBotCredential,
  loadConnectorConfig,
  parseCliArgs
} from "./config.mjs";
import {
  getDiscordDmChannel,
  readDiscordChannelMessages,
  sendDiscordChannelMessage,
  sendDiscordDm
} from "./discord-rest.mjs";
import { buildRecentMessageBatches } from "@wakefield/connector-shared/message-batches.mjs";

const args = parseCliArgs();
if (args.help) {
  console.log("Usage: discord-codex-mcp --config packages/discord-codex/config.local.json");
  process.exit(0);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
const botCredential = await getDiscordBotCredential(config);
const allowedChannelIds = getAllowedOutboundChannelIds(config);
const allowedDmUserIds = getAllowedDmUserIds(config);

const server = new McpServer({
  name: "discord-codex-connector",
  version: "0.1.0"
});

server.registerTool(
  "discord_bridge_status",
  {
    title: "Discord Bridge Status",
    description: "Show the configured Discord connector allowlists and target ids.",
    inputSchema: {}
  },
  async () => ({
    content: [{
      type: "text",
      text: JSON.stringify({
        outboundChannelIds: [...allowedChannelIds],
        outboundDmUserIds: [...allowedDmUserIds],
        targets: config.targets.map((target) => ({
          id: target.id,
          threadId: target.threadId,
          allowedChannelIds: target.allowedChannelIds,
          allowedUserIds: target.allowedUserIds,
          requiredRoleIds: target.requiredRoleIds
        }))
      }, null, 2)
    }]
  })
);

server.registerTool(
  "discord_read_messages",
  {
    title: "Read Discord Messages",
    description: "Read recent messages from an allowed Discord channel or DM user.",
    inputSchema: {
      channelId: z.string().min(1).optional(),
      userId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      before: z.string().min(1).optional(),
      after: z.string().min(1).optional(),
      around: z.string().min(1).optional()
    }
  },
  async ({ channelId, userId, limit = 10, before, after, around }) => {
    let resolvedChannelId = channelId;
    if (userId) {
      assertAllowed(allowedDmUserIds, userId, "user");
      const dmChannel = await getDiscordDmChannel({ botCredential, userId });
      resolvedChannelId = dmChannel.id;
    } else {
      assertAllowed(allowedChannelIds, channelId, "channel");
    }

    const messages = await readDiscordChannelMessages({
      botCredential,
      channelId: resolvedChannelId,
      limit,
      before,
      after,
      around
    });

    const rows = messages.map((message) => ({
      id: message.id,
      channelId: message.channel_id,
      authorId: message.author?.id ?? null,
      author: message.author?.global_name || message.author?.username || null,
      timestamp: message.timestamp,
      content: message.content || "",
      attachments: (message.attachments || []).map((attachment) => ({
        id: attachment.id,
        filename: attachment.filename,
        url: attachment.url
      }))
    }));

    return {
      content: [{ type: "text", text: JSON.stringify(rows, null, 2) }]
    };
  }
);

server.registerTool(
  "discord_read_recent_batch",
  {
    title: "Read Recent Discord Batch",
    description: "Read the most recent logical chunk of Discord channel or DM context from an allowed source.",
    inputSchema: {
      channelId: z.string().min(1).optional(),
      userId: z.string().min(1).optional(),
      limit: z.number().int().min(1).max(100).optional(),
      batches: z.number().int().min(1).max(5).optional(),
      gapMinutes: z.number().min(5).max(240).optional(),
      maxMessages: z.number().int().min(1).max(100).optional()
    }
  },
  async ({ channelId, userId, limit = 50, batches = 1, gapMinutes = 45, maxMessages = 25 }) => {
    let resolvedChannelId = channelId;
    if (userId) {
      assertAllowed(allowedDmUserIds, userId, "user");
      const dmChannel = await getDiscordDmChannel({ botCredential, userId });
      resolvedChannelId = dmChannel.id;
    } else {
      assertAllowed(allowedChannelIds, channelId, "channel");
    }

    const messages = await readDiscordChannelMessages({
      botCredential,
      channelId: resolvedChannelId,
      limit
    });
    const recentBatches = buildRecentMessageBatches(messages.map(discordMessageForBatch), {
      batchCount: batches,
      gapMinutes,
      maxMessages
    });

    return {
      content: [{
        type: "text",
        text: JSON.stringify({
          status: recentBatches.length > 0 ? "found" : "not_found",
          source: {
            channelId: resolvedChannelId,
            userId: userId || null
          },
          chunking: {
            fetchedMessages: messages.length,
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
  "discord_send_message",
  {
    title: "Send Discord Channel Message",
    description: "Send a concise Discord message to an allowed channel.",
    inputSchema: {
      channelId: z.string().min(1),
      content: z.string().min(1).max(2000),
      replyToMessageId: z.string().min(1).optional()
    }
  },
  async ({ channelId, content, replyToMessageId }) => {
    assertAllowed(allowedChannelIds, channelId, "channel");
    const message = await sendDiscordChannelMessage({
      botCredential,
      channelId,
      content,
      replyToMessageId
    });
    return {
      content: [{ type: "text", text: `sent discord message ${message.id} to channel ${channelId}` }]
    };
  }
);

server.registerTool(
  "discord_send_dm",
  {
    title: "Send Discord Direct Message",
    description: "Send a concise Discord direct message to an allowed user.",
    inputSchema: {
      userId: z.string().min(1),
      content: z.string().min(1).max(2000)
    }
  },
  async ({ userId, content }) => {
    assertAllowed(allowedDmUserIds, userId, "user");
    const result = await sendDiscordDm({
      botCredential,
      userId,
      content
    });
    return {
      content: [{ type: "text", text: `sent discord dm ${result.message.id} to user ${userId}` }]
    };
  }
);

await server.connect(new StdioServerTransport());

function assertAllowed(allowedIds, id, label) {
  if (allowedIds.size === 0) {
    throw new Error(`No outbound Discord ${label} ids are configured.`);
  }
  if (!allowedIds.has(id)) {
    throw new Error(`Discord ${label} ${id} is not allowed by connector config.`);
  }
}

function discordMessageForBatch(message) {
  return {
    platform: "discord",
    chatType: message.guild_id ? "guild_channel" : "dm",
    conversationId: message.channel_id || null,
    messageId: message.id,
    receivedAt: message.timestamp,
    senderId: message.author?.id ?? null,
    sender: message.author?.global_name || message.author?.username || message.author?.id || null,
    text: message.content || "",
    attachments: (message.attachments || []).map((attachment) => ({
      id: attachment.id,
      filename: attachment.filename,
      url: attachment.url
    }))
  };
}
