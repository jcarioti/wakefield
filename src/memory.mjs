import { randomUUID } from "node:crypto";
import { appendJsonl, readJson, readJsonl, writeJson } from "./json-store.mjs";

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
  now = new Date()
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
  const summaries = pending.map((entry) => summarizeDream(entry, journal, now));

  if (!dryRun && summaries.length > 0) {
    for (const summary of summaries) {
      await recordMemory(agent, {
        channel: "dreams",
        kind: "dream-summary",
        text: summary.summary,
        source: "wakefield-dreamer",
        data: {
          sourceDreamId: summary.sourceDreamId,
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
        processedIds: mergeProcessedIds(processedIds, summaries),
        lastRunAt: now.toISOString()
      }
    });
  }

  return {
    processed: summaries.length,
    pending: Math.max(0, dreams.filter((entry) => isPendingDream(entry, processedIds)).length - summaries.length),
    dryRun: Boolean(dryRun),
    summaries
  };
}

export async function recall(agent, query, { limit = 5 } = {}) {
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
    .filter((item) => item.score > 0 || terms.length === 0)
    .sort((left, right) => right.score - left.score || String(right.entry.at || "").localeCompare(String(left.entry.at || "")))
    .slice(0, limit)
    .map((item) => item.entry);
}

export async function memoryContext(agent, query, { limit = 5, maxChars = 1600 } = {}) {
  const entries = await recall(agent, query, { limit });
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
    return result.pending > 0
      ? `No dreams processed in this batch. ${result.pending} still pending.`
      : "No pending dreams.";
  }

  const lines = [`Processed ${result.processed} dream${result.processed === 1 ? "" : "s"}.`];
  for (const summary of result.summaries) {
    lines.push(`- ${compact(summary.summary, 220)}`);
  }
  if (result.pending > 0) lines.push(`${result.pending} still pending.`);
  if (result.dryRun) lines.push("Dry run; no memory was written.");
  return lines.join("\n");
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

function summarizeDream(entry, journal, now) {
  const sessionId = entry.data?.sessionId || entry.data?.session_id || null;
  const turnId = entry.data?.turnId || entry.data?.turn_id || null;
  const related = journal.filter((item) => sameTurn(item, { sessionId, turnId }));
  const stop = related.findLast?.((item) => item.kind === "turn-stop")
    || [...related].reverse().find((item) => item.kind === "turn-stop")
    || null;
  const tools = related.filter((item) => item.kind === "tool-use");
  const changes = tools.map((item) => compact(item.text, 180));
  const subject = turnId ? `Turn ${turnId}` : entry.kind === "dream-queued" ? "A Codex turn" : "A compaction edge";
  const base = stop?.text
    ? compact(stop.text, 360)
    : compact(entry.text, 360);
  const toolText = changes.length > 0
    ? ` Tool activity: ${changes.slice(-4).join("; ")}.`
    : "";
  const summary = `${subject}: ${base}${toolText}`;

  return {
    sourceDreamId: entry.id,
    at: now.toISOString(),
    sessionId,
    turnId,
    summary,
    toolCount: tools.length,
    changes
  };
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
    const key = item.sourceDreamId || `${item.sessionId || ""}:${item.turnId || ""}:${item.summary || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  }).slice(0, 50);
}

function mergeProcessedIds(processedIds, summaries) {
  const ids = new Set(processedIds);
  for (const summary of summaries) ids.add(summary.sourceDreamId);
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
  if (terms.length === 0) return entry.channel === "state" ? 2 : 1;
  return terms.reduce((score, term) => score + (haystack.includes(term) ? 1 : 0), 0);
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "you", "your", "about", "have", "has", "are", "was", "were"
]);
