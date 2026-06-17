#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { Client, Events, GatewayIntentBits, Partials } from "discord.js";
import {
  getDiscordBotCredential,
  loadConnectorConfig,
  parseCliArgs
} from "./config.mjs";
import { sendTextToCodexTarget } from "@wakefield/connector-shared/codex-router.mjs";
import { findThreadRolloutPath, waitForTurnCompletion } from "@wakefield/connector-shared/codex-rollout-watch.mjs";
import { recordWakefieldConnectorTurn, wakefieldMemoryForConnectorMessage } from "@wakefield/connector-shared/wakefield-memory.mjs";
import {
  eventLogRecordFromDiscordMessage,
  formatDiscordMessageForCodex
} from "./discord-message-format.mjs";
import { startCodexPresenceMonitor } from "./discord-presence.mjs";
import { startDiscordTyping } from "./discord-typing.mjs";
import { acquireSingletonProcessLock } from "@wakefield/connector-shared/lock.mjs";

const args = parseCliArgs();
if (args.help) {
  console.log("Usage: discord-codex-bot --config packages/discord-codex/config.local.json");
  process.exit(0);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
const botCredential = await getDiscordBotCredential(config);
const releaseProcessLock = await acquireSingletonProcessLock(botProcessLockName(config), {
  lockRoot: config.bot.processLockRoot,
  staleMs: config.bot.processLockStaleMs
});

const client = new Client({
  intents: [
    GatewayIntentBits.Guilds,
    GatewayIntentBits.GuildMessages,
    GatewayIntentBits.DirectMessages,
    GatewayIntentBits.GuildMembers,
    GatewayIntentBits.MessageContent
  ],
  partials: [Partials.Channel]
});

let stopPresenceMonitor = () => {};

client.once(Events.ClientReady, () => {
  console.log(`Discord Codex connector online as ${client.user.tag}`);
  stopPresenceMonitor = startCodexPresenceMonitor({
    client,
    targets: config.targets,
    presence: config.discord.presence
  });
});

process.once("SIGINT", () => {
  shutdown("SIGINT");
});
process.once("SIGTERM", () => {
  shutdown("SIGTERM");
});

client.on("messageCreate", async (message) => {
  try {
    if (config.bot.ignoreBotMessages !== false && message.author.bot) {
      return;
    }

    const targets = [];
    for (const target of config.targets) {
      if (await matchesTarget(message, target)) {
        targets.push(target);
      }
    }
    if (targets.length === 0) {
      return;
    }

    for (const target of targets) {
      const stopTyping = startDiscordTyping(message.channel, config.discord.typing);
      const memory = await connectorMemoryForDiscord({ message, target });
      const text = formatDiscordMessageForCodex({
        message,
        target,
        connectorGuidance: config.codex.connectorSkillPrompt,
        memory
      });
      try {
        const routeResult = await sendTextToCodexTarget({
          target,
          text,
          mode: "auto",
          codex: config.codex
        });
        const completionStatus = await keepTypingUntilTurnCompletes({ target, routeResult, message });
        await appendEventLog(target, eventLogRecordFromDiscordMessage({ message, target, routeResult }));
        await recordConnectorTurn({ target, routeResult, completionStatus, message, text });
        console.log(`Routed Discord message ${message.id} to ${target.id} via Codex ${routeResult.action}.`);
      } finally {
        stopTyping();
      }
    }
  } catch (error) {
    console.error(`Failed to route Discord message ${message.id}: ${error.stack || error.message}`);
  }
});

async function connectorMemoryForDiscord({ message, target }) {
  try {
    return await wakefieldMemoryForConnectorMessage({
      target,
      query: [
        message.content,
        [...message.attachments.values()].map((attachment) => attachment.name || attachment.id)
      ].flat().filter(Boolean).join("\n"),
      scope: {
        connector: "discord",
        sender: message.author?.id || null,
        conversation: message.channelId || null,
        channel: message.channelId || null,
        room: message.guildId ? message.channelId : null,
        person: [
          message.author?.id,
          message.member?.displayName,
          message.author?.globalName,
          message.author?.username
        ].filter(Boolean)
      }
    });
  } catch (error) {
    console.warn(`Wakefield memory unavailable for Discord message ${message.id}: ${error.message}`);
    return "";
  }
}

await client.login(botCredential);

async function shutdown(signal) {
  console.log(`Discord Codex connector shutting down after ${signal}.`);
  try {
    stopPresenceMonitor();
    client.destroy();
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
  return `discord-codex-bot:${targetKey || "no-targets"}`;
}

async function matchesTarget(message, target) {
  if (target.allowedGuildIds.length > 0 && message.guildId && !target.allowedGuildIds.includes(message.guildId)) {
    return false;
  }

  if (message.guildId == null) {
    return target.allowDirectMessages && isAllowedUser(message, target);
  }

  if (target.allowedChannelIds.length > 0 && !target.allowedChannelIds.includes(message.channelId)) {
    return false;
  }
  if (!await isAuthorizedSender(message, target)) {
    return false;
  }

  if (target.alwaysRouteChannelMessages) {
    return true;
  }
  if (message.mentions.users.has(client.user.id)) {
    return true;
  }
  for (const userId of target.triggerUserIds) {
    if (message.mentions.users.has(userId)) {
      return true;
    }
  }

  const commandPrefix = config.bot.commandPrefix;
  return commandPrefix && message.content.trimStart().startsWith(commandPrefix);
}

function isAllowedUser(message, target) {
  return target.allowedUserIds.length === 0 || target.allowedUserIds.includes(message.author.id);
}

async function isAuthorizedSender(message, target) {
  if (target.allowedUserIds.includes(message.author.id)) {
    return true;
  }
  if (target.allowedUserIds.length === 0 && target.requiredRoleIds.length === 0) {
    return true;
  }
  if (target.requiredRoleIds.length === 0) {
    return false;
  }
  if (!message.guildId) {
    return false;
  }
  const member = message.member || await message.guild.members.fetch(message.author.id).catch(() => null);
  if (!member) {
    return false;
  }
  return target.requiredRoleIds.some((roleId) => member.roles.cache.has(roleId));
}

async function appendEventLog(target, record) {
  if (!target.eventLogPath) {
    return;
  }
  await fs.mkdir(path.dirname(target.eventLogPath), { recursive: true });
  await fs.appendFile(target.eventLogPath, `${JSON.stringify(record)}\n`, "utf8");
}

async function keepTypingUntilTurnCompletes({ target, routeResult, message }) {
  if (!routeResult.turnId) {
    return null;
  }
  const rolloutPath = target.rolloutPath || await findThreadRolloutPath(target.threadId);
  const status = await waitForTurnCompletion({
    rolloutPath,
    turnId: routeResult.turnId,
    timeoutMs: config.discord.typing.completionTimeoutMs,
    pollMs: config.discord.typing.completionPollMs,
    stopOnToolCallEnd: [{
      server: "discord-codex",
      tools: ["discord_send_message", "discord_send_dm"]
    }]
  });
  if (status.completed) {
    console.log(`Codex turn ${routeResult.turnId} completed for Discord message ${message.id}.`);
    return status;
  } else if (status.outboundToolCallEnded) {
    console.log(`Stopped Discord typing for ${message.id} after ${status.toolCall.server}/${status.toolCall.tool}.`);
    const finalStatus = await waitForTurnCompletion({
      rolloutPath,
      turnId: routeResult.turnId,
      timeoutMs: Math.min(config.discord.typing.completionTimeoutMs, 120000),
      pollMs: config.discord.typing.completionPollMs
    });
    if (finalStatus.completed) {
      console.log(`Codex turn ${routeResult.turnId} completed for Discord message ${message.id}.`);
      return finalStatus;
    }
    return status;
  } else {
    console.warn(`Stopped waiting for Codex turn ${routeResult.turnId} (${status.reason}) for Discord message ${message.id}.`);
    return status;
  }
}

async function recordConnectorTurn({ target, routeResult, completionStatus, message, text }) {
  try {
    const result = await recordWakefieldConnectorTurn({
      target,
      connector: "discord",
      messageId: message.id,
      prompt: text,
      routeResult,
      completionStatus,
      scope: {
        connector: "discord",
        sender: message.author?.id || null,
        conversation: message.channelId || null,
        channel: message.channelId || null,
        room: message.guildId ? message.channelId : null,
        person: [
          message.author?.id,
          message.member?.displayName,
          message.author?.globalName,
          message.author?.username
        ].filter(Boolean)
      }
    });
    if (!result.ok) {
      console.warn(`Wakefield memory record skipped for Discord message ${message.id}: ${result.reason}`);
    }
  } catch (error) {
    console.warn(`Wakefield memory record failed for Discord message ${message.id}: ${error.message}`);
  }
}
