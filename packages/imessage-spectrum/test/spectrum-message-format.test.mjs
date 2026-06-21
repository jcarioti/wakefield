import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createContactResolver } from "../src/contact-resolver.mjs";
import {
  materializeSpectrumContent,
  mergeSpectrumHistoryContent,
  shouldEnrichSpectrumContentFromHistory
} from "../src/spectrum-content.mjs";
import {
  formatSpectrumMessageForCodex,
  matchesSpectrumTarget
} from "../src/spectrum-message-format.mjs";

const space = {
  id: "any;-;+15551234567",
  type: "dm",
  phone: "+15550000000"
};

const message = {
  id: "spc-msg-1",
  direction: "inbound",
  platform: "iMessage",
  timestamp: new Date("2026-05-23T10:00:00Z"),
  sender: { id: "+15551234567" },
  content: { type: "text", text: "hello" }
};

test("matchesSpectrumTarget accepts configured sender and known spaces", () => {
  assert.equal(matchesSpectrumTarget({
    space,
    message,
    target: {
      allowedAddresses: ["+15551234567"],
      allowedSpaceIds: [],
      allowedChatGuids: [],
      allowGroupChats: false
    }
  }), true);

  assert.equal(matchesSpectrumTarget({
    space,
    message: { ...message, direction: "outbound" },
    target: {
      allowedAddresses: ["+15551234567"],
      allowedSpaceIds: [],
      allowedChatGuids: [],
      allowGroupChats: false
    }
  }), false);
});

test("matchesSpectrumTarget requires explicit group chat allowance", () => {
  const groupSpace = {
    id: "any;+;company",
    type: "group",
    phone: "+15550000000"
  };
  const target = {
    allowedAddresses: [],
    allowedSpaceIds: ["any;+;company"],
    allowedChatGuids: [],
    allowGroupChats: false
  };

  assert.equal(matchesSpectrumTarget({
    space: groupSpace,
    message,
    target
  }), false);

  assert.equal(matchesSpectrumTarget({
    space: groupSpace,
    message,
    target: { ...target, allowGroupChats: true }
  }), true);
});

