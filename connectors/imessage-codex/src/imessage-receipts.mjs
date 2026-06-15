import { execFile } from "node:child_process";

const APPLE_EPOCH_MS = Date.UTC(2001, 0, 1);

export async function readReceiptStatus({
  databasePath,
  messageId = null,
  messageGuid = null
}) {
  if (!messageId && !messageGuid) {
    throw new Error("Receipt lookup requires messageId or messageGuid.");
  }
  const conditions = [];
  if (messageId != null && String(messageId).trim()) {
    const numericId = Number(messageId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      throw new Error(`Invalid message id: ${messageId}`);
    }
    conditions.push(`ROWID = ${numericId}`);
  }
  if (messageGuid) {
    conditions.push(`guid = '${escapeSql(messageGuid)}'`);
  }
  const sql = `
    SELECT
      ROWID AS id,
      guid,
      service,
      is_from_me,
      is_sent,
      is_delivered,
      date_delivered,
      is_read,
      date_read,
      error,
      is_finished,
      date
    FROM message
    WHERE ${conditions.join(" OR ")}
    ORDER BY ROWID DESC
    LIMIT 1;
  `;
  const rows = await sqliteJson({ databasePath, sql });
  const row = rows[0] || null;
  if (!row) {
    return { found: false, messageId, messageGuid };
  }
  return normalizeReceiptRow(row);
}

export function normalizeReceiptRow(row) {
  const deliveredAt = appleMessageDateToIso(row.date_delivered);
  const readAt = appleMessageDateToIso(row.date_read);
  return {
    found: true,
    id: row.id,
    guid: row.guid,
    service: row.service || null,
    fromMe: row.is_from_me === 1,
    sent: row.is_sent === 1,
    delivered: row.is_delivered === 1 || Boolean(deliveredAt),
    deliveredAt,
    read: Boolean(readAt),
    readAt,
    localRead: row.is_read === 1,
    error: row.error ?? null,
    finished: row.is_finished === 1,
    createdAt: appleMessageDateToIso(row.date)
  };
}

export function appleMessageDateToIso(value) {
  const number = Number(value);
  if (!Number.isFinite(number) || number <= 0) {
    return null;
  }
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

function sqliteJson({ databasePath, sql }) {
  return new Promise((resolve, reject) => {
    execFile("sqlite3", ["-readonly", "-json", databasePath, sql], (error, stdout, stderr) => {
      if (error) {
        reject(new Error([error.message, stderr?.trim()].filter(Boolean).join(": ")));
        return;
      }
      try {
        resolve(stdout.trim() ? JSON.parse(stdout) : []);
      } catch (parseError) {
        reject(new Error(`Failed to parse sqlite JSON: ${parseError.message}`));
      }
    });
  });
}

function escapeSql(value) {
  return String(value).replaceAll("'", "''");
}
