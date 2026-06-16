import fs from "node:fs/promises";

const DEFAULT_GAP_MINUTES = 45;
const DEFAULT_MAX_MESSAGES = 25;
const DEFAULT_BATCH_COUNT = 1;

export async function readJsonlRecords(paths) {
  const records = [];
  for (const filePath of paths.filter(Boolean)) {
    let text;
    try {
      text = await fs.readFile(filePath, "utf8");
    } catch (error) {
      if (error?.code === "ENOENT") {
        continue;
      }
      throw error;
    }
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) {
        continue;
      }
      try {
        records.push(JSON.parse(line));
      } catch {
        records.push({
          time_local: null,
          text: `[unparseable event log line: ${line.slice(0, 160)}]`
        });
      }
    }
  }
  return records;
}

export function buildRecentMessageBatches(messages, {
  gapMinutes = DEFAULT_GAP_MINUTES,
  maxMessages = DEFAULT_MAX_MESSAGES,
  batchCount = DEFAULT_BATCH_COUNT
} = {}) {
  const gapMs = normalizePositiveNumber(gapMinutes, DEFAULT_GAP_MINUTES) * 60 * 1000;
  const messageLimit = Math.floor(normalizePositiveNumber(maxMessages, DEFAULT_MAX_MESSAGES));
  const limitBatches = Math.floor(normalizePositiveNumber(batchCount, DEFAULT_BATCH_COUNT));
  const sorted = messages
    .map(normalizeBatchMessage)
    .filter((message) => message.timestampMs != null)
    .sort((a, b) => a.timestampMs - b.timestampMs);

  const batches = [];
  let current = [];
  for (const message of sorted) {
    const previous = current.at(-1);
    if (previous && message.timestampMs - previous.timestampMs > gapMs) {
      batches.push(current);
      current = [];
    }
    current.push(message);
  }
  if (current.length > 0) {
    batches.push(current);
  }

  return batches.slice(-limitBatches).map((batch) => {
    const trimmed = batch.slice(-messageLimit);
    return {
      start: trimmed[0]?.receivedAt || null,
      end: trimmed.at(-1)?.receivedAt || null,
      messageCount: trimmed.length,
      messages: trimmed.map(({ timestampMs, ...message }) => message)
    };
  });
}

export function normalizeEventLogRecord(record) {
  return {
    platform: record.platform || null,
    chatType: record.chat_type || null,
    conversationId: record.space_id || record.chat_id || record.channel_id || null,
    conversationName: record.chat_name || null,
    messageId: record.message_id || record.id || null,
    receivedAt: record.received_at || record.timestamp || record.time_local || null,
    senderId: record.user_id || record.author_id || null,
    sender: record.user_name || record.author || record.user_id || record.author_id || null,
    text: record.text || record.content || "",
    attachments: record.attachments || [],
    replyTo: record.reply_to_message_id ? {
      messageId: record.reply_to_message_id,
      text: record.reply_to_text || ""
    } : null,
    reactionTo: record.reaction_to_message_id ? {
      messageId: record.reaction_to_message_id,
      text: record.reaction_to_text || ""
    } : null
  };
}

function normalizeBatchMessage(input) {
  const receivedAt = input.receivedAt || input.received_at || input.timestamp || input.time_local || null;
  const timestampMs = parseTimestampMs(receivedAt);
  return {
    platform: input.platform || null,
    chatType: input.chatType || input.chat_type || null,
    conversationId: input.conversationId || input.space_id || input.chat_id || input.channelId || input.channel_id || null,
    conversationName: input.conversationName || input.chat_name || input.channelName || null,
    messageId: input.messageId || input.message_id || input.id || null,
    receivedAt: timestampMs == null ? receivedAt : new Date(timestampMs).toISOString(),
    senderId: input.senderId || input.user_id || input.authorId || input.author_id || null,
    sender: input.sender || input.user_name || input.author || input.user_id || input.senderId || input.authorId || null,
    text: input.text || input.content || "",
    attachments: input.attachments || [],
    replyTo: input.replyTo || null,
    reactionTo: input.reactionTo || null,
    timestampMs
  };
}

function normalizePositiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function parseTimestampMs(value) {
  if (!value) {
    return null;
  }
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}
