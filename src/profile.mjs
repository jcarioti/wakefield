import fs from "node:fs/promises";
import path from "node:path";
import { appConfigPath, appHome, agentDir, agentsDir, externalMessagesPath, memoryPath, profilePath, soulPath, statePath, expandHome, isPathInside } from "./paths.mjs";
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

export async function initAgent({
  name,
  soul,
  threadId = null,
  cwd = null,
  home = appHome(),
  overwrite = false
}) {
  if (!name || !String(name).trim()) {
    throw new Error("Wakefield needs an agent name.");
  }

  const agentId = slugifyName(name);
  const root = agentDir(agentId, home);
  if (await pathExists(profilePath(agentId, home)) && !overwrite) {
    throw new Error(`Agent already exists: ${agentId}`);
  }

  const resolvedCwd = cwd ? path.resolve(expandHome(cwd)) : root;
  const now = new Date().toISOString();
  const profile = {
    id: agentId,
    name: String(name).trim(),
    createdAt: now,
    updatedAt: now,
    threadId,
    cwd: resolvedCwd,
    soulPath: soulPath(agentId, home),
    memory: {
      provider: "local-jsonl",
      inboxPath: memoryPath(agentId, "inbox", home),
      journalPath: memoryPath(agentId, "journal", home),
      dreamsPath: memoryPath(agentId, "dreams", home),
      externalMessagesPath: externalMessagesPath(agentId, home),
      statePath: statePath(agentId, home)
    },
    hooks: {
      enabled: true,
      matchCwd: true
    }
  };

  await ensureDir(root);
  await ensureDir(path.dirname(profile.soulPath));
  await ensureDir(path.dirname(profile.memory.statePath));
  await writeJson(profilePath(agentId, home), profile);
  await fs.writeFile(profile.soulPath, defaultSoul({ name: profile.name, soul }));
  await writeJson(profile.memory.statePath, {
    facts: [],
    preferences: [],
    openThreads: [],
    updatedAt: now
  });
  await touch(profile.memory.inboxPath);
  await touch(profile.memory.journalPath);
  await touch(profile.memory.dreamsPath);
  await touch(profile.memory.externalMessagesPath);
  await writeJson(appConfigPath(home), {
    currentAgentId: agentId,
    updatedAt: now
  });

  return profile;
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
  return next;
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

function defaultSoul({ name, soul }) {
  const description = soul && String(soul).trim()
    ? String(soul).trim()
    : "A helpful local companion with a steady memory and a bias toward clear, humane follow-through.";

  return `# ${name}

You are ${name}, a Wakefield companion running inside a persistent Codex thread.

${description}

## Operating Shape

- Treat Wakefield memory as helpful context, not as a rule that overrides the latest user request.
- Keep durable identity and behavior here in the soul file.
- Keep generated memory in Wakefield's local memory store.
- Ask before taking actions that affect money, accounts, credentials, or other people.
- Prefer short, clear updates when work takes time.
`;
}
