import WebSocket from "ws";
import { connectorStatus } from "./connectors.mjs";
import { ingestExternalMessage } from "./external-messages.mjs";
import { dispatchExternalMessage } from "./inbox-dispatch.mjs";
import { appHome } from "./paths.mjs";

const DISCORD_GATEWAY_URL = "wss://gateway.discord.gg/?v=10&encoding=json";
const DISCORD_INTENTS = (1 << 9) | (1 << 12) | (1 << 15);

export async function startDiscordGateway(agent, {
  home = appHome(),
  gatewayUrl = DISCORD_GATEWAY_URL,
  dispatchMode = null,
  dispatchClient = null,
  WebSocketImpl = WebSocket,
  logger = console
} = {}) {
  if (!agent) throw new Error("startDiscordGateway needs an agent profile.");
  const connector = await connectorStatus("discord", { home });
  if (!connector.ready) {
    throw new Error(discordNotReadyReason(connector));
  }

  const token = process.env[String(connector.settings.botTokenEnv)];
  const socket = new WebSocketImpl(gatewayUrl);
  const state = {
    sequence: null,
    heartbeat: null,
    botUserId: null,
    closed: false
  };

  socket.on("message", (data) => {
    handleDiscordGatewayPayload(agent, data, {
      home,
      connector,
      token,
      socket,
      state,
      dispatchMode,
      dispatchClient,
      logger
    }).catch((error) => logger?.error?.(`Wakefield Discord listener error: ${error.stack || error.message}`));
  });

  socket.on("close", () => {
    state.closed = true;
    if (state.heartbeat) clearInterval(state.heartbeat);
  });

  socket.on("error", (error) => {
    logger?.error?.(`Wakefield Discord gateway error: ${error.message}`);
  });

  return {
    socket,
    connector,
    close() {
      state.closed = true;
      if (state.heartbeat) clearInterval(state.heartbeat);
      if (typeof socket.close === "function") socket.close();
    }
  };
}

export async function ingestDiscordGatewayMessage(agent, message, {
  home = appHome(),
  connector = null,
  botUserId = null,
  dispatchMode = null,
  dispatchClient = null,
  now = new Date()
} = {}) {
  if (!agent) throw new Error("ingestDiscordGatewayMessage needs an agent profile.");
  const status = connector || await connectorStatus("discord", { home });
  if (!status.enabled) return skipped("disabled", "Discord connector is disabled.", status);
  if (!status.configured) return skipped("needs-setup", `Discord connector is missing: ${status.missingSettings.join(", ")}.`, status);
  if (status.missingSecrets.length > 0) return skipped("missing-secret", `Missing bot token environment variable: ${status.missingSecrets.join(", ")}.`, status);

  const normalized = normalizeDiscordMessage(message);
  if (!normalized) return skipped("ignored", "Discord message payload was not a normal message.", status);
  if (!normalized.content) return skipped("empty-message", "Discord message has no text or attachment URL to queue.", status);
  if (botUserId && normalized.authorId === String(botUserId)) return skipped("self-message", "Ignored the Wakefield bot user.", status);
  if (normalized.authorBot) return skipped("bot-message", "Ignored a bot message.", status);
  if (!discordMessageAllowed(normalized, status.settings)) {
    return skipped("not-allowed", "Discord message is outside configured DMs, channels, or senders.", status);
  }

  const ingested = await ingestExternalMessage(agent, {
    home,
    connector: "discord",
    conversationId: normalized.channelId,
    sender: normalized.authorLabel,
    messageId: normalized.id,
    subject: normalized.guildId ? `Discord channel ${normalized.channelId}` : "Discord DM",
    url: normalized.url,
    text: normalized.content,
    metadata: {
      guildId: normalized.guildId,
      channelId: normalized.channelId,
      authorId: normalized.authorId,
      username: normalized.username,
      globalName: normalized.globalName,
      attachments: normalized.attachments
    },
    now
  });
  const dispatch = dispatchMode
    ? await dispatchExternalMessage(agent, {
      id: ingested.message.id,
      mode: dispatchMode,
      client: dispatchClient
    })
    : null;

  return {
    ok: true,
    status: ingested.duplicate ? "duplicate" : "queued",
    connector: connectorSummary(status),
    message: normalized,
    ingest: ingested,
    dispatch
  };
}

