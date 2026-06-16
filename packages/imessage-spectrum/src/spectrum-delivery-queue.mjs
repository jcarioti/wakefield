import fs from "node:fs/promises";
import path from "node:path";

const QUEUE_VERSION = 1;

export class SpectrumDeliveryQueue {
  #queuePath;
  #writeChain = Promise.resolve();
  #now;

  constructor({ queuePath, now = () => new Date() } = {}) {
    this.#queuePath = queuePath || null;
    this.#now = now;
  }

  get path() {
    return this.#queuePath;
  }

  async pending() {
    const state = await this.#read();
    return state.records
      .filter((record) => !record.deliveredAt)
      .sort(compareDeliveryRecords);
  }

  async countPending() {
    return (await this.pending()).length;
  }

  async upsert(record) {
    if (!this.#queuePath) {
      return record;
    }
    return this.#withWrite(async () => {
      const state = await this.#read();
      const index = state.records.findIndex((entry) => entry.id === record.id);
      const existing = index >= 0 ? state.records[index] : null;
      const next = {
        ...existing,
        ...record,
        firstQueuedAt: existing?.firstQueuedAt || record.firstQueuedAt || this.#timestamp(),
        updatedAt: this.#timestamp(),
        attempts: existing?.attempts || record.attempts || 0,
        deliveredAt: existing?.deliveredAt || record.deliveredAt || null,
        lastError: existing?.lastError || record.lastError || null
      };
      if (index >= 0) {
        state.records[index] = next;
      } else {
        state.records.push(next);
      }
      await this.#write(state);
      return next;
    });
  }

  async markAttemptStarted(id) {
    if (!this.#queuePath) {
      return null;
    }
    return this.#update(id, (record) => ({
      ...record,
      attempts: Number(record.attempts || 0) + 1,
      lastAttemptAt: this.#timestamp(),
      lastError: null
    }));
  }

  async markAttemptFailed(id, error) {
    if (!this.#queuePath) {
      return null;
    }
    return this.#update(id, (record) => ({
      ...record,
      updatedAt: this.#timestamp(),
      lastError: serializeError(error)
    }));
  }

  async markDelivered(id, routeResult = null) {
    if (!this.#queuePath) {
      return null;
    }
    return this.#withWrite(async () => {
      const state = await this.#read();
      const index = state.records.findIndex((record) => record.id === id);
      if (index < 0) {
        return null;
      }
      const [record] = state.records.splice(index, 1);
      await this.#write(state);
      return {
        ...record,
        deliveredAt: this.#timestamp(),
        routeResult
      };
    });
  }

  async #update(id, updater) {
    return this.#withWrite(async () => {
      const state = await this.#read();
      const index = state.records.findIndex((record) => record.id === id);
      if (index < 0) {
        return null;
      }
      const next = updater(state.records[index]);
      state.records[index] = {
        ...next,
        updatedAt: next.updatedAt || this.#timestamp()
      };
      await this.#write(state);
      return state.records[index];
    });
  }

  async #read() {
    if (!this.#queuePath) {
      return emptyQueue();
    }
    try {
      const parsed = JSON.parse(await fs.readFile(this.#queuePath, "utf8"));
      return {
        version: QUEUE_VERSION,
        updatedAt: parsed.updatedAt || null,
        records: Array.isArray(parsed.records) ? parsed.records.filter((record) => record?.id) : []
      };
    } catch (error) {
      if (error?.code === "ENOENT") {
        return emptyQueue();
      }
      throw new Error(`Failed to read Spectrum delivery queue at ${this.#queuePath}: ${error.message}`);
    }
  }

  async #write(state) {
    await fs.mkdir(path.dirname(this.#queuePath), { recursive: true });
    const next = {
      version: QUEUE_VERSION,
      updatedAt: this.#timestamp(),
      records: state.records
    };
    await fs.writeFile(this.#queuePath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  }

  #withWrite(operation) {
    const next = this.#writeChain.then(operation, operation);
    this.#writeChain = next.catch(() => {});
    return next;
  }

  #timestamp() {
    const value = this.#now();
    return value instanceof Date ? value.toISOString() : new Date(value).toISOString();
  }
}

export function createDeliveryId({ targetId, spaceId, messageId }) {
  return [targetId, spaceId, messageId]
    .map((value) => encodeURIComponent(String(value || "")))
    .join(":");
}

export async function beginPendingDeliveryAttempt(queue, record) {
  const queuedRecord = await queue.markAttemptStarted(record.id);
  if (queue.path && !queuedRecord) {
    return null;
  }
  return queuedRecord || record;
}

export async function findEarlierPendingDeliveryInLane(queue, record) {
  if (!queue?.path) {
    return null;
  }
  const pending = await queue.pending();
  let earlierSameLane = null;
  for (const entry of pending) {
    if (entry.id === record.id) {
      return earlierSameLane;
    }
    if (sameDeliveryLane(entry, record)) {
      earlierSameLane = entry;
    }
  }
  return null;
}

export function createPendingDeliveryRecord({
  target,
  space,
  message,
  codexText,
  eventLogRecord,
  source = "live",
  now = new Date()
}) {
  const queuedAt = now instanceof Date ? now.toISOString() : new Date(now).toISOString();
  return {
    id: createDeliveryId({
      targetId: target.id,
      spaceId: space.id,
      messageId: message.id
    }),
    source,
    targetId: target.id,
    targetThreadId: target.threadId,
    targetCwd: target.cwd,
    spaceId: space.id,
    spaceType: space.type || null,
    messageId: message.id,
    receivedAt: normalizeTimestamp(message.timestamp),
    sender: message.sender?.id || null,
    codexText,
    eventLogRecord,
    firstQueuedAt: queuedAt,
    updatedAt: queuedAt,
    attempts: 0,
    lastAttemptAt: null,
    lastError: null,
    deliveredAt: null
  };
}

export function deliveredEventLogRecord(record, routeResult) {
  return {
    ...record.eventLogRecord,
    codex_route: routeResult?.action || null,
    codex_turn_id: routeResult?.turnId || null
  };
}

export function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null,
    method: error?.method || null
  };
}

function compareDeliveryRecords(left, right) {
  const leftTime = Date.parse(left.receivedAt || left.firstQueuedAt || 0);
  const rightTime = Date.parse(right.receivedAt || right.firstQueuedAt || 0);
  if (Number.isFinite(leftTime) && Number.isFinite(rightTime) && leftTime !== rightTime) {
    return leftTime - rightTime;
  }
  return String(left.id).localeCompare(String(right.id));
}

function sameDeliveryLane(left, right) {
  return left?.targetId === right?.targetId && left?.spaceId === right?.spaceId;
}

function emptyQueue() {
  return {
    version: QUEUE_VERSION,
    updatedAt: null,
    records: []
  };
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
