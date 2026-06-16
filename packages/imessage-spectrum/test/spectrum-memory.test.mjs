import assert from "node:assert/strict";
import test from "node:test";
import {
  spectrumMemoryQuery,
  spectrumMemoryScope,
  wakefieldMemoryForSpectrumMessage
} from "../src/spectrum-memory.mjs";

test("spectrumMemoryScope scopes direct messages without a room", () => {
  assert.deepEqual(spectrumMemoryScope({
    space: { id: "any;-;+15551234567", type: "dm" },
    message: { sender: { id: "+15551234567" } }
  }), {
    connector: "imessage",
    sender: "+15551234567",
    conversation: "any;-;+15551234567",
    channel: "any;-;+15551234567",
    room: null
  });
});

test("spectrumMemoryScope scopes group spaces as rooms", () => {
  assert.equal(spectrumMemoryScope({
    space: { id: "any;+;group-chat", type: "group" },
    message: { sender: { id: "+15551234567" } }
  }).room, "any;+;group-chat");
});

test("spectrumMemoryQuery includes text, reply, reaction, and attachment names", () => {
  assert.equal(spectrumMemoryQuery({
    text: "main text",
    reply: { text: "reply text" },
    reaction: { text: "reacted text" },
    attachments: [{ name: "photo.jpg" }]
  }), "main text\nreacted text\nreply text\nphoto.jpg");
});

test("wakefieldMemoryForSpectrumMessage falls back quietly when memory lookup fails", async () => {
  const warnings = [];
  const memory = await wakefieldMemoryForSpectrumMessage({
    space: { id: "any;-;+15551234567", type: "dm" },
    message: { id: "spc-msg-1", sender: { id: "+15551234567" } },
    content: { text: "hello" },
    target: { id: "missing-agent" },
    logger: { warn: (message) => warnings.push(message) }
  });

  assert.equal(memory, "");
  assert.deepEqual(warnings, []);
});
