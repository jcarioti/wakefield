import fs from "node:fs/promises";
import path from "node:path";
import { routePromptToCodex } from "./codex-ipc.mjs";
import { dutiesPath, appHome, expandHome } from "./paths.mjs";
import { readJson, writeJson } from "./json-store.mjs";

const DUTIES_SCHEMA_VERSION = 1;
const DEFAULT_DISPATCH_MODE = "dry-run";
const SCHEDULED_WAKEUP_SKILL = "wakefield-scheduled-wakeup";

export async function loadDuties({
  home = appHome()
} = {}) {
  return normalizeDutiesDocument(await readJson(dutiesPath(home), null));
}

export async function saveDuties(document, {
  home = appHome()
} = {}) {
  const next = normalizeDutiesDocument(document);
  next.updatedAt = new Date().toISOString();
  await writeJson(dutiesPath(home), next);
  return next;
}

export async function importDuties(duties, {
  home = appHome(),
  source = null,
  wakeups = null,
  replace = false
} = {}) {
  const current = await loadDuties({ home });
  const incomingRaw = Array.isArray(duties)
    ? { duties, wakeups: wakeups || [] }
    : {
      ...(duties || {}),
      wakeups: wakeups == null ? duties?.wakeups : wakeups
    };
  return saveDuties({
    schemaVersion: DUTIES_SCHEMA_VERSION,
    source: source || current.source,
    duties: mergeDuties(current.duties, incomingRaw.duties || [], { replace }),
    wakeups: mergeWakeups(current.wakeups, incomingRaw.wakeups || [], { replace })
  }, { home });
}

export async function configureWakeup(id, {
  home = appHome(),
  label = null,
  duties = null,
  skills = null,
  wakeTimes = null,
  enabled = null,
  intervalMinutes = null,
  clearInterval = false,
  clearWakeTimes = false,
  dispatchMode = null,
  requiredTools = null,
  resetSchedule = false
} = {}) {
  const current = await loadDuties({ home });
  const existing = current.wakeups.find((wakeup) => wakeup.id === id) || { id };
  const next = normalizeWakeup({
    ...existing,
    label: label == null ? existing.label : label,
    duties: duties == null ? existing.duties : duties,
    skills: skills == null ? existing.skills : skills,
    wakeTimes: clearWakeTimes ? [] : wakeTimes == null ? existing.wakeTimes : wakeTimes,
    enabled: enabled == null ? existing.enabled : Boolean(enabled),
    intervalMinutes: clearInterval ? null : intervalMinutes == null ? existing.intervalMinutes : intervalMinutes,
    dispatchMode: dispatchMode == null ? existing.dispatchMode : dispatchMode,
    requiredTools: requiredTools == null ? existing.requiredTools : requiredTools,
    lastRunAt: resetSchedule ? null : existing.lastRunAt || null
  });
  return importDuties({
    duties: current.duties,
    wakeups: [next]
  }, { home, source: current.source });
}

export async function configureDuty(id, {
  home = appHome(),
  label = null,
  prompt = null,
  promptFile = null,
  skills = null,
  wakeTimes = null,
  enabled = null,
  intervalMinutes = null,
  clearInterval = false,
  clearWakeTimes = false,
  dispatchMode = null,
  requiredTools = null,
  resetSchedule = false
} = {}) {
  const current = await loadDuties({ home });
  const existing = current.duties.find((duty) => duty.id === id) || { id };
  const next = normalizeDuty({
    ...existing,
    label: label == null ? existing.label : label,
    prompt: prompt == null ? existing.prompt : prompt,
    promptFile: promptFile == null ? existing.promptFile : promptFile,
    skills: skills == null ? existing.skills : skills,
    wakeTimes: clearWakeTimes ? [] : wakeTimes == null ? existing.wakeTimes : wakeTimes,
    enabled: enabled == null ? existing.enabled : Boolean(enabled),
    intervalMinutes: clearInterval ? null : intervalMinutes == null ? existing.intervalMinutes : intervalMinutes,
    dispatchMode: dispatchMode == null ? existing.dispatchMode : dispatchMode,
    requiredTools: requiredTools == null ? existing.requiredTools : requiredTools,
    lastRunAt: resetSchedule ? null : existing.lastRunAt || null
  });
  return importDuties([next], { home, source: current.source });
}

