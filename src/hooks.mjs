import { findAgentForHookInput } from "./profile.mjs";
import { compact, recordMemory } from "./memory.mjs";

export async function handleHookInput(input) {
  const eventName = input?.hook_event_name;
  const agent = await findAgentForHookInput(input);
  if (!agent) return jsonNoopEvent(eventName) ? {} : null;

  if (eventName === "UserPromptSubmit") {
    await recordMemory(agent, {
      channel: "inbox",
      kind: "user-prompt",
      text: input.prompt || "",
      source: "codex-hook",
      data: hookData(input)
    });
    return null;
  }

  if (eventName === "SessionStart") {
    await recordMemory(agent, {
      channel: "journal",
      kind: "session-start",
      text: input.source || "session start",
      source: "codex-hook",
      data: hookData(input)
    });
    return null;
  }

  if (eventName === "Stop") {
    const text = input.last_assistant_message || "";
    await recordMemory(agent, {
      channel: "journal",
      kind: "turn-stop",
      text: compact(text, 1200),
      source: "codex-hook",
      data: hookData(input)
    });
    await recordMemory(agent, {
      channel: "dreams",
      kind: "dream-queued",
      text: `Turn ${input.turn_id || "unknown"} stopped; summarize durable memory when the dreamer runs.`,
      source: "codex-hook",
      data: {
        sessionId: input.session_id || null,
        turnId: input.turn_id || null,
        reason: "stop"
      }
    });
    return {};
  }

  if (eventName === "PostToolUse") {
    await recordMemory(agent, {
      channel: "journal",
      kind: "tool-use",
      text: summarizeToolUse(input),
      source: "codex-hook",
      data: hookData(input)
    });
    return null;
  }

  if (eventName === "PreCompact" || eventName === "PostCompact") {
    await recordMemory(agent, {
      channel: "dreams",
      kind: eventName === "PreCompact" ? "pre-compact" : "post-compact",
      text: `${eventName} triggered by ${input.trigger || "unknown"}.`,
      source: "codex-hook",
      data: hookData(input)
    });
    return {};
  }

  return null;
}

export async function runHookFromStdin({ stdin = process.stdin, stdout = process.stdout } = {}) {
  const input = await readStdinJson(stdin);
  const output = await handleHookInput(input);
  if (output != null) {
    stdout.write(`${JSON.stringify(output)}\n`);
  }
}

export function hookConfig({ command, statusMessage = null }) {
  const hook = {
    type: "command",
    command,
    timeout: 10
  };
  if (statusMessage) hook.statusMessage = statusMessage;
  return {
    hooks: {
      SessionStart: [{ matcher: "startup|resume|compact", hooks: [hook] }],
      UserPromptSubmit: [{ hooks: [hook] }],
      PostToolUse: [{ matcher: "*", hooks: [hook] }],
      PreCompact: [{ matcher: "*", hooks: [hook] }],
      PostCompact: [{ matcher: "*", hooks: [hook] }],
      Stop: [{ hooks: [hook] }]
    }
  };
}

function jsonNoopEvent(eventName) {
  return eventName === "Stop"
    || eventName === "SubagentStop"
    || eventName === "PreCompact"
    || eventName === "PostCompact";
}

function hookData(input) {
  return {
    sessionId: input.session_id || null,
    turnId: input.turn_id || null,
    cwd: input.cwd || null,
    transcriptPath: input.transcript_path || null,
    hookEventName: input.hook_event_name || null,
    permissionMode: input.permission_mode || null,
    model: input.model || null,
    toolName: input.tool_name || null,
    toolUseId: input.tool_use_id || null,
    trigger: input.trigger || null
  };
}

function summarizeToolUse(input) {
  const tool = input.tool_name || "tool";
  const command = input.tool_input?.command || null;
  if (command) return `${tool}: ${compact(command, 400)}`;
  return `${tool}: ${compact(JSON.stringify(input.tool_input || {}), 400)}`;
}

async function readStdinJson(stdin) {
  const chunks = [];
  for await (const chunk of stdin) chunks.push(chunk);
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (!text) return {};
  return JSON.parse(text);
}
