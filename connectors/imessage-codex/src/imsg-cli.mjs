import { execFile, spawn } from "node:child_process";
import readline from "node:readline";

const DEFAULT_TIMEOUT_MS = 30000;

export function buildWatchArgs({ state = {}, imessage = {} } = {}) {
  const watch = imessage.watch || {};
  const args = ["watch", "--json"];
  if (watch.includeAttachments !== false) {
    args.push("--attachments");
  }
  if (watch.convertAttachments !== false) {
    args.push("--convert-attachments");
  }
  if (watch.includeReactions === true) {
    args.push("--reactions");
  }
  if (watch.debounce) {
    args.push("--debounce", String(watch.debounce));
  }
  if (state.lastRowId) {
    args.push("--since-rowid", String(state.lastRowId));
  }
  if (imessage.databasePath) {
    args.push("--db", imessage.databasePath);
  }
  return args;
}

export function startImsgWatch({
  imessage,
  state = {},
  onMessage,
  onExit = null,
  logger = console
}) {
  const args = buildWatchArgs({ state, imessage });
  const child = spawn(imessage.imsgPath, args, {
    stdio: ["ignore", "pipe", "pipe"]
  });

  const stdout = readline.createInterface({ input: child.stdout });
  stdout.on("line", (line) => {
    if (!line.trim()) return;
    try {
      onMessage(JSON.parse(line));
    } catch (error) {
      logger.warn?.(`imsg watch emitted unparseable JSON: ${error.message}`);
    }
  });

  const stderr = readline.createInterface({ input: child.stderr });
  stderr.on("line", (line) => {
    if (line.trim()) logger.warn?.(`imsg watch: ${line}`);
  });

  child.on("error", (error) => {
    logger.error?.(`Failed to start imsg watch: ${error.message}`);
  });
  child.on("exit", (code, signal) => {
    onExit?.({ code, signal });
  });

  return () => {
    stdout.close();
    stderr.close();
    if (!child.killed) {
      child.kill("SIGTERM");
    }
  };
}

export async function sendImsgMessage({
  imessage,
  target,
  text = "",
  files = [],
  timeoutMs = 120000
}) {
  const cleanedText = String(text || "");
  const attachmentPaths = (files || []).map((file) => String(file || "").trim()).filter(Boolean);
  if (!cleanedText.trim() && attachmentPaths.length === 0) {
    throw new Error("iMessage send requires text or at least one attachment.");
  }

  const sends = [];
  if (attachmentPaths.length === 0) {
    sends.push({ text: cleanedText, file: null });
  } else {
    attachmentPaths.forEach((file, index) => {
      sends.push({ text: index === 0 ? cleanedText : "", file });
    });
  }

  const results = [];
  for (const send of sends) {
    const args = ["send", ...imsgTargetArgs(target), "--json"];
    if (send.text.trim()) {
      args.push("--text", send.text);
    }
    if (send.file) {
      args.push("--file", send.file);
    }
    if (target.to) {
      args.push("--service", imessage.service || "auto");
      args.push("--region", imessage.region || "US");
    }
    if (imessage.databasePath) {
      args.push("--db", imessage.databasePath);
    }
    const lines = await runImsgJsonLines({ imessage, args, timeoutMs });
    results.push(...lines);
  }
  return results;
}

export function startImsgTyping({
  imessage,
  target,
  logger = console
}) {
  const typing = imessage.typing || {};
  if (!typing.enabled) {
    return () => {};
  }
  let stopped = false;
  let interval = null;

  const pulse = async () => {
    if (stopped) return;
    try {
      const args = ["typing", ...imsgTargetArgs(target), "--json"];
      if (target.to) {
        args.push("--service", imessage.service || "auto");
      }
      if (imessage.databasePath) {
        args.push("--db", imessage.databasePath);
      }
      await runImsgJsonLines({ imessage, args, timeoutMs: 10000 });
    } catch (error) {
      logger.warn?.(`iMessage typing indicator unavailable: ${error.message}`);
      stop();
    }
  };

  const stop = () => {
    if (stopped) return;
    stopped = true;
    if (interval != null) clearInterval(interval);
    stopImsgTyping({ imessage, target, logger }).catch((error) => {
      logger.warn?.(`iMessage typing stop failed: ${error.message}`);
    });
  };

  pulse();
  interval = setInterval(pulse, typing.intervalMs || 6000);
  setTimeout(stop, typing.maxMs || 1800000);
  return stop;
}