export async function deleteWakeup(id, {
  home = appHome()
} = {}) {
  const current = await loadDuties({ home });
  const normalizedId = normalizeId(id);
  return saveDuties({
    ...current,
    wakeups: current.wakeups.filter((wakeup) => wakeup.id !== normalizedId)
  }, { home });
}

export async function deleteDuty(id, {
  home = appHome(),
  removeReferences = false
} = {}) {
  const current = await loadDuties({ home });
  const normalizedId = normalizeId(id);
  const references = current.wakeups.filter((wakeup) => dutyIds(wakeup).includes(normalizedId));
  if (references.length > 0 && !removeReferences) {
    throw new Error(`Duty ${normalizedId} is used by wakeup(s): ${references.map((wakeup) => wakeup.id).join(", ")}. Re-run with --remove-references to delete it anyway.`);
  }
  return saveDuties({
    ...current,
    duties: current.duties.filter((duty) => duty.id !== normalizedId),
    wakeups: removeReferences
      ? current.wakeups.map((wakeup) => ({
        ...wakeup,
        duties: dutyIds(wakeup).filter((dutyId) => dutyId !== normalizedId)
      }))
      : current.wakeups
  }, { home });
}

export async function dutyStatuses({
  home = appHome(),
  now = new Date(),
  includeCompatibilityWakeups = true
} = {}) {
  const document = await loadDuties({ home });
  return {
    ...document,
    wakeups: wakeupStatuses(document, { now, includeCompatibilityWakeups })
  };
}

export async function runDueDuties(agent, {
  home = appHome(),
  now = new Date(),
  dispatchClient = null,
  dispatchSocketPath = null,
  only = null,
  force = false
} = {}) {
  if (!agent) throw new Error("runDueDuties needs an agent profile.");
  const document = await loadDuties({ home });
  const selected = wakeupStatuses(document, { now, includeCompatibilityWakeups: true })
    .filter((duty) => !only || duty.id === only)
    .filter((duty) => duty.enabled && (force || duty.due));
  const results = [];
  let nextDocument = document;

  for (const duty of selected) {
    const result = await runDuty(agent, duty, {
      dispatchClient,
      dispatchSocketPath,
      now
    });
    results.push(result);
    if (result.ok) {
      nextDocument = updateWakeupRunState(nextDocument, duty, now);
    }
  }

  if (results.some((result) => result.ok)) {
    await saveDuties(nextDocument, { home });
  }

  return {
    ok: results.every((result) => result.ok),
    ranAt: now.toISOString(),
    attempted: results.length,
    dispatched: results.filter((result) => result.status === "delivered").length,
    dryRun: results.filter((result) => result.status === "dry-run").length,
    results,
    wakeups: (await dutyStatuses({ home, now })).wakeups
  };
}

export async function runDuty(agent, duty, {
  dispatchClient = null,
  dispatchSocketPath = null,
  now = new Date()
} = {}) {
  const route = await routeForDuty(agent, duty, { now });
  if (route.status !== "ready") {
    return {
      ok: false,
      status: route.status,
      duty,
      route,
      dispatch: null
    };
  }

  const mode = normalizeDispatchMode(duty.dispatchMode);
  if (mode === "dry-run" || mode === "manual") {
    return {
      ok: true,
      status: mode,
      duty,
      route,
      dispatch: null,
      ranAt: now.toISOString()
    };
  }

  try {
    const dispatch = await routePromptToCodex({
      threadId: route.threadId,
      cwd: route.cwd,
      prompt: route.prompt,
      mode: mode === "ipc" ? "auto" : mode,
      client: dispatchClient,
      socketPath: dispatchSocketPath
    });
    return {
      ok: true,
      status: "delivered",
      duty,
      route,
      dispatch,
      ranAt: now.toISOString()
    };
  } catch (error) {
    return {
      ok: false,
      status: "failed",
      duty,
      route,
      dispatch: null,
      error: serializeError(error),
      ranAt: now.toISOString()
    };
  }
}

