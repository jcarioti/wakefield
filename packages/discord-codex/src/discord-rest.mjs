const DISCORD_API_BASE = "https://discord.com/api/v10";
const MAX_CONTENT_LENGTH = 2000;

export async function sendDiscordChannelMessage({
  botCredential,
  channelId,
  content,
  replyToMessageId = null,
  allowedMentions = { parse: [] },
  sendTypingBeforeSend = true,
  logger = console
}) {
  assertDiscordContent(content);
  if (sendTypingBeforeSend) {
    await sendDiscordTyping({ botCredential, channelId }).catch((error) => {
      logger.warn?.(`Discord typing pulse failed before channel message: ${error.message}`);
    });
  }
  const body = {
    content,
    allowed_mentions: allowedMentions
  };
  if (replyToMessageId) {
    body.message_reference = {
      message_id: replyToMessageId,
      channel_id: channelId,
      fail_if_not_exists: false
    };
  }

  return discordRequest({
    botCredential,
    path: `/channels/${encodeURIComponent(channelId)}/messages`,
    method: "POST",
    body
  });
}

export async function sendDiscordDm({
  botCredential,
  userId,
  content,
  allowedMentions = { parse: [] },
  sendTypingBeforeSend = true,
  logger = console
}) {
  assertDiscordContent(content);
  const channel = await getDiscordDmChannel({ botCredential, userId });
  const message = await sendDiscordChannelMessage({
    botCredential,
    channelId: channel.id,
    content,
    allowedMentions,
    sendTypingBeforeSend,
    logger
  });
  return { channel, message };
}

export async function sendDiscordTyping({ botCredential, channelId }) {
  return discordRequest({
    botCredential,
    path: `/channels/${encodeURIComponent(channelId)}/typing`,
    method: "POST"
  });
}

export async function getDiscordDmChannel({ botCredential, userId }) {
  return discordRequest({
    botCredential,
    path: "/users/@me/channels",
    method: "POST",
    body: { recipient_id: userId }
  });
}

export async function readDiscordChannelMessages({
  botCredential,
  channelId,
  limit = 10,
  before = null,
  after = null,
  around = null
}) {
  const params = new URLSearchParams();
  params.set("limit", String(Math.max(1, Math.min(100, Number(limit) || 10))));
  if (before) params.set("before", before);
  if (after) params.set("after", after);
  if (around) params.set("around", around);

  return discordRequest({
    botCredential,
    path: `/channels/${encodeURIComponent(channelId)}/messages?${params.toString()}`,
    method: "GET"
  });
}

export async function discordRequest({ botCredential, path, method = "GET", body = null }) {
  const response = await fetch(`${DISCORD_API_BASE}${path}`, {
    method,
    headers: {
      Authorization: `Bot ${botCredential}`,
      "Content-Type": "application/json",
      "User-Agent": "Wakefield Discord Codex Connector"
    },
    body: body == null ? null : JSON.stringify(body)
  });
  const text = await response.text();
  const payload = parseJsonOrText(text);
  if (!response.ok) {
    const message = typeof payload === "string" ? payload : payload?.message || text;
    throw new Error(`Discord API ${method} ${path} failed with ${response.status}: ${message}`);
  }
  return payload;
}

function assertDiscordContent(content) {
  if (!content || typeof content !== "string") {
    throw new Error("Discord message content must be a non-empty string.");
  }
  if (content.length > MAX_CONTENT_LENGTH) {
    throw new Error(`Discord message content is ${content.length} characters; Discord limit is ${MAX_CONTENT_LENGTH}.`);
  }
}

function parseJsonOrText(text) {
  if (!text) {
    return null;
  }
  try {
    return JSON.parse(text);
  } catch {
    return text;
  }
}
