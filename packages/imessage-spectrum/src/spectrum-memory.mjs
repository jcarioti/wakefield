import { wakefieldMemoryForConnectorMessage } from "@wakefield/connector-shared/wakefield-memory.mjs";

export async function wakefieldMemoryForSpectrumMessage({
  space,
  message,
  content,
  target,
  logger = console
}) {
  try {
    return await wakefieldMemoryForConnectorMessage({
      target,
      query: spectrumMemoryQuery(content),
      scope: spectrumMemoryScope({ space, message })
    });
  } catch (error) {
    logger.warn?.(`Wakefield memory unavailable for Photon/Spectrum iMessage ${message.id}: ${error.message}`);
    return "";
  }
}

export function spectrumMemoryQuery(content = {}) {
  return [
    content.text,
    content.reaction?.text,
    content.reply?.text,
    (content.attachments || []).map((attachment) => attachment.name || attachment.mimeType)
  ].flat().filter(Boolean).join("\n");
}

export function spectrumMemoryScope({ space, message }) {
  const sender = message.sender?.id || null;
  const isGroup = space?.type === "group" || String(space?.id || "").includes(";+;");
  return {
    connector: "imessage",
    sender,
    conversation: space?.id || null,
    channel: space?.id || null,
    room: isGroup ? space?.id || null : null
  };
}