export async function routeForDuty(agent, duty, {
  now = new Date()
} = {}) {
  const ready = Boolean(agent?.threadId && agent?.cwd);
  return {
    status: ready ? "ready" : "needs-thread",
    reason: ready ? null : "Select a persistent Codex thread before running duties.",
    threadId: agent?.threadId || null,
    cwd: agent?.cwd || null,
    prompt: await formatDutyPrompt(duty, { agent, cwd: agent?.cwd || null, now })
  };
}

export async function formatDutyPrompt(duty, {
  cwd = null,
  now = new Date()
} = {}) {
  const body = await dutyPromptBody(duty, { cwd });
  const skills = dutySkills(duty);
  return [
    `Scheduled Wakefield wakeup: ${duty.label || duty.id}`,
    `Use $${SCHEDULED_WAKEUP_SKILL}.`,
    "",
    `Wakeup ID: ${duty.id}`,
    `Wake time: ${normalizeWakeTime(now)}`,
    duty.wakeTimes?.length > 0 ? `Wake schedule: ${duty.wakeTimes.join(", ")} local` : null,
    duty.dueWakeTimes?.length > 0 ? `Due wake slot: ${duty.dueWakeTimes.join(", ")} local` : null,
    duty.dutyIds?.length > 0 ? `Duties: ${duty.dutyIds.join(", ")}` : null,
    skills.length > 0 ? `Duty skills: ${skills.map((skill) => `$${skill}`).join(", ")}` : null,
    duty.requiredTools?.length > 0 ? `Required tools: ${duty.requiredTools.join(", ")}` : null,
    "",
    body
  ].filter((line) => line != null).join("\n");
}

export function formatDutyStatuses(document) {
  const wakeups = document.wakeups || [];
  if (wakeups.length === 0) return "No Wakefield wakeups configured.";
  return wakeups
    .map((wakeup) => `${wakeup.id}: ${wakeup.enabled ? "enabled" : "disabled"}${wakeup.due ? ", due" : ""}${formatDutyCadence(wakeup)} - ${wakeup.label}`)
    .join("\n");
}

export function formatDutyRun(result) {
  if (result.attempted === 0) return "No Wakefield wakeups were due.";
  return result.results
    .map((item) => `${item.duty.id}: ${item.status}`)
    .join("\n");
}

function normalizeDutiesDocument(value) {
  const source = Array.isArray(value)
    ? { duties: value }
    : value && typeof value === "object" ? value : {};
  return {
    schemaVersion: DUTIES_SCHEMA_VERSION,
    updatedAt: source.updatedAt || source.updated || null,
    source: source.source || null,
    duties: (source.duties || []).map(normalizeDuty),
    wakeups: (source.wakeups || []).map(normalizeWakeup)
  };
}

function normalizeDuty(duty) {
  const source = duty && typeof duty === "object" ? duty : {};
  const id = normalizeId(source.id || source.label || "duty");
  return {
    id,
    label: String(source.label || id).trim(),
    enabled: source.enabled !== false,
    intervalMinutes: source.intervalMinutes == null ? null : normalizeInterval(source.intervalMinutes),
    dispatchMode: normalizeDispatchMode(source.dispatchMode),
    prompt: source.prompt || null,
    promptFile: source.promptFile || null,
    skills: dutySkills(source),
    wakeTimes: dutyWakeTimes(source),
    requiredTools: asArray(source.requiredTools),
    lastRunAt: source.lastRunAt || null
  };
}

function normalizeWakeup(wakeup) {
  const source = wakeup && typeof wakeup === "object" ? wakeup : {};
  const id = normalizeId(source.id || source.label || "wakeup");
  return {
    id,
    label: String(source.label || id).trim(),
    enabled: source.enabled !== false,
    intervalMinutes: source.intervalMinutes == null ? null : normalizeInterval(source.intervalMinutes),
    dispatchMode: normalizeDispatchMode(source.dispatchMode),
    prompt: source.prompt || null,
    promptFile: source.promptFile || null,
    duties: dutyIds(source),
    skills: dutySkills(source),
    wakeTimes: dutyWakeTimes(source),
    requiredTools: asArray(source.requiredTools),
    lastRunAt: source.lastRunAt || null
  };
}

