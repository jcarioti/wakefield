import assert from "node:assert/strict";
import test from "node:test";
import {
  advancedBridgeReadyFromStatusRows,
  assertAdvancedBridgeReady,
  buildWatchArgs,
  imsgTargetArgs
} from "../src/imsg-cli.mjs";

test("buildWatchArgs includes resume cursor and attachment flags", () => {
  assert.deepEqual(
    buildWatchArgs({
      state: { lastRowId: 100 },
      imessage: {
        databasePath: "/tmp/chat.db",
        watch: {
          includeAttachments: true,
          convertAttachments: true,
          includeReactions: true,
          debounce: "750ms"
        }
      }
    }),
    [
      "watch",
      "--json",
      "--attachments",
      "--convert-attachments",
      "--reactions",
      "--debounce",
      "750ms",
      "--since-rowid",
      "100",
      "--db",
      "/tmp/chat.db"
    ]
  );
});

test("imsgTargetArgs chooses one supported target", () => {
  assert.deepEqual(imsgTargetArgs({ chatId: 42 }), ["--chat-id", "42"]);
  assert.deepEqual(imsgTargetArgs({ chatGuid: "iMessage;-;+15551234567" }), ["--chat-guid", "iMessage;-;+15551234567"]);
  assert.deepEqual(imsgTargetArgs({ to: "+15551234567" }), ["--to", "+15551234567"]);
});

test("advancedBridgeReadyFromStatusRows requires advanced typing and read receipt flags", () => {
  assert.deepEqual(
    advancedBridgeReadyFromStatusRows([{
      advanced_features: true,
      typing_indicators: true,
      read_receipts: true
    }]),
    {
      ok: true,
      required: true,
      status: {
        advanced_features: true,
        typing_indicators: true,
        read_receipts: true
      },
      reason: null
    }
  );

  const notReady = advancedBridgeReadyFromStatusRows([{
    advanced_features: true,
    typing_indicators: false,
    read_receipts: true
  }]);
  assert.equal(notReady.ok, false);
  assert.match(notReady.reason, /typing_indicators/);
});

test("assertAdvancedBridgeReady can be disabled for non-advanced installs", async () => {
  const result = await assertAdvancedBridgeReady({
    imessage: { advancedBridgeRequired: false },
    statusReader: async () => {
      throw new Error("should not be called");
    }
  });
  assert.deepEqual(result, { ok: true, required: false, status: null });
});

test("assertAdvancedBridgeReady fails loudly when required status is unavailable", async () => {
  await assert.rejects(
    () => assertAdvancedBridgeReady({
      imessage: { advancedBridgeRequired: true },
      statusReader: async () => ([{
        advanced_features: true,
        typing_indicators: true,
        read_receipts: false
      }])
    }),
    /advanced bridge is required.*read_receipts/
  );
});
