import assert from "node:assert/strict";
import test from "node:test";
import { createContactResolver } from "../src/contact-resolver.mjs";
import {
  formatImessageMessageForCodex,
  matchesTarget
} from "../src/imessage-message-format.mjs";

const message = {
  id: 12,
  guid: "msg-guid",
  chat_id: 5,
  chat_guid: "iMessage;-;+15551234567",
  chat_identifier: "+15551234567",
  chat_name: "Joe",
  sender: "+15551234567",
  sender_name: "Joe",
  is_from_me: false,
  is_group: false,
  text: "hello",
  created_at: "2026-05-23T10:00:00Z",
  attachments: [{
    transfer_name: "probe.pdf",
    mime_type: "application/pdf",
    path: "/tmp/probe.pdf"
  }]
};

test("matchesTarget accepts configured direct sender and rejects outgoing", () => {
  const target = {
    allowedAddresses: ["+15551234567"],
    allowedChatIds: [],
    allowedChatGuids: [],
    allowGroupChats: false
  };
  assert.equal(matchesTarget(message, target), true);
  assert.equal(matchesTarget({ ...message, is_from_me: true }, target), false);
});

test("formatImessageMessageForCodex stays compact and includes reply target and attachments", () => {
  const text = formatImessageMessageForCodex({
    message,
    target: { id: "rick" },
    memory: "Context for this external message\nActive context:\n- joe-package: [active] Joe package follow-up",
    contacts: createContactResolver({
      phone_numbers: { "+15551234567": "joe" },
      people: { joe: { display_name: "Joe" } }
    })
  });
  assert.match(text, /^Source: iMessage dm/m);
  assert.match(text, /^From: Joe <\+15551234567>/m);
  assert.match(text, /Use \$imessage-connector for iMessage connector routing\./);
  assert.match(text, /Reply: imessage_send_message\(\{ chatId: 5 \}\)/);
  assert.match(text, /probe.pdf \(application\/pdf\): \/tmp\/probe.pdf/);
  assert.doesNotMatch(text, /Context for this external message/);
  assert.doesNotMatch(text, /joe-package/);
  assert.doesNotMatch(text, /Source metadata/);
});
