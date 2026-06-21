import { normalizeAddress } from "./config.mjs";
import { formatContactAddress } from "./contact-resolver.mjs";

export function formatImessageMessageForCodex({ message, target, contacts = null, connectorGuidance = "Use $imessage-connector for iMessage connector routing." }) {
  const receivedAt = message.created_at || new Date().toISOString();
  const senderName = message.sender_name || message.sender || "unknown";
  const chatName = message.chat_name || message.chat_identifier || message.chat_guid || message.chat_id || "unknown-chat";
  const chatType = message.is_group ? "group" : "dm";
  const attachmentLines = attachmentLinesForMessage(message);
  const sender = contacts
    ? formatContactAddress(message.sender || senderName, contacts)
    : message.sender && message.sender !== senderName
      ? `${senderName} <${message.sender}>`
      : senderName;

  return [
    `Source: iMessage ${chatType}`,
    message.is_group ? `Chat: ${chatName}` : null,
    `From: ${sender}`,
    `Received: ${receivedAt}`,
    connectorGuidance,
    `Reply: ${formatReplyCall(imessageReplyTargetFromMessage(message))}`,
    "",
    "Message:",
    message.text || "(no text content)",
    attachmentLines.length === 0 ? null : "",
    attachmentLines.length === 0 ? null : "Attachments:",
    ...attachmentLines
  ].filter((line) => line != null).join("\n");
}

export function eventLogRecordFromImessage({ message, target, routeResult, contacts = null }) {
  const resolved = contacts?.resolveAddress?.(message.sender);
  return {
    time_local: formatLocalIso(),
    target_id: target.id,
    target_thread_id: target.threadId,
    platform: "imessage",
    chat_type: message.is_group ? "group" : "dm",
    chat_id: message.chat_id ?? null,
    chat_guid: message.chat_guid || null,
    chat_identifier: message.chat_identifier || null,
    chat_name: message.chat_name || null,
    user_id: message.sender || null,
    user_name: resolved?.displayName || message.sender_name || message.sender || null,
    message_id: message.id ?? null,
    message_guid: message.guid || null,
    codex_route: routeResult?.action || null,
    codex_turn_id: routeResult?.turnId || null,
    attachments: (message.attachments || []).map((attachment) => ({
      filename: attachment.transfer_name || attachment.filename || null,
      path: preferredAttachmentPath(attachment),
      mime_type: attachment.converted_mime_type || attachment.mime_type || null
    })),
    text: message.text || ""
  };
}

export function imessageReplyTargetFromMessage(message) {
  if (message.chat_id != null) {
    return { chatId: message.chat_id };
  }
  if (message.chat_guid) {
    return { chatGuid: message.chat_guid };
  }
  if (message.chat_identifier) {
    return { chatIdentifier: message.chat_identifier };
  }
  if (message.sender) {
    return { to: message.sender };
  }
  return {};
}

export function matchesTarget(message, target) {
  if (message.is_from_me) {
    return false;
  }
  if (message.is_reaction) {
    return false;
  }
  if (message.is_group && !target.allowGroupChats) {
    return false;
  }
  if (target.allowAllAddresses) {
    return true;
  }
  const sender = normalizeAddress(message.sender);
  const chatId = message.chat_id == null ? null : String(message.chat_id);
  const chatGuid = message.chat_guid || "";
  if (sender && target.allowedAddresses.includes(sender)) {
    return true;
  }
  if (chatId && target.allowedChatIds.includes(chatId)) {
    return true;
  }
  if (chatGuid && target.allowedChatGuids.includes(chatGuid)) {
    return true;
  }
  return false;
}

export function attachmentLinesForMessage(message) {
  return (message.attachments || []).map((attachment) => {
    const name = attachment.transfer_name || attachment.filename || "attachment";
    const mime = attachment.converted_mime_type || attachment.mime_type || attachment.uti || "unknown";
    const path = preferredAttachmentPath(attachment) || "(missing local file)";
    return `- ${name} (${mime}): ${path}`;
  });
}

function preferredAttachmentPath(attachment) {
  return attachment.converted_path || attachment.path || attachment.filename || null;
}

function formatReplyCall(target) {
  const args = Object.entries(target)
    .map(([key, value]) => `${key}: ${JSON.stringify(value)}`)
    .join(", ");
  return `imessage_send_message({ ${args} })`;
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
