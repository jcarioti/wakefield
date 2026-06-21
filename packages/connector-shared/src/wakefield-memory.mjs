import fs from "node:fs/promises";
import { randomUUID } from "node:crypto";
import os from "node:os";
import path from "node:path";

export async function recordWakefieldConnectorTurn({
  target,
  connector,
  messageId = null,
  prompt = "",
  routeResult = null,
  completionStatus = null,
  scope = {},
  home = wakefieldHome(),
  now = new Date()
} = {}) {
  const agent = await findWakefieldAgentForConnectorTarget(target, { home });
  if (!agent) return { ok: false, reason: "agent-not-found" };

  const sessionId = target?.threadId || agent.threadId || null;
  const turnId = routeResult?.turnId || completionStatus?.turnId || null;
  if (!turnId) return { ok: false, reason: "missing-turn-id" };

  const source = `connector:${connector || "unknown"}`;
  const data = {
    sessionId,
    turnId,
    connector: connector || null,
    messageId,
    codexRoute: routeResult?.action || null,
    completionReason: completionStatus?.reason || null,
    completed: Boolean(completionStatus?.completed),
    scope: normalizeScope(scope)
  };
  const written = [];

  if (prompt) {
    await appendMemoryEntry(agent, "inbox", {
      at: now,
      source,
      kind: "user-prompt",
      text: compactText(prompt, 2400),
      data
    });
    written.push("user-prompt");
  }

  if (completionStatus?.lastAgentMessage) {
    await appendMemoryEntry(agent, "journal", {
      at: now,
      source,
      kind: "turn-stop",
      text: compactText(completionStatus.lastAgentMessage, 1200),
      data
    });
    written.push("turn-stop");
  }

  await appendMemoryEntry(agent, "dreams", {
    at: now,
    source,
    kind: "dream-queued",
    text: `Connector turn ${turnId} stopped; summarize durable memory when the dreamer runs.`,
    data: {
      ...data,
      reason: "connector-turn"
    }
  });
  written.push("dream-queued");

  return { ok: true, agentId: agent.id, turnId, written };
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

async function appendMemoryEntry(agent, channel, entry) {
  const file = memoryFile(agent, channel);
  if (!file) return;
  const at = entry.at instanceof Date ? entry.at.toISOString() : String(entry.at || new Date().toISOString());
  const payload = {
    id: randomUUID(),
    at,
    agentId: agent.id,
    source: entry.source || "connector",
    kind: entry.kind,
    text: entry.text || "",
    data: entry.data || {}
  };
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.appendFile(file, `${JSON.stringify(payload)}\n`, "utf8");
}

function memoryFile(agent, channel) {
  if (channel === "inbox") return agent.memory?.inboxPath || null;
  if (channel === "dreams") return agent.memory?.dreamsPath || null;
  return agent.memory?.journalPath || null;
}

function compactText(value, max = 500) {
  const text = String(value || "").replace(/\s+/g, " ").trim();
  if (text.length <= max) return text;
  return `${text.slice(0, Math.max(0, max - 3))}...`;
}

function scopeArray(value) {
  return uniqueStrings(optionList(value).map(normalizeScopeValue).filter(Boolean));
}

function normalizeScopeValue(value) {
  return String(value || "").trim().toLowerCase();
}

function optionList(value) {
  if (value == null || value === false) return [];
  if (Array.isArray(value)) return value.flatMap(optionList);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function uniqueStrings(values) {
  return [...new Set(optionList(values))].filter(Boolean);
}

function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
