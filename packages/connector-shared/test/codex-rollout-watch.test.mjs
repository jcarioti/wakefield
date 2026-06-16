import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  findThreadRolloutPath,
  readLatestThreadStatus,
  readTurnStatus,
  waitForTurnCompletion
} from "../src/codex-rollout-watch.mjs";

test("findThreadRolloutPath discovers the newest matching rollout", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-rollout-test-"));
  const dir = path.join(root, "sessions", "2026", "05", "22");
  await fs.mkdir(dir, { recursive: true });
  const rollout = path.join(dir, "rollout-2026-05-22-019e51a5-5ad3-7991-87d4-4745494f7ae9.jsonl");
  await fs.writeFile(rollout, "", "utf8");

  assert.equal(
    await findThreadRolloutPath("019e51a5-5ad3-7991-87d4-4745494f7ae9", { codexHome: root }),
    rollout
  );
});

test("readTurnStatus detects task_complete for a specific turn", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "agent_message", message: "working" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", last_agent_message: "done", duration_ms: 42 } })
  ].join("\n"), "utf8");

  const status = await readTurnStatus({ rolloutPath: rollout, turnId: "turn-1" });
  assert.equal(status.completed, true);
  assert.equal(status.lastAgentMessage, "done");
  assert.equal(status.durationMs, 42);
  assert.equal(status.contextCompacted, false);
});

test("readTurnStatus reports context compaction before completion", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-compacted-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ type: "compacted", payload: { message: "" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "context_compacted" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 42 } })
  ].join("\n"), "utf8");

  const status = await readTurnStatus({ rolloutPath: rollout, turnId: "turn-1" });
  assert.equal(status.completed, true);
  assert.equal(status.contextCompacted, true);
});

test("readLatestThreadStatus returns active compacted state until the turn completes", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-latest-compacted-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-05-23T03:26:48.000Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ timestamp: "2026-05-23T03:26:48.116Z", type: "event_msg", payload: { type: "context_compacted" } })
  ].join("\n"), "utf8");

  let status = await readLatestThreadStatus({ rolloutPath: rollout });
  assert.equal(status.active, true);
  assert.equal(status.contextCompacted, true);
  assert.ok(status.lastContextCompactedAt);
  assert.equal(status.turnContextSeen, false);
  assert.equal(status.reason, "context_compacted");

  await fs.appendFile(
    rollout,
    `\n${JSON.stringify({ timestamp: "2026-05-23T03:26:48.127Z", type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })}`,
    "utf8"
  );
  status = await readLatestThreadStatus({ rolloutPath: rollout });
  assert.equal(status.active, false);
  assert.equal(status.contextCompacted, false);
  assert.ok(status.lastContextCompactedAt);
  assert.equal(status.turnContextSeen, false);
  assert.equal(status.reason, "task_complete");
});

test("readLatestThreadStatus distinguishes normal turns from manual compact turns", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-latest-turn-kind-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [
    JSON.stringify({ timestamp: "2026-05-23T03:31:33.605Z", type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", started_at: 1779507093 } })
  ].join("\n"), "utf8");

  let status = await readLatestThreadStatus({ rolloutPath: rollout });
  assert.equal(status.active, true);
  assert.equal(status.turnContextSeen, false);
  assert.equal(status.startedAt, "2026-05-23T03:31:33.000Z");

  await fs.appendFile(
    rollout,
    `\n${JSON.stringify({ timestamp: "2026-05-23T03:31:33.900Z", type: "turn_context", payload: { turn_id: "turn-1" } })}`,
    "utf8"
  );
  status = await readLatestThreadStatus({ rolloutPath: rollout });
  assert.equal(status.active, true);
  assert.equal(status.turnContextSeen, true);
});

test("waitForTurnCompletion times out cleanly when completion is absent", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-timeout-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, "", "utf8");
  const status = await waitForTurnCompletion({
    rolloutPath: rollout,
    turnId: "turn-1",
    timeoutMs: 5,
    pollMs: 1
  });
  assert.equal(status.completed, false);
  assert.equal(status.reason, "timeout");
});

test("waitForTurnCompletion can stop on a matching outbound MCP tool call", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-tool-stop-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        invocation: {
          server: "imessage-codex",
          tool: "imessage_send_message"
        }
      }
    })
  ].join("\n"), "utf8");

  const status = await waitForTurnCompletion({
    rolloutPath: rollout,
    turnId: "turn-1",
    timeoutMs: 100,
    pollMs: 1,
    stopOnToolCallEnd: [{
      server: "imessage-codex",
      tools: ["imessage_send_message"]
    }]
  });

  assert.equal(status.completed, false);
  assert.equal(status.outboundToolCallEnded, true);
  assert.equal(status.reason, "outbound_tool_call_end");
  assert.deepEqual(status.toolCall, {
    server: "imessage-codex",
    tool: "imessage_send_message"
  });
});

test("waitForTurnCompletion ignores outbound tool calls before the target turn starts", async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "codex-turn-tool-before-test-"));
  const rollout = path.join(root, "rollout.jsonl");
  await fs.writeFile(rollout, [
    JSON.stringify({
      type: "event_msg",
      payload: {
        type: "mcp_tool_call_end",
        invocation: {
          server: "discord-codex",
          tool: "discord_send_message"
        }
      }
    }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } }),
    JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } })
  ].join("\n"), "utf8");

  const status = await waitForTurnCompletion({
    rolloutPath: rollout,
    turnId: "turn-1",
    timeoutMs: 100,
    pollMs: 1,
    stopOnToolCallEnd: [{
      server: "discord-codex",
      tools: ["discord_send_message"]
    }]
  });

  assert.equal(status.completed, true);
  assert.equal(status.reason, "task_complete");
  assert.equal(status.outboundToolCallEnded, undefined);
});
