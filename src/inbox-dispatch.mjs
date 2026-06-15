import { routePromptToCodex } from "./codex-ipc.mjs";
import { acknowledgeExternalMessage, listExternalMessages, routeForExternalMessage } from "./external-messages.mjs";

export async function dispatchExternalMessage(agent, {
  id = null,
  mode = "dry-run",
  client = null,
  socketPath = null,
  now = new Date()
} = {}) {
  if (!agent) throw new Error("dispatchExternalMessage needs an agent profile.");
  const message = await selectMessage(agent, id);
  const route = routeForExternalMessage(agent, message);
  if (route.status !== "ready") {
    return {
      ok: false,
      status: route.status,
      message,
      route,
      dispatch: null
    };
  }

  const normalizedMode = String(mode || "dry-run");
  if (normalizedMode === "dry-run" || normalizedMode === "manual") {
    return {
      ok: true,
      status: normalizedMode,
      message,
      route,
      dispatch: null
    };
  }

  try {
    const dispatch = await routePromptToCodex({
      threadId: route.threadId,
      cwd: route.cwd,
      prompt: route.prompt,
      mode: normalizedMode === "ipc" ? "auto" : normalizedMode,
      client,
      socketPath
    });
    const delivered = await acknowledgeExternalMessage(agent, message.id, {
      status: "delivered",
      reason: `Codex ${dispatch.action || normalizedMode}`,
      now
    });
    return {
      ok: true,
      status: "delivered",
      message: delivered,
      route,
      dispatch
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      message,
      route,
      dispatch: null,
      error: serializeError(error)
    };
  }
}

export function formatDispatchResult(result) {
  const lines = [
    `Wakefield inbox dispatch: ${result.status}`,
    `message: ${result.message.id}`,
    `connector: ${result.message.connector}`
  ];
  if (result.route.threadId) lines.push(`thread: ${result.route.threadId}`);
  if (result.dispatch?.action) lines.push(`action: ${result.dispatch.action}`);
  if (result.dispatch?.turnId) lines.push(`turn: ${result.dispatch.turnId}`);
  if (result.error) lines.push(`error: ${result.error.message}`);
  if (result.status === "manual" || result.status === "dry-run") {
    lines.push("", result.route.prompt);
  }
  return lines.join("\n");
}

async function selectMessage(agent, id) {
  const messages = await listExternalMessages(agent, { status: "pending", limit: 10000 });
  if (id) {
    const message = messages.find((entry) => entry.id === id);
    if (!message) throw new Error(`Pending external message not found: ${id}`);
    return message;
  }
  if (!messages[0]) throw new Error("No pending external messages.");
  return messages[0];
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null,
    method: error?.method || null
  };
}
