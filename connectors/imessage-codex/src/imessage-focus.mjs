import { execFile } from "node:child_process";
import {
  findThreadRolloutPath,
  readLatestThreadStatus
} from "../../discord-codex/src/codex-rollout-watch.mjs";

const DEFAULT_FOCUS = {
  enabled: false,
  pollMs: 1500,
  rolloutRefreshMs: 30000,
  compactionStartGraceMs: 2000,
  compactionHoldMs: 15000,
  compactingShortcutName: null,
  onlineShortcutName: null,
  offlineShortcutName: null
};

export function createFocusMonitorState() {
  return {
    currentFocusState: null,
    targets: new Map()
  };
}

export function startCodexFocusMonitor({
  targets = [],
  focus = {},
  logger = console
} = {}) {
  const options = normalizeFocusOptions(focus);
  if (!options.enabled || targets.length === 0) {
    return () => {};
  }

  const monitorState = createFocusMonitorState();
  const poll = () => {
    pollCodexFocus({ targets, focus: options, monitorState, logger }).catch((error) => {
      logger.warn?.(`iMessage focus monitor failed: ${error.message}`);
    });
  };

  poll();
  const interval = setInterval(poll, options.pollMs);
  return async () => {
    clearInterval(interval);
    if (options.offlineShortcutName) {
      await runShortcut(options.offlineShortcutName, logger);
    }
  };
}

export async function pollCodexFocus({
  targets = [],
  focus = {},
  monitorState = createFocusMonitorState(),
  now = Date.now(),
  logger = console
} = {}) {
  const options = normalizeFocusOptions(focus);
  const targetStatuses = [];

  for (const target of targets) {
    const targetKey = target.id || target.threadId;
    const targetState = monitorState.targets.get(targetKey) || {};
    const rolloutPath = await resolveTargetRolloutPath({ target, targetState, options, now });
    targetState.rolloutPath = rolloutPath;
    targetState.rolloutCheckedAt = now;
    monitorState.targets.set(targetKey, targetState);

    if (!rolloutPath) {
      targetStatuses.push({ targetId: targetKey, active: false, reason: "missing-rollout" });
      continue;
    }
    targetStatuses.push({
      targetId: targetKey,
      ...await readLatestThreadStatus({ rolloutPath })
    });
  }

  const focusState = focusStateForTargetStatuses(targetStatuses, options, now);
  if (focusState !== monitorState.currentFocusState) {
    const shortcut = focusState === "compacting"
      ? options.compactingShortcutName
      : options.onlineShortcutName;
    if (shortcut) {
      await runShortcut(shortcut, logger);
      logger.info?.(`iMessage focus shortcut ran for ${focusState}.`);
    }
    monitorState.currentFocusState = focusState;
  }

  return { focusState, targetStatuses };
}

export function focusStateForTargetStatuses(targetStatuses, focus = {}, now = Date.now()) {
  const options = normalizeFocusOptions(focus);
  return targetStatuses.some((status) => isCompactingStatusVisible(status, options, now))
    ? "compacting"
    : "online";
}

function isCompactingStatusVisible(status, options, now) {
  if (status.active && status.contextCompacted) {
    return true;
  }
  const startedAtMs = Date.parse(status.startedAt || "");
  if (
    status.active &&
    status.turnContextSeen === false &&
    Number.isFinite(startedAtMs) &&
    now - startedAtMs >= options.compactionStartGraceMs
  ) {
    return true;
  }
  const compactedAtMs = Date.parse(status.lastContextCompactedAt || "");
  return !status.active && Number.isFinite(compactedAtMs) && now - compactedAtMs <= options.compactionHoldMs;
}

async function resolveTargetRolloutPath({ target, targetState, options, now }) {
  if (target.rolloutPath) {
    return target.rolloutPath;
  }
  const shouldRefresh =
    !targetState.rolloutPath ||
    !targetState.rolloutCheckedAt ||
    now - targetState.rolloutCheckedAt >= options.rolloutRefreshMs;
  if (!shouldRefresh) {
    return targetState.rolloutPath;
  }
  return findThreadRolloutPath(target.threadId);
}

function runShortcut(name, logger = console) {
  return new Promise((resolve) => {
    execFile("shortcuts", ["run", name], (error, stdout, stderr) => {
      if (error) {
        logger.warn?.(`Shortcut "${name}" failed: ${[error.message, stderr?.trim()].filter(Boolean).join(": ")}`);
      }
      resolve({ stdout: String(stdout || ""), stderr: String(stderr || "") });
    });
  });
}

function normalizeFocusOptions(focus = {}) {
  return {
    ...DEFAULT_FOCUS,
    ...focus
  };
}
