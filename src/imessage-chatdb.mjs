import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { connectorStatus } from "./connectors.mjs";
import { ingestExternalMessage } from "./external-messages.mjs";
import { dispatchExternalMessage } from "./inbox-dispatch.mjs";
import { readJson, writeJson } from "./json-store.mjs";
import { appHome, connectorStatePath, expandHome } from "./paths.mjs";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);
const DEFAULT_MAX_MESSAGES = 20;
const execFileAsync = promisify(execFile);

export async function pollImessageChatDb(agent, {
  home = appHome(),
  rows = null,
  sqlitePath = "sqlite3",
  limit = null,
  dispatchMode = null,
  dispatchClient = null,
  now = new Date()
} = {}) {
  if (!agent) throw new Error("pollImessageChatDb needs an agent profile.");
  const connector = await connectorStatus("imessage", { home });
  const statePath = connectorStatePath("imessage", home);

  if (!connector.enabled) {
    return pollResult({ ok: false, status: "disabled", reason: "iMessage connector is disabled.", connector, statePath });
  }
  if (!connector.configured) {
    return pollResult({ ok: false, status: "needs-setup", reason: "iMessage connector needs setup.", connector, statePath });
  }
  if (connector.missingPaths.length > 0) {
    return pollResult({
      ok: false,
      status: "missing-database",
      reason: `Messages database is not readable: ${connector.missingPaths.join(", ")}.`,
      connector,
      statePath
    });
  }

  let state = await loadImessagePollState(statePath);
  const max = normalizeLimit(limit || connector.settings.maxMessagesPerPoll || DEFAULT_MAX_MESSAGES);
  const sourceRows = rows || await queryMessagesDatabase({
    databasePath: expandHome(connector.settings.databasePath),
    sinceRowId: state.lastRowId,
    limit: max,
    sqlitePath
  });
  const results = [];

  for (const row of sourceRows) {
    const message = normalizeImessageRow(row);
    if (!message) {
      results.push({ skipped: true, reason: "invalid_row" });
      continue;
    }
    if (message.id <= state.lastRowId) {
      results.push({ id: message.id, skipped: true, reason: "already_processed" });
      continue;
    }

    state = markSeen(state, message.id, now);
    if (!imessageMessageAllowed(message, connector.settings)) {
      results.push({ id: message.id, skipped: true, reason: "not_allowed", sender: message.sender });
      continue;
    }

    const ingested = await ingestExternalMessage(agent, {
      home,
      connector: "imessage",
      conversationId: message.chatGuid || message.chatIdentifier || String(message.chatId || message.sender || ""),
      sender: message.sender,
      messageId: message.guid || String(message.id),
      subject: message.isGroup ? `iMessage group ${message.chatName || message.chatIdentifier || message.chatGuid || message.chatId}` : "iMessage",
      text: message.text,
      metadata: {
        rowId: message.id,
        guid: message.guid,
        service: message.service,
        date: message.date,
        receivedAt: message.receivedAt,
        chatId: message.chatId,
        chatGuid: message.chatGuid,
        chatIdentifier: message.chatIdentifier,
        chatName: message.chatName,
        isGroup: message.isGroup
      },
      now
    });
    const dispatch = dispatchMode
      ? await dispatchExternalMessage(agent, {
        id: ingested.message.id,
        mode: dispatchMode,
        client: dispatchClient
      })
      : null;
    results.push({
      id: message.id,
      queued: !ingested.duplicate,
      duplicate: Boolean(ingested.duplicate),
      externalMessageId: ingested.message.id,
      routeStatus: ingested.route.status,
      dispatchStatus: dispatch?.status || null
    });
  }

  await writeJson(statePath, state);
  return pollResult({
    ok: true,
    status: "poll-complete",
    reason: null,
    connector,
    statePath,
    results
  });
}

export async function queryMessagesDatabase({
  databasePath,
  sinceRowId = 0,
  limit = DEFAULT_MAX_MESSAGES,
  sqlitePath = "sqlite3"
} = {}) {
  const sql = messagesQuery({
    sinceRowId: normalizeRowId(sinceRowId),
    limit: normalizeLimit(limit)
  });
  try {
    const { stdout } = await execFileAsync(sqlitePath, ["-json", databasePath, sql], {
      maxBuffer: 10 * 1024 * 1024
    });
    return stdout.trim() ? JSON.parse(stdout) : [];
  } catch (error) {
    throw new Error(`Unable to read Messages database with sqlite3: ${error.message}`);
  }
}

export function normalizeImessageRow(row) {
  if (!row || row.id == null) return null;
  const text = String(row.text || "").trim();
  if (!text) return null;
  return {
    id: normalizeRowId(row.id),
    guid: row.guid ? String(row.guid) : null,
    text,
    date: row.date == null ? null : Number(row.date),
    receivedAt: appleMessageDateToIso(row.date),
    isFromMe: truthy(row.is_from_me),
    sender: normalizeNullable(row.sender),
    service: normalizeNullable(row.service),
    chatId: row.chat_id == null ? null : String(row.chat_id),
    chatGuid: normalizeNullable(row.chat_guid),
    chatIdentifier: normalizeNullable(row.chat_identifier),
    chatName: normalizeNullable(row.chat_name),
    isGroup: truthy(row.is_group)
  };
}