function wakeupStatuses(document, { now, includeCompatibilityWakeups = true }) {
  const dutiesById = new Map(document.duties.map((duty) => [duty.id, duty]));
  const explicitWakeups = document.wakeups.map((wakeup) => resolveWakeup(wakeup, dutiesById, {
    stateKind: "wakeup",
    stateId: wakeup.id
  }));
  const compatibilityWakeups = includeCompatibilityWakeups
    ? document.duties
      .filter(hasInlineSchedule)
      .map((duty) => resolveWakeup(legacyWakeupFromDuty(duty), dutiesById, {
        stateKind: "duty",
        stateId: duty.id
      }))
    : [];
  return [...explicitWakeups, ...compatibilityWakeups]
    .map((wakeup) => wakeupStatus(wakeup, { now }))
    .sort((left, right) => left.id.localeCompare(right.id));
}

function resolveWakeup(wakeup, dutiesById, state) {
  const normalized = normalizeWakeup(wakeup);
  const dutyItems = normalized.duties
    .map((id) => dutiesById.get(id) || { id, label: id, skills: [], requiredTools: [], missing: true });
  return {
    ...normalized,
    dutyIds: normalized.duties,
    dutyItems,
    missingDuties: dutyItems.filter((item) => item.missing).map((item) => item.id),
    skills: uniqueStrings([
      ...normalized.skills,
      ...dutyItems.flatMap((item) => item.skills)
    ]),
    requiredTools: uniqueStrings([
      ...normalized.requiredTools,
      ...dutyItems.flatMap((item) => item.requiredTools || [])
    ]),
    state
  };
}

function legacyWakeupFromDuty(duty) {
  return {
    ...duty,
    duties: [duty.id],
    skills: duty.skills
  };
}

function wakeupStatus(wakeup, { now }) {
  const normalized = normalizeWakeup(wakeup);
  const resolved = {
    ...wakeup,
    ...normalized,
    dutyIds: wakeup.dutyIds || normalized.duties,
    dutyItems: wakeup.dutyItems || [],
    missingDuties: wakeup.missingDuties || [],
    skills: dutySkills(wakeup),
    requiredTools: wakeup.requiredTools || [],
    state: wakeup.state || { stateKind: "wakeup", stateId: normalized.id }
  };
  const interval = intervalDutyStatus(normalized, { now });
  const schedule = scheduleDutyStatus(normalized, { now });
  const dueReasons = uniqueStrings([
    interval?.due ? "interval" : null,
    schedule.due ? "wake-time" : null
  ]);
  const due = resolved.enabled && dueReasons.length > 0;
  return {
    ...resolved,
    nextRunAt: nextDutyRunAt([interval, schedule]),
    due,
    dueReasons,
    dueWakeTimes: schedule.dueWakeTimes,
    schedule: normalized.wakeTimes.length > 0
      ? {
        timeZone: "local",
        wakeTimes: normalized.wakeTimes,
        dueWakeTimes: schedule.dueWakeTimes,
        nextRunAt: schedule.nextRunAt
      }
      : null
  };
}

function intervalDutyStatus(duty, { now }) {
  if (!duty.enabled || duty.intervalMinutes == null) return null;
  const nextRunAt = nextIntervalRunAt(duty);
  return {
    kind: "interval",
    due: Boolean(nextRunAt && new Date(nextRunAt).getTime() <= now.getTime()),
    nextRunAt
  };
}

function nextIntervalRunAt(duty) {
  if (!duty.enabled || duty.intervalMinutes == null) return null;
  if (!duty.lastRunAt) return new Date(0).toISOString();
  const last = new Date(duty.lastRunAt);
  if (Number.isNaN(last.getTime())) return new Date(0).toISOString();
  return new Date(last.getTime() + duty.intervalMinutes * 60 * 1000).toISOString();
}

function scheduleDutyStatus(duty, { now }) {
  if (!duty.enabled || duty.wakeTimes.length === 0) return {
    kind: "wake-time",
    due: false,
    nextRunAt: null,
    dueWakeTimes: []
  };
  const lastRunAt = validDateOrNull(duty.lastRunAt);
  const dueSlots = todayScheduleSlots(duty.wakeTimes, now)
    .filter((slot) => slot.at.getTime() <= now.getTime())
    .filter((slot) => !lastRunAt || slot.at.getTime() > lastRunAt.getTime());
  const nextSlot = nextScheduleSlot(duty.wakeTimes, now, lastRunAt);
  return {
    kind: "wake-time",
    due: dueSlots.length > 0,
    nextRunAt: dueSlots[0]?.at.toISOString() || nextSlot?.at.toISOString() || null,
    dueWakeTimes: dueSlots.map((slot) => slot.time)
  };
}

