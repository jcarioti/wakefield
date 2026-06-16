export function formatDiscordMessageForCodex({ message, target, connectorGuidance = "Use $wakefield-discord for Discord connector routing.", memory = "" }) {
  const authorName = message.member?.displayName || message.author?.globalName || message.author?.username || "unknown";
  const channelName = message.channel?.name ? `#${message.channel.name}` : "direct-message";
  const receivedAt = message.createdAt.toISOString();
  const sourceLine = message.guildId ? `Source: Discord ${channelName}` : "Source: Discord DM";
  const replyLine = message.guildId
    ? `- Text reply target: discord_send_message channelId=${message.channelId} replyToMessageId=${message.id}`
    : `- Text reply target: discord_send_dm userId=${message.author.id}`;
  const batchLine = message.guildId
    ? `- Load recent context batch: discord_read_recent_batch channelId=${message.channelId}`
    : `- Load recent context batch: discord_read_recent_batch userId=${message.author.id}`;
  const attachmentLines = [...message.attachments.values()].map((attachment) => {
    const label = attachment.name || attachment.id;
    return `- ${label}: ${attachment.url}`;
  });

  return [
    sourceLine,
    `From: ${authorName} <${message.author.id}>`,
    `Received: ${receivedAt}`,
    message.guildId ? `Channel ID: ${message.channelId}` : null,
    `Message ID: ${message.id}`,
    connectorGuidance,
    memory ? "" : null,
    memory || null,
    "",
    "Message:",
    message.content || "(no text content)",
    attachmentLines.length === 0 ? null : "",
    attachmentLines.length === 0 ? null : "Attachments:",
    ...attachmentLines,
    "",
    "Routing:",
    replyLine,
    batchLine
  ].filter((line) => line != null).join("\n");
}

export function eventLogRecordFromDiscordMessage({ message, target, routeResult }) {
  return {
    time_local: formatLocalIso(),
    target_id: target.id,
    target_thread_id: target.threadId,
    platform: "discord",
    chat_type: message.guildId ? "guild_channel" : "dm",
    guild_id: message.guildId || null,
    chat_id: message.channelId,
    chat_name: message.channel?.name || null,
    user_id: message.author.id,
    user_name: message.member?.displayName || message.author?.globalName || message.author?.username || null,
    message_id: message.id,
    received_at: message.createdAt.toISOString(),
    codex_route: routeResult?.action || null,
    codex_turn_id: routeResult?.turnId || null,
    text: message.content || ""
  };
}

function formatLocalIso(date = new Date()) {
  const offsetMinutes = -date.getTimezoneOffset();
  const sign = offsetMinutes >= 0 ? "+" : "-";
  const absolute = Math.abs(offsetMinutes);
  const hours = String(Math.floor(absolute / 60)).padStart(2, "0");
  const minutes = String(absolute % 60).padStart(2, "0");
  const local = new Date(date.getTime() + offsetMinutes * 60 * 1000)
    .toISOString()
    .replace("Z", "");
  return `${local}${sign}${hours}:${minutes}`;
}
