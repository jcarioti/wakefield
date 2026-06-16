import fs from "node:fs/promises";
import { createHash } from "node:crypto";
import os from "node:os";
import path from "node:path";

const INJECTION_LEDGER_SCHEMA_VERSION = 1;
const INJECTION_LEDGER_MAX_ENTRIES = 500;
const ACTIVE_MATTER_STATUSES = new Set(["active", "waiting"]);
const STOP_WORDS = new Set([
  "the", "and", "for", "that", "this", "with", "from", "you", "your", "about", "have", "has", "are", "was", "were",
  "what", "when", "where", "why", "how", "did", "does", "can", "could", "would", "should", "please", "message"
]);
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

export async function wakefieldMemoryForConnectorMessage({
  target,
  query = "",
  scope = {},
  heading = "Wakefield context for this external message",
  home = wakefieldHome(),
  limitNotes = 3,
  limitMatters = 3,
  maxChars = 1200,
  injection = {}
} = {}) {
  const agent = await findWakefieldAgentForConnectorTarget(target, { home });
  if (!agent) return "";
  const scoped = await scopeWithWakefieldContact(scope, { home });
  const recalled = await recallAgentMemory(agent, {
    query,
    scope: scoped,
    limitNotes,
    limitMatters
  });
  const injectable = await filterInjectableMemory(agent, recalled, {
    query,
    threadId: target?.threadId || agent.threadId || null,
    lane: injection.lane || connectorMemoryLane(scoped),
    force: injection.force,
    record: injection.record !== false,
    now: injection.now
  });
  const formatted = formatContextMemory(injectable, { heading });
  if (!formatted) return "";
  return formatted.length <= maxChars ? formatted : `${formatted.slice(0, maxChars - 3)}...`;
}

export async function findWakefieldAgentForConnectorTarget(target = {}, {
  home = wakefieldHome()
} = {}) {
  const candidateIds = uniqueStrings([
    target.wakefieldAgentId,
    target.agentId,
    target.agent?.id,
    target.id
  ]);

  for (const id of candidateIds) {
    const profile = await readAgentProfile(id, { home });
    if (profile) return profile;
  }

  const current = await readCurrentAgent({ home });
  if (agentMatchesConnectorTarget(current, target)) return current;

  const agents = await listAgentProfiles({ home });
  return agents.find((agent) => agentMatchesConnectorTarget(agent, target)) || null;
}

export function formatContextMemory({ notes = [], matters = [] } = {}, {
  heading = "Wakefield scoped memory"
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

export function wakefieldHome(env = process.env) {
  if (env.WAKEFIELD_HOME) return expandHome(env.WAKEFIELD_HOME);
  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", "Wakefield");
  }
  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), "Wakefield");
  }
  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "wakefield");
}

async function recallAgentMemory(agent, {
  query = "",
  scope = {},
  limitNotes = 3,
  limitMatters = 3
} = {}) {
  const terms = importantTerms(query);
  const recallScope = normalizeScope(scope);
  const [notes, matters] = await Promise.all([
    readJson(agent.memory?.notesPath, { notes: [] }),
    readJson(agent.memory?.mattersPath, { matters: [] })
  ]);

  return {
    notes: rankItems((notes.notes || []).map(normalizeNote), {
      terms,
      scope: recallScope,
      kind: "note"
    }).slice(0, Number(limitNotes || 3)),
    matters: rankItems((matters.matters || []).map(normalizeMatter).filter((matter) => ACTIVE_MATTER_STATUSES.has(matter.status)), {
      terms,
      scope: recallScope,
      kind: "matter"
    }).slice(0, Number(limitMatters || 3))
  };
}

