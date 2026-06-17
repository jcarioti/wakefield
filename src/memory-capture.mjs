import { archiveMatter, loadMatters, loadNotes, upsertMatter, upsertNote } from "./context-memory.mjs";
import { codexDreamerConfig, createCodexStructuredMemoryResponse } from "./codex-dreamer.mjs";
import { readJson, readJsonl, writeJson } from "./json-store.mjs";

const CAPTURE_PROCESSED_MAX = 1000;
const CAPTURE_CONFIDENCE = new Set(["medium", "high"]);

export async function processMemoryCaptures(agent, {
  summaries = null,
  limit = 5,
  dryRun = false,
  now = new Date(),
  captureProvider = null,
  env = process.env,
  execFileImpl = null
} = {}) {
  if (!agent) throw new Error("processMemoryCaptures needs an agent profile.");
  const config = codexDreamerConfig(env);
  const provider = captureProvider || (config.enabled
    ? (payload) => codexCaptureProvider(payload, { config, execFileImpl })
    : null);
  const model = captureProvider ? "injected-test-provider" : config.model || "codex-default";

  if (!provider) {
    return {
      enabled: false,
      provider: config.provider,
      model,
      skippedReason: `Wakefield memory provider is disabled or unsupported: ${config.provider}.`,
      reviewed: 0,
      applied: [],
      captures: []
    };
  }

  const state = await loadCaptureState(agent);
  const processed = new Set(state.processedIds);
  const candidates = (summaries || await unprocessedDreamSummaries(agent, processed))
    .filter((summary) => !processed.has(summaryCaptureKey(summary)))
    .slice(0, Number(limit || 5));
  const captures = [];
  const applied = [];
  const nextProcessed = new Set(processed);

  for (const summary of candidates) {
    const key = summaryCaptureKey(summary);
    try {
      const capture = await captureTurnMemory(agent, summary, {
        provider,
        dryRun,
        now
      });
      captures.push({
        key,
        ...capture
      });
      applied.push(...capture.applied);
      if (!dryRun) nextProcessed.add(key);
    } catch (error) {
      captures.push({
        key,
        error: error?.message || String(error),
        deltas: [],
        applied: []
      });
    }
  }

  if (!dryRun && nextProcessed.size !== processed.size) {
    await saveCaptureState(agent, {
      processedIds: [...nextProcessed].slice(-CAPTURE_PROCESSED_MAX),
      lastRunAt: now.toISOString()
    });
  }

  return {
    enabled: true,
    provider: captureProvider ? "injected" : config.provider,
    model,
    skippedReason: null,
    reviewed: captures.length,
    applied,
    captures
  };
}

export async function captureTurnMemory(agent, summary, {
  provider,
  dryRun = false,
  now = new Date()
} = {}) {
  if (!provider) throw new Error("captureTurnMemory needs a capture provider.");
  const payload = await capturePayload(agent, summary);
  const response = normalizeCaptureResponse(await provider(payload));
  const applied = [];

  for (const delta of response.deltas) {
    if (!CAPTURE_CONFIDENCE.has(delta.confidence)) continue;
    const result = await applyMemoryDelta(agent, delta, {
      summary,
      dryRun,
      now
    });
    if (result) applied.push(result);
  }

  return {
    summaryKey: summaryCaptureKey(summary),
    deltas: response.deltas,
    applied
  };
}

