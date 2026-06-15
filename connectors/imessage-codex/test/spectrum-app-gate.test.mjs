import assert from "node:assert/strict";
import test from "node:test";
import {
  SpectrumAppOperationGate,
  isSpectrumChannelShutdownError
} from "../src/spectrum-app-gate.mjs";

test("SpectrumAppOperationGate serializes overlapping operations", async () => {
  const gate = new SpectrumAppOperationGate();
  const events = [];
  let releaseFirst;

  const first = gate.run(async () => {
    events.push("first:start");
    await new Promise((resolve) => {
      releaseFirst = resolve;
    });
    events.push("first:end");
  });
  const second = gate.run(async () => {
    events.push("second:start");
  });

  await new Promise((resolve) => setImmediate(resolve));
  assert.deepEqual(events, ["first:start"]);
  releaseFirst();
  await Promise.all([first, second]);
  assert.deepEqual(events, ["first:start", "first:end", "second:start"]);
});

test("SpectrumAppOperationGate keeps running after a failed operation", async () => {
  const gate = new SpectrumAppOperationGate();
  await assert.rejects(
    () => gate.run(async () => {
      throw new Error("boom");
    }),
    /boom/
  );

  assert.equal(await gate.run(async () => "ok"), "ok");
});

test("SpectrumAppOperationGate enforces a minimum gap between operation starts", async () => {
  let now = 1000;
  const sleeps = [];
  const gate = new SpectrumAppOperationGate({
    minIntervalMs: 1500,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
      now += ms;
    }
  });

  await gate.run(async () => "first");
  now += 200;
  await gate.run(async () => "second");

  assert.deepEqual(sleeps, [1300]);
});

test("isSpectrumChannelShutdownError recognizes provider channel closure", () => {
  assert.equal(isSpectrumChannelShutdownError(new Error("Channel has been shut down")), true);
  assert.equal(isSpectrumChannelShutdownError(new Error("Connection dropped")), true);
  assert.equal(isSpectrumChannelShutdownError(new Error("Too many requests")), false);
});