export function imessageMessageAllowed(message, settings = {}) {
  if (!message || message.isFromMe) return false;
  const allowedSenders = parseList(settings.allowedSenders).map(normalizeAddress);
  if (allowedSenders.length > 0 && !allowedSenders.includes(normalizeAddress(message.sender))) return false;

  const allowedChats = parseList(settings.allowedChats);
  const chatAllowed = allowedChats.length === 0 || allowedChats.some((item) => chatMatches(message, item));
  if (!chatAllowed) return false;

  const explicitlyAllowedChat = allowedChats.length > 0 && allowedChats.some((item) => chatMatches(message, item));
  if (message.isGroup && !truthy(settings.allowGroupChats) && !explicitlyAllowedChat) return false;
  return true;
}

export function appleMessageDateToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) return null;
  let timestampMs;
  if (number > 1e15) {
    timestampMs = APPLE_EPOCH_MS + number / 1_000_000;
  } else if (number > 1e12) {
    timestampMs = APPLE_EPOCH_MS + number / 1_000;
  } else if (number > 1e8) {
    timestampMs = APPLE_EPOCH_MS + number * 1000;
  } else {
    return null;
  }
  const date = new Date(timestampMs);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

export function formatImessagePoll(result) {
  const lines = [
    `iMessage poll: ${result.status}`,
    `checked: ${result.checked}`,
    `queued: ${result.queued}`,
    `duplicates: ${result.duplicates}`,
    `skipped: ${result.skipped}`
  ];
  if (result.reason) lines.push(`reason: ${result.reason}`);
  return lines.join("\n");
}

function messagesQuery({ sinceRowId, limit }) {
  return `
SELECT
  message.ROWID AS id,
  message.guid AS guid,
  message.text AS text,
  message.date AS date,
  message.is_from_me AS is_from_me,
  message.service AS service,
  handle.id AS sender,
  chat.ROWID AS chat_id,
  chat.guid AS chat_guid,
  chat.chat_identifier AS chat_identifier,
  chat.display_name AS chat_name,
  CASE
    WHEN (SELECT COUNT(*) FROM chat_handle_join WHERE chat_handle_join.chat_id = chat.ROWID) > 1 THEN 1
    ELSE 0
  END AS is_group
FROM message
LEFT JOIN handle ON message.handle_id = handle.ROWID
LEFT JOIN chat_message_join ON chat_message_join.message_id = message.ROWID
LEFT JOIN chat ON chat.ROWID = chat_message_join.chat_id
WHERE message.ROWID > ${sinceRowId}
  AND message.is_from_me = 0
  AND message.text IS NOT NULL
  AND message.text <> ''
ORDER BY message.ROWID ASC
LIMIT ${limit};
`;
}

function pollResult({
  ok,
  status,
  reason = null,
  connector,
  statePath,
  results = []
}) {
  return {
    ok,
    status,
    reason,
    connector: {
      id: connector.id,
      ready: connector.ready,
      enabled: connector.enabled,
      configured: connector.configured,
      missingSettings: connector.missingSettings,
      missingPaths: connector.missingPaths
    },
    checked: results.length,
    queued: results.filter((result) => result.queued).length,
    duplicates: results.filter((result) => result.duplicate).length,
    skipped: results.filter((result) => result.skipped).length,
    statePath,
    results
  };
}

async function loadImessagePollState(statePath) {
  const current = await readJson(statePath, {});
  return {
    lastRowId: normalizeRowId(current.lastRowId || 0),
    updatedAt: current.updatedAt || null
  };
}

function markSeen(state, rowId, now) {
  const id = Math.max(normalizeRowId(rowId), normalizeRowId(state.lastRowId));
  return {
    lastRowId: id,
    updatedAt: now.toISOString()
  };
}

function normalizeRowId(value) {
  const number = Number(value || 0);
  if (!Number.isFinite(number) || number < 0) return 0;
  return Math.floor(number);
}

function normalizeLimit(value) {
  const limit = Number(value || DEFAULT_MAX_MESSAGES);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("iMessage poll limit must be at least 1.");
  return Math.round(limit);
}

function normalizeNullable(value) {
  const text = String(value || "").trim();
  return text || null;
}

function parseList(value) {
  return Array.isArray(value)
    ? value.flatMap(parseList)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function normalizeAddress(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[()\s-]/g, "");
}

function chatMatches(message, value) {
  const expected = String(value || "").trim();
  return expected !== "" && [
    message.chatId,
    message.chatGuid,
    message.chatIdentifier
  ].filter(Boolean).some((item) => String(item) === expected);
}

function truthy(value) {
  return value === true || ["1", "true", "yes", "on"].includes(String(value || "").trim().toLowerCase());
}