export function memoryCaptureSchema() {
  return {
    type: "object",
    additionalProperties: false,
    required: ["deltas"],
    properties: {
      deltas: {
        type: "array",
        maxItems: 5,
        items: {
          type: "object",
          additionalProperties: false,
          required: [
            "action",
            "id",
            "title",
            "text",
            "summary",
            "status",
            "statusReason",
            "scope",
            "nextAction",
            "notifyWhen",
            "tags",
            "sources",
            "confidence",
            "rationale"
          ],
          properties: {
            action: {
              type: "string",
              enum: [
                "noop",
                "create_note",
                "update_note",
                "create_active_context",
                "update_active_context",
                "resolve_active_context",
                "archive_active_context"
              ]
            },
            id: { type: ["string", "null"] },
            title: { type: ["string", "null"] },
            text: { type: ["string", "null"] },
            summary: { type: ["string", "null"] },
            status: {
              type: ["string", "null"],
              enum: ["active", "waiting", "resolved", "archived", null]
            },
            statusReason: { type: ["string", "null"] },
            scope: {
              type: "object",
              additionalProperties: false,
              required: ["people", "rooms", "channels", "tasks", "topics", "cases", "connectors", "senders", "conversations"],
              properties: {
                people: { type: "array", items: { type: "string" } },
                rooms: { type: "array", items: { type: "string" } },
                channels: { type: "array", items: { type: "string" } },
                tasks: { type: "array", items: { type: "string" } },
                topics: { type: "array", items: { type: "string" } },
                cases: { type: "array", items: { type: "string" } },
                connectors: { type: "array", items: { type: "string" } },
                senders: { type: "array", items: { type: "string" } },
                conversations: { type: "array", items: { type: "string" } }
              }
            },
            nextAction: { type: ["string", "null"] },
            notifyWhen: { type: ["string", "null"] },
            tags: { type: "array", items: { type: "string" } },
            sources: { type: "array", items: { type: "string" } },
            confidence: {
              type: "string",
              enum: ["low", "medium", "high"]
            },
            rationale: { type: ["string", "null"] }
          }
        }
      }
    }
  };
}

export function formatMemoryCaptureResult(result) {
  if (!result.enabled) return `Memory capture skipped: ${result.skippedReason}`;
  if (result.reviewed === 0) return "No uncaptured dream summaries.";
  const lines = [`Reviewed ${result.reviewed} dream summar${result.reviewed === 1 ? "y" : "ies"}.`];
  if (result.applied.length === 0) lines.push("No memory deltas applied.");
  for (const item of result.applied) {
    lines.push(`- ${item.action} ${item.type} ${item.id}`);
  }
  return lines.join("\n");
}

async function codexCaptureProvider(payload, { config, execFileImpl }) {
  return createCodexStructuredMemoryResponse({
    prompt: [
      MEMORY_CAPTURE_SYSTEM_PROMPT,
      "",
      "Review this Wakefield turn summary and existing memory. Return only JSON matching the schema.",
      "",
      JSON.stringify(payload, null, 2)
    ].join("\n"),
    schema: memoryCaptureSchema(),
    config,
    ...(execFileImpl ? { execFileImpl } : {})
  });
}

async function capturePayload(agent, summary) {
  const [notes, matters] = await Promise.all([
    loadNotes(agent),
    loadMatters(agent)
  ]);
  return {
    agent: {
      id: agent.id,
      name: agent.name
    },
    turn: {
      sessionId: summary.sessionId || null,
      turnId: summary.turnId || null,
      at: summary.at || null,
      summary: compactText(summary.summary, 1600),
      toolCount: summary.toolCount || 0,
      changes: (summary.changes || []).map((item) => compactText(item, 240)).slice(-8)
    },
    existingMemory: {
      notes: notes.notes.slice(-20).map(compactNote),
      activeContext: matters.matters
        .filter((matter) => matter.status !== "archived")
        .slice(-30)
        .map(compactMatter)
    },
    instructions: [
      "Return only deltas that future turns would benefit from outside the visible chat.",
      "Use notes for stable durable facts or preferences.",
      "Use active context for temporary situations, incidents, tasks, cases, and cross-channel continuity.",
      "Prefer active context for unresolved outages, connector failures, support cases, RMAs, and follow-up work.",
      "Use noop for ordinary chatter, completed one-off actions, or facts already captured accurately.",
      "Keep every title and summary short."
    ]
  };
}

function normalizeCaptureResponse(response) {
  const deltas = Array.isArray(response?.deltas) ? response.deltas : [];
  return {
    deltas: deltas.map(normalizeDelta).filter(Boolean)
  };
}

