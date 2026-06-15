import assert from "node:assert/strict";
import test from "node:test";
import {
  activeDiscordTypingCount,
  resetDiscordTypingForTests,
  startDiscordTyping
} from "../src/discord-typing.mjs";

test.afterEach(() => {
  resetDiscordTypingForTests();
});

test("startDiscordTyping sends immediately and stops idempotently", async () => {
  let sends = 0;
  const stop = startDiscordTyping({
    id: "channel-1",
    async sendTyping() {
      sends += 1;
    }
  });

  await tick();
  assert.equal(sends, 1);
  assert.equal(activeDiscordTypingCount(), 1);
  stop();
  stop();
  assert.equal(activeDiscordTypingCount(), 0);
});

test("startDiscordTyping keeps one loop per channel with reference counted stops", async () => {
  let sends = 0;
  const channel = {
    id: "channel-1",
    async sendTyping() {
      sends += 1;
    }
  };
  const stopOne = startDiscordTyping(channel, { intervalMs: 10 });
  const stopTwo = startDiscordTyping(channel, { intervalMs: 10 });

  await tick();
  assert.equal(sends, 1);
  assert.equal(activeDiscordTypingCount(), 1);

  stopOne();
  assert.equal(activeDiscordTypingCount(), 1);
  stopTwo();
  assert.equal(activeDiscordTypingCount(), 0);
});

test("startDiscordTyping removes failed loops so future starts can recreate them", async () => {
  const channel = {
    id: "channel-1",
    async sendTyping() {
      throw new Error("network");
    }
  };
  startDiscordTyping(channel, { logger: { warn() {} } });
  await tick();
  assert.equal(activeDiscordTypingCount(), 0);

  let sends = 0;
  startDiscordTyping({
    id: "channel-1",
    async sendTyping() {
      sends += 1;
    }
  });
  await tick();
  assert.equal(sends, 1);
  assert.equal(activeDiscordTypingCount(), 1);
});

function tick() {
  return new Promise((resolve) => setTimeout(resolve, 0));
}
