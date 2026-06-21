import fs from "node:fs/promises";
import path from "node:path";
import { createHash, randomUUID } from "node:crypto";
import { readJson, writeJson } from "./json-store.mjs";

const INJECTION_LEDGER_SCHEMA_VERSION = 1;
const INJECTION_LEDGER_MAX_ENTRIES = 500;
const NOTES_SCHEMA_VERSION = 1;
const MATTERS_SCHEMA_VERSION = 1;
const ACTIVE_MATTER_STATUSES = new Set(["active", "waiting"]);
const ALL_MATTER_STATUSES = new Set(["active", "waiting", "resolved", "archived"]);
const EXPLICIT_RECALL_PATTERNS = [
  /\bremind me\b/i,
  /\brefresh me\b/i,
  /\brecap\b/i,
  /\bwhat do (?:we|you) know\b/i,
  /\bwhat(?:'s| is) going on\b/i,
  /\bwhat(?:'s| is) the status\b/i,
  /\bstatus (?:of|on|for)\b/i,
  /\bwhere (?:are we|does .+ stand)\b/i,
  /\bbring me up to speed\b/i,
  /\bcatch me up\b/i
];

export async function loadNotes(agent) {
  if (!agent) throw new Error("loadNotes needs an agent profile.");
  const file = notesPathForAgent(agent);
  return normalizeNotesDocument(file ? await readJson(file, null) : null);
}

export async function loadMatters(agent) {
  if (!agent) throw new Error("loadMatters needs an agent profile.");
  const file = mattersPathForAgent(agent);
  return normalizeMattersDocument(file ? await readJson(file, null) : null);
}

export async function saveNotes(agent, document) {
  const file = notesPathForAgent(agent);
  if (!file) throw new Error("saveNotes needs an agent memory store.");
  const next = normalizeNotesDocument(document);
  next.updatedAt = new Date().toISOString();
  await writeJson(file, next);
  return next;
}

export async function saveMatters(agent, document) {
  const file = mattersPathForAgent(agent);
  if (!file) throw new Error("saveMatters needs an agent memory store.");
  const next = normalizeMattersDocument(document);
  next.updatedAt = new Date().toISOString();
  await writeJson(file, next);
  return next;
}

export async function upsertNote(agent, note, { now = new Date() } = {}) {
  const current = await loadNotes(agent);
  const normalized = normalizeNote(note, { now });
  const existing = current.notes.find((item) => item.id === normalized.id);
  const nextNote = existing
    ? normalizeNote({
      ...existing,
      ...normalized,
      createdAt: existing.createdAt || normalized.createdAt,
      scope: mergeScopes(existing.scope, normalized.scope),
      tags: uniqueStrings([...existing.tags, ...normalized.tags]),
      sources: uniqueStrings([...existing.sources, ...normalized.sources])
    }, { now })
    : normalized;
  return saveNotes(agent, {
    ...current,
    notes: replaceById(current.notes, nextNote)
  });
}

export async function upsertMatter(agent, matter, { now = new Date() } = {}) {
  const current = await loadMatters(agent);
  const normalized = normalizeMatter(matter, { now });
  const existing = current.matters.find((item) => item.id === normalized.id);
  const nextMatter = existing
    ? normalizeMatter({
      ...existing,
      ...normalized,
      createdAt: existing.createdAt || normalized.createdAt,
      scope: mergeScopes(existing.scope, normalized.scope),
      tags: uniqueStrings([...existing.tags, ...normalized.tags]),
      sources: uniqueStrings([...existing.sources, ...normalized.sources])
    }, { now })
    : normalized;
  return saveMatters(agent, {
    ...current,
    matters: replaceById(current.matters, nextMatter)
  });
}

export async function archiveMatter(agent, id, {
  reason = null,
  now = new Date()
} = {}) {
  const current = await loadMatters(agent);
  const matter = current.matters.find((item) => item.id === id);
  if (!matter) throw new Error(`Matter not found: ${id}`);
  const archived = normalizeMatter({
    ...matter,
    status: "archived",
    statusReason: reason || matter.statusReason || null,
    archivedAt: now.toISOString(),
    updatedAt: now.toISOString()
  }, { now });
  return saveMatters(agent, {
    ...current,
    matters: replaceById(current.matters, archived)
  });
}

export async function forgetMemoryItem(agent, type, id) {
  const normalizedType = normalizeMemoryType(type);
  if (normalizedType === "note") {
    const current = await loadNotes(agent);
    const notes = current.notes.filter((item) => item.id !== id);
    if (notes.length === current.notes.length) throw new Error(`Note not found: ${id}`);
    return saveNotes(agent, { ...current, notes });
  }
  const current = await loadMatters(agent);
  const matters = current.matters.filter((item) => item.id !== id);
  if (matters.length === current.matters.length) throw new Error(`Matter not found: ${id}`);
  return saveMatters(agent, { ...current, matters });
}

export async function recallContext(agent, {
  query = "",
  scope = {},
  limitNotes = 3,
  limitMatters = 3,
  includeArchived = false
} = {}) {
  const terms = importantTerms(query);
  const recallScope = normalizeScope(scope);
  const [notes, matters] = await Promise.all([
    loadNotes(agent),
    loadMatters(agent)
  ]);

  return {
    notes: rankItems(notes.notes, {
      terms,
      scope: recallScope,
      kind: "note"
    }).slice(0, Number(limitNotes || 3)),
    matters: rankItems(matters.matters.filter((matter) => includeArchived || ACTIVE_MATTER_STATUSES.has(matter.status)), {
      terms,
      scope: recallScope,
      kind: "matter"
    }).slice(0, Number(limitMatters || 3))
  };
}

export async function contextMemory(agent, {
  query = "",
  scope = {},
  limitNotes = 3,
  limitMatters = 3,
  maxChars = 1200,
  heading = "Scoped memory",
  injection = null
} = {}) {
  const recalled = await recallContext(agent, {
    query,
    scope,
    limitNotes,
    limitMatters
  });
  const injectable = injection
    ? await filterInjectableMemory(agent, recalled, {
      query,
      threadId: injection.threadId || agent.threadId || null,
      lane: injection.lane || "default",
      force: injection.force,
      record: injection.record !== false,
      now: injection.now
    })
    : recalled;
  const formatted = formatContextMemory(injectable, { heading });
  if (!formatted) return "";
  return formatted.length <= maxChars ? formatted : `${formatted.slice(0, maxChars - 3)}...`;
}

export function formatContextMemory({ notes = [], matters = [] } = {}, {
  heading = "Scoped memory"
} = {}) {
  if (notes.length === 0 && matters.length === 0) return "";
  const lines = [heading];
  if (notes.length > 0) {
    lines.push("Notes:");
    for (const note of notes) lines.push(`- ${formatNoteLine(note)}`);
  }
  if (matters.length > 0) {
    lines.push("Active context:");
    for (const matter of matters) lines.push(`- ${formatMatterLine(matter)}`);
  }
  return lines.join("\n");
}

export function formatNotes(document) {
  const notes = normalizeNotesDocument(document).notes;
  if (notes.length === 0) return "No scoped notes.";
  return notes.map(formatNoteLine).join("\n");
}

export function formatMatters(document, {
  includeArchived = false
} = {}) {
  const matters = normalizeMattersDocument(document).matters
    .filter((matter) => includeArchived || matter.status !== "archived");
  if (matters.length === 0) return "No active matters.";
  return matters.map(formatMatterLine).join("\n");
}

export function noteFromCli(options, trailingText = "") {
  const text = options.text || trailingText;
  if (!text) throw new Error("memory notes add needs --text or trailing text.");
  const id = slugify(options.id || options.title || text);
  return {
    id,
    title: options.title || firstSentence(text),
    text,
    tags: optionList(options.tag || options.tags),
    scope: scopeFromOptions(options),
    sources: optionList(options.source || options.sources)
  };
}

export function matterFromCli(options, trailingText = "") {
  const summary = options.summary || options.text || trailingText;
  if (!summary) throw new Error("memory matters upsert needs --summary, --text, or trailing text.");
  const id = slugify(options.id || options.title || summary);
  return {
    id,
    kind: options.kind || "matter",
    title: options.title || firstSentence(summary),
    summary,
    status: options.status || "active",
    nextAction: options.nextAction || null,
    notifyWhen: options.notifyWhen || null,
    statusReason: options.reason || null,
    tags: optionList(options.tag || options.tags),
    scope: scopeFromOptions(options),
    sources: optionList(options.source || options.sources)
  };
}

export function scopeFromOptions(options = {}) {
  return normalizeScope({
    person: options.person,
    room: options.room,
    channel: options.channel,
    task: options.task || options.duty,
    topic: options.topic,
    case: options.case || options.caseId,
    connector: options.connector,
    sender: options.sender,
    conversation: options.conversation || options.conversationId
  });
}

export function dutyScope(duty) {
  return normalizeScope({
    task: [duty.id, duty.dutyIds, duty.skills].flat().filter(Boolean),
    topic: [duty.label, duty.dutyIds, duty.skills].flat().filter(Boolean),
    channel: "scheduled-wakeup"
  });
}

export function normalizeScope(scope = {}) {
  const source = scope && typeof scope === "object" ? scope : {};
  return {
    people: scopeArray(source.people ?? source.person),
    rooms: scopeArray(source.rooms ?? source.room),
    channels: scopeArray(source.channels ?? source.channel),
    tasks: scopeArray(source.tasks ?? source.task),
    topics: scopeArray(source.topics ?? source.topic),
    cases: scopeArray(source.cases ?? source.case),
    connectors: scopeArray(source.connectors ?? source.connector),
    senders: scopeArray(source.senders ?? source.sender),
    conversations: scopeArray(source.conversations ?? source.conversation)
  };
}

export function notesPathForAgent(agent) {
  if (agent.memory?.notesPath) return agent.memory.notesPath;
  if (!agent.memory?.inboxPath) return null;
  return path.join(path.dirname(agent.memory.inboxPath), "notes.json");
}

export function mattersPathForAgent(agent) {
  if (agent.memory?.mattersPath) return agent.memory.mattersPath;
  if (!agent.memory?.inboxPath) return null;
  return path.join(path.dirname(agent.memory.inboxPath), "matters.json");
}

export function injectionLedgerPathForAgent(agent) {
  if (agent.memory?.injectionLedgerPath) return agent.memory.injectionLedgerPath;
  const anchor = agent.memory?.notesPath
    || agent.memory?.mattersPath
    || agent.memory?.statePath
    || agent.memory?.inboxPath
    || agent.memory?.journalPath
    || agent.memory?.dreamsPath;
  return anchor ? path.join(path.dirname(anchor), "injection-ledger.json") : null;
}

async function filterInjectableMemory(agent, recalled, {
  query = "",
  threadId = null,
  lane = "default",
  force = false,
  record = true,
  now = new Date()
} = {}) {
  const ledgerPath = injectionLedgerPathForAgent(agent);
  if (!ledgerPath) return recalled;

  const compactEpoch = await compactEpochForAgent(agent);
  const forced = Boolean(force);
  const explicit = forced || isExplicitRecallRequest(query);
  const normalizedThreadId = normalizeLedgerValue(threadId || agent.threadId || agent.id || "default-thread");
  const currentEpochTurnIds = await currentEpochTurnIdsForAgent(agent, {
    threadId: normalizedThreadId,
    compactEpoch
  });
  const ledger = await readInjectionLedger(ledgerPath);
  const context = {
    threadId: normalizedThreadId,
    lane: normalizeLedgerValue(lane || "default"),
    compactEpoch,
    currentEpochTurnIds,
    explicit,
    forced,
    now
  };

  const notes = [];
  const matters = [];
  for (const note of recalled.notes || []) {
    if (shouldInjectMemoryItem(ledger, note, { ...context, type: "note" })) notes.push(note);
  }
  for (const matter of recalled.matters || []) {
    if (shouldInjectMemoryItem(ledger, matter, { ...context, type: "matter" })) matters.push(matter);
  }

  if (record && (notes.length > 0 || matters.length > 0)) {
    await writeInjectionLedger(ledgerPath, ledger, { now });
  }

  return { notes, matters };
}

function shouldInjectMemoryItem(ledger, item, {
  type,
  threadId,
  lane,
  compactEpoch,
  currentEpochTurnIds,
  explicit,
  forced,
  now
}) {
  const itemId = item.id || "";
  if (!itemId) return false;
  if (!forced && memorySourceTurnIds(item).some((turnId) => currentEpochTurnIds.has(turnId))) {
    return false;
  }
  const ledgerKey = [threadId, lane, type, itemId].map(normalizeLedgerValue).join("|");
  const contentHash = memoryItemHash(item);
  const previous = ledger.entries[ledgerKey];
  const reason = injectionReason(previous, { compactEpoch, contentHash, explicit });
  if (!reason) return false;

  ledger.entries[ledgerKey] = {
    threadId,
    lane,
    type,
    itemId,
    compactEpoch,
    contentHash,
    lastInjectedAt: now.toISOString(),
    reason
  };
  return true;
}

function injectionReason(previous, { compactEpoch, contentHash, explicit }) {
  if (explicit) return "explicit-recall";
  if (!previous) return "first-in-epoch";
  if (previous.compactEpoch !== compactEpoch) return "after-compaction";
  if (previous.contentHash !== contentHash) return "memory-changed";
  return null;
}

function memorySourceTurnIds(item) {
  const ids = [];
  for (const source of uniqueStrings(item?.sources || item?.source || [])) {
    const match = String(source).match(/^(?:codex-)?turn:([a-z0-9_.-]+)/i);
    if (match?.[1]) ids.push(normalizeLedgerValue(match[1]));
  }
  return ids;
}

async function currentEpochTurnIdsForAgent(agent, {
  threadId,
  compactEpoch
} = {}) {
  const turnIds = new Set();
  const entries = [
    ...await readJsonl(agent.memory?.inboxPath),
    ...await readJsonl(agent.memory?.journalPath),
    ...await readJsonl(agent.memory?.dreamsPath)
  ];
  for (const entry of entries) {
    if (!entryInCompactEpoch(entry, compactEpoch)) continue;
    const turnId = entry?.data?.turnId || entry?.data?.turn_id || null;
    if (!turnId) continue;
    const sessionId = entry?.data?.sessionId || entry?.data?.session_id || null;
    if (!sessionId || normalizeLedgerValue(sessionId) !== threadId) continue;
    turnIds.add(normalizeLedgerValue(turnId));
  }
  return turnIds;
}

function entryInCompactEpoch(entry, compactEpoch) {
  if (!entry) return false;
  if (!compactEpoch || compactEpoch === "initial") return true;
  const at = entry.at || entry.data?.at || null;
  return Boolean(at && String(at) > String(compactEpoch));
}

function isExplicitRecallRequest(query) {
  const text = String(query || "");
  return EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(text));
}

function memoryItemHash(item) {
  const stable = {
    id: item.id || null,
    type: item.type || null,
    title: item.title || null,
    text: item.text || null,
    summary: item.summary || null,
    status: item.status || null,
    statusReason: item.statusReason || null,
    scope: normalizeScope(item.scope),
    nextAction: item.nextAction || null,
    notifyWhen: item.notifyWhen || null,
    tags: item.tags || [],
    sources: item.sources || [],
    updatedAt: item.updatedAt || null
  };
  return createHash("sha256").update(JSON.stringify(stable)).digest("hex");
}

async function compactEpochForAgent(agent) {
  const candidates = [];
  if (agent.memory?.statePath) {
    const state = await readJson(agent.memory.statePath, null);
    for (const turn of state?.recentTurns || []) {
      if (String(turn.summary || "").toLowerCase().includes("compaction")) {
        candidates.push(turn.at || turn.updatedAt || null);
      }
    }
  }
  if (agent.memory?.dreamsPath) {
    for (const entry of await readJsonl(agent.memory.dreamsPath)) {
      if (entry?.kind === "pre-compact" || entry?.kind === "post-compact") {
        candidates.push(entry.at || entry.data?.at || null);
      }
    }
  }
  const latest = candidates
    .filter(Boolean)
    .sort()
    .at(-1);
  return latest || "initial";
}

async function readInjectionLedger(file) {
  const source = await readJson(file, null);
  return {
    schemaVersion: INJECTION_LEDGER_SCHEMA_VERSION,
    updatedAt: source?.updatedAt || null,
    entries: source?.entries && typeof source.entries === "object" ? source.entries : {}
  };
}

async function writeInjectionLedger(file, ledger, { now = new Date() } = {}) {
  const entries = Object.fromEntries(Object.entries(ledger.entries || {})
    .sort((left, right) => String(right[1].lastInjectedAt || "").localeCompare(String(left[1].lastInjectedAt || "")))
    .slice(0, INJECTION_LEDGER_MAX_ENTRIES));
  await writeJson(file, {
    schemaVersion: INJECTION_LEDGER_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    entries
  });
}

async function readJsonl(file) {
  if (!file) return [];
  try {
    const text = await fs.readFile(file, "utf8");
    return text.split(/\r?\n/g)
      .filter(Boolean)
      .map((line) => JSON.parse(line));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

function normalizeNotesDocument(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: NOTES_SCHEMA_VERSION,
    updatedAt: source.updatedAt || null,
    notes: (source.notes || []).map((note) => normalizeNote(note))
  };
}

function normalizeMattersDocument(value) {
  const source = value && typeof value === "object" ? value : {};
  return {
    schemaVersion: MATTERS_SCHEMA_VERSION,
    updatedAt: source.updatedAt || null,
    matters: (source.matters || []).map((matter) => normalizeMatter(matter))
  };
}

function normalizeNote(note, { now = new Date() } = {}) {
  const source = note && typeof note === "object" ? note : {};
  const text = String(source.text || source.summary || source.title || "").trim();
  const id = slugify(source.id || source.title || text || randomUUID());
  const timestamp = now.toISOString();
  return {
    id,
    type: "note",
    title: String(source.title || firstSentence(text) || id).trim(),
    text,
    scope: normalizeScope(source.scope),
    tags: uniqueStrings(source.tags || source.tag || []),
    sources: uniqueStrings(source.sources || source.source || []),
    createdAt: source.createdAt || timestamp,
    updatedAt: source.updatedAt || timestamp
  };
}

function normalizeMatter(matter, { now = new Date() } = {}) {
  const source = matter && typeof matter === "object" ? matter : {};
  const summary = String(source.summary || source.text || source.title || "").trim();
  const id = slugify(source.id || source.title || summary || randomUUID());
  const status = normalizeStatus(source.status || "active");
  const timestamp = now.toISOString();
  return {
    id,
    type: "matter",
    kind: String(source.kind || "matter").trim() || "matter",
    title: String(source.title || firstSentence(summary) || id).trim(),
    summary,
    status,
    statusReason: source.statusReason || null,
    scope: normalizeScope(source.scope),
    nextAction: source.nextAction || null,
    notifyWhen: source.notifyWhen || null,
    tags: uniqueStrings(source.tags || source.tag || []),
    sources: uniqueStrings(source.sources || source.source || []),
    createdAt: source.createdAt || timestamp,
    updatedAt: source.updatedAt || timestamp,
    resolvedAt: source.resolvedAt || (status === "resolved" ? timestamp : null),
    archivedAt: source.archivedAt || (status === "archived" ? timestamp : null)
  };
}

function rankItems(items, { terms, scope, kind }) {
  const ranked = items
    .filter((item) => !scopeConflicts(item.scope, scope) || queryNamesScopedSubject(item, terms))
    .map((item) => ({ item, ...scoreItem(item, { terms, scope, kind }) }))
    .filter(({ score }) => score > 0)
  const hasQueryMatch = terms.length > 0 && ranked.some(({ queryScore }) => queryScore > 0);
  return ranked
    .filter(({ queryScore, strongScopeScore }) => !hasQueryMatch || queryScore > 0 || strongScopeScore > 0)
    .sort((left, right) => right.score - left.score || String(right.item.updatedAt || "").localeCompare(String(left.item.updatedAt || "")))
    .map(({ item }) => item);
}

function queryNamesScopedSubject(item, terms) {
  if (terms.length === 0) return false;
  const scope = normalizeScope(item.scope);
  const scopedSubjects = [
    ...scope.people,
    ...scope.cases
  ].filter(Boolean).join(" ").toLowerCase();
  return terms.some((term) => term.length >= 4 && scopedSubjects.includes(term));
}

function scopeConflicts(left, right) {
  const itemScope = normalizeScope(left);
  const recallScope = normalizeScope(right);
  const peopleOverlap = scopeValuesOverlap(itemScope.people, recallScope.people);
  for (const key of ["people", "rooms", "cases", "connectors", "senders", "conversations"]) {
    if (itemScope[key].length === 0 || recallScope[key].length === 0) continue;
    if (key === "senders" && peopleOverlap) continue;
    const available = new Set(itemScope[key]);
    if (!recallScope[key].some((value) => available.has(value))) return true;
  }
  if (itemScope.tasks.length > 0 && recallScope.tasks.length > 0) {
    const tasks = new Set(itemScope.tasks);
    if (!recallScope.tasks.some((value) => tasks.has(value))) return true;
  }
  if (recallScope.tasks.length > 0 && itemScope.tasks.length === 0) {
    return itemScope.people.length > 0
      || itemScope.rooms.length > 0
      || itemScope.senders.length > 0
      || itemScope.conversations.length > 0;
  }
  return false;
}

function scopeValuesOverlap(left, right) {
  if (left.length === 0 || right.length === 0) return false;
  const available = new Set(left);
  return right.some((value) => available.has(value));
}

function scoreItem(item, { terms, scope, kind }) {
  const evidence = searchEvidence(item, terms);
  const queryScore = evidence.score;
  const scopeScore = scopeOverlapScore(item.scope, scope);
  const strongScopeScore = strongScopeOverlapScore(item.scope, scope);
  if (isBroadPolicyMemory(item) && queryScore > 0 && !hasStrongPolicyEvidence(item, evidence, scope)) {
    return { score: 0, queryScore, scopeScore, strongScopeScore };
  }
  if (terms.length === 0 && scopeScore === 0) {
    return {
      score: kind === "matter" && ACTIVE_MATTER_STATUSES.has(item.status) ? 1 : 0,
      queryScore,
      scopeScore,
      strongScopeScore
    };
  }
  if (queryScore === 0 && scopeScore === 0) return { score: 0, queryScore, scopeScore, strongScopeScore };
  const statusScore = kind === "matter" ? matterStatusScore(item.status) : 2;
  return {
    score: queryScore + scopeScore + statusScore,
    queryScore,
    scopeScore,
    strongScopeScore
  };
}

function searchEvidence(item, terms) {
  const idTokens = searchTokenSet([item.id, item.kind]);
  const titleTokens = searchTokenSet(item.title);
  const bodyTokens = searchTokenSet([item.text, item.summary, item.nextAction, item.notifyWhen]);
  const tagTokens = searchTokenSet(item.tags);
  const scope = normalizeScope(item.scope);
  const scopeTokens = searchTokenSet(Object.values(scope).flat());
  const policyScopeTokens = searchTokenSet([scope.tasks, scope.topics, scope.cases].flat());
  let score = 0;
  const hits = new Set();
  let contentHitCount = 0;
  let scopeHitCount = 0;
  let policyScopeHitCount = 0;

  for (const term of terms) {
    let matched = false;
    if (idTokens.has(term) || titleTokens.has(term)) {
      score += 5;
      contentHitCount += 1;
      matched = true;
    }
    if (bodyTokens.has(term)) {
      score += 3;
      contentHitCount += 1;
      matched = true;
    }
    if (tagTokens.has(term)) {
      score += 2;
      contentHitCount += 1;
      matched = true;
    }
    if (scopeTokens.has(term)) {
      score += 4;
      scopeHitCount += 1;
      matched = true;
    }
    if (policyScopeTokens.has(term)) {
      policyScopeHitCount += 1;
    }
    if (matched) hits.add(term);
  }

  return {
    score,
    hitCount: hits.size,
    contentHitCount,
    scopeHitCount,
    policyScopeHitCount
  };
}

function isBroadPolicyMemory(item) {
  const scope = normalizeScope(item.scope);
  return scope.people.length === 0
    && scope.rooms.length === 0
    && scope.channels.length === 0
    && scope.cases.length === 0
    && scope.connectors.length === 0
    && scope.senders.length === 0
    && scope.conversations.length === 0;
}

function hasStrongPolicyEvidence(item, evidence, recallScope) {
  return evidence.policyScopeHitCount > 0
    || taskTopicCaseOverlapScore(item.scope, recallScope) > 0
    || evidence.contentHitCount >= 2;
}

function scopeOverlapScore(left, right) {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  let score = 0;
  for (const key of Object.keys(normalizedRight)) {
    const wanted = normalizedRight[key];
    if (wanted.length === 0) continue;
    const available = new Set(normalizedLeft[key]);
    for (const value of wanted) {
      if (available.has(value)) score += key === "people" || key === "cases" ? 8 : 5;
    }
  }
  return score;
}

function taskTopicCaseOverlapScore(left, right) {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  let score = 0;
  for (const key of ["tasks", "topics", "cases"]) {
    const wanted = normalizedRight[key];
    if (wanted.length === 0) continue;
    const available = new Set(normalizedLeft[key]);
    for (const value of wanted) {
      if (available.has(value)) score += 8;
    }
  }
  return score;
}

function strongScopeOverlapScore(left, right) {
  const normalizedLeft = normalizeScope(left);
  const normalizedRight = normalizeScope(right);
  let score = 0;
  for (const key of ["rooms", "tasks", "cases", "conversations"]) {
    const wanted = normalizedRight[key];
    if (wanted.length === 0) continue;
    const available = new Set(normalizedLeft[key]);
    for (const value of wanted) {
      if (available.has(value)) score += 8;
    }
  }
  return score;
}

function matterStatusScore(status) {
  if (status === "active") return 4;
  if (status === "waiting") return 3;
  if (status === "resolved") return 1;
  return 0;
}

function formatNoteLine(note) {
  const scope = compactScope(note.scope);
  return `${note.id}: ${note.title}${note.text && note.text !== note.title ? ` - ${note.text}` : ""}${scope ? ` (${scope})` : ""}`;
}

function formatMatterLine(matter) {
  const pieces = [
    `${matter.id}: [${matter.status}] ${matter.title}`,
    matter.summary && matter.summary !== matter.title ? matter.summary : null,
    matter.nextAction ? `Next: ${matter.nextAction}` : null,
    matter.notifyWhen ? `Notify: ${matter.notifyWhen}` : null
  ].filter(Boolean);
  const scope = compactScope(matter.scope);
  return `${pieces.join(" - ")}${scope ? ` (${scope})` : ""}`;
}

function compactScope(scope) {
  const normalized = normalizeScope(scope);
  const chunks = [];
  if (normalized.people.length > 0) chunks.push(`people=${normalized.people.join(",")}`);
  if (normalized.tasks.length > 0) chunks.push(`tasks=${normalized.tasks.join(",")}`);
  if (normalized.cases.length > 0) chunks.push(`cases=${normalized.cases.join(",")}`);
  if (normalized.topics.length > 0) chunks.push(`topics=${normalized.topics.join(",")}`);
  return chunks.join("; ");
}

function mergeScopes(left, right) {
  const a = normalizeScope(left);
  const b = normalizeScope(right);
  const merged = {};
  for (const key of Object.keys(a)) merged[key] = uniqueStrings([...a[key], ...b[key]]);
  return merged;
}

function replaceById(items, nextItem) {
  const filtered = items.filter((item) => item.id !== nextItem.id);
  return [...filtered, nextItem].sort((left, right) => left.id.localeCompare(right.id));
}

function normalizeStatus(value) {
  const status = String(value || "active").trim().toLowerCase();
  if (ALL_MATTER_STATUSES.has(status)) return status;
  throw new Error(`Matter status must be one of: ${[...ALL_MATTER_STATUSES].join(", ")}`);
}

function normalizeMemoryType(value) {
  const type = String(value || "").trim().toLowerCase();
  if (["note", "notes"].includes(type)) return "note";
  if (["matter", "matters", "active-context", "active_context"].includes(type)) return "matter";
  throw new Error("Memory type must be note or matter.");
}

function scopeArray(value) {
  return uniqueStrings(optionList(value).map(normalizeScopeValue).filter(Boolean));
}

function normalizeScopeValue(value) {
  return String(value || "").trim().toLowerCase();
}

function normalizeLedgerValue(value) {
  return String(value || "").trim().toLowerCase() || "default";
}

function optionList(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(optionList);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(optionList(values))].filter(Boolean);
}

function importantTerms(value) {
  return uniqueStrings(searchTokens(value)
    .filter((term) => term.length >= 3)
    .filter((term) => !STOP_WORDS.has(term)));
}

function searchTokenSet(value) {
  return new Set(searchTokens(value));
}

function searchTokens(value) {
  return uniqueStrings(optionList(value).join(" ")
    .toLowerCase()
    .split(/[^a-z0-9]+/g)
    .map(normalizeSearchToken)
    .filter(Boolean));
}

function normalizeSearchToken(value) {
  const token = String(value || "").trim();
  if (!token) return "";
  if (token.length > 4 && token.endsWith("ies")) return `${token.slice(0, -3)}y`;
  if (token.length > 4 && token.endsWith("es") && !token.endsWith("ses")) return token.slice(0, -2);
  if (token.length > 4 && token.endsWith("s") && !token.endsWith("ss")) return token.slice(0, -1);
  return token;
}

function firstSentence(value) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (!text) return "";
  const sentence = text.match(/^.{1,80}?(?:[.!?](?:\s|$)|$)/)?.[0] || text.slice(0, 80);
  return sentence.trim();
}

function slugify(value) {
  return String(value || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-")
    .replace(/^-+|-+$/g, "") || randomUUID();
}

const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "you", "your", "about", "have", "has", "are", "was", "were",
  "what", "when", "where", "why", "how", "did", "does", "can", "could", "would", "should", "please", "message",
  "all", "any", "tell", "need", "needs", "needed", "necessary", "include", "including", "item", "items", "sub",
  "build", "make", "give", "last", "request", "rick", "hey", "hello", "hi", "thanks", "thank"
]);
