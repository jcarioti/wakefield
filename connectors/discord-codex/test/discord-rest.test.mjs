import assert from "node:assert/strict";
import test from "node:test";
import { sendDiscordChannelMessage } from "../src/discord-rest.mjs";

test("sendDiscordChannelMessage emits a typing pulse before sending", async () => {
  const calls = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    calls.push({ url: String(url), method: options.method, body: options.body || null });
    if (String(url).endsWith("/typing")) {
      return jsonResponse(null, { status: 204 });
    }
    return jsonResponse({ id: "message-1" });
  };

  try {
    const message = await sendDiscordChannelMessage({
      botCredential: "token",
      channelId: "channel-1",
      content: "hello"
    });

    assert.equal(message.id, "message-1");
    assert.equal(calls.length, 2);
    assert.equal(calls[0].method, "POST");
    assert.match(calls[0].url, /\/channels\/channel-1\/typing$/);
    assert.equal(calls[1].method, "POST");
    assert.match(calls[1].url, /\/channels\/channel-1\/messages$/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("sendDiscordChannelMessage keeps sending when typing pulse fails", async () => {
  const warnings = [];
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, options) => {
    if (String(url).endsWith("/typing")) {
      return jsonResponse({ message: "rate limited" }, { status: 429 });
    }
    return jsonResponse({ id: "message-1" });
  };

  try {
    const message = await sendDiscordChannelMessage({
      botCredential: "token",
      channelId: "channel-1",
      content: "hello",
      logger: { warn(message) { warnings.push(message); } }
    });

    assert.equal(message.id, "message-1");
    assert.equal(warnings.length, 1);
    assert.match(warnings[0], /typing pulse failed/);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

function jsonResponse(payload, { status = 200 } = {}) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async text() {
      return payload == null ? "" : JSON.stringify(payload);
    }
  };
}