export async function stopImsgTyping({ imessage, target }) {
  const args = ["typing", ...imsgTargetArgs(target), "--stop", "true", "--json"];
  if (target.to) {
    args.push("--service", imessage.service || "auto");
  }
  if (imessage.databasePath) {
    args.push("--db", imessage.databasePath);
  }
  return runImsgJsonLines({ imessage, args, timeoutMs: 10000 });
}

export async function markImsgRead({ imessage, target }) {
  const args = ["read", ...imsgTargetArgs(target), "--json"];
  if (imessage.databasePath) {
    args.push("--db", imessage.databasePath);
  }
  return runImsgJsonLines({ imessage, args, timeoutMs: 10000 });
}

export async function readImsgHistory({
  imessage,
  chatId,
  limit = 20,
  includeAttachments = true
}) {
  const args = ["history", "--chat-id", String(chatId), "--limit", String(Math.max(1, Math.min(100, Number(limit) || 20))), "--json"];
  if (includeAttachments) {
    args.push("--attachments");
    if (imessage.watch?.convertAttachments !== false) {
      args.push("--convert-attachments");
    }
  }
  if (imessage.databasePath) {
    args.push("--db", imessage.databasePath);
  }
  return runImsgJsonLines({ imessage, args, timeoutMs: 30000 });
}

export async function imsgStatus({ imessage }) {
  return runImsgJsonLines({
    imessage,
    args: ["status", "--json"],
    timeoutMs: 10000
  });
}

export async function assertAdvancedBridgeReady({
  imessage,
  statusReader = imsgStatus
}) {
  if (imessage.advancedBridgeRequired === false) {
    return { ok: true, required: false, status: null };
  }
  let rows;
  try {
    rows = await statusReader({ imessage });
  } catch (error) {
    throw new Error(`iMessage advanced bridge is required, but imsg status failed: ${error.message}`);
  }

  const readiness = advancedBridgeReadyFromStatusRows(rows);
  if (!readiness.ok) {
    throw new Error(`iMessage advanced bridge is required, but ${readiness.reason}`);
  }
  return readiness;
}

export function advancedBridgeReadyFromStatusRows(rows = []) {
  const status = Array.isArray(rows) ? rows.find((row) => row && typeof row === "object") : rows;
  if (!status) {
    return {
      ok: false,
      required: true,
      status: null,
      reason: "imsg status returned no JSON status row."
    };
  }

  const missing = [];
  if (status.advanced_features !== true) missing.push("advanced_features");
  if (status.typing_indicators !== true) missing.push("typing_indicators");
  if (status.read_receipts !== true) missing.push("read_receipts");

  return {
    ok: missing.length === 0,
    required: true,
    status,
    reason: missing.length === 0
      ? null
      : `imsg status reports ${missing.join(", ")} unavailable. Run imsg advanced IMCore setup on this Mac before starting the connector.`
  };
}

export async function runImsgJsonLines({ imessage, args, timeoutMs = DEFAULT_TIMEOUT_MS }) {
  const { stdout } = await runCommand({
    command: imessage.imsgPath,
    args,
    timeoutMs
  });
  return stdout
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function imsgTargetArgs(target = {}) {
  if (target.chatId != null && target.chatId !== "") {
    return ["--chat-id", String(target.chatId)];
  }
  if (target.chatIdentifier) {
    return ["--chat-identifier", String(target.chatIdentifier)];
  }
  if (target.chatGuid) {
    return ["--chat-guid", String(target.chatGuid)];
  }
  if (target.to) {
    return ["--to", String(target.to)];
  }
  throw new Error("iMessage target requires to, chatId, chatIdentifier, or chatGuid.");
}

export function runCommand({ command, args = [], timeoutMs = DEFAULT_TIMEOUT_MS }) {
  return new Promise((resolve, reject) => {
    const child = execFile(command, args, { timeout: timeoutMs }, (error, stdout, stderr) => {
      if (error) {
        const message = [error.message, stderr?.trim()].filter(Boolean).join(": ");
        reject(new Error(message));
        return;
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
    child.on("error", reject);
  });
}
