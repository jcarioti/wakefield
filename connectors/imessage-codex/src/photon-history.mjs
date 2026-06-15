import { createClient } from "@photon-ai/advanced-imessage";

const DEFAULT_CLOUD_URL = "https://spectrum.photon.codes";
const DEFAULT_SHARED_ADDRESS = "imessage.spectrum.photon.codes:443";
const SHARED_PHONE = "shared";

const TAPBACK_ALIASES = new Map([
  ["love", "love"],
  ["heart", "love"],
  ["like", "like"],
  ["thumbsup", "like"],
  ["thumbs_up", "like"],
  ["thumbs up", "like"],
  ["dislike", "dislike"],
  ["thumbsdown", "dislike"],
  ["thumbs_down", "dislike"],
  ["thumbs down", "dislike"],
  ["laugh", "laugh"],
  ["haha", "laugh"],
  ["emphasize", "emphasize"],
  ["exclaim", "emphasize"],
  ["question", "question"]
]);

const TAPBACK_EMOJI_ALIASES = new Map([
  ["\u2764\uFE0F", "love"],
  ["\u2764", "love"],
  ["\u{1F44D}", "like"],
  ["\u{1F44E}", "dislike"],
  ["\u{1F602}", "laugh"],
  ["\u203C\uFE0F", "emphasize"],
  ["\u203C", "emphasize"],
  ["\u2753", "question"]
]);

const REACTION_LABELS = new Map([
  ["love", "love"],
  ["like", "like"],
  ["dislike", "dislike"],
  ["laugh", "laugh"],
  ["emphasize", "emphasize"],
  ["question", "question"]
]);

