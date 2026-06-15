import assert from "node:assert/strict";
import test from "node:test";
import { formatDiscordMessageForCodex } from "../src/discord-message-format.mjs";

test("Discord content is rendered as a compact external message event", () => {
  const prompt = formatDiscordMessageForCodex({
    target: { id: "rick", displayName: "Rick" },
    message: {
      id: "message-1",
      guildId: "guild-1",
      guild: { name: "Example Guild" },
      channelId: "channel-1",
      channel: { name: "boardroom" },
      author: { id: "user-1", username: "Joe" },
      member: { displayName: "Joe" },
      createdAt: new Date("2026-05-22T12:00:00Z"),
      content: "hello ``` prompt boundary",
      attachments: new Map()
    }
  });

  assert.match(prompt, /^Source: Discord #boardroom/m);
  assert.match(prompt, /^From: Joe <user-1>/m);
  assert.match(prompt, /^Channel ID: channel-1/m);
  assert.match(prompt, /^Message ID: message-1/m);
  assert.match(prompt, /Message:\nhello ``` prompt boundary/);
  assert.match(prompt, /^- Load recent context batch: discord_read_recent_batch channelId=channel-1/m);
  assert.doesNotMatch(prompt, /Source metadata:/);
  assert.doesNotMatch(prompt, /Routing instruction:/);
  assert.doesNotMatch(prompt, /```text/);
});

test("Discord prompts trigger the Wakefield connector skill", () => {
  const prompt = formatDiscordMessageForCodex({
    target: { id: "rick", displayName: "Rick" },
    message: {
      id: "message-1",
      guildId: "guild-1",
      guild: { name: "Example Guild" },
      channelId: "channel-1",
      channel: { name: "boardroom" },
      author: { id: "user-1", username: "Joe" },
      createdAt: new Date("2026-05-22T12:00:00Z"),
      content: "check this",
      attachments: new Map()
    }
  });

  assert.match(prompt, /Use \$wakefield-discord for Discord connector routing\./);
  assert.doesNotMatch(prompt, /external-source-replies/);
  assert.doesNotMatch(prompt, /Codex-only replies are not visible to Discord/);
  assert.doesNotMatch(prompt, /Keep reasoning\/tool traces out of Discord/);
});

test("DM prompts point Rick at the Discord DM tool", () => {
  const prompt = formatDiscordMessageForCodex({
    target: { id: "rick", displayName: "Rick" },
    message: {
      id: "message-1",
      guildId: null,
      guild: null,
      channelId: "dm-channel-1",
      channel: {},
      author: { id: "user-1", username: "Joe" },
      createdAt: new Date("2026-05-22T12:00:00Z"),
      content: "hello",
      attachments: new Map()
    }
  });

  assert.match(prompt, /- Text reply target: discord_send_dm userId=user-1/);
  assert.match(prompt, /- Load recent context batch: discord_read_recent_batch userId=user-1/);
  assert.match(prompt, /Use \$wakefield-discord for Discord connector routing\./);
  assert.doesNotMatch(prompt, /use `discord_send_message`/);
});

test("guild prompts keep acknowledgements in the source channel", () => {
  const prompt = formatDiscordMessageForCodex({
    target: { id: "rick", displayName: "Rick" },
    message: {
      id: "message-1",
      guildId: "guild-1",
      guild: { name: "Example Guild" },
      channelId: "channel-1",
      channel: { name: "boardroom" },
      author: { id: "user-1", username: "Joe" },
      createdAt: new Date("2026-05-22T12:00:00Z"),
      content: "check this",
      attachments: new Map()
    }
  });

  assert.match(prompt, /- Text reply target: discord_send_message channelId=channel-1 replyToMessageId=message-1/);
  assert.match(prompt, /Use \$wakefield-discord for Discord connector routing\./);
  assert.doesNotMatch(prompt, /For long or tool-heavy work/);
});