function normalizeDelta(delta) {
  if (!delta || typeof delta !== "object") return null;
  const action = String(delta.action || "noop").trim();
  if (action === "noop") {
    return {
      action,
      id: null,
      title: null,
      text: null,
      summary: null,
      status: null,
      statusReason: null,
      scope: emptyScope(),
      nextAction: null,
      notifyWhen: null,
      tags: [],
      sources: [],
      confidence: normalizeConfidence(delta.confidence),
      rationale: delta.rationale || null
    };
  }
  const text = stringOrNull(delta.text);
  const summary = stringOrNull(delta.summary);
  const title = stringOrNull(delta.title) || firstSentence(summary || text || action);
  return {
    action,
    id: slugify(delta.id || title || summary || text || action),
    title,
    text,
    summary,
    status: normalizeDeltaStatus(delta.status, action),
    statusReason: stringOrNull(delta.statusReason),
    scope: normalizeScopeDocument(delta.scope),
    nextAction: stringOrNull(delta.nextAction),
    notifyWhen: stringOrNull(delta.notifyWhen),
    tags: uniqueStrings(delta.tags || []),
    sources: uniqueStrings(delta.sources || []),
    confidence: normalizeConfidence(delta.confidence),
    rationale: stringOrNull(delta.rationale)
  };
}

async function applyMemoryDelta(agent, delta, {
  summary,
  dryRun,
  now
}) {
  if (delta.action === "noop") return null;
  const source = `codex-turn:${summary.turnId || summary.sourceDreamId || "unknown"}`;
  const sources = uniqueStrings([...delta.sources, source, "wakefield-capture"]);

  if (delta.action === "create_note" || delta.action === "update_note") {
    const note = {
      id: delta.id,
      title: delta.title,
      text: delta.text || delta.summary || delta.title,
      scope: delta.scope,
      tags: delta.tags,
      sources
    };
    if (!dryRun) await upsertNote(agent, note, { now });
    return {
      action: delta.action,
      type: "note",
      id: note.id
    };
  }

  const matter = {
    id: delta.id,
    title: delta.title,
    summary: delta.summary || delta.text || delta.title,
    status: delta.status || "active",
    statusReason: delta.statusReason,
    nextAction: delta.nextAction,
    notifyWhen: delta.notifyWhen,
    scope: delta.scope,
    tags: delta.tags,
    sources
  };

  if (!dryRun) {
    if (delta.action === "archive_active_context") {
      try {
        await archiveMatter(agent, matter.id, {
          reason: matter.statusReason || "Archived by Wakefield memory capture.",
          now
        });
      } catch {
        await upsertMatter(agent, { ...matter, status: "archived" }, { now });
      }
    } else {
      await upsertMatter(agent, matter, { now });
    }
  }

  return {
    action: delta.action,
    type: "matter",
    id: matter.id
  };
}

async function unprocessedDreamSummaries(agent, processed) {
  const dreams = await readJsonl(agent.memory.dreamsPath);
  return dreams
    .filter((entry) => entry.kind === "dream-summary")
    .map(summaryFromDreamEntry)
    .filter((summary) => !processed.has(summaryCaptureKey(summary)));
}

function summaryFromDreamEntry(entry) {
  return {
    sourceDreamId: entry.data?.sourceDreamId || entry.id,
    sourceDreamIds: entry.data?.sourceDreamIds || [entry.data?.sourceDreamId || entry.id].filter(Boolean),
    at: entry.at || null,
    sessionId: entry.data?.sessionId || null,
    turnId: entry.data?.turnId || null,
    summary: entry.text || "",
    toolCount: entry.data?.toolCount || 0,
    changes: entry.data?.changes || []
  };
}

function summaryCaptureKey(summary) {
  const ids = uniqueStrings(summary.sourceDreamIds || [summary.sourceDreamId]);
  if (ids.length > 0) return ids.join(",");
  return [summary.sessionId, summary.turnId, summary.summary].filter(Boolean).join(":");
}

