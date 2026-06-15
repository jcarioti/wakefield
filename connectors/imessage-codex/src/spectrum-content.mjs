import fs from "node:fs/promises";
import path from "node:path";

export async function materializeSpectrumContent({
  message,
  attachmentDir,
  logger = console,
  includeReplyTarget = true
}) {
  const content = message.content || { type: "custom", raw: null };
  switch (content.type) {
    case "text":
      return { text: content.text || "", attachments: [] };
    case "attachment":
    case "voice":
      return {
        text: contentTextWithSummary(content, attachmentSummary(content)),
        attachments: [await saveReadableContent({
          content,
          attachmentDir,
          messageId: message.id,
          logger
        })].filter(Boolean)
      };
    case "richlink":
      return { text: await richlinkText(content), attachments: [] };
    case "reaction":
      return {
        text: reactionText(content),
        attachments: [],
        reaction: {
          emoji: content.emoji || null,
          ...await referencedMessageSummary({
            target: content.target,
            attachmentDir,
            logger,
            includeReplyTarget
          })
        }
      };
    case "reply": {
      const inner = await materializeSpectrumContent({
        message: { ...message, content: content.content },
        attachmentDir,
        logger,
        includeReplyTarget
      });
      return {
        ...inner,
        reply: await referencedMessageSummary({
          target: content.target,
          attachmentDir,
          logger,
          includeReplyTarget
        })
      };
    }
    case "group":
      return materializeGroupContent({ message, attachmentDir, logger, includeReplyTarget });
    case "custom":
      return { text: `[Custom Spectrum content: ${safeJson(content.raw)}]`, attachments: [] };
    default:
      return { text: `[Unsupported Spectrum content type: ${content.type || "unknown"}]`, attachments: [] };
  }
}

export async function summarizeSpectrumMessage({
  message,
  attachmentDir,
  logger = console,
  includeReplyTarget = true
}) {
  const content = await materializeSpectrumContent({
    message,
    attachmentDir,
    logger,
    includeReplyTarget
  });
  return {
    messageId: message.id || null,
    platform: message.platform || null,
    direction: message.direction || null,
    sender: message.sender?.id || null,
    timestamp: normalizeTimestamp(message.timestamp),
    text: content.text || "",
    attachments: content.attachments || [],
    reaction: content.reaction || null,
    reply: content.reply || null
  };
}

export function shouldEnrichSpectrumContentFromHistory(content) {
  const attachments = Array.isArray(content?.attachments) ? content.attachments : [];
  if (attachments.length === 0) {
    return false;
  }
  const text = normalizeHistoryText(content?.text);
  return !text || isOnlyAttachmentOrVoiceSummary(text);
}

export function mergeSpectrumHistoryContent({ liveContent, historyMessage }) {
  if (!shouldEnrichSpectrumContentFromHistory(liveContent)) {
    return liveContent;
  }
  const historyText = normalizeHistoryText(historyMessage?.text);
  if (!historyText || isOnlyAttachmentOrVoiceSummary(historyText)) {
    return liveContent;
  }
  return {
    ...liveContent,
    text: historyText
  };
}

async function materializeGroupContent({ message, attachmentDir, logger, includeReplyTarget }) {
  const pieces = [];
  const attachments = [];
  const replies = [];
  for (const [index, item] of (message.content.items || []).entries()) {
    const result = await materializeSpectrumContent({
      message: {
        ...message,
        id: item.id || `${message.id}-${index}`,
        content: item.content || item
      },
      attachmentDir,
      logger,
      includeReplyTarget
    });
    if (result.text) {
      pieces.push(result.text);
    }
    if (result.reply) {
      replies.push(result.reply);
    }
    attachments.push(...result.attachments);
  }
  return {
    text: pieces.join("\n"),
    attachments,
    reply: replies[0] || null
  };
}

async function referencedMessageSummary({ target, attachmentDir, logger, includeReplyTarget }) {
  if (!target) {
    return null;
  }
  const depth = includeReplyTargetDepth(includeReplyTarget);
  const summary = {
    targetId: target.id || null,
    sender: target.sender?.id || null,
    timestamp: normalizeTimestamp(target.timestamp),
    text: null,
    attachments: [],
    reply: null
  };
  if (depth <= 0 || !target.content || isKnownStubTarget(target.content)) {
    return summary;
  }
  const targetContent = await materializeSpectrumContent({
    message: target,
    attachmentDir,
    logger,
    includeReplyTarget: depth - 1
  });
  return {
    ...summary,
    text: targetContent.text || "",
    attachments: targetContent.attachments || [],
    reply: targetContent.reply || null
  };
}

