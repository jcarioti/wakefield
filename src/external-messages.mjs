import path from "node:path";
import { randomUUID } from "node:crypto";
import { CONNECTOR_SETUP_SLOTS } from "./connectors.mjs";
import { connectorSkillPrompt } from "./connector-skills.mjs";
import { resolveContact } from "./contacts.mjs";
import { appendJsonl, readJsonl } from "./json-store.mjs";
import { compact, recordMemory } from "./memory.mjs";
import { appHome } from "./paths.mjs";

const DEFAULT_LIMIT = 20;
const MESSAGE_EVENT_KIND = "external-message";
const STATUS_EVENT_KIND = "external-status";

export async function ingestExternalMessage(agent, {
  home = appHome(),
  connector,
  conversationId = null,
  sender = null,
  text = "",
  messageId = null,
  subject = null,
  url = null,
  metadata = {},
  now = new Date()
} = {}) {
  if (!agent) throw new Error("ingestExternalMessage needs an agent profile.");
  const connectorSlot = requireConnector(connector);
  const body = String(text || "").trim();
  if (!body) throw new Error("External message text is required.");
  const contact = (await resolveContact({
    connector: connectorSlot.id,
    sender,
    metadata
  }, { home })).contact;

  const stableKey = externalStableKey({
    connector: connectorSlot.id,
    messageId,
    conversationId,
    sender,
    text: body
  });
  const existing = (await listExternalMessages(agent, { status: "all", limit: 10000 }))
    .find((entry) => entry.stableKey === stableKey);
  if (existing) {
    return {
      duplicate: true,
      message: existing,
      route: routeForExternalMessage(agent, existing)
    };
  }

  const entry = {
    eventKind: MESSAGE_EVENT_KIND,
    id: randomUUID(),
    stableKey,
    at: now.toISOString(),
    agentId: agent.id,
    connector: connectorSlot.id,
    connectorName: connectorSlot.name,
    conversationId: conversationId ? String(conversationId) : null,
    sender: sender ? String(sender) : null,
    messageId: messageId ? String(messageId) : null,
    subject: subject ? String(subject) : null,
    url: url ? String(url) : null,
    text: body,
    metadata: metadata && typeof metadata === "object" ? metadata : {},
    contactId: contact?.id || null,
    contact,
    status: "pending"
  };

  await appendJsonl(externalMessagesPathForAgent(agent), entry);
  await recordMemory(agent, {
    channel: "inbox",
    kind: "external-message",
    text: externalMemoryText(entry),
    source: `connector:${entry.connector}`,
    data: {
      externalMessageId: entry.id,
      connector: entry.connector,
      conversationId: entry.conversationId,
      sender: entry.sender,
      contactId: entry.contactId,
      messageId: entry.messageId,
      url: entry.url
    },
    now
  });

  return {
    duplicate: false,
    message: entry,
    route: routeForExternalMessage(agent, entry)
  };
}

export async function listExternalMessages(agent, {
  status = "pending",
  limit = DEFAULT_LIMIT
} = {}) {
  if (!agent) throw new Error("listExternalMessages needs an agent profile.");
  const events = await readJsonl(externalMessagesPathForAgent(agent));
  const messages = new Map();
  const statuses = new Map();

  for (const event of events) {
    if (event.eventKind === MESSAGE_EVENT_KIND || (!event.eventKind && event.connector && event.text)) {
      messages.set(event.id, {
        ...event,
        eventKind: MESSAGE_EVENT_KIND,
        status: statuses.get(event.id)?.status || event.status || "pending",
        statusAt: statuses.get(event.id)?.at || event.statusAt || null,
        statusReason: statuses.get(event.id)?.reason || event.statusReason || null
      });
      continue;
    }

    if (event.eventKind === STATUS_EVENT_KIND && event.externalMessageId) {
      statuses.set(event.externalMessageId, event);
      const message = messages.get(event.externalMessageId);
      if (message) {
        message.status = event.status;
        message.statusAt = event.at;
        message.statusReason = event.reason || null;
      }
    }
  }

  const wantedStatus = String(status || "pending");
  return [...messages.values()]
    .filter((message) => wantedStatus === "all" || message.status === wantedStatus)
    .sort((left, right) => String(left.at).localeCompare(String(right.at)))
    .slice(0, Number(limit || DEFAULT_LIMIT));
}

