import assert from "node:assert/strict";
import test from "node:test";
import {
  DEFAULT_SPECTRUM_RATE_LIMIT_COOLDOWN_MS,
  SpectrumOperationTimeoutError,
  SpectrumRateLimitCooldown,
  isSpectrumRateLimitError,
  shouldRotateReceiveLoopAfterHistoryReplay,
  spectrumRateLimitRetryAfterMs,
  spectrumServiceStatusForReceiveLoop,
  withSpectrumOperationTimeout
} from "../src/spectrum-receive-loop-health.mjs";

test("withSpectrumOperationTimeout resolves successful operations and clears the timer", async () => {
  const timeoutId = { id: "timer" };
  let clearedId = null;

  const result = await withSpectrumOperationTimeout(
    async () => "ok",
    {
      label: "startup createSpectrumApp",
      timeoutMs: 1000,
      setTimeoutFn: () => timeoutId,
      clearTimeoutFn: (id) => {
        clearedId = id;
      }
    }
  );

  assert.equal(result, "ok");
  assert.equal(clearedId, timeoutId);
});

test("withSpectrumOperationTimeout rejects stalled operations with context", async () => {
  let timeoutCallback = null;
  const operation = withSpectrumOperationTimeout(
    () => new Promise(() => {}),
    {
      label: "receive-loop restart app.stop",
      timeoutMs: 50,
      setTimeoutFn: (callback, ms) => {
        assert.equal(ms, 50);
        timeoutCallback = callback;
        return { unref() {} };
      },
      clearTimeoutFn: () => {}
    }
  );

  timeoutCallback();

  await assert.rejects(
    operation,
    (error) => {
      assert.equal(error instanceof SpectrumOperationTimeoutError, true);
      assert.equal(error.name, "SpectrumOperationTimeoutError");
      assert.equal(error.label, "receive-loop restart app.stop");
      assert.equal(error.timeoutMs, 50);
      assert.match(error.message, /timed out after 50ms/);
      return true;
    }
  );
});

test("spectrumServiceStatusForReceiveLoop maps internal state to service status", () => {
  assert.equal(spectrumServiceStatusForReceiveLoop("running"), "online");
  assert.equal(spectrumServiceStatusForReceiveLoop("restarting"), "receive-loop-restarting");
  assert.equal(spectrumServiceStatusForReceiveLoop("rate-limited"), "rate-limited");
  assert.equal(spectrumServiceStatusForReceiveLoop("failed"), "receive-loop-failed");
});

test("Spectrum rate-limit cooldown honors Photon retry-after with a 60-second minimum", () => {
  assert.equal(isSpectrumRateLimitError(new Error("Rate limited by ip_per_minute")), true);
  assert.equal(isSpectrumRateLimitError(new Error("ordinary failure")), false);
  assert.equal(spectrumRateLimitRetryAfterMs(new Error("Retry after 5s")), DEFAULT_SPECTRUM_RATE_LIMIT_COOLDOWN_MS);
  assert.equal(spectrumRateLimitRetryAfterMs(new Error("Retry after 90s")), 90_000);

  let now = 1_000;
  const cooldown = new SpectrumRateLimitCooldown({
    now: () => now,
    jitterMs: 0
  });
  assert.deepEqual(cooldown.activate(new Error("Retry after 60s")), {
    active: true,
    until: new Date(61_000).toISOString(),
    remainingMs: 60_000
  });
  now = 61_000;
  assert.deepEqual(cooldown.snapshot(), {
    active: false,
    until: new Date(61_000).toISOString(),
    remainingMs: 0
  });
});

test("shouldRotateReceiveLoopAfterHistoryReplay rotates only after periodic replay recovers messages", () => {
  assert.equal(shouldRotateReceiveLoopAfterHistoryReplay({
    reason: "periodic history poll",
    stats: { queuedCount: 1 }
  }), true);
  assert.equal(shouldRotateReceiveLoopAfterHistoryReplay({
    reason: "startup",
    stats: { queuedCount: 1 }
  }), false);
  assert.equal(shouldRotateReceiveLoopAfterHistoryReplay({
    reason: "periodic history poll",
    stats: { queuedCount: 0 }
  }), false);
});