function nextDutyRunAt(statuses) {
  const dates = statuses
    .filter(Boolean)
    .map((status) => status.nextRunAt)
    .filter(Boolean)
    .map((value) => new Date(value))
    .filter((date) => !Number.isNaN(date.getTime()))
    .sort((left, right) => left.getTime() - right.getTime());
  return dates[0]?.toISOString() || null;
}

async function dutyPromptBody(duty, { cwd }) {
  if (duty.prompt) return String(duty.prompt);
  if (duty.promptFile) {
    const file = path.resolve(cwd || process.cwd(), expandHome(duty.promptFile));
    return fs.readFile(file, "utf8");
  }
  const skills = dutySkills(duty);
  const dutyLines = duty.dutyItems?.length > 0
    ? duty.dutyItems.map((item) => {
      const itemSkills = dutySkills(item);
      const skillText = itemSkills.length > 0 ? `: ${itemSkills.map((skill) => `$${skill}`).join(", ")}` : "";
      const missingText = item.missing ? " (missing duty definition)" : "";
      return `- ${item.id}${skillText}${missingText}`;
    })
    : [];
  if (skills.length > 0) {
    return [
      "Run these scheduled duties in this turn:",
      ...(dutyLines.length > 0 ? dutyLines : skills.map((skill) => `- $${skill}`))
    ].join("\n");
  }
  if (dutyLines.length > 0) {
    return [
      "Run these scheduled duties in this turn:",
      ...dutyLines
    ].join("\n");
  }
  return `Run wakeup ${duty.id}.`;
}

function mergeDuties(left, right, { replace = false } = {}) {
  const merged = new Map();
  const incoming = right.map((duty) => ({ raw: duty, normalized: normalizeDuty(duty) }));
  const current = left.map(normalizeDuty);
  const base = replace
    ? current.filter((duty) => incoming.some((item) => item.normalized.id === duty.id))
    : current;
  for (const item of [
    ...base.map((duty) => ({ raw: duty, normalized: duty })),
    ...incoming
  ]) {
    const source = item.raw && typeof item.raw === "object" ? item.raw : {};
    const normalized = item.normalized;
    const previous = merged.get(normalized.id) || {};
    const next = {
      ...previous,
      ...normalized
    };
    if (!Object.hasOwn(source, "lastRunAt") && previous.lastRunAt) {
      next.lastRunAt = previous.lastRunAt;
    }
    merged.set(normalized.id, {
      ...next
    });
  }
  return [...merged.values()].sort((leftDuty, rightDuty) => leftDuty.id.localeCompare(rightDuty.id));
}

function mergeWakeups(left, right, { replace = false } = {}) {
  const merged = new Map();
  const incoming = right.map((wakeup) => ({ raw: wakeup, normalized: normalizeWakeup(wakeup) }));
  const current = left.map(normalizeWakeup);
  const base = replace
    ? current.filter((wakeup) => incoming.some((item) => item.normalized.id === wakeup.id))
    : current;
  for (const item of [
    ...base.map((wakeup) => ({ raw: wakeup, normalized: wakeup })),
    ...incoming
  ]) {
    const source = item.raw && typeof item.raw === "object" ? item.raw : {};
    const normalized = item.normalized;
    const previous = merged.get(normalized.id) || {};
    const next = {
      ...previous,
      ...normalized
    };
    if (!Object.hasOwn(source, "lastRunAt") && previous.lastRunAt) {
      next.lastRunAt = previous.lastRunAt;
    }
    merged.set(normalized.id, next);
  }
  return [...merged.values()].sort((leftWakeup, rightWakeup) => leftWakeup.id.localeCompare(rightWakeup.id));
}

function updateWakeupRunState(document, wakeup, now) {
  const ranAt = now.toISOString();
  if (wakeup.state?.stateKind === "duty") {
    return {
      ...document,
      duties: document.duties.map((item) => item.id === wakeup.state.stateId
        ? {
          ...item,
          lastRunAt: ranAt
        }
        : item)
    };
  }
  return {
    ...document,
    wakeups: document.wakeups.map((item) => item.id === wakeup.state?.stateId
      ? {
        ...item,
        lastRunAt: ranAt
      }
      : item)
  };
}

