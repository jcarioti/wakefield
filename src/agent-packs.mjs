import fs from "node:fs/promises";
import path from "node:path";
import { listRecentThreads } from "./codex-sessions.mjs";
import { configureConnector } from "./connectors.mjs";
import { importContactsFile } from "./contacts.mjs";
import { importDuties } from "./duties.mjs";
import { installWakefield } from "./install.mjs";
import { importManagedConnectors } from "./managed-connectors.mjs";
import { configureService } from "./service.mjs";
import { appHome, expandHome } from "./paths.mjs";
import { ensureDir, pathExists } from "./json-store.mjs";

const PACK_SCHEMA_VERSION = 1;

export async function readAgentPack(file) {
  const packPath = path.resolve(expandHome(file));
  const raw = JSON.parse(await fs.readFile(packPath, "utf8"));
  return normalizeAgentPack(raw, { packPath });
}

export async function inspectAgentPack(file) {
  const pack = await readAgentPack(file);
  const checks = [
    check("pack schema", pack.schemaVersion === PACK_SCHEMA_VERSION, `v${pack.schemaVersion}`),
    check("agent name", Boolean(pack.agent.name), pack.agent.name || "missing"),
    check("cwd", Boolean(pack.agent.cwd) && await pathExists(pack.agent.cwd), pack.agent.cwd || "missing"),
    check("cwd AGENTS.md", Boolean(pack.agent.cwd) && await pathExists(path.join(pack.agent.cwd, "AGENTS.md")), pack.agent.cwd ? path.join(pack.agent.cwd, "AGENTS.md") : "missing"),
    check("contacts file", !pack.contacts.file || await pathExists(pack.contacts.file), pack.contacts.file || "not configured"),
    ...await skillChecks(pack),
    check("duties", pack.duties.length > 0, `${pack.duties.length} configured`, { optional: true }),
    check("wakeups", pack.wakeups.length > 0, `${pack.wakeups.length} configured`, { optional: true }),
    check("connectors", Object.keys(pack.connectors).length > 0, `${Object.keys(pack.connectors).length} configured`, { optional: true }),
    check("managed connectors", pack.managedConnectors.length > 0, `${pack.managedConnectors.length} configured`, { optional: true })
  ];
  return {
    ok: checks.filter((item) => !item.optional).every((item) => item.ok),
    pack,
    checks
  };
}

export async function installAgentPack(file, {
  home = appHome(),
  codexHomePath = null,
  threadId = null,
  latestThread = false,
  overwriteAgent = false,
  skipHooks = false,
  enableService = false,
  dryRun = false
} = {}) {
  const inspection = await inspectAgentPack(file);
  const pack = inspection.pack;
  const actions = [];
  if (dryRun) {
    return {
      ok: inspection.ok,
      dryRun: true,
      pack,
      checks: inspection.checks,
      actions
    };
  }
  if (!inspection.ok) {
    return {
      ok: false,
      dryRun: false,
      pack,
      checks: inspection.checks,
      actions
    };
  }

  const install = await installWakefield({
    name: pack.agent.name,
    soul: await packSoul(pack),
    threadId: threadId || await maybeLatestThreadId({ latestThread, codexHomePath }),
    cwd: pack.agent.cwd,
    overwriteAgent,
    skipHooks,
    home,
    codexHomePath
  });
  actions.push({
    id: "agent",
    status: install.createdAgent ? "created" : "updated",
    detail: `${install.profile.name} at ${install.profile.cwd}`
  });

  if (pack.contacts.file) {
    const contacts = await importContactsFile(pack.contacts.file, {
      home,
      format: pack.contacts.format || "auto"
    });
    actions.push({
      id: "contacts",
      status: "imported",
      detail: `${contacts.contacts.length} contact(s)`
    });
  }

  if (pack.skills.install.length > 0 || pack.skills.uninstall.length > 0) {
    const skills = await installPackSkills(pack.skills, {
      codexHomePath: codexHomePath || undefined
    });
    actions.push({
      id: "skills",
      status: "configured",
      detail: `${skills.installed.length} installed, ${skills.removed.length} removed`
    });
  }

  if (pack.duties.length > 0 || pack.wakeups.length > 0) {
    const duties = await importDuties({
      duties: pack.duties,
      wakeups: pack.wakeups
    }, {
      home,
      source: { path: pack.path, format: "wakefield-agent-pack" },
      replace: true
    });
    actions.push({
      id: "wakeups",
      status: "imported",
      detail: `${duties.duties.length} duty/duties, ${duties.wakeups.length} wakeup(s)`
    });
  }

  for (const [connectorId, config] of Object.entries(pack.connectors)) {
    const connector = await configureConnector(connectorId, {
      home,
      enabled: config.enabled == null ? null : Boolean(config.enabled),
      settings: config.settings || {},
      unset: config.unset || []
    });
    actions.push({
      id: `connector-${connectorId}`,
      status: "configured",
      detail: connector.ready ? "ready" : connector.status
    });
  }

  if (pack.managedConnectors.length > 0) {
    const managed = await importManagedConnectors(pack.managedConnectors, {
      home,
      source: { path: pack.path, format: "wakefield-agent-pack" }
    });
    actions.push({
      id: "managed-connectors",
      status: "configured",
      detail: `${managed.imported} connector package(s)`
    });
  }

  if (enableService || pack.service.enabled) {
    const service = await configureService({
      home,
      enabled: true,
      intervalMinutes: pack.service.intervalMinutes || null,
      dispatchEnabled: pack.service.externalDispatch?.enabled == null ? null : pack.service.externalDispatch.enabled,
      dispatchMode: pack.service.externalDispatch?.mode || null,
      dispatchLimit: pack.service.externalDispatch?.limit || null,
      envFile: pack.service.envFile || null
    });
    actions.push({
      id: "service",
      status: "configured",
      detail: `${service.intervalMinutes} minute interval`
    });
  }

  return {
    ok: true,
    dryRun: false,
    pack,
    checks: inspection.checks,
    actions,
    profile: install.profile
  };
}

