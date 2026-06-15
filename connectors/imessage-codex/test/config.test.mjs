import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  getAllowedOutboundAddresses,
  getAllowedOutboundChatIds,
  getAllowedOutboundSpaceIds,
  loadConnectorConfig,
  normalizeAddress
} from "../src/config.mjs";

test("loadConnectorConfig normalizes iMessage paths and allowlists", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imessage-config-test-"));
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    imessage: {
      imsgPath: "/opt/homebrew/bin/imsg",
      databasePath: "~/Library/Messages/chat.db",
      statePath: "state.json",
      allowedOutboundAddresses: ["+15551234567"],
      allowedOutboundSpaceIds: ["any;-;+15559876543"],
      spectrum: {
        projectId: "project-from-file",
        cloudUrl: "https://spectrum.example.test",
        projectSecretEnv: "TEST_PHOTON_SECRET",
        ipcSocketPath: "spectrum.sock",
        attachmentDir: "attachments"
      }
    },
    targets: [{
      id: "agent",
      threadId: "thread-1",
      cwd: "~/WakefieldAgents/agent",
      allowedAddresses: ["Joe@Example.COM"],
      allowedChatIds: [42],
      allowedSpaceIds: ["iMessage;-;group-chat"]
    }]
  }), "utf8");

  const config = await loadConnectorConfig({
    configPath,
    env: { TEST_PHOTON_SECRET: "secret-from-env" }
  });

  assert.equal(config.imessage.provider, "spectrum");
  assert.equal(config.imessage.imsgPath, "/opt/homebrew/bin/imsg");
  assert.equal(config.imessage.databasePath, path.join(os.homedir(), "Library/Messages/chat.db"));
  assert.equal(config.imessage.statePath, path.join(root, "state.json"));
  assert.equal(config.imessage.advancedBridgeRequired, true);
  assert.equal(config.imessage.sendReadReceipts, true);
  assert.equal(config.imessage.typing.showWhileThinking, true);
  assert.equal(config.codex.deepLinkWake.waitMs, 30000);
  assert.equal(config.codex.deepLinkWake.pollMs, 1000);
  assert.equal(config.codex.deepLinkWake.reopenMs, 6000);
  assert.equal(config.codex.lockTimeoutMs, 45000);
  assert.equal(config.codex.lockStaleMs, 90000);
  assert.equal(config.imessage.spectrum.projectId, "project-from-file");
  assert.equal(config.imessage.spectrum.projectSecret, "secret-from-env");
  assert.equal(config.imessage.spectrum.cloudUrl, "https://spectrum.example.test");
  assert.equal(config.imessage.spectrum.ipcSocketPath, path.join(root, "spectrum.sock"));
  assert.equal(config.imessage.spectrum.attachmentDir, path.join(root, "attachments"));
  assert.equal(config.imessage.spectrum.deliveryQueuePath, path.join(os.homedir(), ".codex/connectors/imessage-codex/spectrum-delivery-queue.json"));
  assert.equal(config.imessage.spectrum.startupReplayEnabled, true);
  assert.equal(config.imessage.spectrum.startupReplayLookbackMs, 60 * 60 * 1000);
  assert.equal(config.imessage.spectrum.startupReplayDelayMs, 30000);
  assert.equal(config.imessage.spectrum.startupReplayPageSize, 30);
  assert.equal(config.imessage.spectrum.deliveryRetryMs, 60000);
  assert.equal(config.imessage.spectrum.outboundRequestMinIntervalMs, 2000);
  assert.equal(config.imessage.spectrum.receiveLoopMaxAgeMs, 110 * 60 * 1000);
  assert.equal(config.imessage.spectrum.appOperationTimeoutMs, 120000);
  assert.equal(config.identity.contactsPath, null);
  assert.deepEqual([...getAllowedOutboundAddresses(config)].sort(), ["+15551234567", "joe@example.com"]);
  assert.deepEqual([...getAllowedOutboundChatIds(config)], ["42"]);
  assert.deepEqual([...getAllowedOutboundSpaceIds(config)].sort(), ["any;-;+15559876543", "iMessage;-;group-chat"]);
});

test("loadConnectorConfig normalizes Spectrum receive-loop max age", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imessage-config-spectrum-age-test-"));
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    imessage: {
      spectrum: {
        receiveLoopMaxAgeMs: 123456,
        appOperationTimeoutMs: 654321
      }
    },
    targets: [{
      id: "agent",
      threadId: "thread-1",
      cwd: "~/WakefieldAgents/agent"
    }]
  }), "utf8");

  const config = await loadConnectorConfig({ configPath });

  assert.equal(config.imessage.spectrum.receiveLoopMaxAgeMs, 123456);
  assert.equal(config.imessage.spectrum.appOperationTimeoutMs, 654321);
});

test("loadConnectorConfig can opt out of typing while thinking", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "imessage-config-typing-test-"));
  const configPath = path.join(root, "config.json");
  await fs.writeFile(configPath, JSON.stringify({
    imessage: {
      typing: {
        showWhileThinking: false
      }
    },
    targets: [{
      id: "agent",
      threadId: "thread-1",
      cwd: "~/WakefieldAgents/agent"
    }]
  }), "utf8");

  const config = await loadConnectorConfig({ configPath });

  assert.equal(config.imessage.typing.showWhileThinking, false);
});

test("normalizeAddress is lower-case and whitespace tolerant", () => {
  assert.equal(normalizeAddress("  JOE@EXAMPLE.COM "), "joe@example.com");
});
