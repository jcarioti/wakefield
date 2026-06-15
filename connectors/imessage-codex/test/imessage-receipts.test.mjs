import assert from "node:assert/strict";
import test from "node:test";
import { appleMessageDateToIso, normalizeReceiptRow } from "../src/imessage-receipts.mjs";

test("appleMessageDateToIso converts nanosecond Apple timestamps", () => {
  assert.equal(
    appleMessageDateToIso(1_000_000_000_000_000_000),
    "2032-09-09T01:46:40.000Z"
  );
});

test("normalizeReceiptRow exposes delivered and read status", () => {
  const status = normalizeReceiptRow({
    id: 1,
    guid: "guid-1",
    service: "iMessage",
    is_from_me: 1,
    is_sent: 1,
    is_delivered: 1,
    date_delivered: 1_000_000_000_000_000_000,
    is_read: 0,
    date_read: 2_000_000_000,
    error: 0,
    is_finished: 1,
    date: 500_000_000
  });
  assert.equal(status.sent, true);
  assert.equal(status.delivered, true);
  assert.equal(status.read, true);
  assert.equal(status.deliveredAt, "2032-09-09T01:46:40.000Z");
});