function includeReplyTargetDepth(value) {
  if (value === false) {
    return 0;
  }
  if (Number.isInteger(value)) {
    return Math.max(0, value);
  }
  return 4;
}

function isKnownStubTarget(content) {
  if (content?.type !== "custom") {
    return false;
  }
  const raw = content.raw || content;
  return raw?.terminal_type === "reaction-target"
    || raw?.slack_type === "reaction-target"
    || raw?.whatsapp_type === "reaction-target";
}

async function saveReadableContent({ content, attachmentDir, messageId, logger }) {
  if (!attachmentDir) {
    return null;
  }
  try {
    await fs.mkdir(attachmentDir, { recursive: true });
    const name = safeFileName(content.name || `${content.type || "attachment"}.bin`);
    const filePath = path.join(attachmentDir, `${safeFileName(messageId)}-${name}`);
    const data = await content.read();
    await fs.writeFile(filePath, data);
    return {
      name,
      path: filePath,
      mimeType: content.mimeType || null,
      size: content.size || data.length
    };
  } catch (error) {
    logger.warn?.(`Failed to materialize Spectrum attachment for ${messageId}: ${error.message}`);
    return {
      name: content.name || "attachment",
      path: "(failed to save attachment)",
      mimeType: content.mimeType || null,
      size: content.size || null
    };
  }
}

function attachmentSummary(content) {
  return `[${content.type === "voice" ? "Voice note" : "Attachment"}: ${content.name || "attachment"} (${content.mimeType || "unknown"})]`;
}

function contentTextWithSummary(content, summary) {
  return [
    contentText(content),
    summary
  ].filter(Boolean).join("\n");
}

function contentText(content) {
  const seen = new Set();
  return [
    content?.text,
    content?.caption,
    content?.body
  ]
    .map((value) => typeof value === "string" || typeof value === "number" ? String(value).trim() : "")
    .filter(Boolean)
    .filter((value) => {
      if (seen.has(value)) {
        return false;
      }
      seen.add(value);
      return true;
    })
    .join("\n");
}

function normalizeHistoryText(value) {
  if (typeof value !== "string" && typeof value !== "number") {
    return "";
  }
  const raw = String(value);
  const lines = raw.split(/\r?\n/);
  const attachmentLines = [];
  const bodyLines = [];
  for (const line of lines) {
    const trimmed = line.trim();
    if (trimmed && isAttachmentOrVoiceSummaryLine(trimmed)) {
      attachmentLines.push(trimmed);
    } else {
      bodyLines.push(line);
    }
  }
  if (attachmentLines.length > 0 && bodyLines.join("\n").includes("\uFFFC")) {
    let used = 0;
    const withInlineAttachments = bodyLines.join("\n").replace(/\uFFFC/g, () => {
      const summary = attachmentLines[used];
      used += 1;
      return summary ? `\n${summary}\n` : "";
    });
    return normalizeTextLines([
      withInlineAttachments,
      ...attachmentLines.slice(used)
    ].filter(Boolean).join("\n"));
  }
  return normalizeTextLines(raw.replace(/\uFFFC/g, ""));
}

function normalizeTextLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

function isOnlyAttachmentOrVoiceSummary(text) {
  const lines = normalizeHistoryText(text).split("\n").filter(Boolean);
  return lines.length > 0 && lines.every(isAttachmentOrVoiceSummaryLine);
}

function isAttachmentOrVoiceSummaryLine(line) {
  return /^\[(?:Attachment|Voice note): .+\]$/.test(line);
}

function reactionText(content) {
  const target = content.target?.id ? ` on ${content.target.id}` : "";
  return `[Reaction: ${content.emoji || "unknown"}${target}]`;
}

async function richlinkText(content) {
  const title = await content.title?.().catch(() => null);
  const summary = await content.summary?.().catch(() => null);
  return [
    `[Rich link: ${content.url}]`,
    title ? `Title: ${title}` : null,
    summary ? `Summary: ${summary}` : null
  ].filter(Boolean).join("\n");
}

function safeFileName(value) {
  return String(value || "attachment")
    .replace(/[^A-Za-z0-9._-]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 120) || "attachment";
}

function normalizeTimestamp(value) {
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

function safeJson(value) {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}