export function normalizeDiscordMessage(message) {
  if (!message || message.type !== 0 || !message.id || !message.channel_id || !message.author) return null;
  const author = message.author || {};
  const username = author.global_name || author.username || "unknown";
  return {
    id: String(message.id),
    channelId: String(message.channel_id),
    guildId: message.guild_id ? String(message.guild_id) : null,
    authorId: author.id ? String(author.id) : null,
    authorBot: Boolean(author.bot),
    username: author.username || null,
    globalName: author.global_name || null,
    authorLabel: author.id ? `${username} <${author.id}>` : username,
    content: String(message.content || "").trim() || attachmentFallback(message.attachments),
    attachments: Array.isArray(message.attachments)
      ? message.attachments.map((attachment) => ({
        id: attachment.id ? String(attachment.id) : null,
        filename: attachment.filename || null,
        url: attachment.url || null,
        contentType: attachment.content_type || null,
        size: attachment.size || null
      }))
      : [],
    url: message.guild_id
      ? `https://discord.com/channels/${message.guild_id}/${message.channel_id}/${message.id}`
      : null
  };
}

export function discordMessageAllowed(message, settings = {}) {
  const allowedTargets = parseList(settings.allowedTargets);
  const allowedUsers = parseList(settings.allowedUsers);
  if (allowedUsers.length > 0 && !allowedUsers.includes(message.authorId)) return false;
  if (!message.guildId) {
    return allowedTargets.length === 0 || allowedTargets.includes(message.channelId);
  }
  return allowedTargets.includes(message.channelId);
}

export function formatDiscordGatewayResult(result) {
  if (!result.ok) return `Discord message skipped: ${result.status} - ${result.reason}`;
  return `${result.status === "duplicate" ? "Already queued" : "Queued"} Discord message: ${result.ingest.message.id}`;
}

async function handleDiscordGatewayPayload(agent, data, {
  home,
  connector,
  token,
  socket,
  state,
  dispatchMode,
  dispatchClient,
  logger
}) {
  const payload = JSON.parse(Buffer.isBuffer(data) ? data.toString("utf8") : String(data));
  if (payload.s != null) state.sequence = payload.s;

  if (payload.op === 10) {
    startHeartbeat(socket, state, payload.d?.heartbeat_interval);
    sendDiscord(socket, {
      op: 2,
      d: {
        token,
        intents: DISCORD_INTENTS,
        properties: {
          os: process.platform,
          browser: "wakefield",
          device: "wakefield"
        }
      }
    });
    return;
  }

  if (payload.op === 1) {
    sendDiscord(socket, { op: 1, d: state.sequence });
    return;
  }

  if (payload.op !== 0) return;
  if (payload.t === "READY") {
    state.botUserId = payload.d?.user?.id || null;
    logger?.log?.(`Wakefield Discord listener ready as ${payload.d?.user?.username || state.botUserId || "bot"}.`);
    return;
  }

  if (payload.t === "MESSAGE_CREATE") {
    const result = await ingestDiscordGatewayMessage(agent, payload.d, {
      home,
      connector,
      botUserId: state.botUserId,
      dispatchMode,
      dispatchClient
    });
    if (result.ok) logger?.log?.(formatDiscordGatewayResult(result));
  }
}

function startHeartbeat(socket, state, intervalMs) {
  const interval = Number(intervalMs);
  if (!Number.isFinite(interval) || interval < 1000) return;
  if (state.heartbeat) clearInterval(state.heartbeat);
  state.heartbeat = setInterval(() => {
    if (!state.closed) sendDiscord(socket, { op: 1, d: state.sequence });
  }, interval);
  sendDiscord(socket, { op: 1, d: state.sequence });
}

function sendDiscord(socket, payload) {
  if (typeof socket.send === "function") socket.send(JSON.stringify(payload));
}

function skipped(status, reason, connector) {
  return {
    ok: false,
    status,
    reason,
    connector: connectorSummary(connector)
  };
}

function connectorSummary(connector) {
  return {
    id: connector.id,
    ready: connector.ready,
    enabled: connector.enabled,
    configured: connector.configured,
    missingSettings: connector.missingSettings,
    missingSecrets: connector.missingSecrets
  };
}

function parseList(value) {
  return Array.isArray(value)
    ? value.flatMap(parseList)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function attachmentFallback(attachments) {
  if (!Array.isArray(attachments) || attachments.length === 0) return "";
  return attachments
    .map((attachment) => attachment.url || attachment.filename || attachment.id)
    .filter(Boolean)
    .join("\n");
}

function discordNotReadyReason(connector) {
  if (!connector.enabled) return "Discord connector is disabled.";
  if (!connector.configured) return `Discord connector is missing: ${connector.missingSettings.join(", ")}.`;
  if (connector.missingSecrets.length > 0) return `Missing bot token environment variable: ${connector.missingSecrets.join(", ")}.`;
  return "Discord connector is not ready.";
}
