import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  SpectrumDeliveryQueue,
  beginPendingDeliveryAttempt,
  createDeliveryId,
  createPendingDeliveryRecord,
  deliveredEventLogRecord,
  findEarlierPendingDeliveryInLane
} from "../src/spectrum-delivery-queue.mjs";

test("SpectrumDeliveryQueue persists pending records until delivery is confirmed", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-delivery-queue-test-"));
  const queuePath = path.join(root, "queue.json");
  const queue = new SpectrumDeliveryQueue({
    queuePath,
    now: () => new Date("2026-05-26T17:00:00.000Z")
  });
  const record = createPendingDeliveryRecord({
    target: { id: "rick", threadId: "thread-1", cwd: "/tmp/rick" },
    space: { id: "any;-;+15551234567", type: "dm" },
    message: {
      id: "spc-msg-1",
      timestamp: new Date("2026-05-26T16:45:31.476Z"),
      sender: { id: "+15551234567" }
    },
    codexText: "iMessage DM from Joe\nMessage:\nWake up",
    eventLogRecord: {
      target_id: "rick",
      message_id: "spc-msg-1",
      codex_route: null,
      codex_turn_id: null
    }
  });

  await queue.upsert(record);
  assert.equal(await queue.countPending(), 1);

  const reloaded = new SpectrumDeliveryQueue({ queuePath });
  assert.deepEqual((await reloaded.pending()).map((entry) => entry.id), [record.id]);

  await reloaded.markAttemptStarted(record.id);
  await reloaded.markAttemptFailed(record.id, Object.assign(new Error("no-client-found"), {
    code: "no-client-found"
  }));
  const failed = (await reloaded.pending())[0];
  assert.equal(failed.attempts, 1);
  assert.equal(failed.lastError.code, "no-client-found");

  const delivered = await reloaded.markDelivered(record.id, { action: "start", turnId: "turn-1" });
  assert.equal(delivered.routeResult.turnId, "turn-1");
  assert.deepEqual(await reloaded.pending(), []);

  const persisted = JSON.parse(await fs.readFile(queuePath, "utf8"));
  assert.equal(persisted.records[0].id, record.id);
  assert.equal(persisted.records[0].deliveredAt != null, true);
});

test("delivery ids distinguish target, space, and message", () => {
  assert.equal(
    createDeliveryId({ targetId: "rick", spaceId: "any;-;+15551234567", messageId: "spc-msg-1" }),
    "rick:any%3B-%3B%2B15551234567:spc-msg-1"
  );
});

test("beginPendingDeliveryAttempt skips stale pending snapshots after delivery", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-delivery-queue-test-"));
  const queuePath = path.join(root, "queue.json");
  const queue = new SpectrumDeliveryQueue({ queuePath });
  const record = createPendingDeliveryRecord({
    target: { id: "rick", threadId: "thread-1", cwd: "/tmp/rick" },
    space: { id: "any;-;+15551234567", type: "dm" },
    message: {
      id: "spc-msg-1",
      timestamp: new Date("2026-05-26T16:45:31.476Z"),
      sender: { id: "+15551234567" }
    },
    codexText: "iMessage DM from Joe\nMessage:\nWake up",
    eventLogRecord: {
      target_id: "rick",
      message_id: "spc-msg-1",
      codex_route: null,
      codex_turn_id: null
    }
  });

  await queue.upsert(record);
  const staleSnapshot = (await queue.pending())[0];
  await queue.markDelivered(record.id, { action: "steer", turnId: "turn-1" });

  assert.equal(await beginPendingDeliveryAttempt(queue, staleSnapshot), null);
  assert.deepEqual(await queue.pending(), []);
});

test("upsert does not resurrect delivered records", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-delivery-queue-test-"));
  const queuePath = path.join(root, "queue.json");
  const queue = new SpectrumDeliveryQueue({ queuePath });
  const record = createPendingDeliveryRecord({
    target: { id: "rick", threadId: "thread-1", cwd: "/tmp/rick" },
    space: { id: "any;-;+15551234567", type: "dm" },
    message: {
      id: "spc-msg-1",
      timestamp: new Date("2026-05-26T16:45:31.476Z"),
      sender: { id: "+15551234567" }
    },
    codexText: "iMessage DM from Joe\nMessage:\nWake up",
    eventLogRecord: {
      target_id: "rick",
      message_id: "spc-msg-1",
      codex_route: null,
      codex_turn_id: null
    }
  });

  await queue.upsert(record);
  const delivered = await queue.markDelivered(record.id, { action: "start", turnId: "turn-1" });
  const upserted = await queue.upsert({
    ...record,
    codexText: "replayed text"
  });

  assert.equal(upserted.deliveredAt, delivered.deliveredAt);
  assert.deepEqual(await queue.pending(), []);
  assert.equal(await beginPendingDeliveryAttempt(queue, upserted), null);
});

test("findEarlierPendingDeliveryInLane blocks newer same-chat records until older messages deliver", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-delivery-queue-test-"));
  const queuePath = path.join(root, "queue.json");
  const queue = new SpectrumDeliveryQueue({ queuePath });
  const newer = createPendingDeliveryRecord({
    target: { id: "rick", threadId: "thread-1", cwd: "/tmp/rick" },
    space: { id: "any;-;+15551234567", type: "dm" },
    message: {
      id: "spc-msg-newer",
      timestamp: new Date("2026-06-07T05:08:10.248Z"),
      sender: { id: "+15551234567" }
    },
    codexText: "newer",
    eventLogRecord: { target_id: "rick", message_id: "spc-msg-newer" }
  });
  const older = createPendingDeliveryRecord({
    target: { id: "rick", threadId: "thread-1", cwd: "/tmp/rick" },
    space: { id: "any;-;+15551234567", type: "dm" },
    message: {
      id: "spc-msg-older",
      timestamp: new Date("2026-06-07T05:08:01.904Z"),
      sender: { id: "+15551234567" }
    },
    codexText: "older",
    eventLogRecord: { target_id: "rick", message_id: "spc-msg-older" }
  });
  const otherChat = createPendingDeliveryRecord({
    target: { id: "rick", threadId: "thread-1", cwd: "/tmp/rick" },
    space: { id: "any;-;+15557654321", type: "dm" },
    message: {
      id: "spc-msg-other-chat",
      timestamp: new Date("2026-06-07T05:08:00.000Z"),
      sender: { id: "+15557654321" }
    },
    codexText: "other chat",
    eventLogRecord: { target_id: "rick", message_id: "spc-msg-other-chat" }
  });

  await queue.upsert(newer);
  await queue.upsert(otherChat);
  await queue.upsert(older);

  assert.equal((await findEarlierPendingDeliveryInLane(queue, newer))?.messageId, "spc-msg-older");
  assert.equal(await findEarlierPendingDeliveryInLane(queue, older), null);
  assert.equal(await findEarlierPendingDeliveryInLane(queue, otherChat), null);

  await queue.markDelivered(older.id, { action: "steer", turnId: "turn-1" });
  assert.equal(await findEarlierPendingDeliveryInLane(queue, newer), null);
});

test("deliveredEventLogRecord stamps the successful Codex route", () => {
  assert.deepEqual(deliveredEventLogRecord({
    eventLogRecord: {
      target_id: "rick",
      message_id: "spc-msg-1",
      codex_route: null,
      codex_turn_id: null
    }
  }, {
    action: "steer",
    turnId: "turn-1"
  }), {
    target_id: "rick",
    message_id: "spc-msg-1",
    codex_route: "steer",
    codex_turn_id: "turn-1"
  });
});
