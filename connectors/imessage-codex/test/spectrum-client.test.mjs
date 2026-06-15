import assert from "node:assert/strict";
import test from "node:test";
import {
  addressFromSpectrumSpaceId,
  normalizeSpectrumReaction,
  readSpectrumMessage,
  reactToSpectrumMessage,
  sendSpectrumMessage,
  startSpectrumTyping,
  stopSpectrumTyping,
  spectrumReactionTargetMessageId
} from "../src/spectrum-client.mjs";

test("normalizeSpectrumReaction maps tapback names to iMessage emoji values", () => {
  assert.equal(normalizeSpectrumReaction("like"), "\u{1F44D}");
  assert.equal(normalizeSpectrumReaction("love"), "\u2764\uFE0F");
  assert.equal(normalizeSpectrumReaction("thumbs down"), "\u{1F44E}");
  assert.equal(normalizeSpectrumReaction("question"), "\u2753");
  assert.equal(normalizeSpectrumReaction("\u{1F44C}"), "\u{1F44C}");
});

test("addressFromSpectrumSpaceId only derives direct-message addresses", () => {
  assert.equal(addressFromSpectrumSpaceId("any;-;+15551234567"), "+15551234567");
  assert.equal(addressFromSpectrumSpaceId("any;+;company-group"), null);
});

test("spectrumReactionTargetMessageId strips Spectrum reaction event suffixes", () => {
  assert.equal(
    spectrumReactionTargetMessageId("spc-msg-1:reaction:20462:0"),
    "spc-msg-1"
  );
  assert.equal(spectrumReactionTargetMessageId("spc-msg-1"), "spc-msg-1");
});

test("reactToSpectrumMessage reacts to a known Spectrum message", async () => {
  let reactedWith = null;
  const original = {
    id: "spc-msg-1",
    content: { type: "text", text: "hello" },
    react: async (reaction) => {
      reactedWith = reaction;
    }
  };
  const space = {
    id: "any;+;company-group",
    getMessage: async (messageId) => messageId === original.id ? original : null
  };

  const result = await reactToSpectrumMessage({
    app: {},
    target: { spaceId: space.id },
    messageId: original.id,
    reaction: "like",
    knownSpaces: new Map([[space.id, space]])
  });

  assert.equal(reactedWith, "\u{1F44D}");
  assert.deepEqual(result, {
    status: "reacted",
    spaceId: space.id,
    messageId: original.id,
    reaction: "\u{1F44D}"
  });
});

test("reactToSpectrumMessage fails loudly when a message is missing", async () => {
  const space = {
    id: "any;-;+15551234567",
    getMessage: async () => null
  };

  await assert.rejects(
    () => reactToSpectrumMessage({
      app: {},
      target: { spaceId: space.id },
      messageId: "missing",
      reaction: "like",
      knownSpaces: new Map([[space.id, space]])
    }),
    /message missing was not found/
  );
});

test("reactToSpectrumMessage falls back to Photon when Spectrum cannot hydrate the target", async () => {
  const calls = [];
  const space = {
    id: "any;-;+15551234567",
    getMessage: async () => {
      throw new Error("chat_guid must not be empty");
    }
  };

  const result = await reactToSpectrumMessage({
    app: {},
    target: { spaceId: space.id },
    messageId: "spc-msg-1",
    reaction: "like",
    knownSpaces: new Map([[space.id, space]]),
    photonFallback: {
      react: async (request) => {
        calls.push(request);
        return {
          status: "reacted",
          method: "photon.messages.setReaction",
          messageId: request.messageId
        };
      }
    }
  });

  assert.equal(result.method, "photon.messages.setReaction");
  assert.equal(calls[0].messageId, "spc-msg-1");
  assert.equal(calls[0].reaction, "like");
  assert.match(calls[0].reason.message, /chat_guid/);
});

