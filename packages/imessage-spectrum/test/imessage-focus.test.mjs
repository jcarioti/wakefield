import assert from "node:assert/strict";
import test from "node:test";
import { focusStateForTargetStatuses } from "../src/imessage-focus.mjs";

test("focusStateForTargetStatuses maps compacting statuses", () => {
  assert.equal(
    focusStateForTargetStatuses([{ active: true, contextCompacted: true }], {}, 1000),
    "compacting"
  );
  assert.equal(
    focusStateForTargetStatuses([{ active: true, contextCompacted: false, turnContextSeen: true }], {}, 1000),
    "online"
  );
});

test("focusStateForTargetStatuses holds compacting after context compact", () => {
  const compactedAt = "2026-05-23T03:26:48.116Z";
  assert.equal(
    focusStateForTargetStatuses(
      [{ active: false, lastContextCompactedAt: compactedAt }],
      { compactionHoldMs: 60000 },
      Date.parse(compactedAt) + 1000
    ),
    "compacting"
  );
});