export async function acknowledgeExternalMessage(agent, externalMessageId, {
  status = "delivered",
  reason = null,
  now = new Date()
} = {}) {
  if (!agent) throw new Error("acknowledgeExternalMessage needs an agent profile.");
  const nextStatus = normalizeStatus(status);
  const messages = await listExternalMessages(agent, { status: "all", limit: 10000 });
  const message = messages.find((entry) => entry.id === externalMessageId);
  if (!message) throw new Error(`External message not found: ${externalMessageId}`);

  const event = {
    eventKind: STATUS_EVENT_KIND,
    id: randomUUID(),
    at: now.toISOString(),
    agentId: agent.id,
    externalMessageId,
    status: nextStatus,
    reason: reason ? String(reason) : null
  };
  await appendJsonl(externalMessagesPathForAgent(agent), event);

  return {
    ...message,
    status: event.status,
    statusAt: event.at,
    statusReason: event.reason
  };
}

export function routeForExternalMessage(agent, message) {
  const ready = Boolean(agent?.threadId && agent?.cwd);
  return {
    status: ready ? "ready" : "needs-thread",
    reason: ready ? null : "Select a persistent Codex thread before dispatching external messages.",
    threadId: agent?.threadId || null,
    cwd: agent?.cwd || null,
    prompt: formatExternalPrompt(message)
  };
}

export function formatExternalPrompt(message) {
  const header = [
    `External ${message.connectorName || message.connector || "connector"} message`,
    `Connector: ${message.connector}`,
    message.conversationId ? `Conversation: ${message.conversationId}` : null,
    message.sender ? `From: ${message.sender}` : null,
    message.contact?.displayName ? `Contact: ${message.contact.displayName} (${message.contact.id})` : null,
    message.contact?.roles?.length > 0 ? `Contact roles: ${message.contact.roles.join(", ")}` : null,
    message.contact?.relationships?.length > 0 ? `Contact relationships: ${message.contact.relationships.join(", ")}` : null,
    message.contact?.preferredReplyConnector ? `Preferred reply connector: ${message.contact.preferredReplyConnector}` : null,
    message.subject ? `Subject: ${message.subject}` : null,
    message.messageId ? `Message ID: ${message.messageId}` : null,
    message.url ? `URL: ${message.url}` : null,
    message.id ? `Wakefield external ID: ${message.id}` : null
  ].filter(Boolean);

  return [
    ...header,
    connectorSkillPrompt(message.connector) || null,
    "",
    "Message:",
    message.text || "",
    "",
    "Handle this through the selected Wakefield personality. Keep the source metadata available for any connector reply tool, and do not claim a reply was sent unless a connector transport actually sends it."
  ].filter((line) => line != null).join("\n");
}

export function formatExternalMessages(messages) {
  if (messages.length === 0) return "No pending external messages.";
  return messages
    .map((message) => {
      const source = [message.connector, message.sender, message.conversationId].filter(Boolean).join(" ");
      return `${message.id}: ${message.status} ${source} - ${compact(message.text, 120)}`;
    })
    .join("\n");
}

export function formatExternalIngest(result) {
  const duplicate = result.duplicate ? "Already queued" : "Queued";
  const message = result.message;
  const route = result.route;
  const lines = [
    `${duplicate} ${message.connector} message: ${message.id}`,
    `status: ${message.status}`,
    `route: ${route.status}`
  ];
  if (route.threadId) lines.push(`thread: ${route.threadId}`);
  if (route.cwd) lines.push(`cwd: ${route.cwd}`);
  if (route.reason) lines.push(`reason: ${route.reason}`);
  return lines.join("\n");
}

export function externalMemoryText(entry) {
  const source = [entry.connectorName || entry.connector, entry.sender, entry.conversationId]
    .filter(Boolean)
    .join(" / ");
  return `${source}: ${compact(entry.text, 500)}`;
}

function requireConnector(connectorId) {
  const normalized = String(connectorId || "").trim().toLowerCase();
  const slot = CONNECTOR_SETUP_SLOTS.find((connector) => connector.id === normalized);
  if (!slot) throw new Error(`Unknown connector: ${connectorId || "(missing)"}`);
  return slot;
}

function externalStableKey({ connector, messageId, conversationId, sender, text }) {
  if (messageId) return `${connector}:message:${String(messageId)}`;
  return `${connector}:fingerprint:${fingerprint([conversationId, sender, text].filter(Boolean).join("\n"))}`;
}

function fingerprint(text) {
  let hash = 5381;
  for (const char of String(text)) {
    hash = ((hash << 5) + hash) ^ char.charCodeAt(0);
  }
  return (hash >>> 0).toString(16);
}

function normalizeStatus(status) {
  const value = String(status || "delivered").trim().toLowerCase();
  if (["pending", "delivered", "ignored", "failed"].includes(value)) return value;
  throw new Error("External message status must be pending, delivered, ignored, or failed.");
}

function externalMessagesPathForAgent(agent) {
  if (agent.memory?.externalMessagesPath) return agent.memory.externalMessagesPath;
  return path.join(path.dirname(agent.memory.inboxPath), "external-messages.jsonl");
}