export async function issuePhotonImessageTokens({
  spectrum,
  env = process.env,
  fetchImpl = globalThis.fetch
}) {
  if (!spectrum?.projectId || !spectrum?.projectSecret) {
    throw new Error("Photon/Spectrum history requires projectId and projectSecret. Set them in config.local.json or PHOTON_PROJECT_ID/PHOTON_SECRET_KEY.");
  }
  if (typeof fetchImpl !== "function") {
    throw new Error("Photon/Spectrum history requires a fetch implementation.");
  }

  const cloudUrl = normalizeCloudUrl(spectrum.cloudUrl || env.SPECTRUM_CLOUD_URL || DEFAULT_CLOUD_URL);
  const response = await fetchImpl(`${cloudUrl}/projects/${encodeURIComponent(spectrum.projectId)}/imessage/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${spectrum.projectId}:${spectrum.projectSecret}`).toString("base64")}`
    }
  });

  if (!response?.ok) {
    const body = await response?.text?.().catch(() => "") || "";
    throw new Error(`Photon/Spectrum token request failed (${response?.status || "unknown"}): ${body || response?.statusText || "no response body"}`);
  }

  const json = await response.json();
  if (json?.succeed === false) {
    throw new Error(`Photon/Spectrum token request failed: ${json.message || json.code || "succeed=false"}`);
  }
  const data = Object.hasOwn(json || {}, "data") ? json.data : json;
  if (data?.type !== "shared" && data?.type !== "dedicated") {
    throw new Error("Photon/Spectrum token response did not include a supported iMessage token type.");
  }
  return data;
}

export async function createPhotonImessageClients({
  spectrum,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClientImpl = createClient
}) {
  const tokenData = await issuePhotonImessageTokens({ spectrum, env, fetchImpl });
  const clients = tokenData.type === "shared"
    ? [createSharedClient({ tokenData, env, createClientImpl })]
    : createDedicatedClients({ tokenData, createClientImpl });

  return {
    tokenType: tokenData.type,
    clients,
    closeAll: async () => {
      for (const entry of clients) {
        await entry.client.close?.();
      }
    }
  };
}

export function selectPhotonClient({ clients, phone }) {
  const requested = normalizeString(phone);
  if (requested) {
    const match = clients.find((entry) => entry.phone === requested || entry.instanceId === requested);
    if (!match) {
      throw new Error(`Photon/Spectrum iMessage phone ${requested} is not available. Available phones: ${availablePhones(clients)}.`);
    }
    return match;
  }
  if (clients.length === 1) {
    return clients[0];
  }
  throw new Error(`Photon/Spectrum history has multiple iMessage numbers. Pass phone. Available phones: ${availablePhones(clients)}.`);
}

export async function listPhotonMessagesInChat({
  spectrum,
  chatGuid,
  phone,
  pageSize = 100,
  pageToken,
  before,
  after,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClientImpl = createClient,
  clientSet = null
}) {
  const ownedClientSet = clientSet || await createPhotonImessageClients({
    spectrum,
    env,
    fetchImpl,
    createClientImpl
  });
  try {
    return await listPhotonMessagesInChatWithClientSet({
      clientSet: ownedClientSet,
      chatGuid,
      phone,
      pageSize,
      pageToken,
      before,
      after
    });
  } finally {
    if (!clientSet) {
      await ownedClientSet.closeAll();
    }
  }
}

export async function listPhotonMessagesInChatWithClientSet({
  clientSet,
  chatGuid,
  phone,
  pageSize = 100,
  pageToken,
  before,
  after
}) {
  const normalizedChatGuid = normalizeString(chatGuid);
  if (!normalizedChatGuid) {
    throw new Error("Photon/Spectrum history requires chatGuid or spaceId.");
  }

  const selected = selectPhotonClient({ clients: clientSet.clients, phone });
  const options = normalizeListOptions({ pageSize, pageToken, before, after });
  const page = await selected.client.messages.listInChat(normalizedChatGuid, options);
  return {
    chatGuid: normalizedChatGuid,
    phone: selected.phone,
    tokenType: clientSet.tokenType,
    pageSize: options.pageSize,
    pageToken: options.pageToken || null,
    nextPageToken: page.nextPageToken || null,
    messages: (page.messages || []).map((message) => normalizePhotonMessage(message, { chatGuid: normalizedChatGuid }))
  };
}

export async function getPhotonMessage({
  spectrum,
  chatGuid,
  messageId,
  phone,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClientImpl = createClient,
  clientSet = null
}) {
  const target = photonMessageTargetFromId(messageId);
  const ownedClientSet = clientSet || await createPhotonImessageClients({
    spectrum,
    env,
    fetchImpl,
    createClientImpl
  });
  try {
    const selected = selectPhotonClient({ clients: ownedClientSet.clients, phone });
    const normalizedChatGuid = normalizeString(chatGuid);
    let message = null;
    try {
      message = normalizedChatGuid
        ? await selected.client.messages.get(normalizedChatGuid, target.guid)
        : await selected.client.messages.get(target.guid);
    } catch (error) {
      if (!normalizedChatGuid) {
        throw error;
      }
      message = await findPhotonMessageInChatByGuid({
        client: selected.client,
        chatGuid: normalizedChatGuid,
        messageId: target.guid,
        cause: error
      });
    }
    return normalizePhotonMessage(message, {
      chatGuid: message.chatGuids?.[0] || normalizedChatGuid || null
    });
  } finally {
    if (!clientSet) {
      await ownedClientSet.closeAll();
    }
  }
}

export async function sendPhotonTextMessage({
  spectrum,
  chatGuid,
  text,
  replyToMessageId,
  phone,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClientImpl = createClient,
  clientSet = null
}) {
  const normalizedChatGuid = normalizeString(chatGuid);
  if (!normalizedChatGuid) {
    throw new Error("Photon/Spectrum text send fallback requires chatGuid or spaceId.");
  }
  const body = String(text || "");
  if (!body.trim()) {
    throw new Error("Photon/Spectrum text send fallback requires text.");
  }
  const ownedClientSet = clientSet || await createPhotonImessageClients({
    spectrum,
    env,
    fetchImpl,
    createClientImpl
  });
  try {
    const selected = selectPhotonClient({ clients: ownedClientSet.clients, phone });
    const options = replyToMessageId
      ? { replyTo: photonReplyTargetFromMessageId(replyToMessageId) }
      : undefined;
    const message = await selected.client.messages.sendText(normalizedChatGuid, body, options);
    return normalizePhotonSentMessage(message, {
      chatGuid: normalizedChatGuid,
      phone: selected.phone,
      source: "photon"
    });
  } finally {
    if (!clientSet) {
      await ownedClientSet.closeAll();
    }
  }
}

export async function sendPhotonReaction({
  spectrum,
  chatGuid,
  messageId,
  reaction,
  phone,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClientImpl = createClient,
  clientSet = null
}) {
  const normalizedChatGuid = normalizeString(chatGuid);
  if (!normalizedChatGuid) {
    throw new Error("Photon/Spectrum reaction fallback requires chatGuid or spaceId.");
  }
  const target = photonMessageTargetFromId(messageId);
  const normalizedReaction = normalizePhotonSettableReaction(reaction);
  const ownedClientSet = clientSet || await createPhotonImessageClients({
    spectrum,
    env,
    fetchImpl,
    createClientImpl
  });
  try {
    const selected = selectPhotonClient({ clients: ownedClientSet.clients, phone });
    const options = typeof target.partIndex === "number" ? { partIndex: target.partIndex } : undefined;
    const message = await selected.client.messages.setReaction(
      normalizedChatGuid,
      target.guid,
      normalizedReaction,
      true,
      options
    );
    return {
      status: "reacted",
      method: "photon.messages.setReaction",
      chatGuid: normalizedChatGuid,
      phone: selected.phone,
      messageId: target.guid,
      partIndex: target.partIndex ?? null,
      reaction: normalizedReaction,
      event: normalizePhotonSentMessage(message, {
        chatGuid: normalizedChatGuid,
        phone: selected.phone,
        source: "photon"
      })
    };
  } finally {
    if (!clientSet) {
      await ownedClientSet.closeAll();
    }
  }
}

export async function markPhotonChatRead({
  spectrum,
  chatGuid,
  phone,
  env = process.env,
  fetchImpl = globalThis.fetch,
  createClientImpl = createClient,
  clientSet = null
}) {
  const normalizedChatGuid = normalizeString(chatGuid);
  if (!normalizedChatGuid) {
    throw new Error("Photon/Spectrum mark-read fallback requires chatGuid or spaceId.");
  }
  const ownedClientSet = clientSet || await createPhotonImessageClients({
    spectrum,
    env,
    fetchImpl,
    createClientImpl
  });
  try {
    const selected = selectPhotonClient({ clients: ownedClientSet.clients, phone });
    await selected.client.chats.markRead(normalizedChatGuid);
    return {
      status: "read",
      method: "photon.chats.markRead",
      chatGuid: normalizedChatGuid,
      phone: selected.phone
    };
  } finally {
    if (!clientSet) {
      await ownedClientSet.closeAll();
    }
  }
}

export function normalizePhotonMessage(message, { chatGuid } = {}) {
  const conversationId = message.chatGuids?.[0] || chatGuid || null;
  const reactionLabel = formatReaction(message.reaction);
  const attachmentSummaries = (message.content?.attachments || []).map(attachmentSummary);
  const contentText = message.content?.text ? String(message.content.text) : "";
  const text = [
    message.reactionTargetGuid ? `[Reaction: ${reactionLabel || "unknown"} on ${message.reactionTargetGuid}]` : null,
    textWithAttachmentPlaceholders(contentText, attachmentSummaries)
  ].filter(Boolean).join("\n");

  return {
    platform: "imessage",
    chatType: conversationId?.includes(";+;") ? "group" : "dm",
    conversationId,
    messageId: message.guid || null,
    receivedAt: normalizeTimestamp(message.dateCreated),
    senderId: message.sender?.address || (message.isFromMe ? "me" : null),
    sender: message.isFromMe ? "agent" : (message.sender?.address || "unknown"),
    text: text || serviceMessageSummary(message),
    attachments: (message.content?.attachments || []).map(normalizeAttachment),
    replyTo: message.replyTargetGuid ? {
      messageId: message.replyTargetGuid,
      text: ""
    } : null,
    reactionTo: message.reactionTargetGuid ? {
      messageId: message.reactionTargetGuid,
      reaction: reactionLabel || null,
      text: ""
    } : null
  };
}

function textWithAttachmentPlaceholders(contentText, attachmentSummaries) {
  const summaries = attachmentSummaries.filter(Boolean);
  const raw = typeof contentText === "string" || typeof contentText === "number"
    ? String(contentText)
    : "";
  if (summaries.length === 0) {
    return normalizeTextLines(raw.replace(/\uFFFC/g, ""));
  }
  if (!raw) {
    return summaries.join("\n");
  }
  if (!raw.includes("\uFFFC")) {
    return [
      normalizeTextLines(raw),
      ...summaries
    ].filter(Boolean).join("\n");
  }

  let used = 0;
  const withInlineAttachments = raw.replace(/\uFFFC/g, () => {
    const summary = summaries[used];
    used += 1;
    return summary ? `\n${summary}\n` : "";
  });
  return [
    normalizeTextLines(withInlineAttachments),
    ...summaries.slice(used)
  ].filter(Boolean).join("\n");
}

function normalizeTextLines(value) {
  return String(value || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .join("\n")
    .trim();
}

export function normalizePhotonSettableReaction(value) {
  const reaction = normalizeString(value);
  if (!reaction) {
    throw new Error("Photon/Spectrum reaction must be non-empty.");
  }
  const emojiAlias = TAPBACK_EMOJI_ALIASES.get(reaction);
  if (emojiAlias) {
    return { kind: emojiAlias };
  }
  const key = reaction.toLowerCase().replace(/[\s-]+/g, "_");
  const tapback = TAPBACK_ALIASES.get(key) || TAPBACK_ALIASES.get(reaction.toLowerCase());
  if (tapback) {
    return { kind: tapback };
  }
  return {
    kind: "emoji",
    emoji: reaction
  };
}

export function photonMessageTargetFromId(messageId) {
  const cleaned = stripSpectrumReactionSuffix(messageId);
  if (!cleaned) {
    throw new Error("Photon/Spectrum message target requires messageId.");
  }
  const child = cleaned.match(/^p:(\d+)\/(.+)$/);
  if (child) {
    const partIndex = Number(child[1]);
    return {
      guid: child[2],
      partIndex: Number.isSafeInteger(partIndex) ? partIndex : undefined
    };
  }
  return { guid: cleaned };
}

export function photonReplyTargetFromMessageId(messageId) {
  const target = photonMessageTargetFromId(messageId);
  if (typeof target.partIndex === "number") {
    return {
      guid: target.guid,
      partIndex: target.partIndex
    };
  }
  return target.guid;
}

function createSharedClient({ tokenData, env, createClientImpl }) {
  const address = normalizeString(env.SPECTRUM_IMESSAGE_ADDRESS) || DEFAULT_SHARED_ADDRESS;
  return {
    phone: SHARED_PHONE,
    instanceId: null,
    address,
    client: createClientImpl({
      address,
      tls: true,
      token: tokenData.token
    })
  };
}

function createDedicatedClients({ tokenData, createClientImpl }) {
  const entries = [];
  for (const [instanceId, token] of Object.entries(tokenData.auth || {})) {
    const phone = normalizeString(tokenData.numbers?.[instanceId]);
    if (!phone) {
      throw new Error(`Photon/Spectrum iMessage instance ${instanceId} has no phone assigned.`);
    }
    const address = `${instanceId}.imsg.photon.codes:443`;
    entries.push({
      phone,
      instanceId,
      address,
      client: createClientImpl({
        address,
        tls: true,
        token
      })
    });
  }
  if (entries.length === 0) {
    throw new Error("Photon/Spectrum dedicated token response did not include any iMessage instances.");
  }
  return entries;
}

function normalizeListOptions({ pageSize, pageToken, before, after }) {
  return removeNullish({
    pageSize: clampPageSize(pageSize),
    pageToken: normalizeString(pageToken) || undefined,
    before: normalizeDate(before, "before"),
    after: normalizeDate(after, "after")
  });
}

function clampPageSize(value) {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 100;
  }
  return Math.max(1, Math.min(100, Math.floor(number)));
}

function normalizeDate(value, label) {
  if (value == null || value === "") {
    return undefined;
  }
  if (value instanceof Date) {
    return value;
  }
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) {
    throw new Error(`Photon/Spectrum history ${label} must be an ISO timestamp.`);
  }
  return date;
}

function normalizePhotonSentMessage(message, { chatGuid, phone, source }) {
  return {
    id: message.guid || null,
    guid: message.guid || null,
    platform: "iMessage",
    source,
    chatGuid: message.chatGuids?.[0] || chatGuid || null,
    phone: phone || null,
    timestamp: normalizeTimestamp(message.dateCreated)
  };
}

async function findPhotonMessageInChatByGuid({ client, chatGuid, messageId, cause }) {
  let pageToken = undefined;
  for (let pageCount = 0; pageCount < 3; pageCount += 1) {
    const page = await client.messages.listInChat(chatGuid, {
      pageSize: 100,
      pageToken
    });
    const match = (page.messages || []).find((message) => message.guid === messageId);
    if (match) {
      return match;
    }
    pageToken = page.nextPageToken || undefined;
    if (!pageToken) {
      break;
    }
  }
  throw cause;
}

function stripSpectrumReactionSuffix(messageId) {
  const value = normalizeString(messageId);
  const reactionIndex = value.indexOf(":reaction:");
  return reactionIndex > 0 ? value.slice(0, reactionIndex) : value;
}

function normalizeCloudUrl(value) {
  const normalized = normalizeString(value) || DEFAULT_CLOUD_URL;
  return normalized.replace(/\/+$/g, "");
}

function formatReaction(reaction) {
  if (!reaction) {
    return null;
  }
  if (reaction.kind === "emoji" && reaction.emoji) {
    return reaction.emoji;
  }
  if (reaction.emoji) {
    return reaction.emoji;
  }
  return REACTION_LABELS.get(reaction.kind) || reaction.kind || null;
}

function attachmentSummary(attachment) {
  return `[Attachment: ${attachment.fileName || attachment.guid || "attachment"} (${attachment.mimeType || "unknown"})]`;
}

function normalizeAttachment(attachment) {
  return {
    guid: attachment.guid || null,
    name: attachment.fileName || null,
    mimeType: attachment.mimeType || null,
    size: attachment.totalBytes || null,
    isSticker: attachment.isSticker === true,
    transferState: attachment.transferState || null
  };
}

function serviceMessageSummary(message) {
  if (message.itemType && message.itemType !== "normal") {
    return `[iMessage ${message.itemType}]`;
  }
  if (message.isServiceMessage || message.isSystemMessage) {
    return "[iMessage service message]";
  }
  return "";
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

function normalizeString(value) {
  return String(value || "").trim();
}

function removeNullish(value) {
  return Object.fromEntries(Object.entries(value).filter(([, entry]) => entry != null));
}

function availablePhones(clients) {
  return clients.map((entry) => entry.phone || entry.instanceId).filter(Boolean).join(", ") || "(none)";
}