test("formatSpectrumMessageForCodex stays compact and includes Spectrum reply target", () => {
  const text = formatSpectrumMessageForCodex({
    space,
    message,
    target: { id: "rick" },
    content: { text: "hello", attachments: [] },
    contacts: createContactResolver({
      phone_numbers: { "+15551234567": "joe" },
      people: { joe: { display_name: "Joe" } }
    })
  });
  assert.match(text, /^iMessage DM from Joe <\+15551234567>/m);
  assert.match(text, /Use \$imessage-connector for iMessage connector routing\./);
  assert.match(text, /Message:\nhello/);
  assert.match(text, /^Route: spaceId=any;-;\+15551234567 replyToMessageId=spc-msg-1 messageId=spc-msg-1$/m);
  assert.doesNotMatch(text, /Context: no linked prior message was included/);
  assert.doesNotMatch(text, /^Tools:/m);
  assert.doesNotMatch(text, /imessage_send_message\(\{/);
  assert.doesNotMatch(text, /Keep this topic scoped/);
  assert.doesNotMatch(text, /Source metadata/);
});

test("formatSpectrumMessageForCodex ignores connector memory payloads", () => {
  const text = formatSpectrumMessageForCodex({
    space,
    message,
    target: { id: "rick" },
    content: { text: "is Earle closed?", attachments: [] },
    memory: "Context for this external message\nActive context:\n- rma-earle-20260514-01: [waiting] Earle RMA"
  });

  assert.doesNotMatch(text, /Context for this external message/);
  assert.doesNotMatch(text, /rma-earle-20260514-01/);
  assert.match(text, /Message:\nis Earle closed\?/);
});

test("formatSpectrumMessageForCodex includes quiet group behavior", () => {
  const text = formatSpectrumMessageForCodex({
    space: {
      id: "any;+;company",
      type: "group",
      phone: "+15550000000"
    },
    message,
    target: { id: "rick" },
    content: { text: "ambient update", attachments: [] }
  });

  assert.match(text, /^iMessage group any;\+;company from \+15551234567/m);
  assert.match(text, /Group behavior: monitor quietly like #boardroom/);
});

test("formatSpectrumMessageForCodex routes reaction event actions to the original target", async () => {
  const content = await materializeSpectrumContent({
    attachmentDir: null,
    message: {
      id: "spc-msg-original:reaction:20462:0",
      content: {
        type: "reaction",
        emoji: "\u2753",
        target: {
          id: "spc-msg-original",
          direction: "inbound",
          platform: "iMessage",
          timestamp: new Date("2026-05-23T09:58:00Z"),
          sender: { id: "+15551234567" },
          content: { type: "text", text: "Can you answer this?" }
        }
      }
    }
  });
  const text = formatSpectrumMessageForCodex({
    space,
    message: {
      ...message,
      id: "spc-msg-original:reaction:20462:0"
    },
    target: { id: "rick" },
    content
  });

  assert.match(text, /Current event:\nReaction: \u2753/);
  assert.match(text, /Current user action: \+15551234567 reacted with \u2753 to a prior message\./);
  assert.match(text, /Reacted-to message:\n\(from \+15551234567; sent 2026-05-23T09:58:00.000Z; messageId spc-msg-original\)\nCan you answer this\?/);
  assert.match(text, /^Route: spaceId=any;-;\+15551234567 replyToMessageId=spc-msg-original messageId=spc-msg-original:reaction:20462:0$/m);
  assert.doesNotMatch(text, /^Tools:/m);
  assert.doesNotMatch(text, /replyToMessageId=spc-msg-original:reaction/);
  assert.doesNotMatch(text, /do not react to the reaction event/);
});

test("formatSpectrumMessageForCodex includes replied-to message text when Spectrum supplies it", async () => {
  const content = await materializeSpectrumContent({
    attachmentDir: null,
    message: {
      id: "spc-reply-1",
      content: {
        type: "reply",
        content: { type: "text", text: "The one I am replying to?" },
        target: {
          id: "spc-original-1",
          direction: "inbound",
          platform: "iMessage",
          timestamp: new Date("2026-05-23T09:59:00Z"),
          sender: { id: "+15551234567" },
          content: { type: "text", text: "Original text" }
        }
      }
    }
  });

  const text = formatSpectrumMessageForCodex({
    space,
    message: { ...message, id: "spc-reply-1" },
    target: { id: "rick" },
    content
  });

  assert.match(text, /This message replies to:\n\(from \+15551234567; sent 2026-05-23T09:59:00.000Z; messageId spc-original-1\)\nOriginal text/);
  assert.match(text, /Message:\nThe one I am replying to\?/);
});

test("formatSpectrumMessageForCodex includes nested reply history when Spectrum supplies it", async () => {
  const content = await materializeSpectrumContent({
    attachmentDir: null,
    message: {
      id: "spc-reply-2",
      content: {
        type: "reply",
        content: { type: "text", text: "Did you get to those things?" },
        target: {
          id: "spc-reply-1",
          direction: "inbound",
          platform: "iMessage",
          timestamp: new Date("2026-05-23T09:59:00Z"),
          sender: { id: "+15551234567" },
          content: {
            type: "reply",
            content: { type: "text", text: "Can you do A and B?" },
            target: {
              id: "spc-original-1",
              direction: "inbound",
              platform: "iMessage",
              timestamp: new Date("2026-05-23T09:58:00Z"),
              sender: { id: "+15551234567" },
              content: { type: "text", text: "Original context" }
            }
          }
        }
      }
    }
  });

  const text = formatSpectrumMessageForCodex({
    space,
    message: { ...message, id: "spc-reply-2" },
    target: { id: "rick" },
    content
  });

  assert.match(text, /Message:\nDid you get to those things\?/);
  assert.match(text, /This message replies to:\n\(from \+15551234567; sent 2026-05-23T09:59:00.000Z; messageId spc-reply-1\)\nCan you do A and B\?/);
  assert.match(text, /Earlier in reply chain:\n\(from \+15551234567; sent 2026-05-23T09:58:00.000Z; messageId spc-original-1\)\nOriginal context/);
});


test("materializeSpectrumContent writes attachment content to disk", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-content-test-"));
  const result = await materializeSpectrumContent({
    attachmentDir: root,
    message: {
      id: "spc-msg-2",
      content: {
        type: "attachment",
        name: "probe.pdf",
        mimeType: "application/pdf",
        size: 4,
        read: async () => Buffer.from("test")
      }
    }
  });

  assert.equal(result.attachments.length, 1);
  assert.equal(result.attachments[0].mimeType, "application/pdf");
  assert.equal(await fs.readFile(result.attachments[0].path, "utf8"), "test");
});

test("materializeSpectrumContent preserves text on attachment messages", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "spectrum-content-caption-test-"));
  const result = await materializeSpectrumContent({
    attachmentDir: root,
    message: {
      id: "spc-msg-price-list",
      content: {
        type: "attachment",
        text: "Use the following file to create a new price list in Zoho.",
        name: "price-list.pdf",
        mimeType: "application/pdf",
        size: 4,
        read: async () => Buffer.from("test")
      }
    }
  });

  assert.match(result.text, /^Use the following file to create a new price list in Zoho\./);
  assert.match(result.text, /\[Attachment: price-list\.pdf \(application\/pdf\)\]/);

  const formatted = formatSpectrumMessageForCodex({
    space,
    message: { ...message, id: "spc-msg-price-list" },
    target: { id: "rick" },
    content: result
  });
  assert.match(formatted, /Message:\nUse the following file to create a new price list in Zoho\./);
  assert.match(formatted, /Attachments:\n- price-list\.pdf \(application\/pdf, 4 bytes\): /);
});