async function filterInjectableMemory(agent, recalled, {
  query = "",
  threadId = null,
  lane = "default",
  force = false,
  record = true,
  now = new Date()
} = {}) {
  if (!record) return recalled;

  const ledgerPath = injectionLedgerPathForAgent(agent);
  if (!ledgerPath) return recalled;

  const compactEpoch = await compactEpochForAgent(agent);
  const explicit = Boolean(force) || isExplicitRecallRequest(query);
  const ledger = await readInjectionLedger(ledgerPath);
  const context = {
    threadId: normalizeLedgerValue(threadId || agent.threadId || agent.id || "default-thread"),
    lane: normalizeLedgerValue(lane || "default"),
    compactEpoch,
    explicit,
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

  if (notes.length > 0 || matters.length > 0) {
    await writeInjectionLedger(ledgerPath, ledger, { now });
  }

  return { notes, matters };
}

function shouldInjectMemoryItem(ledger, item, {
  type,
  threadId,
  lane,
  compactEpoch,
  explicit,
  now
}) {
  const itemId = item.id || "";
  if (!itemId) return false;
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

function isExplicitRecallRequest(query) {
  const text = String(query || "");
  return EXPLICIT_RECALL_PATTERNS.some((pattern) => pattern.test(text));
}

function connectorMemoryLane(scope) {
  const connector = normalizeScope(scope).connectors[0] || "connector";
  return `external-message:${connector}`;
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

function injectionLedgerPathForAgent(agent) {
  if (agent.memory?.injectionLedgerPath) return agent.memory.injectionLedgerPath;
  const anchor = agent.memory?.notesPath
    || agent.memory?.mattersPath
    || agent.memory?.statePath
    || agent.memory?.inboxPath
    || agent.memory?.journalPath
    || agent.memory?.dreamsPath;
  return anchor ? path.join(path.dirname(anchor), "injection-ledger.json") : null;
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
  const next = {
    schemaVersion: INJECTION_LEDGER_SCHEMA_VERSION,
    updatedAt: now.toISOString(),
    entries
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(next, null, 2)}\n`, "utf8");
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

function rankItems(items, { terms, scope, kind }) {
  return items
    .filter((item) => !scopeConflicts(item.scope, scope) || queryNamesScopedSubject(item, terms))
    .map((item) => ({ item, score: scoreItem(item, { terms, scope, kind }) }))
    .filter(({ score }) => score > 0)
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
  for (const key of ["people", "rooms", "cases", "connectors", "senders", "conversations"]) {
    if (itemScope[key].length === 0 || recallScope[key].length === 0) continue;
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

function scoreItem(item, { terms, scope, kind }) {
  const itemTerms = searchableText(item);
  const queryScore = terms.reduce((score, term) => score + (itemTerms.includes(term) ? 3 : 0), 0);
  const scopeScore = scopeOverlapScore(item.scope, scope);
  if (terms.length === 0 && scopeScore === 0) return kind === "matter" && ACTIVE_MATTER_STATUSES.has(item.status) ? 1 : 0;
  if (queryScore === 0 && scopeScore === 0) return 0;
  const statusScore = kind === "matter" ? matterStatusScore(item.status) : 2;
  return queryScore + scopeScore + statusScore;
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

function matterStatusScore(status) {
  if (status === "active") return 4;
  if (status === "waiting") return 3;
  if (status === "resolved") return 1;
  return 0;
}

function searchableText(item) {
  return [
    item.id,
    item.title,
    item.text,
    item.summary,
    item.kind,
    item.nextAction,
    item.notifyWhen,
    item.tags,
    item.sources,
    Object.values(normalizeScope(item.scope)).flat()
  ].flat().filter(Boolean).join(" ").toLowerCase();
}

async function scopeWithWakefieldContact(scope, { home }) {
  const normalized = normalizeScope(scope);
  const contact = await resolveWakefieldContact(scope, { home });
  if (!contact) return normalized;
  return normalizeScope({
    ...normalized,
    people: [...normalized.people, contact.id]
  });
}

async function resolveWakefieldContact(scope, { home }) {
  const connectorCandidates = connectorAliases(scope.connector || scope.connectors);
  const senderCandidates = uniqueStrings([
    scope.sender,
    scope.senders,
    scope.address,
    scope.userId,
    scope.user_id
  ]);
  if (connectorCandidates.length === 0 || senderCandidates.length === 0) return null;
  const document = await readJson(path.join(home, "contacts.json"), null);
  for (const contact of document?.contacts || []) {
    for (const identity of contact.identities || []) {
      if (!connectorCandidates.includes(normalizeScopeValue(identity.connector))) continue;
      const values = uniqueStrings([identity.id, identity.address]);
      if (senderCandidates.some((candidate) => values.some((value) => identityValueMatches(identity.connector, value, candidate)))) {
        return {
          id: normalizeScopeValue(contact.id),
          displayName: contact.displayName || contact.display_name || contact.id
        };
      }
    }
  }
  return null;
}

function connectorAliases(value) {
  const aliases = new Set();
  for (const connector of optionList(value)) {
    const normalized = normalizeScopeValue(connector);
    aliases.add(normalized);
    if (normalized === "imessage-spectrum") aliases.add("imessage");
    if (normalized === "imessage") aliases.add("sms");
  }
  return [...aliases];
}

function identityValueMatches(connector, left, right) {
  return normalizeIdentityValue(connector, left) === normalizeIdentityValue(connector, right);
}

function normalizeIdentityValue(connector, value) {
  const text = String(value || "").trim();
  if (!text) return "";
  const normalizedConnector = normalizeScopeValue(connector);
  if ((normalizedConnector === "imessage" || normalizedConnector === "sms") && !text.includes("@")) {
    const digits = text.replace(/\D/g, "");
    if (digits.length === 10) return `+1${digits}`;
    if (digits.length === 11 && digits.startsWith("1")) return `+${digits}`;
    if (text.startsWith("+") && digits) return `+${digits}`;
  }
  return text.toLowerCase();
}

function normalizeNote(note) {
  const source = note && typeof note === "object" ? note : {};
  const text = String(source.text || source.summary || source.title || "").trim();
  return {
    id: slugify(source.id || source.title || text),
    type: "note",
    title: String(source.title || firstSentence(text)).trim(),
    text,
    scope: normalizeScope(source.scope),
    tags: uniqueStrings(source.tags || source.tag || []),
    sources: uniqueStrings(source.sources || source.source || []),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  };
}

function normalizeMatter(matter) {
  const source = matter && typeof matter === "object" ? matter : {};
  const summary = String(source.summary || source.text || source.title || "").trim();
  return {
    id: slugify(source.id || source.title || summary),
    type: "matter",
    kind: String(source.kind || "matter").trim() || "matter",
    title: String(source.title || firstSentence(summary)).trim(),
    summary,
    status: String(source.status || "active").trim().toLowerCase(),
    statusReason: source.statusReason || null,
    scope: normalizeScope(source.scope),
    nextAction: source.nextAction || null,
    notifyWhen: source.notifyWhen || null,
    tags: uniqueStrings(source.tags || source.tag || []),
    sources: uniqueStrings(source.sources || source.source || []),
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  };
}

function normalizeScope(scope = {}) {
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

function agentMatchesConnectorTarget(agent, target) {
  if (!agent || !target) return false;
  const threadMatches = target.threadId && agent.threadId === target.threadId;
  const cwdMatches = target.cwd && agent.cwd && path.resolve(agent.cwd) === path.resolve(target.cwd);
  if (target.threadId && target.cwd) return Boolean(threadMatches && cwdMatches);
  if (target.threadId) return Boolean(threadMatches);
  if (target.cwd) return Boolean(cwdMatches);
  return false;
}

async function readCurrentAgent({ home }) {
  const config = await readJson(path.join(home, "config.json"), null);
  return config?.currentAgentId ? readAgentProfile(config.currentAgentId, { home }) : null;
}

async function readAgentProfile(agentId, { home }) {
  if (!agentId) return null;
  return readJson(path.join(home, "agents", String(agentId), "profile.json"), null);
}

async function listAgentProfiles({ home }) {
  let entries;
  try {
    entries = await fs.readdir(path.join(home, "agents"), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = await readAgentProfile(entry.name, { home });
    if (profile) profiles.push(profile);
  }
  return profiles;
}

async function readJson(file, fallback) {
  if (!file) return fallback;
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
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
  return uniqueStrings(String(value || "")
    .toLowerCase()
    .split(/[^a-z0-9_+.-]+/g)
    .filter((term) => term.length >= 3)
    .filter((term) => !STOP_WORDS.has(term)));
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
    .replace(/^-+|-+$/g, "");
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
