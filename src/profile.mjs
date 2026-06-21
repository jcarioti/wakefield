import fs from "node:fs/promises";
import path from "node:path";
import {
  agentLocalDir,
  agentLocalMemoryDocumentPath,
  agentLocalMemoryPath,
  agentLocalProfilePath,
  appConfigPath,
  appHome,
  agentDir,
  agentsDir,
  externalMessagesPath,
  memoryDocumentPath,
  memoryPath,
  profilePath,
  soulPath,
  statePath,
  expandHome,
  isPathInside
} from "./paths.mjs";
import { ensureDir, pathExists, readJson, touch, writeJson } from "./json-store.mjs";

export function slugifyName(name) {
  const slug = String(name || "")
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .toLowerCase()
    .replace(/[-\s]+/g, "-");
  return slug || "agent";
}

export const SOUL_PRESETS = [
  {
    id: "friendly",
    label: "Light Friendly",
    description: "Warm, lightly playful, practical, and easy to talk to. You make everyday help feel calm and human without becoming performative."
  },
  {
    id: "gamer",
    label: "Nerdy Gamer",
    description: "Bright, game-literate, a little mischievous, and quest-minded. You can use playful adventure language when it fits, while still being useful and grounded."
  },
  {
    id: "fantasy",
    label: "Quiet Fantasy",
    description: "Mysterious, gentle, and a little storybook. You speak with a soft sense of ritual and wonder while keeping actions clear and modern."
  },
  {
    id: "operator",
    label: "Calm Operator",
    description: "Focused, reliable, concise, and quietly kind. You are excellent at reminders, scheduled checks, and practical follow-through."
  }
];

export function soulFromPreset(value) {
  const normalized = String(value || "").trim().toLowerCase();
  return SOUL_PRESETS.find((preset) => preset.id === normalized || preset.label.toLowerCase() === normalized)?.description || "";
}

export async function initAgent({
  name,
  soul,
  ownerName = null,
  threadId = null,
  cwd = null,
  agentHome = null,
  home = appHome(),
  overwrite = false
}) {
  if (!name || !String(name).trim()) {
    throw new Error("Wakefield needs an agent name.");
  }

  const agentId = slugifyName(name);
  const root = agentDir(agentId, home);
  const resolvedAgentHome = agentHome
    ? path.resolve(expandHome(agentHome))
    : null;
  const localDir = resolvedAgentHome ? agentLocalDir(resolvedAgentHome) : root;
  if (await pathExists(profilePath(agentId, home)) && !overwrite) {
    throw new Error(`Agent already exists: ${agentId}`);
  }

  const resolvedCwd = cwd
    ? path.resolve(expandHome(cwd))
    : resolvedAgentHome || root;
  const resolvedSoulPath = resolvedAgentHome
    ? path.join(resolvedAgentHome, "AGENTS.md")
    : soulPath(agentId, home);
  const memory = resolvedAgentHome
    ? {
      provider: "local-jsonl",
      inboxPath: agentLocalMemoryPath(resolvedAgentHome, "inbox"),
      journalPath: agentLocalMemoryPath(resolvedAgentHome, "journal"),
      dreamsPath: agentLocalMemoryPath(resolvedAgentHome, "dreams"),
      capturePath: agentLocalMemoryPath(resolvedAgentHome, "memory-capture"),
      notesPath: agentLocalMemoryDocumentPath(resolvedAgentHome, "notes"),
      mattersPath: agentLocalMemoryDocumentPath(resolvedAgentHome, "matters"),
      externalMessagesPath: agentLocalMemoryPath(resolvedAgentHome, "external-messages"),
      statePath: agentLocalMemoryDocumentPath(resolvedAgentHome, "state"),
      injectionLedgerPath: agentLocalMemoryDocumentPath(resolvedAgentHome, "injection-ledger")
    }
    : {
      provider: "local-jsonl",
      inboxPath: memoryPath(agentId, "inbox", home),
      journalPath: memoryPath(agentId, "journal", home),
      dreamsPath: memoryPath(agentId, "dreams", home),
      capturePath: memoryPath(agentId, "memory-capture", home),
      notesPath: memoryDocumentPath(agentId, "notes", home),
      mattersPath: memoryDocumentPath(agentId, "matters", home),
      externalMessagesPath: externalMessagesPath(agentId, home),
      statePath: statePath(agentId, home)
    };
  const now = new Date().toISOString();
  const profile = {
    id: agentId,
    name: String(name).trim(),
    ownerName: ownerName == null || String(ownerName).trim() === "" ? null : String(ownerName).trim(),
    createdAt: now,
    updatedAt: now,
    agentHome: resolvedAgentHome,
    localDir,
    threadId,
    cwd: resolvedCwd,
    soulPath: resolvedSoulPath,
    bootstrapPromptPath: resolvedAgentHome ? path.join(localDir, "bootstrap-prompt.md") : null,
    memory,
    hooks: {
      enabled: true,
      matchCwd: true
    }
  };

  await ensureDir(root);
  if (resolvedAgentHome) await ensureDir(resolvedAgentHome);
  await ensureDir(path.dirname(profile.soulPath));
  await ensureDir(path.dirname(profile.memory.statePath));
  await writeJson(profilePath(agentId, home), profile);
  if (resolvedAgentHome) await writeJson(agentLocalProfilePath(resolvedAgentHome), profile);
  await fs.writeFile(profile.soulPath, soulDocument({ name: profile.name, soul }));
  if (resolvedAgentHome) {
    await writeAgentGitignore(resolvedAgentHome);
    await fs.writeFile(profile.bootstrapPromptPath, bootstrapPrompt({ profile, soul }));
  }
  await writeJson(profile.memory.statePath, {
    facts: [],
    preferences: [],
    openThreads: [],
    updatedAt: now
  });
  await writeJson(profile.memory.notesPath, {
    schemaVersion: 1,
    updatedAt: now,
    notes: []
  });
  await writeJson(profile.memory.mattersPath, {
    schemaVersion: 1,
    updatedAt: now,
    matters: []
  });
  await touch(profile.memory.inboxPath);
  await touch(profile.memory.journalPath);
  await touch(profile.memory.dreamsPath);
  await touch(profile.memory.capturePath);
  await touch(profile.memory.externalMessagesPath);
  await writeJson(appConfigPath(home), {
    currentAgentId: agentId,
    updatedAt: now
  });

  return profile;
}