test("mergeSpectrumHistoryContent restores missing attachment captions in inline order", () => {
  const liveContent = {
    text: "[Attachment: IMG_2694.heic (image/heic)]",
    attachments: [{
      name: "IMG_2694.heic",
      path: "/tmp/local/IMG_2694.heic",
      mimeType: "image/heic",
      size: 940193
    }]
  };

  assert.equal(shouldEnrichSpectrumContentFromHistory(liveContent), true);

  const result = mergeSpectrumHistoryContent({
    liveContent,
    historyMessage: {
      text: "\uFFFCThis is a test to see if the iMessage injector can handle text+attachment\n[Attachment: IMG_2694.heic (image/heic)]",
      attachments: [{
        name: "IMG_2694.heic",
        mimeType: "image/heic",
        size: 940193
      }]
    }
  });

  assert.equal(result.text, "[Attachment: IMG_2694.heic (image/heic)]\nThis is a test to see if the iMessage injector can handle text+attachment");
  assert.deepEqual(result.attachments, liveContent.attachments);
});

test("mergeSpectrumHistoryContent preserves text-before-attachment captions", () => {
  const liveContent = {
    text: "[Attachment: IMG_2700.heic (image/heic)]",
    attachments: [{
      name: "IMG_2700.heic",
      path: "/tmp/local/IMG_2700.heic",
      mimeType: "image/heic",
      size: 940193
    }]
  };

  const result = mergeSpectrumHistoryContent({
    liveContent,
    historyMessage: {
      text: "Please check this \uFFFC\n[Attachment: IMG_2700.heic (image/heic)]"
    }
  });

  assert.equal(result.text, "Please check this\n[Attachment: IMG_2700.heic (image/heic)]");
  assert.deepEqual(result.attachments, liveContent.attachments);
});

test("mergeSpectrumHistoryContent leaves already captioned attachment content alone", () => {
  const liveContent = {
    text: "Use this image please\n[Attachment: IMG_2694.heic (image/heic)]",
    attachments: [{
      name: "IMG_2694.heic",
      path: "/tmp/local/IMG_2694.heic",
      mimeType: "image/heic",
      size: 940193
    }]
  };

  assert.equal(shouldEnrichSpectrumContentFromHistory(liveContent), false);
  assert.equal(mergeSpectrumHistoryContent({
    liveContent,
    historyMessage: {
      text: "Different history text\n[Attachment: IMG_2694.heic (image/heic)]"
    }
  }), liveContent);
});

test("materializeSpectrumContent includes reaction target when available", async () => {
  const result = await materializeSpectrumContent({
    attachmentDir: null,
    message: {
      id: "spc-reaction-1",
      content: {
        type: "reaction",
        emoji: "\u{1F44D}",
        target: { id: "spc-msg-1" }
      }
    }
  });

  assert.equal(result.text, "[Reaction: \u{1F44D} on spc-msg-1]");
  assert.deepEqual(result.reaction, {
    emoji: "\u{1F44D}",
    targetId: "spc-msg-1",
    sender: null,
    timestamp: null,
    text: null,
    attachments: [],
    reply: null
  });
});