test("sendSpectrumMessage falls back to Photon for reply sends when Spectrum lookup fails", async () => {
  const calls = [];
  const sentDirect = [];
  const space = {
    id: "any;-;+15551234567",
    getMessage: async () => {
      throw new Error("chat_guid must not be empty");
    },
    send: async (...content) => {
      sentDirect.push(content);
      return { id: "direct-send" };
    }
  };

  const result = await sendSpectrumMessage({
    app: {},
    target: {
      spaceId: space.id,
      replyToMessageId: "spc-msg-1"
    },
    text: "reply body",
    knownSpaces: new Map([[space.id, space]]),
    typing: { enabled: false },
    photonFallback: {
      sendTextReply: async (request) => {
        calls.push(request);
        return {
          id: "photon-reply",
          source: "photon"
        };
      }
    }
  });

  assert.equal(result.id, "photon-reply");
  assert.deepEqual(sentDirect, []);
  assert.equal(calls[0].replyToMessageId, "spc-msg-1");
  assert.equal(calls[0].text, "reply body");
  assert.match(calls[0].reason.message, /chat_guid/);
});

test("sendSpectrumMessage skips Photon fallback during upstream pressure", async () => {
  const calls = [];
  const sentDirect = [];
  const space = {
    id: "any;-;+15551234567",
    getMessage: async () => {
      throw new Error("[upstream] Service temporarily unavailable. Please retry.");
    },
    send: async (...content) => {
      sentDirect.push(content);
      return { id: "direct-send" };
    }
  };

  await assert.rejects(
    () => sendSpectrumMessage({
      app: {},
      target: {
        spaceId: space.id,
        replyToMessageId: "spc-msg-1"
      },
      text: "reply body",
      knownSpaces: new Map([[space.id, space]]),
      typing: { enabled: false },
      photonFallback: {
        sendTextReply: async (request) => {
          calls.push(request);
          return { id: "photon-reply" };
        }
      }
    }),
    /Service temporarily unavailable/
  );

  assert.deepEqual(calls, []);
  assert.deepEqual(sentDirect, []);
});

test("sendSpectrumMessage does not let typing wrapper failures block direct sends", async () => {
  const sentDirect = [];
  const space = {
    id: "any;-;+15551234567",
    send: async (...content) => {
      sentDirect.push(content);
      return { id: "direct-send" };
    },
    responding: async () => {
      throw new Error("[upstream] Service temporarily unavailable. Please retry.");
    }
  };

  const result = await sendSpectrumMessage({
    app: {},
    target: { spaceId: space.id },
    text: "plain reply",
    knownSpaces: new Map([[space.id, space]]),
    typing: { enabled: true }
  });

  assert.equal(result.id, "direct-send");
  assert.deepEqual(sentDirect, [["plain reply"]]);
});

test("readSpectrumMessage marks the containing chat read through the live space", async () => {
  const calls = [];
  const message = {
    id: "spc-msg-1",
    direction: "inbound",
    content: { type: "text", text: "hello" }
  };
  const space = {
    id: "any;-;+15551234567",
    read: async (target) => calls.push(["read", target.id])
  };

  assert.deepEqual(
    await readSpectrumMessage({ space, message }),
    {
      status: "read",
      method: "space.read",
      spaceId: space.id,
      messageId: message.id
    }
  );
  assert.deepEqual(calls, [["read", message.id]]);
});

test("readSpectrumMessage falls back to the canonical read control send", async () => {
  const sent = [];
  const message = {
    id: "spc-msg-1",
    direction: "inbound",
    content: { type: "text", text: "hello" }
  };
  const space = {
    id: "any;-;+15551234567",
    send: async (content) => sent.push(content)
  };

  assert.deepEqual(
    await readSpectrumMessage({ space, message }),
    {
      status: "read",
      method: "space.send(read)",
      spaceId: space.id,
      messageId: message.id
    }
  );
  assert.equal(typeof sent[0]?.build, "function");
});

test("startSpectrumTyping and stopSpectrumTyping use known spaces", async () => {
  const calls = [];
  const space = {
    id: "any;+;company-group",
    startTyping: async () => calls.push("start"),
    stopTyping: async () => calls.push("stop")
  };
  const knownSpaces = new Map([[space.id, space]]);

  assert.deepEqual(
    await startSpectrumTyping({
      app: {},
      target: { spaceId: space.id },
      knownSpaces
    }),
    { status: "started", spaceId: space.id }
  );
  assert.deepEqual(
    await stopSpectrumTyping({
      app: {},
      target: { spaceId: space.id },
      knownSpaces
    }),
    { status: "stopped", spaceId: space.id }
  );
  assert.deepEqual(calls, ["start", "stop"]);
});