async function maybeLatestThreadId({ latestThread, codexHomePath }) {
  if (!latestThread) return null;
  const [thread] = await listRecentThreads({
    codexHomePath: codexHomePath || undefined,
    limit: 1
  });
  return thread?.threadId || null;
}

export function formatAgentPackInspection(result) {
  const lines = [
    `${result.pack.agent.name} agent pack`,
    `state: ${result.ok ? "ready" : "needs attention"}`,
    ""
  ];
  for (const checkItem of result.checks) {
    lines.push(`${checkItem.ok ? "ok" : checkItem.optional ? "warn" : "fail"}: ${checkItem.label} - ${checkItem.detail}`);
  }
  return lines.join("\n");
}

export function formatAgentPackInstall(result) {
  if (result.dryRun) return formatAgentPackInspection(result);
  const lines = [
    `${result.pack.agent.name} agent pack ${result.ok ? "installed" : "not installed"}.`
  ];
  for (const action of result.actions || []) {
    lines.push(`${action.status}: ${action.id} - ${action.detail}`);
  }
  if (!result.ok) {
    lines.push("", formatAgentPackInspection(result));
  }
  return lines.join("\n");
}

function normalizeAgentPack(raw, { packPath }) {
  const packDir = path.dirname(packPath);
  const source = raw && typeof raw === "object" ? raw : {};
  const agent = source.agent || {};
  return {
    schemaVersion: source.schemaVersion || PACK_SCHEMA_VERSION,
    id: source.id || agent.id || "agent-pack",
    path: packPath,
    agent: {
      name: agent.name || source.name || "Wakefield",
      soul: agent.soul || source.soul || "",
      soulFile: agent.soulFile ? resolvePackPath(packDir, agent.soulFile) : null,
      cwd: agent.cwd ? resolvePackPath(packDir, agent.cwd) : null
    },
    contacts: {
      file: source.contacts?.file ? resolvePackPath(packDir, source.contacts.file) : null,
      format: source.contacts?.format || "auto"
    },
    skills: normalizePackSkills(source.skills || source.skillPackages || {}, { packDir }),
    duties: (source.duties || []).map((duty) => ({
      ...duty,
      promptFile: duty.promptFile ? resolvePackPath(packDir, duty.promptFile) : duty.promptFile || null
    })),
    wakeups: (source.wakeups || []).map((wakeup) => ({
      ...wakeup,
      promptFile: wakeup.promptFile ? resolvePackPath(packDir, wakeup.promptFile) : wakeup.promptFile || null
    })),
    connectors: source.connectors && typeof source.connectors === "object" ? source.connectors : {},
    managedConnectors: normalizeManagedConnectors(source.managedConnectors || source.connectorPackages || [], {
      packDir,
      agentId: source.id || agent.id || slugId(agent.name || source.name || "wakefield")
    }),
    service: source.service && typeof source.service === "object" ? source.service : {},
    metadata: source.metadata || {}
  };
}

async function packSoul(pack) {
  if (pack.agent.soulFile) return fs.readFile(pack.agent.soulFile, "utf8");
  return pack.agent.soul || "";
}

async function skillChecks(pack) {
  const checks = [];
  for (const skill of pack.skills.install) {
    checks.push(check(
      `skill ${skill.name}`,
      Boolean(skill.path) && await pathExists(path.join(skill.path, "SKILL.md")),
      skill.path || "missing"
    ));
  }
  if (pack.skills.uninstall.length > 0) {
    checks.push(check("skill unload list", true, `${pack.skills.uninstall.length} configured`, { optional: true }));
  }
  return checks;
}

