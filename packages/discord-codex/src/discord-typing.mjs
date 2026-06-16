const activeTypingByChannelId = new Map();

export function startDiscordTyping(channel, {
  enabled = true,
  intervalMs = 6000,
  maxMs = 1800000,
  logger = console
} = {}) {
  if (!enabled || !channel || typeof channel.sendTyping !== "function") {
    return () => {};
  }
  const channelId = channel.id || "unknown-channel";
  const existing = activeTypingByChannelId.get(channelId);
  if (existing) {
    existing.refCount += 1;
    return () => releaseTyping(channelId);
  }

  const entry = {
    refCount: 1,
    interval: null,
    timeout: null
  };
  activeTypingByChannelId.set(channelId, entry);

  const send = () => {
    if (!activeTypingByChannelId.has(channelId)) {
      return;
    }
    channel.sendTyping().catch((error) => {
      logger.warn?.(`Discord typing indicator failed: ${error.message}`);
      stopTyping(channelId);
    });
  };

  send();
  entry.interval = setInterval(send, intervalMs);
  entry.timeout = setTimeout(() => stopTyping(channelId), maxMs);

  return () => releaseTyping(channelId);
}

export function activeDiscordTypingCount() {
  return activeTypingByChannelId.size;
}

export function resetDiscordTypingForTests() {
  for (const channelId of activeTypingByChannelId.keys()) {
    stopTyping(channelId);
  }
}

function releaseTyping(channelId) {
  const entry = activeTypingByChannelId.get(channelId);
  if (!entry) {
    return;
  }
  entry.refCount -= 1;
  if (entry.refCount <= 0) {
    stopTyping(channelId);
  }
}

function stopTyping(channelId) {
  const entry = activeTypingByChannelId.get(channelId);
  if (!entry) {
    return;
  }
  activeTypingByChannelId.delete(channelId);
  if (entry.interval != null) clearInterval(entry.interval);
  if (entry.timeout != null) clearTimeout(entry.timeout);
}