export async function ensureAgentMemory(profile, home = appHome()) {
  if (!profile) return null;
  const now = new Date().toISOString();
  const memory = {
    provider: "local-jsonl",
    ...(profile.memory || {}),
    capturePath: profile.memory?.capturePath || memoryPath(profile.id, "memory-capture", home),
    notesPath: profile.memory?.notesPath || memoryDocumentPath(profile.id, "notes", home),
    mattersPath: profile.memory?.mattersPath || memoryDocumentPath(profile.id, "matters", home)
  };
  const next = {
    ...profile,
    memory
  };
  let changed = memory.notesPath !== profile.memory?.notesPath
    || memory.mattersPath !== profile.memory?.mattersPath
    || memory.capturePath !== profile.memory?.capturePath
    || memory.provider !== profile.memory?.provider;

  if (!await pathExists(memory.notesPath)) {
    await writeJson(memory.notesPath, {
      schemaVersion: 1,
      updatedAt: now,
      notes: []
    });
  }
  if (!await pathExists(memory.mattersPath)) {
    await writeJson(memory.mattersPath, {
      schemaVersion: 1,
      updatedAt: now,
      matters: []
    });
  }
  if (!await pathExists(memory.capturePath)) await touch(memory.capturePath);

  if (changed) return saveAgent(next, home);
  return next;
}

export async function loadAppConfig(home = appHome()) {
  return readJson(appConfigPath(home), {});
}

export async function loadAgent(agentId = null, home = appHome()) {
  const config = await loadAppConfig(home);
  const id = agentId || config.currentAgentId;
  if (!id) return null;
  return readJson(profilePath(id, home), null);
}

export async function saveAgent(profile, home = appHome()) {
  const next = {
    ...profile,
    updatedAt: new Date().toISOString()
  };
  await writeJson(profilePath(next.id, home), next);
  if (next.agentHome) {
    await ensureDir(agentLocalDir(next.agentHome));
    await writeJson(agentLocalProfilePath(next.agentHome), next);
  }
  return next;
}

export async function agentStatus({
  home = appHome()
} = {}) {
  const profile = await loadAgent(null, home);
  if (!profile) {
    return {
      ok: false,
      profile: null,
      soul: ""
    };
  }
  return {
    ok: true,
    profile,
    soul: await fs.readFile(profile.soulPath, "utf8").catch(() => "")
  };
}

export async function configureAgent({
  home = appHome(),
  name = null,
  soul = null,
  ownerName = null
} = {}) {
  const profile = await loadAgent(null, home);
  if (!profile) throw new Error("No Wakefield agent is initialized yet.");
  const next = await saveAgent({
    ...profile,
    name: name == null || String(name).trim() === "" ? profile.name : String(name).trim(),
    ownerName: ownerName == null ? profile.ownerName || null : String(ownerName).trim() || null
  }, home);
  if (soul != null) {
    await fs.writeFile(next.soulPath, soulDocument({ name: next.name, soul }));
    if (next.bootstrapPromptPath) await fs.writeFile(next.bootstrapPromptPath, bootstrapPrompt({ profile: next, soul }));
  }
  return agentStatus({ home });
}

