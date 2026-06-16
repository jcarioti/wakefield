import { findThreadRolloutPath, readLatestThreadStatus } from "@wakefield/connector-shared/codex-rollout-watch.mjs";
import { ActivityType } from "discord.js";

const DEFAULT_PRESENCE = {
  enabled: true,
  pollMs: 1500,
  rolloutRefreshMs: 30000,
  compactionStartGraceMs: 2000,
  compactionHoldMs: 15000,
  presenceRefreshMs: 5000,
  onlineStatus: "online",
  compactingStatus: "idle",
  compactingActivityName: "Codex compact",
  compactingActivityType: "Watching"
};

export function createPresenceMonitorState() {
  return {
    currentDiscordStatus: null,
    lastDiscordPresenceSentAt: null,
    targets: new Map()
  };
}

export function startCodexPresenceMonitor({
  client,
  targets = [],
  presence = {},
  logger = console
} = {}) {
  const options = normalizePresenceOptions(presence);
  if (!options.enabled || targets.length === 0) {
    return () => {};
  }

  const monitorState = createPresenceMonitorState();
  const poll = () => {
    pollCodexPresence({ client, targets, presence: options, monitorState, logger }).catch((error) => {
      logger.warn?.(`Discord presence monitor failed: ${error.message}`);
    });
  };

  poll();
  const interval = setInterval(poll, options.pollMs);
  return () => {
    clearInterval(interval);
  };
}

export async function pollCodexPresence({
  client,
  targets = [],
  presence = {},
  monitorState = createPresenceMonitorState(),
  now = Date.now(),
  logger = console
} = {}) {
  const options = normalizePresenceOptions(presence);
  const targetStatuses = [];

  for (const target of targets) {
    const targetKey = target.id || target.threadId;
    const targetState = monitorState.targets.get(targetKey) || {};
    const rolloutPath = await resolveTargetRolloutPath({ target, targetState, options, now });
    targetState.rolloutPath = rolloutPath;
    targetState.rolloutCheckedAt = now;
    monitorState.targets.set(targetKey, targetState);

    if (!rolloutPath) {
      targetStatuses.push({
        targetId: targetKey,
        active: false,
        contextCompacted: false,
        reason: "missing-rollout"
      });
      continue;
    }

    const status = await readLatestThreadStatus({ rolloutPath });
    targetStatuses.push({
      targetId: targetKey,
      ...status
    });
  }

  const discordStatus = presenceStatusForTargetStatuses(targetStatuses, options, now);
  const shouldRefreshCompactingPresence =
    discordStatus === options.compactingStatus &&
    (!monitorState.lastDiscordPresenceSentAt || now - monitorState.lastDiscordPresenceSentAt >= options.presenceRefreshMs);
  if (discordStatus !== monitorState.currentDiscordStatus || shouldRefreshCompactingPresence) {
    await setDiscordPresence({ client, status: discordStatus, presence: options, logger, targetStatuses });
    monitorState.currentDiscordStatus = discordStatus;
    monitorState.lastDiscordPresenceSentAt = now;
  }

  return { discordStatus, targetStatuses };
}

export function presenceStatusForTargetStatuses(targetStatuses, presence = {}, now = Date.now()) {
  const options = normalizePresenceOptions(presence);
  return targetStatuses.some((status) => isCompactingStatusVisible(status, options, now))
    ? options.compactingStatus
    : options.onlineStatus;
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

async function setDiscordPresence({ client, status, presence, logger, targetStatuses = [] }) {
  if (!client?.user || typeof client.user.setPresence !== "function") {
    return;
  }
  try {
    await client.user.setPresence(discordPresenceData({ status, presence }));
    logger.info?.(`Discord presence set to ${status}: ${presenceReason(targetStatuses)}`);
  } catch (error) {
    logger.warn?.(`Discord presence update failed: ${error.message}`);
  }
}

export function discordPresenceData({ status, presence = {}, targetStatuses = [] } = {}) {
  const options = normalizePresenceOptions(presence);
  const isCompacting = status === options.compactingStatus;
  return {
    status,
    afk: isCompacting,
    activities: isCompacting
      ? [{
          name: options.compactingActivityName,
          type: activityTypeValue(options.compactingActivityType)
        }]
      : []
  };
}

function normalizePresenceOptions(presence = {}) {
  return {
    ...DEFAULT_PRESENCE,
    ...presence,
    pollMs: positiveNumber(presence.pollMs, DEFAULT_PRESENCE.pollMs),
    rolloutRefreshMs: positiveNumber(presence.rolloutRefreshMs, DEFAULT_PRESENCE.rolloutRefreshMs),
    compactionStartGraceMs: positiveNumber(presence.compactionStartGraceMs, DEFAULT_PRESENCE.compactionStartGraceMs),
    compactionHoldMs: positiveNumber(presence.compactionHoldMs, DEFAULT_PRESENCE.compactionHoldMs),
    presenceRefreshMs: positiveNumber(presence.presenceRefreshMs, DEFAULT_PRESENCE.presenceRefreshMs),
    compactingActivityName: presence.compactingActivityName || DEFAULT_PRESENCE.compactingActivityName,
    compactingActivityType: presence.compactingActivityType || DEFAULT_PRESENCE.compactingActivityType
  };
}

function positiveNumber(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? number : fallback;
}

function presenceReason(targetStatuses) {
  return targetStatuses
    .map((status) => {
      const target = status.targetId || "target";
      if (status.active && status.contextCompacted) return `${target}=context_compacted`;
      if (status.active && status.turnContextSeen === false) return `${target}=compact_turn_started`;
      if (status.lastContextCompactedAt) return `${target}=recent_compaction`;
      return `${target}=${status.reason || "unknown"}`;
    })
    .join(", ");
}

function activityTypeValue(value) {
  if (typeof value === "number") {
    return value;
  }
  return ActivityType[value] ?? ActivityType.Watching;
}