async function installPackSkills(skills, {
  codexHomePath = null
} = {}) {
  const home = codexHomePath || expandHome(process.env.CODEX_HOME || "~/.codex");
  const skillsRoot = path.join(home, "skills");
  await ensureDir(skillsRoot);
  const installNames = new Set(skills.install.map((skill) => skill.name));
  const removed = [];
  for (const name of skills.uninstall) {
    if (installNames.has(name)) continue;
    const destination = path.join(skillsRoot, name);
    if (await pathExists(destination)) {
      await fs.rm(destination, { recursive: true, force: true });
      removed.push({ name, path: destination });
    }
  }

  const installed = [];
  for (const skill of skills.install) {
    const metadata = await skillMetadata(skill.path);
    if (skill.name && metadata.name !== skill.name) {
      throw new Error(`Pack skill ${skill.name} declares ${metadata.name} in ${path.join(skill.path, "SKILL.md")}.`);
    }
    const destination = path.join(skillsRoot, metadata.name);
    const beforeText = await readOptionalText(path.join(destination, "SKILL.md"));
    await fs.rm(destination, { recursive: true, force: true });
    await fs.cp(skill.path, destination, { recursive: true });
    installed.push({
      name: metadata.name,
      path: destination,
      changed: beforeText !== metadata.text
    });
  }

  return {
    skillsRoot,
    installed,
    removed
  };
}

function normalizePackSkills(value, { packDir }) {
  const source = value == null ? {} : value;
  if (Array.isArray(source)) {
    return {
      install: source.map((entry) => normalizePackSkillEntry(entry, { packDir })),
      uninstall: []
    };
  }
  if (typeof source === "string") {
    return {
      install: [normalizePackSkillEntry(source, { packDir })],
      uninstall: []
    };
  }
  const install = source.install || source.include || source.skills || [];
  const uninstall = source.uninstall || source.remove || source.retire || [];
  return {
    install: asArray(install).map((entry) => normalizePackSkillEntry(entry, { packDir })),
    uninstall: uniqueStrings(asArray(uninstall).map((name) => String(name || "").replace(/^\$/, "")))
  };
}

function normalizePackSkillEntry(entry, { packDir }) {
  const source = typeof entry === "string" ? { path: entry } : entry || {};
  const resolvedPath = source.path ? resolvePackPath(packDir, source.path) : null;
  const fallbackName = resolvedPath ? path.basename(resolvedPath) : source.name || "skill";
  return {
    name: String(source.name || fallbackName).trim().replace(/^\$/, ""),
    path: resolvedPath
  };
}

async function skillMetadata(skillPath) {
  const file = path.join(skillPath, "SKILL.md");
  const text = await fs.readFile(file, "utf8");
  const match = text.match(/^name:\s*["']?([^"'\n]+)["']?\s*$/m);
  if (!match) {
    throw new Error(`Skill is missing a frontmatter name: ${file}`);
  }
  return {
    name: match[1].trim(),
    text
  };
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function resolvePackPath(packDir, value) {
  const expanded = expandHome(String(value));
  return path.isAbsolute(expanded) ? expanded : path.resolve(packDir, expanded);
}

function normalizeManagedConnectors(value, { packDir, agentId }) {
  const entries = Array.isArray(value)
    ? value
    : Object.entries(value || {}).map(([id, config]) => ({ id, ...config }));
  return entries.map((entry) => ({
    ...entry,
    packagePath: entry.packagePath ? resolvePackPath(packDir, entry.packagePath) : entry.packagePath || null,
    configPath: entry.configPath ? resolvePackPath(packDir, entry.configPath) : entry.configPath || null,
    codexConfigPath: entry.codexConfigPath ? resolvePackPath(packDir, entry.codexConfigPath) : entry.codexConfigPath || null,
    mcp: entry.mcp ? {
      ...entry.mcp,
      codexConfigPath: entry.mcp.codexConfigPath ? resolvePackPath(packDir, entry.mcp.codexConfigPath) : entry.mcp.codexConfigPath || null
    } : entry.mcp,
    launchAgent: entry.launchAgent ? {
      ...entry.launchAgent,
      label: entry.launchAgent.label ? expandPackTemplate(entry.launchAgent.label, {
        soul: agentId,
        connector: entry.adapter || entry.id || "connector"
      }) : entry.launchAgent.label || null
    } : entry.launchAgent
  }));
}

function expandPackTemplate(value, variables) {
  return String(value).replace(/\{([a-zA-Z0-9_-]+)\}/g, (match, key) => {
    return variables[key] == null ? match : safeLabelPart(variables[key]);
  });
}

function slugId(value) {
  return safeLabelPart(String(value || "wakefield"));
}

function safeLabelPart(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "agent";
}

function check(label, ok, detail, { optional = false } = {}) {
  return {
    label,
    ok: Boolean(ok),
    detail,
    optional: Boolean(optional)
  };
}

function asArray(value) {
  if (value == null || value === false) return [];
  return Array.isArray(value) ? value : [value];
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