export async function selectThread({
  agentId = null,
  threadId,
  cwd = null,
  home = appHome()
}) {
  if (!threadId || !String(threadId).trim()) {
    throw new Error("select-thread needs a thread id.");
  }
  const profile = await loadAgent(agentId, home);
  if (!profile) throw new Error("No Wakefield agent is initialized yet.");
  const next = {
    ...profile,
    threadId: String(threadId).trim(),
    cwd: cwd ? path.resolve(expandHome(cwd)) : profile.cwd
  };
  return saveAgent(next, home);
}

export async function listAgents(home = appHome()) {
  let entries;
  try {
    entries = await fs.readdir(agentsDir(home), { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const profiles = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const profile = await readJson(profilePath(entry.name, home), null);
    if (profile) profiles.push(profile);
  }
  return profiles.sort((left, right) => left.name.localeCompare(right.name));
}

export async function findAgentForHookInput(input, home = appHome()) {
  const explicit = process.env.WAKEFIELD_AGENT_ID;
  if (explicit) return loadAgent(explicit, home);

  const cwd = input?.cwd ? path.resolve(expandHome(input.cwd)) : null;
  const sessionId = input?.session_id ? String(input.session_id).trim() : null;
  const profiles = await listAgents(home);

  if (sessionId) {
    const matchedSession = profiles.find((profile) => profile.threadId === sessionId);
    if (matchedSession) return matchedSession;
  }

  if (!cwd) return profiles.length === 1 ? profiles[0] : null;

  return profiles.find((profile) => {
    if (!profile?.cwd || profile.hooks?.matchCwd === false) return false;
    return isPathInside(cwd, profile.cwd);
  }) || null;
}

export function soulDocument({ name, soul }) {
  const source = String(soul || "").trim();
  if (source.startsWith("# ")) return String(soul);

  const description = soul && String(soul).trim()
    ? String(soul).trim()
    : "A helpful local companion with a steady memory and a bias toward clear, humane follow-through.";

  return `# ${name}

You are ${name}.

Wakefield delivers messages and scheduled wakeups into this persistent Codex chat, and exposes local memory through tools when prior context is needed. Wakefield is the delivery system; it is not your identity.

## Soul

${description}

## Identity

- In conversation, answer as ${name}.
- If someone asks what powers you, say you are powered by Codex.
- Do not introduce yourself as Wakefield or Codex.
- Keep your voice consistent with the soul above, especially in the first reply of a new conversation.

## Operating Shape

- Use scoped memory tools when prior context may affect correctness, safety, relationship continuity, or business operations.
- Keep durable identity and behavior here in the soul file.
- Keep generated memory in Wakefield's local memory store.
- Ask before taking actions that affect money, accounts, credentials, or other people.
- Prefer short, clear updates when work takes time.
`;
}

export function bootstrapPrompt({ profile, soul = "" }) {
  const owner = profile.ownerName ? `Your owner is ${profile.ownerName}.` : "Your owner will introduce themselves soon.";
  return [
    `Hello ${profile.name}.`,
    "",
    `You have just been created as a Wakefield-powered assistant. ${owner}`,
    `Your working folder is ${profile.cwd}.`,
    "",
    "Read AGENTS.md in this folder as your identity and operating instructions.",
    "In conversation, answer as your agent name. If someone asks what powers you, say you are powered by Codex.",
    "Wakefield is the local delivery system that brings you iMessage, Discord, email, and scheduled wakeups, with local memory available through tools when prior context is needed.",
    "Wakefield is not your identity.",
    "",
    "Your soul is:",
    String(soul || "").trim() || "A helpful local companion with a steady memory and clear follow-through.",
    "",
    "Acknowledge briefly that you are awake and ready. Do not over-explain the setup."
  ].join("\n");
}

async function writeAgentGitignore(agentHome) {
  const gitignorePath = path.join(agentHome, ".gitignore");
  const entry = ".wakefield/\n";
  const current = await fs.readFile(gitignorePath, "utf8").catch((error) => {
    if (error?.code === "ENOENT") return "";
    throw error;
  });
  if (current.split(/\r?\n/).includes(".wakefield/")) return;
  const prefix = current && !current.endsWith("\n") ? `${current}\n` : current;
  await fs.writeFile(gitignorePath, `${prefix}${entry}`);
}
