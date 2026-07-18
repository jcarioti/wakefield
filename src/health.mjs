import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { findThreadRolloutPath, readTurnStatus } from "../packages/connector-shared/src/codex-rollout-watch.mjs";
import { healthStatePath, serviceConfigPath } from "./paths.mjs";
import { readJson, writeJson } from "./json-store.mjs";
import { loadAgent } from "./profile.mjs";

const execFileAsync = promisify(execFile);
const HEALTH_SCHEMA_VERSION = 1;
const DEFAULT_HEALTH = {
  enabled: false,
  serviceStaleMinutes: 45,
  turnStallMinutes: 60,
  alertCommand: null,
  alertTimeoutMs: 30000
};

export async function runHealthCheck({
  home,
  now = new Date(),
  dutyResults = null,
  externalDispatch = null,
  serviceRun = false,
  notify = runConfiguredHealthAlert
} = {}) {
  const config = await loadHealthConfig(home);
  const state = await loadHealthState(home);
  const checkedAt = now.toISOString();
  if (!config.enabled) {
    return { ok: true, enabled: false, status: "disabled", findings: [], state };
  }

  const pendingTurns = [...state.pendingTurns];
  const findings = [];
  if (dutyResults) {
    for (const result of dutyResults.results || []) {
      if (result.status === "failed") {
        findings.push({
          code: "codex-dispatch-failed",
          detail: `${result.duty?.id || "scheduled wake"}: ${result.error?.message || "Codex dispatch failed."}`
        });
      } else if (result.status === "delivered" && result.dispatch?.turnId) {
        pendingTurns.push({
          wakeupId: result.duty?.id || null,
          threadId: result.route?.threadId || null,
          turnId: result.dispatch.turnId,
          dispatchedAt: checkedAt
        });
      } else if (result.status === "delivered") {
        findings.push({
          code: "codex-dispatch-no-turn-id",
          detail: `${result.duty?.id || "scheduled wake"} was accepted without a Codex turn ID.`
        });
      }
    }
  }

  if (externalDispatch?.failed > 0 && externalDispatch.pending > 0) {
    const failed = (externalDispatch.results || []).find((result) => !result.ok);
    findings.push({
      code: "external-dispatch-failed",
      detail: `An external ${failed?.message?.connector || "connector"} message remains queued after Codex routing failed: ${failed?.error?.message || "unknown dispatch failure"}`
    });
  }

  const unresolvedTurns = [];
  for (const pending of dedupePendingTurns(pendingTurns)) {
    const status = await inspectPendingTurn(pending, now, config);
    if (status.completed) continue;
    if (status.finding) findings.push(status.finding);
    if (!status.remove) unresolvedTurns.push(pending);
  }

  if (!serviceRun) {
    const service = await readJson(serviceConfigPath(home), {});
    if (service.enabled !== false && stale(service.lastRunAt, now, config.serviceStaleMinutes)) {
      findings.push({
        code: "wakefield-service-stale",
        detail: `Wakefield has not completed a service tick since ${service.lastRunAt || "unknown"}.`
      });
    }
  }

  const agent = await loadAgent(null, home);
  if (!agent?.threadId || !agent?.cwd) {
    findings.push({
      code: "rick-thread-not-configured",
      detail: "Rick does not have a selected Codex thread and working directory."
    });
  }

  const finding = findings[0] || null;
  const nextState = {
    ...state,
    schemaVersion: HEALTH_SCHEMA_VERSION,
    lastCheckedAt: checkedAt,
    pendingTurns: unresolvedTurns,
    incident: finding
      ? {
        ...(state.incident || {}),
        code: finding.code,
        detail: finding.detail,
        firstDetectedAt: state.incident?.firstDetectedAt || checkedAt,
        lastDetectedAt: checkedAt
      }
      : null,
    lastHealthyAt: finding ? state.lastHealthyAt : checkedAt,
    resolvedAt: finding ? null : (state.incident ? checkedAt : state.resolvedAt || null)
  };

  let notification = { status: "not-needed" };
  if (finding && state.lastAlertLocalDate !== localDateKey(now)) {
    const payload = {
      kind: "rick-unresponsive",
      detectedAt: checkedAt,
      failureClass: finding.code,
      detail: finding.detail,
      firstDetectedAt: nextState.incident.firstDetectedAt,
      pendingTurns: unresolvedTurns.length,
      pendingExternalMessages: externalDispatch?.pending || 0,
      dailyAlertLimit: 1
    };
    notification = await notify({ config, payload });
    if (notification.status === "sent") {
      nextState.lastAlertAt = checkedAt;
      nextState.lastAlertLocalDate = localDateKey(now);
    }
  } else if (finding) {
    notification = { status: "suppressed-daily-limit", localDate: state.lastAlertLocalDate };
  }

  await writeJson(healthStatePath(home), nextState);
  return {
    ok: !finding,
    enabled: true,
    status: finding ? "degraded" : "healthy",
    findings,
    notification,
    state: nextState
  };
}

