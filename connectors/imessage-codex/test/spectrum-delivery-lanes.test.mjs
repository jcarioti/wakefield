import assert from "node:assert/strict";
import test from "node:test";
import {
  SpectrumDeliveryLaneScheduler,
  deliveryLaneKey
} from "../src/spectrum-delivery-lanes.mjs";

test("deliveryLaneKey groups records by target and iMessage space", () => {
  assert.equal(
    deliveryLaneKey({ targetId: "rick", spaceId: "any;-;+15551234567" }),
    "rick\u0000any;-;+15551234567"
  );
});

test("same target and space delivery operations run FIFO", async () => {
  const scheduler = new SpectrumDeliveryLaneScheduler();
  const events = [];
  let releaseFirst = null;
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = scheduler.run(record("spc-msg-1"), async () => {
    events.push("first-start");
    await firstReleased;
    events.push("first-end");
    return "first";
  });
  const second = scheduler.run(record("spc-msg-2"), async () => {
    events.push("second-start");
    events.push("second-end");
    return "second";
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["first-start"]);

  releaseFirst();
  assert.deepEqual(await Promise.all([first, second]), ["first", "second"]);
  assert.deepEqual(events, ["first-start", "first-end", "second-start", "second-end"]);
  assert.equal(scheduler.size(), 0);
});

test("same delivery lane continues after an earlier operation fails", async () => {
  const scheduler = new SpectrumDeliveryLaneScheduler();
  const events = [];
  const first = scheduler.run(record("spc-msg-1"), async () => {
    events.push("first-start");
    throw new Error("route failed");
  });
  const second = scheduler.run(record("spc-msg-2"), async () => {
    events.push("second-start");
    return "second";
  });

  await assert.rejects(first, /route failed/);
  assert.equal(await second, "second");
  assert.deepEqual(events, ["first-start", "second-start"]);
  assert.equal(scheduler.size(), 0);
});

test("different target or space delivery operations can run concurrently", async () => {
  const scheduler = new SpectrumDeliveryLaneScheduler();
  const events = [];
  let releaseFirst = null;
  const firstReleased = new Promise((resolve) => {
    releaseFirst = resolve;
  });

  const first = scheduler.run(record("spc-msg-1"), async () => {
    events.push("first-start");
    await firstReleased;
    events.push("first-end");
  });
  const otherSpace = scheduler.run(record("spc-msg-2", { spaceId: "any;-;+15557654321" }), async () => {
    events.push("other-space-start");
  });
  const otherTarget = scheduler.run(record("spc-msg-3", { targetId: "terence" }), async () => {
    events.push("other-target-start");
  });

  await Promise.resolve();
  await Promise.resolve();
  assert.deepEqual(events, ["first-start", "other-space-start", "other-target-start"]);

  releaseFirst();
  await Promise.all([first, otherSpace, otherTarget]);
  assert.deepEqual(events, ["first-start", "other-space-start", "other-target-start", "first-end"]);
  assert.equal(scheduler.size(), 0);
});

function record(messageId, overrides = {}) {
  return {
    id: `${overrides.targetId || "rick"}:${overrides.spaceId || "any;-;+15551234567"}:${messageId}`,
    targetId: overrides.targetId || "rick",
    spaceId: overrides.spaceId || "any;-;+15551234567",
    messageId
  };
}