async function loadCaptureState(agent) {
  const state = await readJson(agent.memory.statePath, {});
  return {
    processedIds: Array.isArray(state.memoryCapture?.processedIds) ? state.memoryCapture.processedIds : [],
    lastRunAt: state.memoryCapture?.lastRunAt || null
  };
}

async function saveCaptureState(agent, patch) {
  const state = await readJson(agent.memory.statePath, {});
  await writeJson(agent.memory.statePath, {
    ...state,
    memoryCapture: {
      ...(state.memoryCapture || {}),
      ...patch
    },
    updatedAt: new Date().toISOString()
  });
}

function compactNote(note) {
  return {
    id: note.id,
    title: compactText(note.title, 120),
    text: compactText(note.text, 260),
    scope: note.scope,
    tags: note.tags,
    updatedAt: note.updatedAt
  };
}

function compactMatter(matter) {
  return {
    id: matter.id,
    title: compactText(matter.title, 120),
    summary: compactText(matter.summary, 300),
    status: matter.status,
    scope: matter.scope,
    nextAction: compactText(matter.nextAction, 180),
    tags: matter.tags,
    updatedAt: matter.updatedAt
  };
}

function normalizeDeltaStatus(status, action) {
  const source = String(status || "").trim().toLowerCase();
  if (["active", "waiting", "resolved", "archived"].includes(source)) return source;
  if (action === "resolve_active_context") return "resolved";
  if (action === "archive_active_context") return "archived";
  return "active";
}

function normalizeScopeDocument(scope) {
  const source = scope && typeof scope === "object" ? scope : {};
  return {
    people: uniqueStrings(source.people),
    rooms: uniqueStrings(source.rooms),
    channels: uniqueStrings(source.channels),
    tasks: uniqueStrings(source.tasks),
    topics: uniqueStrings(source.topics),
    cases: uniqueStrings(source.cases),
    connectors: uniqueStrings(source.connectors),
    senders: uniqueStrings(source.senders),
    conversations: uniqueStrings(source.conversations)
  };
}

function emptyScope() {
  return normalizeScopeDocument({});
}

function normalizeConfidence(value) {
  const confidence = String(value || "medium").trim().toLowerCase();
  if (["low", "medium", "high"].includes(confidence)) return confidence;
  return "medium";
}

function stringOrNull(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text || null;
}

function firstSentence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  return (text.match(/^.{1,80}?(?:[.!?](?:\s|$)|$)/)?.[0] || text.slice(0, 80)).trim();
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "")
    || "memory-delta";
}

function uniqueStrings(values) {
  if (values == null || values === false) return [];
  const source = Array.isArray(values) ? values.flat() : String(values).split(",");
  return [...new Set(source.map((value) => String(value || "").trim().toLowerCase()).filter(Boolean))];
}

function compactText(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  return text.length <= max ? text : `${text.slice(0, max - 3)}...`;
}

const MEMORY_CAPTURE_SYSTEM_PROMPT = `You are Wakefield's memory capture reviewer.

Wakefield wraps a persistent Codex thread. Codex owns the visible transcript and compaction. Your job is only to decide whether the completed turn produced small, useful memory deltas outside the current visible turn.

Rules:
- Prefer noop unless future turns would be materially helped by a memory item.
- Do not store ordinary chat, politeness, completed one-off work, or "the assistant replied" facts.
- Use notes only for stable durable facts, preferences, or standing operating rules.
- Use active context for temporary unresolved situations, incidents, support cases, cross-channel continuity, and work that should disappear once resolved.
- Passive mentions can matter when they reveal an unresolved operational state, such as a connector outage.
- Keep summaries short and scoped. Include channels, systems, people, cases, or topics when known.
- If an existing memory already captures the state, update it instead of creating a duplicate.
- Use low confidence for guesses that should not be applied.`;
