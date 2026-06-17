import { randomUUID } from "node:crypto";
import { appendJsonl, readJson, readJsonl, writeJson } from "./json-store.mjs";
import { processMemoryCaptures } from "./memory-capture.mjs";

export async function recordMemory(agent, {
  channel = "journal",
  kind = "note",
  text = "",
  data = {},
  source = "manual",
  now = new Date()
}) {
  if (!agent) throw new Error("recordMemory needs an agent profile.");
  const file = memoryFile(agent, channel);
  const entry = {
    id: randomUUID(),
    at: now.toISOString(),
    agentId: agent.id,
    source,
    kind,
    text: String(text || ""),
    data
  };
  await appendJsonl(file, entry);
  return entry;
}

export async function updateState(agent, patch) {
  const current = await readJson(agent.memory.statePath, {
    facts: [],
    preferences: [],
    openThreads: [],
    recentTurns: [],
    dreamer: {
      processedIds: []
    }
  });
  const next = {
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  await writeJson(agent.memory.statePath, next);
  return next;
}

export async function processDreams(agent, {
  limit = 10,
  dryRun = false,
  now = new Date(),
  capture = true,
  captureProvider = null,
  env = process.env,
  fetchImpl = fetch
} = {}) {
  if (!agent) throw new Error("processDreams needs an agent profile.");
  const state = await readJson(agent.memory.statePath, {
    facts: [],
    preferences: [],
    openThreads: [],
    recentTurns: [],
    dreamer: {
      processedIds: []
    }
  });
  const processedIds = new Set(Array.isArray(state.dreamer?.processedIds) ? state.dreamer.processedIds : []);
  const dreams = await readJsonl(agent.memory.dreamsPath);
  const pending = dreams
    .filter((entry) => isPendingDream(entry, processedIds))
    .slice(0, Number(limit || 10));
  const journal = pending.length > 0 ? await readJsonl(agent.memory.journalPath) : [];
  const inbox = pending.length > 0 ? await readJsonl(agent.memory.inboxPath) : [];
  const summaries = summarizePendingDreams(pending, [...journal, ...inbox], now);
  const nextProcessedIds = mergeProcessedIds(processedIds, summaries);

  if (!dryRun && summaries.length > 0) {
    for (const summary of summaries) {
      await recordMemory(agent, {
        channel: "dreams",
        kind: "dream-summary",
        text: summary.summary,
        source: "wakefield-dreamer",
        data: {
          sourceDreamId: summary.sourceDreamId,
          sourceDreamIds: summary.sourceDreamIds,
          sessionId: summary.sessionId,
          turnId: summary.turnId,
          toolCount: summary.toolCount,
          changes: summary.changes
        },
        now
      });
    }

    await updateState(agent, {
      recentTurns: mergeRecentTurns(state.recentTurns, summaries),
      dreamer: {
        ...(state.dreamer || {}),
        processedIds: nextProcessedIds,
        lastRunAt: now.toISOString()
      }
    });
  }

  const captureResult = capture === false
    ? null
    : await processMemoryCaptures(agent, {
      summaries: summaries.length > 0 ? summaries : null,
      limit,
      dryRun,
      now,
      captureProvider,
      env,
      fetchImpl
    });

  return {
    processed: summaries.length,
    pending: dreams.filter((entry) => isPendingDream(entry, new Set(nextProcessedIds))).length,
    dryRun: Boolean(dryRun),
    summaries,
    capture: captureResult
  };
}

export async function recall(agent, query, {
  limit = 5,
  includeIfNoTerms = false,
  minScore = 1
} = {}) {
  if (!agent) return [];
  const terms = importantTerms(query);
  const state = await readJson(agent.memory.statePath, {});
  const journal = await readJsonl(agent.memory.journalPath);
  const dreams = await readJsonl(agent.memory.dreamsPath);
  const candidates = [
    ...stateEntries(state),
    ...journal.map((entry) => ({ ...entry, channel: "journal" })),
    ...dreams.map((entry) => ({ ...entry, channel: "dreams" }))
  ];

  return candidates
    .map((entry) => ({ entry, score: scoreEntry(entry, terms) }))
    .filter((item) => terms.length === 0 ? includeIfNoTerms && item.score > 0 : item.score >= minScore)
    .sort((left, right) => right.score - left.score || String(right.entry.at || "").localeCompare(String(left.entry.at || "")))
    .filter(deduplicateScoredEntries())
    .slice(0, limit)
    .map((item) => item.entry);
}

export async function memoryContext(agent, query, {
  limit = 5,
  maxChars = 1600,
  includeIfNoTerms = false,
  minScore = 1
} = {}) {
  const entries = await recall(agent, query, { limit, includeIfNoTerms, minScore });
  if (entries.length === 0) return "";

  const lines = entries.map(formatEntryLine);
  const body = lines.join("\n");
  return body.length <= maxChars ? body : `${body.slice(0, maxChars - 3)}...`;
}

export function formatEntryLine(entry) {
  const label = entry.channel || entry.kind || "memory";
  const text = entry.text || entry.value || JSON.stringify(entry.data || entry);
  return `- ${label}: ${compact(text, 220)}`;
}

export function compact(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

export function formatDreamResult(result) {
  if (result.processed === 0) {
    if (result.capture?.enabled && result.capture.reviewed > 0) {
      return formatCaptureLine(result.capture);
    }
    return result.pending > 0
      ? `No dreams processed in this batch. ${result.pending} still pending.`
      : "No pending dreams.";
  }

  const lines = [`Processed ${result.processed} dream${result.processed === 1 ? "" : "s"}.`];
  for (const summary of result.summaries) {
    lines.push(`- ${compact(summary.summary, 220)}`);
  }
  if (result.pending > 0) lines.push(`${result.pending} still pending.`);
  if (result.capture?.enabled && result.capture.applied.length > 0) {
    lines.push(`Memory capture applied ${result.capture.applied.length} delta${result.capture.applied.length === 1 ? "" : "s"}.`);
  } else if (result.capture && !result.capture.enabled) {
    lines.push(`Memory capture skipped: ${result.capture.skippedReason}`);
  }
  if (result.dryRun) lines.push("Dry run; no memory was written.");
  return lines.join("\n");
}

function formatCaptureLine(capture) {
  const base = `Memory capture reviewed ${capture.reviewed} dream summar${capture.reviewed === 1 ? "y" : "ies"}.`;
  if (capture.applied.length === 0) return `${base} No deltas applied.`;
  return `${base} Applied ${capture.applied.length} delta${capture.applied.length === 1 ? "" : "s"}.`;
}

function memoryFile(agent, channel) {
  if (channel === "inbox") return agent.memory.inboxPath;
  if (channel === "dreams") return agent.memory.dreamsPath;
  return agent.memory.journalPath;
}

function stateEntries(state) {
  const facts = Array.isArray(state.facts) ? state.facts.map((value) => ({
    channel: "state",
    kind: "fact",
    text: value
  })) : [];
  const preferences = Array.isArray(state.preferences) ? state.preferences.map((value) => ({
    channel: "state",
    kind: "preference",
    text: value
  })) : [];
  const openThreads = Array.isArray(state.openThreads) ? state.openThreads.map((value) => ({
    channel: "state",
    kind: "open-thread",
    text: value
  })) : [];
  const recentTurns = Array.isArray(state.recentTurns) ? state.recentTurns.map((value) => ({
    channel: "state",
    kind: "turn-summary",
    text: value.summary || value.text || JSON.stringify(value)
  })) : [];
  return [...facts, ...preferences, ...openThreads, ...recentTurns];
}

function isPendingDream(entry, processedIds) {
  if (!entry?.id || processedIds.has(entry.id)) return false;
  return entry.kind === "dream-queued" || entry.kind === "pre-compact" || entry.kind === "post-compact";
}

function summarizePendingDreams(pending, journal, now) {
  const groups = groupPendingDreams(pending);
  return groups.map((group) => summarizeDreamGroup(group, journal, now));
}

function groupPendingDreams(pending) {
  const groups = [];
  const byTurn = new Map();
  for (const entry of pending) {
    const key = dreamGroupKey(entry);
    if (!key) {
      groups.push([entry]);
      continue;
    }
    if (!byTurn.has(key)) {
      const group = [];
      byTurn.set(key, group);
      groups.push(group);
    }
    byTurn.get(key).push(entry);
  }
  return groups;
}

function dreamGroupKey(entry) {
  const sessionId = entry.data?.sessionId || entry.data?.session_id || "";
  const turnId = entry.data?.turnId || entry.data?.turn_id || "";
  if (!sessionId && !turnId) return "";
  return `${sessionId}:${turnId}`;
}

function summarizeDreamGroup(entries, journal, now) {
  const turnEntry = entries.find((entry) => entry.kind === "dream-queued") || null;
  if (turnEntry) return summarizeTurnDream(turnEntry, entries, journal, now);
  if (entries.some(isCompactEdge)) return summarizeCompactDream(entries, now);
  return summarizeTurnDream(entries[0], entries, journal, now);
}

function summarizeTurnDream(entry, sourceEntries, journal, now) {
  const sessionId = entry.data?.sessionId || entry.data?.session_id || null;
  const turnId = entry.data?.turnId || entry.data?.turn_id || null;
  const related = journal.filter((item) => sameTurn(item, { sessionId, turnId }));
  const stop = related.findLast?.((item) => item.kind === "turn-stop")
    || [...related].reverse().find((item) => item.kind === "turn-stop")
    || null;
  const prompts = related.filter((item) => item.kind === "user-prompt");
  const tools = related.filter((item) => item.kind === "tool-use");
  const changes = tools.map((item) => compact(item.text, 180));
  const subject = turnId ? `Turn ${turnId}` : entry.kind === "dream-queued" ? "A Codex turn" : "A compaction edge";
  const promptText = prompts.length > 0
    ? `Prompt: ${compact(prompts.map((item) => item.text).join(" "), 360)}. `
    : "";
  const responseText = stop?.text
    ? `Response: ${compact(stop.text, 360)}`
    : compact(entry.text, 360);
  const base = `${promptText}${responseText}`;
  const toolText = changes.length > 0
    ? ` Tool activity: ${changes.slice(-4).join("; ")}.`
    : "";
  const compactionText = compactionNote(sourceEntries.filter(isCompactEdge));
  const summary = `${subject}: ${base}${toolText}${compactionText}`;
  const sourceDreamIds = sourceEntries.map((item) => item.id).filter(Boolean);

  return {
    sourceDreamId: sourceDreamIds[0] || entry.id,
    sourceDreamIds,
    at: now.toISOString(),
    sessionId,
    turnId,
    summary,
    toolCount: tools.length,
    changes
  };
}

function summarizeCompactDream(entries, now) {
  const first = entries[0] || {};
  const sessionId = first.data?.sessionId || first.data?.session_id || null;
  const turnId = first.data?.turnId || first.data?.turn_id || null;
  const sourceDreamIds = entries.map((item) => item.id).filter(Boolean);
  const summary = compactSummary(entries);
  return {
    sourceDreamId: sourceDreamIds[0] || first.id,
    sourceDreamIds,
    at: now.toISOString(),
    sessionId,
    turnId,
    summary: turnId ? `Turn ${turnId}: ${summary}` : summary,
    toolCount: 0,
    changes: []
  };
}

function isCompactEdge(entry) {
  return entry?.kind === "pre-compact" || entry?.kind === "post-compact";
}

function compactSummary(entries) {
  const hasPre = entries.some((entry) => entry.kind === "pre-compact");
  const hasPost = entries.some((entry) => entry.kind === "post-compact");
  const trigger = compactTrigger(entries);
  if (hasPre && hasPost) return `${capitalize(trigger)} compaction completed.`;
  if (hasPost) return `${capitalize(trigger)} compaction completed.`;
  return `${capitalize(trigger)} compaction started.`;
}

function compactionNote(entries) {
  if (entries.length === 0) return "";
  return ` ${compactSummary(entries)}`;
}

function compactTrigger(entries) {
  const triggers = [...new Set(entries
    .map((entry) => entry.data?.trigger)
    .filter(Boolean))];
  if (triggers.length === 1) return triggers[0];
  if (triggers.length > 1) return "mixed";
  return "unknown";
}

function capitalize(value) {
  const text = String(value || "unknown");
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function sameTurn(entry, { sessionId, turnId }) {
  const entrySessionId = entry.data?.sessionId || entry.data?.session_id || null;
  const entryTurnId = entry.data?.turnId || entry.data?.turn_id || null;
  if (turnId && entryTurnId !== turnId) return false;
  if (sessionId && entrySessionId !== sessionId) return false;
  return Boolean(turnId || sessionId);
}

function mergeRecentTurns(current, summaries) {
  const seen = new Set();
  return [
    ...summaries,
    ...(Array.isArray(current) ? current : [])
  ].filter((item) => {
    const key = (item.sourceDreamIds || []).join(",") || item.sourceDreamId || `${item.sessionId || ""}:${item.turnId || ""}:${item.summary || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
}

function mergeProcessedIds(processedIds, summaries) {
  const ids = new Set(processedIds);
  for (const summary of summaries) {
    for (const id of summary.sourceDreamIds || [summary.sourceDreamId]) {
      if (id) ids.add(id);
    }
  }
  return [...ids].slice(-500);
}

function importantTerms(value) {
  return [...new Set(String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_]+/g)
    .filter((term) => term.length >= 3)
    .filter((term) => !STOP_WORDS.has(term)))];
}

function scoreEntry(entry, terms) {
  const haystack = `${entry.kind || ""} ${entry.text || ""} ${JSON.stringify(entry.data || {})}`.toLowerCase();
  const weight = sourceWeight(entry);
  if (terms.length === 0) return weight;
  const matches = terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
  return matches > 0 ? matches * 10 + weight : 0;
}

function sourceWeight(entry) {
  if (entry.channel === "state") return 5;
  if (entry.kind === "dream-summary") return 4;
  if (entry.kind === "turn-stop") return 3;
  if (entry.kind === "preference" || entry.kind === "fact" || entry.kind === "open-thread") return 3;
  if (entry.kind === "tool-use") return 2;
  return 1;
}

function deduplicateScoredEntries() {
  const seen = new Set();
  return ({ entry }) => {
    const key = compact(entry.text || entry.value || JSON.stringify(entry.data || entry), 260).toLowerCase();
    if (!key) return true;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  };
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "you", "your", "about", "have", "has", "are", "was", "were",
  "what", "when", "where", "why", "how", "did", "does", "can", "could", "would", "should", "please"
]);