export async function healthStatus({ home, now = new Date() } = {}) {
  const config = await loadHealthConfig(home);
  const state = await loadHealthState(home);
  return {
    enabled: config.enabled,
    config,
    state,
    localDate: localDateKey(now)
  };
}

export function formatHealthStatus(status) {
  if (status.status === "disabled" || status.enabled === false) return "Wakefield health monitor: disabled";
  const state = status.state || {};
  const incident = state.incident;
  return [
    "Wakefield health monitor",
    `status: ${status.status || (incident ? "degraded" : "healthy")}`,
    `last checked: ${state.lastCheckedAt || "never"}`,
    `last healthy: ${state.lastHealthyAt || "never"}`,
    `pending turns: ${(state.pendingTurns || []).length}`,
    incident ? `incident: ${incident.code} - ${incident.detail}` : "incident: none",
    state.lastAlertAt ? `last Joe alert: ${state.lastAlertAt}` : "last Joe alert: none"
  ].join("\n");
}

export async function loadHealthConfig(home) {
  const service = await readJson(serviceConfigPath(home), {});
  return normalizeHealth(service.health);
}

export async function loadHealthState(home) {
  const value = await readJson(healthStatePath(home), {});
  return {
    schemaVersion: HEALTH_SCHEMA_VERSION,
    lastCheckedAt: value.lastCheckedAt || null,
    lastHealthyAt: value.lastHealthyAt || null,
    lastAlertAt: value.lastAlertAt || null,
    lastAlertLocalDate: value.lastAlertLocalDate || null,
    incident: value.incident || null,
    resolvedAt: value.resolvedAt || null,
    pendingTurns: Array.isArray(value.pendingTurns) ? value.pendingTurns : []
  };
}

export function normalizeHealth(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    ...DEFAULT_HEALTH,
    ...source,
    enabled: Boolean(source.enabled),
    serviceStaleMinutes: positiveInteger(source.serviceStaleMinutes, DEFAULT_HEALTH.serviceStaleMinutes),
    turnStallMinutes: positiveInteger(source.turnStallMinutes, DEFAULT_HEALTH.turnStallMinutes),
    alertTimeoutMs: positiveInteger(source.alertTimeoutMs, DEFAULT_HEALTH.alertTimeoutMs),
    alertCommand: normalizeCommand(source.alertCommand)
  };
}

export async function runConfiguredHealthAlert({ config, payload }) {
  const command = config.alertCommand;
  if (!command) return { status: "not-configured" };
  try {
    await execFileAsync(command[0], command.slice(1), {
      timeout: config.alertTimeoutMs,
      maxBuffer: 1024 * 1024,
      env: {
        ...process.env,
        WAKEFIELD_HEALTH_ALERT_JSON: JSON.stringify(payload)
      }
    });
    return { status: "sent", command: command[0] };
  } catch (error) {
    return { status: "failed", error: error.message, command: command[0] };
  }
}

async function inspectPendingTurn(pending, now, config) {
  if (!pending.threadId || !pending.turnId) {
    return { completed: false, remove: true, finding: { code: "codex-turn-metadata-missing", detail: "A dispatched wake did not retain enough turn metadata to verify completion." } };
  }
  const rolloutPath = await findThreadRolloutPath(pending.threadId);
  const status = rolloutPath
    ? await readTurnStatus({ rolloutPath, turnId: pending.turnId })
    : { completed: false, reason: "rollout-not-found" };
  if (status.completed) return { completed: true, remove: true };
  if (status.aborted) {
    return {
      completed: false,
      remove: true,
      finding: { code: "codex-turn-aborted", detail: `${pending.wakeupId || "Scheduled wake"} turn ${pending.turnId} aborted.` }
    };
  }
  if (stale(pending.dispatchedAt, now, config.turnStallMinutes)) {
    return {
      completed: false,
      remove: false,
      finding: { code: "codex-turn-stalled", detail: `${pending.wakeupId || "Scheduled wake"} turn ${pending.turnId} has not completed.` }
    };
  }
  return { completed: false, remove: false };
}

function dedupePendingTurns(turns) {
  const seen = new Set();
  return (Array.isArray(turns) ? turns : []).filter((turn) => {
    const key = `${turn.threadId || ""}:${turn.turnId || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function stale(value, now, minutes) {
  if (!value) return true;
  const timestamp = new Date(value).getTime();
  return !Number.isFinite(timestamp) || now.getTime() - timestamp > minutes * 60 * 1000;
}

function localDateKey(value) {
  return new Intl.DateTimeFormat("en-CA", {
    year: "numeric",
    month: "2-digit",
    day: "2-digit"
  }).format(value);
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.round(number) : fallback;
}

function normalizeCommand(value) {
  if (Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string" && item.trim())) {
    return value.map((item) => item.trim());
  }
  if (typeof value === "string" && value.trim()) return [value.trim()];
  return null;
}
