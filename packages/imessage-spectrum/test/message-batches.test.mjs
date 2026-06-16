import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  buildRecentMessageBatches,
  normalizeEventLogRecord,
  readJsonlRecords
} from "@wakefield/connector-shared/message-batches.mjs";

test("buildRecentMessageBatches returns the latest logical time chunk", () => {
  const batches = buildRecentMessageBatches([
    { messageId: "old-1", receivedAt: "2026-05-23T10:00:00Z", sender: "Joe", text: "old" },
    { messageId: "new-1", receivedAt: "2026-05-23T12:00:00Z", sender: "Joe", text: "new 1" },
    { messageId: "new-2", receivedAt: "2026-05-23T12:12:00Z", sender: "Rick", text: "new 2" }
  ], {
    gapMinutes: 45,
    maxMessages: 10,
    batchCount: 1
  });

  assert.equal(batches.length, 1);
  assert.deepEqual(batches[0].messages.map((message) => message.messageId), ["new-1", "new-2"]);
});

test("readJsonlRecords and normalizeEventLogRecord preserve reply and reaction context", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "message-batches-test-"));
  const logPath = path.join(root, "events.jsonl");
  await fs.writeFile(logPath, `${JSON.stringify({
    platform: "imessage",
    space_id: "any;-;+15551234567",
    user_name: "Joe",
    user_id: "+15551234567",
    message_id: "spc-msg-2",
    received_at: "2026-05-23T12:00:00Z",
    reply_to_message_id: "spc-msg-1",
    reply_to_text: "Earlier question",
    reaction_to_message_id: "spc-msg-0",
    reaction_to_text: "Reacted-to question",
    text: "did you get to this?"
  })}\n`, "utf8");

  const [record] = await readJsonlRecords([logPath]);
  const message = normalizeEventLogRecord(record);

  assert.equal(message.conversationId, "any;-;+15551234567");
  assert.equal(message.replyTo.text, "Earlier question");
  assert.equal(message.reactionTo.text, "Reacted-to question");
});
