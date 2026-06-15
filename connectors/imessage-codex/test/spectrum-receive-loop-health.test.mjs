import assert from "node:assert/strict";
import test from "node:test";
import {
  SpectrumOperationTimeoutError,
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
