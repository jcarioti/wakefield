import { normalizeAddress } from "./config.mjs";
import { formatContactAddress } from "./contact-resolver.mjs";

export function matchesSpectrumTarget({ space, message, target }) {
  if (message.direction === "outbound") {
    return false;
  }
  const spaceType = spectrumSpaceType(space);
  if (spaceType === "group" && !target.allowGroupChats) {
    return false;
  }
  if (target.allowAllAddresses) {
    return true;
  }

  const sender = normalizeAddress(message.sender?.id);
  if (sender && target.allowedAddresses.includes(sender)) {
    return true;
  }
  if (space?.id && target.allowedSpaceIds.includes(space.id)) {
    return true;
  }
  if (space?.id && target.allowedChatGuids.includes(space.id)) {
    return true;
  }
  return false;
}

export function formatSpectrumMessageForCodex({ space, message, target, content, contacts = null, connectorGuidance = "Use $wakefield-imessage for iMessage connector routing." }) {
  const sender = message.sender?.id || "unknown";
  const senderLabel = formatContactAddress(sender, contacts);
  const receivedAt = normalizeTimestamp(message.timestamp);
  const spaceType = spectrumSpaceType(space);
  const text = content?.text?.trim() || "(no text content)";
  const attachments = content?.attachments || [];
  const reaction = content?.reaction || null;
  const reactionTargetId = reaction?.targetId || null;
  const actionMessageId = reactionTargetId || message.id;
  const replyTarget = content?.reply || null;
  const currentEventText = reaction
    ? `Reaction: ${reaction.emoji || "unknown"}`
    : text;
  const sourceLabel = spaceType === "group"
    ? `iMessage group ${space.id}`
    : "iMessage DM";

  return [
    `${sourceLabel} from ${senderLabel}`,
    `Received: ${receivedAt}`,
    connectorGuidance,
    spaceType === "group" ? "Group behavior: monitor quietly like #boardroom. Reply only when addressed, when a reply was requested, or when customer/business risk or a human-action blocker needs concise clarification." : null,
    "",
    reaction ? "Current event:" : "Message:",
    currentEventText,
    attachments.length === 0 ? null : "",
    attachments.length === 0 ? null : "Attachments:",
    ...attachments.map(formatAttachmentLine),
    reaction ? "" : null,
    ...formatReactionContextLines({ reaction, senderLabel, contacts }),
    replyTarget?.targetId ? "" : null,
    ...formatReferencedMessageLines({
      heading: "This message replies to:",
      summary: replyTarget,
      contacts,
      missingText: `Reply target messageId: ${replyTarget?.targetId}. Use lookup if its text is needed.`
    }),
    "",
    `Route: spaceId=${space.id} replyToMessageId=${actionMessageId} messageId=${message.id}`
  ].filter((line) => line != null).join("\n");
}

export function eventLogRecordFromSpectrumMessage({ space, message, target, content, routeResult, contacts = null }) {
  const sender = message.sender?.id || null;
  const resolved = contacts?.resolveAddress?.(sender);
  return {
    time_local: formatLocalIso(),
    target_id: target.id,
    target_thread_id: target.threadId,
    platform: "imessage",
    provider: "spectrum",
    chat_type: spectrumSpaceType(space),
    space_id: space.id,
    line: space.phone || null,
    user_id: sender,
    user_name: resolved?.displayName || sender,
    message_id: message.id,
    received_at: normalizeTimestamp(message.timestamp),
    reply_to_message_id: content?.reply?.targetId || null,
    reply_to_text: content?.reply?.text || null,
    reaction_to_message_id: content?.reaction?.targetId || null,
    reaction_to_text: content?.reaction?.text || null,
    codex_route: routeResult?.action || null,
    codex_turn_id: routeResult?.turnId || null,
    attachments: (content?.attachments || []).map((attachment) => ({
      filename: attachment.name || null,
      path: attachment.path || null,
      mime_type: attachment.mimeType || null,
      size: attachment.size || null
    })),
    text: content?.text || ""
  };
}

export function spectrumReplyTargetFromMessage({ space, message }) {
  return {
    spaceId: space.id,
    phone: space.phone || null,
    spaceType: spectrumSpaceType(space),
    sender: message.sender?.id || null,
    replyToMessageId: message.id
  };
}

export function spectrumSpaceType(space) {
  if (space?.type === "group" || space?.type === "dm") {
    return space.type;
  }
  return String(space?.id || "").includes(";+;") ? "group" : "dm";
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
  return new Date().toISOString();
}

function formatReactionContextLines({ reaction, senderLabel, contacts }) {
  if (!reaction) {
    return [];
  }
  const emoji = reaction.emoji || "a reaction";
  return [
    `Current user action: ${senderLabel} reacted with ${emoji} to a prior message.`,
    reaction.targetId ? "" : null,
    ...formatReferencedMessageLines({
      heading: "Reacted-to message:",
      summary: reaction,
      contacts,
      missingText: `Reacted-to messageId: ${reaction.targetId || "unknown"}. Use lookup if the reaction depends on the original text.`
    })
  ];
}

function formatReferencedMessageLines({ heading, summary, contacts, missingText, depth = 0 }) {
  if (!summary?.targetId) {
    return [];
  }
  const meta = [
    summary.sender ? `from ${formatContactAddress(summary.sender, contacts)}` : null,
    summary.timestamp ? `sent ${summary.timestamp}` : null,
    `messageId ${summary.targetId}`
  ].filter(Boolean).join("; ");
  const lines = [
    heading,
    meta ? `(${meta})` : null,
    summary.text ? summary.text : missingText
  ];
  if (summary.attachments?.length) {
    lines.push("Referenced attachments:");
    lines.push(...summary.attachments.map(formatAttachmentLine));
  }
  if (summary.reply?.targetId && depth < 4) {
    lines.push("");
    lines.push(...formatReferencedMessageLines({
      heading: "Earlier in reply chain:",
      summary: summary.reply,
      contacts,
      missingText: `Earlier reply target messageId: ${summary.reply.targetId}. Use lookup if its text is needed.`,
      depth: depth + 1
    }));
  }
  return lines.filter((line) => line != null);
}

function formatAttachmentLine(attachment) {
  return `- ${attachment.name} (${attachment.mimeType || "unknown"}${attachment.size ? `, ${attachment.size} bytes` : ""}): ${attachment.path}`;
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
