import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { ActivityType } from "discord.js";
import {
  createPresenceMonitorState,
  discordPresenceData,
  pollCodexPresence,
  presenceStatusForTargetStatuses
} from "../src/discord-presence.mjs";

test("presenceStatusForTargetStatuses maps compacted active turns to idle", () => {
  assert.equal(
    presenceStatusForTargetStatuses([{ active: true, contextCompacted: true }], {}, 1000),
    "idle"
  );
  assert.equal(
    presenceStatusForTargetStatuses([{ active: true, contextCompacted: false }], {}, 1000),
    "online"
  );
});

test("presenceStatusForTargetStatuses holds idle after a fast manual compact", () => {
  const compactedAt = "2026-05-23T03:26:48.116Z";
  assert.equal(
    presenceStatusForTargetStatuses(
      [{ active: false, contextCompacted: false, lastContextCompactedAt: compactedAt }],
      { compactionHoldMs: 60000 },
      Date.parse(compactedAt) + 1000
    ),
    "idle"
  );
  assert.equal(
    presenceStatusForTargetStatuses(
      [{ active: false, contextCompacted: false, lastContextCompactedAt: compactedAt }],
      { compactionHoldMs: 60000 },
      Date.parse(compactedAt) + 61000
    ),
    "online"
  );
});

test("presenceStatusForTargetStatuses returns online after the completed compact hold", () => {
  const compactedAt = "2026-05-23T03:26:48.116Z";
  assert.equal(
    presenceStatusForTargetStatuses(
      [{ active: false, contextCompacted: false, lastContextCompactedAt: compactedAt }],
      {},
      Date.parse(compactedAt) + 16000
    ),
    "online"
  );
});

test("presenceStatusForTargetStatuses ignores prior compact hold during normal active turns", () => {
  const compactedAt = "2026-05-23T03:26:48.116Z";
  assert.equal(
    presenceStatusForTargetStatuses(
      [{
        active: true,
        contextCompacted: false,
        turnContextSeen: true,
        startedAt: "2026-05-23T03:26:50.000Z",
        lastContextCompactedAt: compactedAt
      }],
      { compactionHoldMs: 60000 },
      Date.parse(compactedAt) + 3000
    ),
    "online"
  );
});

test("presenceStatusForTargetStatuses treats compact-only turns as idle after grace", () => {
  const startedAt = "2026-05-23T03:31:33.000Z";
  assert.equal(
    presenceStatusForTargetStatuses(
      [{ active: true, contextCompacted: false, startedAt, turnContextSeen: false }],
      { compactionStartGraceMs: 2000 },
      Date.parse(startedAt) + 1000
    ),
    "online"
  );
  assert.equal(
    presenceStatusForTargetStatuses(
      [{ active: true, contextCompacted: false, startedAt, turnContextSeen: false }],
      { compactionStartGraceMs: 2000 },
      Date.parse(startedAt) + 3000
    ),
    "idle"
  );
  assert.equal(
    presenceStatusForTargetStatuses(
      [{ active: true, contextCompacted: false, startedAt, turnContextSeen: true }],
      { compactionStartGraceMs: 2000 },
      Date.parse(startedAt) + 3000
    ),
    "online"
  );
});

test("discordPresenceData makes compacting visible and clears activity online", () => {
  assert.deepEqual(discordPresenceData({ status: "idle" }), {
    status: "idle",
    afk: true,
    activities: [{ name: "Codex compact", type: ActivityType.Watching }]
  });
  assert.deepEqual(discordPresenceData({ status: "online" }), {
    status: "online",
    afk: false,
    activities: []
  });
});

test("pollCodexPresence sets idle during compaction and keeps it through the hold window", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "discord-presence-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  const compactedAtMs = Date.parse("2026-05-23T03:26:48.116Z");
  await fs.writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-05-23T03:26:48.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: "2026-05-23T03:26:48.116Z", type: "event_msg", payload: { type: "context_compacted" } })
  ].join("\n"), "utf8");

  const presenceCalls = [];
  const client = {
    user: {
      async setPresence(value) {
        presenceCalls.push(value);
      }
    }
  };
  const monitorState = createPresenceMonitorState();
  const targets = [{ id: "rick", threadId: "thread-1", rolloutPath: rollout }];
  const presence = { compactionHoldMs: 60000, presenceRefreshMs: 15000 };

  let result = await pollCodexPresence({ client, targets, presence, monitorState, now: compactedAtMs + 1000 });
  assert.equal(result.discordStatus, "idle");
  assert.deepEqual(presenceCalls, [{
    status: "idle",
    afk: true,
    activities: [{ name: "Codex compact", type: ActivityType.Watching }]
  }]);

  await fs.appendFile(
    rollout,
    `\n${JSON.stringify({ timestamp: "2026-05-23T03:26:48.127Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })}`,
    "utf8"
  );

  result = await pollCodexPresence({ client, targets, presence, monitorState, now: compactedAtMs + 2000 });
  assert.equal(result.discordStatus, "idle");
  assert.deepEqual(presenceCalls, [{
    status: "idle",
    afk: true,
    activities: [{ name: "Codex compact", type: ActivityType.Watching }]
  }]);

  result = await pollCodexPresence({ client, targets, presence, monitorState, now: compactedAtMs + 17000 });
  assert.equal(result.discordStatus, "idle");
  assert.deepEqual(presenceCalls, [
    {
      status: "idle",
      afk: true,
      activities: [{ name: "Codex compact", type: ActivityType.Watching }]
    },
    {
      status: "idle",
      afk: true,
      activities: [{ name: "Codex compact", type: ActivityType.Watching }]
    }
  ]);

  result = await pollCodexPresence({ client, targets, presence, monitorState, now: compactedAtMs + 61000 });
  assert.equal(result.discordStatus, "online");
  assert.deepEqual(presenceCalls, [
    {
      status: "idle",
      afk: true,
      activities: [{ name: "Codex compact", type: ActivityType.Watching }]
    },
    {
      status: "idle",
      afk: true,
      activities: [{ name: "Codex compact", type: ActivityType.Watching }]
    },
    {
      status: "online",
      afk: false,
      activities: []
    }
  ]);
});