function hasInlineSchedule(duty) {
  return duty.intervalMinutes != null || duty.wakeTimes.length > 0 || Boolean(duty.prompt || duty.promptFile);
}

function dutyIds(value) {
  const source = value && typeof value === "object" ? value : {};
  return uniqueStrings([
    ...asArray(source.duty),
    ...asArray(source.duties)
  ].map((item) => typeof item === "object" && item ? item.id || item.name || item.label : item)).map(normalizeId);
}

function normalizeId(value) {
  return String(value || "item")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "item";
}

function normalizeInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 1) throw new Error("Duty interval must be at least 1 minute.");
  return Math.round(interval);
}

function normalizeWakeTimes(value) {
  const times = uniqueStrings(asArray(value)).map(normalizeTimeOfDay);
  return times.sort((left, right) => timeOfDayMinutes(left) - timeOfDayMinutes(right));
}

function normalizeTimeOfDay(value) {
  const text = String(value || "").trim();
  const match = /^([01]?\d|2[0-3]):([0-5]\d)$/.exec(text);
  if (!match) throw new Error("Wake time must be HH:mm in 24-hour local time.");
  return `${match[1].padStart(2, "0")}:${match[2]}`;
}

function timeOfDayMinutes(value) {
  const [hour, minute] = normalizeTimeOfDay(value).split(":").map(Number);
  return hour * 60 + minute;
}

function normalizeDispatchMode(value) {
  const mode = String(value || DEFAULT_DISPATCH_MODE).trim();
  if (["ipc", "auto", "steer", "start", "dry-run", "manual"].includes(mode)) return mode;
  throw new Error("Duty dispatch mode must be ipc, auto, steer, start, dry-run, or manual.");
}

function formatDutyCadence(duty) {
  const parts = [];
  if (duty.wakeTimes?.length > 0) parts.push(`at ${duty.wakeTimes.join(", ")} local`);
  if (duty.intervalMinutes != null) parts.push(`every ${duty.intervalMinutes}m`);
  return parts.length > 0 ? ` (${parts.join("; ")})` : "";
}

function normalizeWakeTime(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date().toISOString() : date.toISOString();
}

function asArray(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value : [value];
}

function dutySkills(duty) {
  const source = duty && typeof duty === "object" ? duty : {};
  return uniqueStrings([
    ...asArray(source.skill),
    ...asArray(source.skills)
  ]).map((skill) => skill.replace(/^\$/, ""));
}

function dutyWakeTimes(duty) {
  const source = duty && typeof duty === "object" ? duty : {};
  const schedule = source.schedule && typeof source.schedule === "object" ? source.schedule : {};
  return normalizeWakeTimes([
    ...asArray(source.wakeTime),
    ...asArray(source.wakeTimes),
    ...asArray(source.times),
    ...asArray(source.scheduleTimes),
    ...asArray(schedule.wakeTime),
    ...asArray(schedule.wakeTimes),
    ...asArray(schedule.times)
  ]);
}

function todayScheduleSlots(wakeTimes, now) {
  return wakeTimes.map((time) => ({
    time,
    at: localDateAtTime(now, time)
  }));
}

function nextScheduleSlot(wakeTimes, now, lastRunAt) {
  const today = todayScheduleSlots(wakeTimes, now)
    .find((slot) => slot.at.getTime() > now.getTime() && (!lastRunAt || slot.at.getTime() > lastRunAt.getTime()));
  if (today) return today;
  const tomorrow = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1);
  return wakeTimes.map((time) => ({
    time,
    at: localDateAtTime(tomorrow, time)
  }))[0] || null;
}

function localDateAtTime(date, time) {
  const [hour, minute] = normalizeTimeOfDay(time).split(":").map(Number);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, minute, 0, 0);
}

function validDateOrNull(value) {
  if (!value) return null;
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function uniqueStrings(values) {
  const seen = new Set();
  const result = [];
  for (const value of values) {
    const text = String(value || "").trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    result.push(text);
  }
  return result;
}

function serializeError(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null,
    method: error?.method || null
  };
}
