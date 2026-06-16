import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

export async function findThreadRolloutPath(threadId, {
  codexHome = process.env.CODEX_HOME || path.join(os.homedir(), ".codex")
} = {}) {
  const sessionsDir = path.join(codexHome, "sessions");
  const matches = [];
  await walkRecentSessionFiles(sessionsDir, matches, threadId);
  matches.sort((left, right) => right.mtimeMs - left.mtimeMs);
  return matches[0]?.path || null;
}

export async function waitForTurnCompletion({
  rolloutPath,
  turnId,
  timeoutMs = 300000,
  pollMs = 1500,
  stopOnToolCallEnd = []
}) {
  if (!rolloutPath || !turnId) {
    return { completed: false, reason: "missing-rollout-or-turn" };
  }

  const startedAt = Date.now();
  const toolCallMatchers = normalizeToolCallMatchers(stopOnToolCallEnd);
  while (Date.now() - startedAt < timeoutMs) {
    const status = await readTurnStatus({ rolloutPath, turnId, stopOnToolCallEnd: toolCallMatchers });
    if (status.completed || status.aborted) {
      return status;
    }
    if (status.outboundToolCallEnded) {
      return status;
    }
    await sleep(pollMs);
  }
  return { completed: false, reason: "timeout" };
}

export async function readTurnStatus({ rolloutPath, turnId, stopOnToolCallEnd = [] }) {
  let text;
  try {
    text = await fs.readFile(rolloutPath, "utf8");
  } catch (error) {
    return { completed: false, reason: error?.code || "read-failed" };
  }

  let lastAgentMessage = null;
  let contextCompacted = false;
  let inTargetTurn = false;
  const toolCallMatchers = normalizeToolCallMatchers(stopOnToolCallEnd);
  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const payload = entry.payload || {};
    if (payload.type === "agent_message" && typeof payload.message === "string") {
      lastAgentMessage = payload.message;
    }
    if (entry.type === "event_msg" && payload.type === "task_started" && payload.turn_id === turnId) {
      inTargetTurn = true;
      contextCompacted = false;
    }
    if (inTargetTurn && entry.type === "event_msg" && payload.type === "mcp_tool_call_end") {
      const match = matchingToolCall(payload.invocation, toolCallMatchers);
      if (match) {
        return {
          completed: false,
          reason: "outbound_tool_call_end",
          turnId,
          outboundToolCallEnded: true,
          toolCall: match,
          contextCompacted
        };
      }
    }
    if (inTargetTurn && (entry.type === "compacted" || payload.type === "context_compacted")) {
      contextCompacted = true;
    }
    if (entry.type === "event_msg" && payload.type === "task_complete" && payload.turn_id === turnId) {
      return {
        completed: true,
        reason: "task_complete",
        turnId,
        lastAgentMessage: payload.last_agent_message || lastAgentMessage,
        durationMs: payload.duration_ms ?? null,
        contextCompacted
      };
    }
    if (entry.type === "event_msg" && payload.type === "turn_aborted" && payload.turn_id === turnId) {
      return {
        completed: false,
        reason: "turn_aborted",
        turnId,
        aborted: true,
        abortReason: payload.reason || null,
        durationMs: payload.duration_ms ?? null,
        contextCompacted
      };
    }
  }

  return { completed: false, reason: "not-complete", turnId, contextCompacted };
}

export async function readLatestThreadStatus({ rolloutPath }) {
  let text;
  try {
    text = await fs.readFile(rolloutPath, "utf8");
  } catch (error) {
    return { active: false, reason: error?.code || "read-failed", rolloutPath };
  }

  let status = {
    active: false,
    reason: "no-turn",
    rolloutPath,
    turnId: null,
    contextCompacted: false,
    lastContextCompactedAt: null,
    startedAt: null,
    turnContextSeen: false,
    lastEventAt: null
  };

  for (const line of text.split("\n")) {
    if (!line.trim()) {
      continue;
    }
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }

    const payload = entry.payload || {};
    if (entry.type === "event_msg" && payload.type === "task_started" && payload.turn_id) {
      status = {
        active: true,
        reason: "task_started",
        rolloutPath,
        turnId: payload.turn_id,
        contextCompacted: false,
        lastContextCompactedAt: status.lastContextCompactedAt,
        startedAt: payload.started_at ? new Date(payload.started_at * 1000).toISOString() : entry.timestamp || null,
        turnContextSeen: false,
        lastEventAt: entry.timestamp || null
      };
      continue;
    }

    if (status.active && entry.type === "turn_context" && payload.turn_id === status.turnId) {
      status = {
        ...status,
        turnContextSeen: true,
        lastEventAt: entry.timestamp || status.lastEventAt
      };
      continue;
    }

    if (status.active && (entry.type === "compacted" || payload.type === "context_compacted")) {
      status = {
        ...status,
        reason: "context_compacted",
        contextCompacted: true,
        lastContextCompactedAt: entry.timestamp || status.lastContextCompactedAt,
        lastEventAt: entry.timestamp || status.lastEventAt
      };
      continue;
    }

    if (
      status.active &&
      entry.type === "event_msg" &&
      (payload.type === "task_complete" || payload.type === "turn_aborted") &&
      payload.turn_id === status.turnId
    ) {
      status = {
        active: false,
        reason: payload.type,
        rolloutPath,
        turnId: status.turnId,
        contextCompacted: false,
        lastContextCompactedAt: status.lastContextCompactedAt,
        startedAt: status.startedAt,
        turnContextSeen: status.turnContextSeen,
        lastEventAt: entry.timestamp || status.lastEventAt
      };
      continue;
    }

    if (status.active && entry.type === "event_msg" && payload.type === "thread_rolled_back") {
      status = {
        active: false,
        reason: "thread_rolled_back",
        rolloutPath,
        turnId: status.turnId,
        contextCompacted: false,
        lastContextCompactedAt: status.lastContextCompactedAt,
        startedAt: status.startedAt,
        turnContextSeen: status.turnContextSeen,
        lastEventAt: entry.timestamp || status.lastEventAt
      };
    }
  }

  return status;
}

async function walkRecentSessionFiles(directory, matches, threadId, depth = 0) {
  if (depth > 5) {
    return;
  }
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) {
      await walkRecentSessionFiles(entryPath, matches, threadId, depth + 1);
    } else if (entry.isFile() && entry.name.endsWith(".jsonl") && entry.name.includes(threadId)) {
      const stat = await fs.stat(entryPath).catch(() => null);
      matches.push({ path: entryPath, mtimeMs: stat?.mtimeMs ?? 0 });
    }
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function normalizeToolCallMatchers(matchers) {
  return (matchers || [])
    .map((matcher) => ({
      server: matcher.server || null,
      tools: new Set(matcher.tools || (matcher.tool ? [matcher.tool] : []))
    }))
    .filter((matcher) => matcher.server || matcher.tools.size > 0);
}

function matchingToolCall(invocation, matchers) {
  if (!invocation || matchers.length === 0) {
    return null;
  }
  const server = invocation.server || null;
  const tool = invocation.tool || null;
  for (const matcher of matchers) {
    if (matcher.server && matcher.server !== server) {
      continue;
    }
    if (matcher.tools.size > 0 && !matcher.tools.has(tool)) {
      continue;
    }
    return { server, tool };
  }
  return null;
}
