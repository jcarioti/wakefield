import fs from "node:fs/promises";
import { readFileSync, statSync } from "node:fs";
import net from "node:net";
import path from "node:path";
import { execFile, spawn } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { ensureDir, pathExists, readJson, writeJson } from "./json-store.mjs";
import { nodeExecutable } from "./node-runtime.mjs";
import { appHome, connectorConfigPath, expandHome, launchAgentsDir, logsDir, managedConnectorsConfigPath, serviceConfigPath } from "./paths.mjs";
import { loadEnvFile } from "./service-env.mjs";
import { connectorSkill, connectorSkillPrompt } from "./connector-skills.mjs";
import { formatCodexMcpReload, reloadCodexMcpServers } from "./codex-mcp-reload.mjs";
import { upsertContact } from "./contacts.mjs";
import { loadConnectorConfig as loadImessageConnectorConfig } from "../packages/imessage-spectrum/src/config.mjs";
import {
  listPhotonProjectUsers,
  ownerPhotonProjectUser,
  photonUserRedirectUrl
} from "../packages/imessage-spectrum/src/photon-history.mjs";

const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);
const CONFIG_SCHEMA_VERSION = 1;
const DEFAULT_THROTTLE_INTERVAL = 10;

export const MANAGED_CONNECTOR_ADAPTERS = [
  {
    id: "discord-codex",
    name: "Discord Codex Connector",
    connectorId: "discord",
    packageName: "@wakefield/discord-codex",
    workspacePath: "packages/discord-codex",
    description: "Supervise a mature Discord Gateway connector and expose its Codex MCP reply tools.",
    capabilities: [
      "inbound-discord-gateway",
      "codex-ipc-routing",
      "discord-replies",
      "discord-dms",
      "recent-context",
      "typing",
      "presence"
    ],
    requiredFiles: [
      "package.json",
      "src/discord-bot.mjs",
      "src/mcp-server.mjs",
      "src/codex-follower-probe.mjs",
      "src/codex-send.mjs"
    ],
    processes: [
      {
        id: "bot",
        label: "Discord Gateway bot",
        script: "src/discord-bot.mjs",
        keepAlive: true
      }
    ],
    mcp: {
      serverName: "discord-codex",
      script: "src/mcp-server.mjs",
      startupTimeoutSec: 30,
      toolTimeoutSec: 60,
      tools: [
        "discord_bridge_status",
        "discord_read_messages",
        "discord_read_recent_batch",
        "discord_send_message",
        "discord_send_dm"
      ]
    },
    smokeTests: [
      { id: "status", label: "Inspect connector package and config", live: false },
      { id: "follower-probe", label: "Check selected Codex thread follower registration", live: true },
      { id: "reply-plan", label: "Show Discord reply tool contract", live: false },
      { id: "dm-plan", label: "Show Discord DM tool contract", live: false }
    ],
    setupFields: [
      { id: "tokenEnv", label: "Discord bot token env var", required: true, placeholder: "DISCORD_BOT_TOKEN", secretEnv: true },
      { id: "tokenFile", label: "Discord bot token file", required: false, placeholder: "~/.wakefield/discord-bot-token", pathMustExist: true },
      { id: "commandPrefix", label: "Command prefix", required: false, placeholder: "!agent" },
      { id: "allowedChannelIds", label: "Allowed channel ids", required: false, placeholder: "comma-separated ids" },
      { id: "allowedDmUserIds", label: "Allowed DM user ids", required: false, placeholder: "comma-separated ids" },
      { id: "allowedGuildIds", label: "Allowed guild ids", required: false, placeholder: "comma-separated ids" },
      { id: "requiredRoleIds", label: "Required role ids", required: false, placeholder: "comma-separated ids" },
      { id: "triggerUserIds", label: "Trigger user ids", required: false, placeholder: "comma-separated ids" },
      { id: "eventLogPath", label: "Event log path", required: false, placeholder: "local/events.jsonl" }
    ]
  },
  {
    id: "imessage-spectrum",
    name: "Photon/Spectrum iMessage Connector",
    connectorId: "imessage",
    packageName: "@wakefield/imessage-spectrum",
    workspacePath: "packages/imessage-spectrum",
    description: "Supervise the Photon/Spectrum iMessage connector and expose send, reply, tapback, lookup, and typing tools.",
    capabilities: [
      "inbound-spectrum-stream",
      "codex-ipc-routing",
      "imessage-send",
      "imessage-reply",
      "imessage-tapback",
      "imessage-lookup",
      "recent-context",
      "typing",
      "read-receipts",
      "receive-loop-diagnostics"
    ],
    requiredFiles: [
      "package.json",
      "src/spectrum-bot.mjs",
      "src/mcp-server.mjs",
      "src/spectrum-ipc.mjs",
      "scripts/diagnose-spectrum-bridge.mjs"
    ],
    processes: [
      {
        id: "bot",
        label: "Photon/Spectrum bot",
        script: "src/spectrum-bot.mjs",
        keepAlive: true
      }
    ],
    mcp: {
      serverName: "imessage-codex",
      script: "src/mcp-server.mjs",
      startupTimeoutSec: 30,
      toolTimeoutSec: 120,
      tools: [
        "imessage_bridge_status",
        "imessage_read_messages",
        "imessage_lookup_message",
        "imessage_read_recent_batch",
        "imessage_send_message",
        "imessage_send_reaction",
        "imessage_receipt_status",
        "imessage_start_typing",
        "imessage_stop_typing"
      ]
    },
    smokeTests: [
      { id: "status", label: "Inspect connector package and config", live: false },
      { id: "spectrum-bridge", label: "Check live Spectrum outbound IPC status", live: true },
      { id: "diagnostic-plan", label: "Show Spectrum diagnostic command", live: false },
      { id: "reply-plan", label: "Show iMessage reply tool contract", live: false },
      { id: "tapback-plan", label: "Show iMessage tapback tool contract", live: false }
    ],
    setupFields: [
      { id: "projectIdEnv", label: "Photon project id env var", required: true, placeholder: "PHOTON_PROJECT_ID", secretEnv: true },
      { id: "projectSecretEnv", label: "Photon secret env var", required: true, placeholder: "PHOTON_SECRET_KEY", secretEnv: true },
      { id: "cloudUrl", label: "Photon cloud URL", required: false, placeholder: "https://..." },
      { id: "allowedAddresses", label: "Allowed phone/email addresses", required: false, placeholder: "+15551234567,person@example.com" },
      { id: "allowedSpaceIds", label: "Allowed Spectrum space ids", required: false, placeholder: "comma-separated ids" },
      { id: "allowGroupChats", label: "Allow group chats", required: false, placeholder: "false" },
      { id: "allowOutboundToKnownSpaces", label: "Allow outbound to known spaces", required: false, placeholder: "true" },
      { id: "contactsPath", label: "Contacts file", required: false, placeholder: "leave blank for no local contacts file" },
      { id: "eventLogPath", label: "Event log path", required: false, placeholder: "local/events.jsonl" }
    ]
  }
];

export async function managedConnectorStatuses({
  home = appHome(),
  agent = null,
  codexConfigPath = null,
  now = new Date(),
  includeLiveHealth = false
} = {}) {
  const configs = await loadManagedConnectorConfigs({ home });
  return Promise.all(configs.map((config) => managedConnectorStatus(config.id, {
    home,
    agent,
    codexConfigPath,
    now,
    includeLiveHealth
  })));
}

export async function managedConnectorStatus(id, {
  home = appHome(),
  agent = null,
  codexConfigPath = null,
  launchAgentsPath = launchAgentsDir(),
  now = new Date(),
  includeLiveHealth = false
} = {}) {
  await loadManagedEnvironment({ home });
  const config = await getManagedConnectorConfig(id, { home });
  const adapter = managedConnectorAdapter(config.adapter);
  const packageInspection = await inspectManagedPackage(adapter, config);
  const connectorConfig = await inspectConnectorConfig(adapter, config, { agent, now });
  const mcp = await inspectMcpConfig(adapter, config, {
    agent,
    codexConfigPath
  });
  const launchAgent = await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath });
  const health = includeLiveHealth && config.enabled
    ? await inspectManagedConnectorHealth(adapter, { connectorConfig, launchAgent, now })
    : null;
  const checks = [
    ...packageInspection.checks,
    ...connectorConfig.checks,
    ...mcp.checks,
    ...(health?.check ? [health.check] : []),
    check("launch agent", launchAgent.installed && launchAgent.loaded, launchAgent.installed ? launchAgent.loaded ? "loaded" : "installed, not loaded" : "not installed", { optional: true })
  ];
  const requiredChecks = checks.filter((item) => !item.optional);
  const ready = requiredChecks.every((item) => item.ok);
  return {
    schemaVersion: 1,
    id: config.id,
    adapter: adapter.id,
    name: config.name || adapter.name,
    connectorId: adapter.connectorId,
    connectorSkill: connectorSkill(adapter.connectorId),
    description: adapter.description,
    enabled: Boolean(config.enabled),
    configured: packageInspection.ok && connectorConfig.ok,
    ready: Boolean(config.enabled && ready),
    running: Boolean(launchAgent.loaded),
    health,
    capabilities: adapter.capabilities,
    setupFields: managedConnectorSetupFields(adapter, {
      connectorConfig,
      mcp,
      launchAgent,
      package: packageInspection
    }),
    package: packageInspection,
    connectorConfig,
    mcp,
    launchAgent,
    processes: adapter.processes.map((processDef) => processSummary(processDef, config)),
    smokeTests: adapter.smokeTests,
    checks,
    nextAction: managedConnectorNextAction({ config, packageInspection, connectorConfig, mcp, launchAgent, health }),
    commands: managedConnectorCommands(adapter, config)
  };
}

export async function configureManagedConnector(id, {
  home = appHome(),
  adapter = null,
  enabled = null,
  settings = {},
  unset = []
} = {}) {
  const current = await readManagedConnectorStore({ home });
  const existing = current.connectors[id] || {};
  const now = new Date().toISOString();
  const nextSettings = {
    ...existing,
    id,
    adapter: adapter || settings.adapter || existing.adapter || id,
    enabled: enabled == null ? Boolean(existing.enabled) : Boolean(enabled),
    updatedAt: now,
    createdAt: existing.createdAt || now
  };

  for (const [key, value] of Object.entries(settings || {})) {
    if (key === "adapter") continue;
    setNestedSetting(nextSettings, key, value);
  }
  for (const key of unset || []) deleteNestedSetting(nextSettings, key);

  const normalized = normalizeManagedConnectorConfig(nextSettings, {
    cwd: process.cwd()
  });
  managedConnectorAdapter(normalized.adapter);
  current.connectors[id] = normalized;
  await writeManagedConnectorStore(current, { home });
  return managedConnectorStatus(id, { home });
}

export async function setupManagedConnector(id, {
  home = appHome(),
  agent = null,
  adapter = null,
  settings = {},
  packagePath = null,
  configPath = null,
  codexConfigPath = null,
  envFile = null,
  clearEnvFile = false,
  overwrite = false,
  load = true,
  reload = false,
  refreshCodexMcp = false,
  dryRun = false,
  launchAgentsPath = launchAgentsDir(),
  launchctlRunner = execFileAsync
} = {}) {
  const existingConfig = await getManagedConnectorConfig(id, { home }).catch(() => null);
  const adapterDef = managedConnectorAdapter(adapter || existingConfig?.adapter || id);
  const resolvedConfigPath = configPath || settings.configPath || existingConfig?.configPath || connectorConfigPath(id, home);
  const resolvedPackagePath = packagePath || settings.packagePath || existingConfig?.packagePath || null;
  const resolvedCodexConfigPath = codexConfigPath
    || settings.codexConfigPath
    || settings["mcp.codexConfigPath"]
    || existingConfig?.mcp?.codexConfigPath
    || existingConfig?.codexConfigPath
    || null;
  const serviceEnvironment = await configureManagedConnectorEnvironment({
    home,
    envFile,
    clearEnvFile,
    dryRun
  });
  const managedSettings = {
    ...settings,
    configPath: resolvedConfigPath
  };
  if (resolvedPackagePath) managedSettings.packagePath = resolvedPackagePath;
  if (resolvedCodexConfigPath) managedSettings["mcp.codexConfigPath"] = resolvedCodexConfigPath;

  const configured = dryRun
    ? null
    : await configureManagedConnector(id, {
      home,
      adapter: adapterDef.id,
      enabled: true,
      settings: managedSettings
    });
  const initialized = dryRun
    ? {
      ok: true,
      action: "init-config",
      dryRun,
      changed: false,
      skipped: "dry-run",
      path: resolvedConfigPath,
      status: null
    }
    : await initializeManagedConnectorConfig(id, {
      home,
      agent,
      settings,
      overwrite
    });
  const photonUsers = !dryRun && adapterDef.id === "imessage-spectrum"
    ? await refreshPhotonUsersForConnector({
      home,
      configPath: resolvedConfigPath,
      agentName: agent?.name || id,
      ownerName: agent?.ownerName || null
    })
    : null;
  const mcp = dryRun
    ? {
      ok: true,
      action: "mcp-install",
      dryRun,
      changed: false,
      codexConfigPath: resolvedCodexConfigPath || null,
      serverName: adapterDef.mcp.serverName,
      tools: adapterDef.mcp.tools,
      block: null,
      status: null
    }
    : await installManagedConnectorMcp(id, {
      home,
      agent,
      codexConfigPath: resolvedCodexConfigPath,
      dryRun
    });
  const codexMcpReload = !dryRun && refreshCodexMcp && mcp.changed
    ? await reloadCodexMcpServers()
    : null;
  const launchAgent = dryRun
    ? {
      ok: true,
      dryRun,
      action: "install",
      plistPath: path.join(launchAgentsPath, `${launchAgentLabel({ id, launchAgent: {} })}.plist`),
      label: launchAgentLabel({ id, launchAgent: {} }),
      plist: null,
      loadResult: null,
      status: await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath })
    }
    : await installManagedConnectorLaunchAgent(id, {
      home,
      launchAgentsPath,
      dryRun,
      load,
      reload: Boolean(reload || load),
      launchctlRunner
    });
  const status = dryRun
    ? null
    : await managedConnectorStatus(id, {
      home,
      agent,
      codexConfigPath: resolvedCodexConfigPath,
      launchAgentsPath
    });
  return {
    ok: true,
    ready: Boolean(status?.ready),
    running: Boolean(status?.running),
    action: "setup",
    connectorId: id,
    adapter: adapterDef.id,
    name: adapterDef.name,
    dryRun,
    paths: {
      home,
      configPath: resolvedConfigPath,
      packagePath: resolvedPackagePath,
      codexConfigPath: resolvedCodexConfigPath
    },
    serviceEnvironment,
    configured,
    initialized,
    photonUsers,
    mcp,
    codexMcpReload,
    launchAgent,
    status,
    nextAction: status?.nextAction || null
  };
}

async function refreshPhotonUsersForConnector({
  home,
  configPath,
  agentName,
  ownerName
} = {}) {
  try {
    await loadManagedEnvironment({ home });
    const connectorConfig = await loadImessageConnectorConfig({ configPath });
    const listed = await listPhotonProjectUsers({
      spectrum: connectorConfig.imessage.spectrum,
      type: "shared"
    });
    const owner = ownerPhotonProjectUser(listed.users);
    const users = listed.users.map((user) => photonUserStatus(user, {
      spectrum: connectorConfig.imessage.spectrum
    }));
    const raw = await readJson(configPath, {});
    raw.imessage = raw.imessage && typeof raw.imessage === "object" ? raw.imessage : {};
    raw.imessage.spectrum = raw.imessage.spectrum && typeof raw.imessage.spectrum === "object" ? raw.imessage.spectrum : {};
    raw.imessage.spectrum.projectUsersCache = {
      updatedAt: new Date().toISOString(),
      total: listed.total,
      users
    };

    let ownerContact = null;
    let changedConfig = true;
    if (owner?.phoneNumber) {
      const target = ensureFirstTarget(raw, { agentName });
      const before = JSON.stringify(target.allowedAddresses || []);
      target.allowedAddresses = unique([...(target.allowedAddresses || []), owner.phoneNumber]);
      changedConfig = changedConfig || before !== JSON.stringify(target.allowedAddresses);
      ownerContact = await upsertContact(photonOwnerContact(owner, { ownerName }), { home });
    }

    await writeJson(configPath, raw);
    return {
      ok: true,
      action: "photon-users-sync",
      changedConfig,
      total: listed.total,
      owner: owner ? photonUserStatus(owner, { spectrum: connectorConfig.imessage.spectrum }) : null,
      users,
      contactImported: Boolean(ownerContact)
    };
  } catch (error) {
    return {
      ok: false,
      action: "photon-users-sync",
      error: {
        message: error?.message || String(error),
        code: error?.code || null
      }
    };
  }
}

function ensureFirstTarget(raw, { agentName } = {}) {
  raw.targets = Array.isArray(raw.targets) ? raw.targets : [];
  if (raw.targets.length === 0) {
    raw.targets.push({
      id: "default",
      displayName: agentName || "Wakefield Agent",
      allowedAddresses: []
    });
  }
  raw.targets[0].allowedAddresses = asList(raw.targets[0].allowedAddresses);
  return raw.targets[0];
}

function photonOwnerContact(user, { ownerName } = {}) {
  const displayName = user.displayName || ownerName || "Owner";
  return {
    id: user.meta?.project_owner === true ? "owner" : contactIdFromPhotonUser(user),
    displayName,
    relationships: ["owner"],
    roles: ["owner"],
    identities: [
      { connector: "imessage", address: user.phoneNumber, label: "Photon user phone" },
      { connector: "sms", address: user.phoneNumber, label: "Photon user phone" }
    ],
    preferences: {
      preferredReplyConnector: "imessage"
    },
    source: {
      connector: "imessage-spectrum",
      provider: "photon",
      photonUserId: user.id,
      assignedPhoneNumber: user.assignedPhoneNumber || null
    }
  };
}

function contactIdFromPhotonUser(user) {
  return String(user.displayName || user.email || user.phoneNumber || user.id || "photon-user")
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, "-")
    .replace(/^-+|-+$/g, "") || "photon-user";
}

function photonUserStatus(user, { spectrum = null } = {}) {
  return {
    id: user.id,
    type: user.type || "shared",
    displayName: user.displayName,
    firstName: user.firstName,
    lastName: user.lastName,
    email: user.email,
    phoneNumber: user.phoneNumber,
    assignedPhoneNumber: user.assignedPhoneNumber,
    projectOwner: user.meta?.project_owner === true,
    createdAt: user.createdAt,
    redirectUrl: photonUserRedirectUrl(user, { spectrum })
  };
}

export async function importManagedConnectors(connectors = [], {
  home = appHome(),
  source = null
} = {}) {
  const list = Array.isArray(connectors)
    ? connectors
    : Object.entries(connectors || {}).map(([id, value]) => ({ id, ...value }));
  const imported = [];
  for (const entry of list) {
    const id = entry.id || entry.adapter;
    if (!id) throw new Error("Managed connector entries need an id.");
    const status = await configureManagedConnector(id, {
      home,
      adapter: entry.adapter || id,
      enabled: entry.enabled == null ? null : Boolean(entry.enabled),
      settings: {
        ...entry,
        sourcePath: source?.path || entry.sourcePath || null
      },
      unset: []
    });
    imported.push(status);
  }
  return {
    schemaVersion: 1,
    imported: imported.length,
    connectors: imported
  };
}

export async function initializeManagedConnectorConfig(id, {
  home = appHome(),
  agent = null,
  settings = {},
  overwrite = false
} = {}) {
  const config = await getManagedConnectorConfig(id, { home });
  const adapter = managedConnectorAdapter(config.adapter);
  if (!config.packagePath) throw new Error(`Managed connector ${id} needs packagePath before config initialization.`);
  if (!config.configPath) throw new Error(`Managed connector ${id} needs configPath before config initialization.`);
  if (!agent?.threadId) throw new Error("Config initialization needs a selected Codex thread.");
  if (!agent?.cwd) throw new Error("Config initialization needs the selected Codex thread cwd.");

  const exists = await pathExists(config.configPath);
  if (exists && !overwrite) {
    return {
      ok: true,
      action: "init-config",
      changed: false,
      skipped: "exists",
      path: config.configPath,
      status: await managedConnectorStatus(id, { home, agent })
    };
  }

  const connectorConfig = managedConnectorConfigTemplate(adapter, config, agent, settings, { home });
  await writeJson(config.configPath, connectorConfig);
  return {
    ok: true,
    action: "init-config",
    changed: true,
    skipped: null,
    path: config.configPath,
    status: await managedConnectorStatus(id, { home, agent })
  };
}

export function formatManagedConnectorConfigInit(result) {
  if (result.skipped === "exists") return `Managed connector config already exists: ${result.path}`;
  return `Wrote managed connector config: ${result.path}`;
}

export async function retargetManagedConnectorConfigs({
  home = appHome(),
  agent,
  connectorIds = null
} = {}) {
  if (!agent?.threadId || !agent?.cwd) {
    return {
      ok: false,
      changed: 0,
      skipped: [],
      results: [],
      reason: "Retargeting needs an agent with a selected thread and cwd."
    };
  }
  const configs = await loadManagedConnectorConfigs({ home });
  const wanted = connectorIds ? new Set(connectorIds) : null;
  const results = [];
  for (const config of configs) {
    if (wanted && !wanted.has(config.id)) continue;
    if (!config.configPath || !await pathExists(config.configPath)) {
      results.push({ id: config.id, changed: false, skipped: "missing-config", path: config.configPath || null });
      continue;
    }
    const raw = await readJson(config.configPath, {});
    const targetId = config.targetId || raw.targets?.[0]?.id || agent.id || "default";
    const targets = Array.isArray(raw.targets) && raw.targets.length > 0 ? raw.targets : [{ id: targetId }];
    let changed = false;
    const nextTargets = targets.map((target, index) => {
      const selected = config.targetId ? target.id === config.targetId : index === 0;
      if (!selected) return target;
      const next = {
        ...target,
        id: target.id || targetId,
        displayName: agent.name || target.displayName || targetId,
        threadId: agent.threadId,
        cwd: agent.cwd
      };
      changed = changed
        || target.threadId !== next.threadId
        || !sameResolvedPath(target.cwd, next.cwd)
        || target.displayName !== next.displayName;
      return next;
    });
    if (changed) {
      await writeJson(config.configPath, {
        ...raw,
        targets: nextTargets
      });
    }
    results.push({ id: config.id, changed, skipped: null, path: config.configPath });
  }
  return {
    ok: true,
    changed: results.filter((result) => result.changed).length,
    skipped: results.filter((result) => result.skipped),
    results
  };
}

export function formatManagedConnectorSetup(result) {
  const lines = [
    `${result.name} setup`,
    `config: ${result.initialized?.skipped === "exists" ? "already exists" : result.dryRun ? "would write" : "wrote"} ${result.initialized?.path || result.paths.configPath}`,
    result.serviceEnvironment
      ? `env file: ${result.serviceEnvironment.envFile || "cleared"}`
      : null,
    result.mcp?.dryRun
      ? `Codex tools: would install ${result.mcp.serverName}`
      : result.mcp?.changed
        ? `Codex tools: installed ${result.mcp.serverName}`
        : `Codex tools: already configured ${result.mcp?.serverName || ""}`.trim(),
    result.launchAgent?.dryRun
      ? `background service: would install ${result.launchAgent.label}`
      : result.launchAgent?.loadResult
        ? `background service: installed and ${result.launchAgent.loadResult.skipped === "already-loaded" ? "already running" : "loaded"} ${result.launchAgent.label}`
        : `background service: installed ${result.launchAgent?.label || ""}`.trim()
  ].filter(Boolean);
  if (result.status) {
    const state = result.status.ready
      ? result.status.running ? "ready and running" : "ready, not running"
      : "needs attention";
    lines.push(`state: ${state}`);
    if (!result.status.ready && result.nextAction?.reason) lines.push(`next: ${result.nextAction.reason}`);
  }
  if (result.mcp?.changed) {
    if (result.codexMcpReload?.ok) {
      lines.push("Codex tools: refreshed in Codex.");
    } else if (result.codexMcpReload) {
      lines.push(formatCodexMcpReload(result.codexMcpReload));
    } else {
      lines.push("Codex tools: installed; run `wakefield mcp reload` to refresh the live Codex Desktop runtime.");
    }
  }
  return lines.join("\n");
}

export async function installManagedConnectorMcp(id, {
  home = appHome(),
  agent = null,
  codexConfigPath = null,
  dryRun = false
} = {}) {
  const config = await getManagedConnectorConfig(id, { home });
  const adapter = managedConnectorAdapter(config.adapter);
  const resolvedCodexConfigPath = await resolveManagedCodexConfigPath(config, {
    agent,
    codexConfigPath
  });
  if (!resolvedCodexConfigPath) throw new Error(`Managed connector ${id} needs a Codex config path.`);
  if (!config.packagePath || !config.configPath) throw new Error(`Managed connector ${id} needs packagePath and configPath before MCP installation.`);

  const before = await readText(resolvedCodexConfigPath, "");
  const block = managedConnectorMcpBlock(adapter, config);
  const next = upsertTomlSections(before, managedConnectorMcpSectionNames(adapter, config), block);
  if (!dryRun && next !== before) {
    await ensureDir(path.dirname(resolvedCodexConfigPath));
    await fs.writeFile(resolvedCodexConfigPath, next);
  }
  return {
    ok: true,
    action: "mcp-install",
    dryRun,
    changed: next !== before,
    codexConfigPath: resolvedCodexConfigPath,
    serverName: config.mcp.serverName || adapter.mcp.serverName,
    tools: adapter.mcp.tools,
    block,
    status: dryRun ? null : await managedConnectorStatus(id, { home, agent, codexConfigPath: resolvedCodexConfigPath })
  };
}

export async function printManagedConnectorMcp(id, {
  home = appHome()
} = {}) {
  const config = await getManagedConnectorConfig(id, { home });
  const adapter = managedConnectorAdapter(config.adapter);
  return managedConnectorMcpBlock(adapter, config);
}

export function formatManagedConnectorMcpInstall(result) {
  if (result.dryRun) return `Managed connector MCP dry run: ${result.codexConfigPath}`;
  return result.changed
    ? `Installed managed connector MCP server ${result.serverName}: ${result.codexConfigPath}`
    : `Managed connector MCP server ${result.serverName} already configured: ${result.codexConfigPath}`;
}

export async function managedConnectorWizard(id, options = {}) {
  const status = await managedConnectorStatus(id, options);
  const adapter = managedConnectorAdapter(status.adapter);
  return {
    schemaVersion: 1,
    id: `managed-connector-wizard-${status.id}`,
    connectorId: status.id,
    adapter: adapter.id,
    name: status.name,
    title: `Configure ${status.name}`,
    description: status.description,
    enabled: status.enabled,
    configured: status.configured,
    ready: status.ready,
    running: status.running,
    capabilities: status.capabilities,
    fields: managedConnectorWizardFields(status),
    setupFields: managedConnectorSetupFields(adapter, status),
    steps: [
      {
        id: "package",
        title: "Connector package",
        status: status.package.ok ? "complete" : "needs_attention",
        description: "Confirm the reusable connector package and local config file.",
        checks: status.package.checks,
        command: configureCommand(status)
      },
      {
        id: "connector-config",
        title: "Connector config",
        status: status.connectorConfig.ok ? "complete" : "needs_attention",
        description: "Check target, credentials, allowlists, and provider-specific runtime files.",
        checks: status.connectorConfig.checks,
        command: ["wakefield", "managed-connectors", "init-config", status.id, "--json"],
        fields: managedConnectorSetupFields(adapter, status)
      },
      {
        id: "codex-tools",
        title: "Codex tools",
        status: status.mcp.ok ? "complete" : "needs_attention",
        description: "Expose reply tools to the selected Codex thread through MCP.",
        checks: status.mcp.checks,
        command: ["wakefield", "managed-connectors", "mcp", "install", status.id, "--json"],
        serverCommand: status.mcp.command
      },
      {
        id: "daemon",
        title: "Background connector",
        status: status.launchAgent.loaded ? "running" : status.launchAgent.installed ? "installed" : "available",
        description: "Install and load a user LaunchAgent for the inbound connector process.",
        checks: [
          { id: "installed", ok: status.launchAgent.installed, optional: true, detail: status.launchAgent.plistPath },
          { id: "loaded", ok: status.launchAgent.loaded === true, optional: true, detail: status.launchAgent.loaded == null ? "unknown" : status.launchAgent.loaded ? "loaded" : "not loaded" }
        ],
        commands: [
          ["wakefield", "managed-connectors", "launch-agent", "status", status.id, "--json"],
          ["wakefield", "managed-connectors", "launch-agent", "install", status.id, "--load", "--json"]
        ]
      },
      {
        id: "smoke-tests",
        title: "Connector checks",
        status: "available",
        description: "Run status checks, live bridge checks, or outbound tool contract plans.",
        tests: status.smokeTests.map((test) => ({
          ...test,
          command: ["wakefield", "managed-connectors", "test", status.id, "--kind", test.id, "--json"]
        }))
      }
    ],
    nextAction: status.nextAction,
    status
  };
}

export async function managedConnectorWizards(options = {}) {
  const configs = await loadManagedConnectorConfigs({ home: options.home || appHome() });
  return Promise.all(configs.map((config) => managedConnectorWizard(config.id, options)));
}

export function formatManagedConnectorStatuses(statuses) {
  if (statuses.length === 0) return "No managed connector packages configured.";
  return statuses.map((status) => {
    const state = status.ready
      ? status.running ? "ready, running" : "ready, not running"
      : status.enabled ? "needs attention" : "disabled";
    const failed = status.checks.filter((item) => !item.ok && !item.optional).map((item) => item.id);
    const detail = status.health && !status.health.ok
      ? status.health.detail
      : failed.length > 0 ? `missing: ${failed.join(", ")}` : "";
    const details = detail ? ` - ${detail}` : "";
    return `${status.id}: ${state}${details}`;
  }).join("\n");
}

export function formatManagedConnectorWizard(wizard) {
  return [
    wizard.title,
    `state: ${wizard.ready ? wizard.running ? "ready, running" : "ready" : wizard.enabled ? "needs attention" : "disabled"}`,
    `next: ${wizard.nextAction.label}`,
    "",
    ...wizard.steps.map((step) => `${step.status}: ${step.title} - ${step.description}`)
  ].join("\n");
}

export async function runManagedConnectorProcess(id, {
  home = appHome(),
  processId = "bot",
  spawnImpl = spawn
} = {}) {
  await loadManagedEnvironment({ home });
  const config = await getManagedConnectorConfig(id, { home });
  const adapter = managedConnectorAdapter(config.adapter);
  const processDef = adapter.processes.find((item) => item.id === processId);
  if (!processDef) throw new Error(`Unknown managed connector process ${processId} for ${id}.`);
  if (!config.packagePath || !config.configPath) throw new Error(`Managed connector ${id} needs packagePath and configPath.`);
  const command = processCommand(processDef, config);
  return new Promise((resolve, reject) => {
    const child = spawnImpl(command.command, command.args, {
      cwd: config.packagePath,
      env: process.env,
      stdio: "inherit"
    });
    child.once("error", reject);
    child.once("exit", (code, signal) => {
      resolve({
        ok: code === 0,
        code,
        signal,
        command: [command.command, ...command.args],
        cwd: config.packagePath
      });
    });
  });
}

export async function testManagedConnector(id, {
  home = appHome(),
  kind = "status",
  agent = null,
  codexConfigPath = null,
  execFileImpl = execFileAsync,
  now = new Date()
} = {}) {
  const status = await managedConnectorStatus(id, {
    home,
    agent,
    codexConfigPath,
    now
  });
  const adapter = managedConnectorAdapter(status.adapter);
  if (kind === "status") {
    return {
      ok: status.checks.filter((item) => !item.optional).every((item) => item.ok),
      kind,
      connector: status.id,
      checks: status.checks
    };
  }
  if (kind === "follower-probe" && adapter.id === "discord-codex") {
    const script = path.join(status.package.path, "src/codex-follower-probe.mjs");
    const targetId = status.connectorConfig.targetId || status.connectorConfig.targets[0]?.id;
    if (!targetId) throw new Error("Follower probe needs a target id.");
    const nodePath = nodeExecutable();
    const result = await execFileJson(execFileImpl, nodePath, [script, "--config", status.connectorConfig.path, "--target", targetId], {
      cwd: status.package.path,
      timeout: 45000,
      tolerateExitCodes: [0, 3]
    });
    return {
      ok: result.code === 0,
      kind,
      connector: status.id,
      command: [nodePath, script, "--config", status.connectorConfig.path, "--target", targetId],
      result: result.json || result.text,
      code: result.code
    };
  }
  if (kind === "spectrum-bridge" && adapter.id === "imessage-spectrum") {
    const bridge = await spectrumBridgeStatus(status.connectorConfig.spectrum?.ipcSocketPath);
    return {
      ok: bridge.ok,
      kind,
      connector: status.id,
      bridge
    };
  }
  return {
    ok: true,
    kind,
    connector: status.id,
    plan: managedConnectorSmokePlan(adapter, status, kind)
  };
}

export function formatManagedConnectorTest(result) {
  if (result.plan) {
    return [
      `${result.connector} ${result.kind}`,
      result.plan.summary,
      ...result.plan.items.map((item) => `- ${item}`)
    ].join("\n");
  }
  if (result.bridge) {
    return `${result.connector} ${result.kind}: ${result.ok ? "ok" : "failed"} - ${result.bridge.detail}`;
  }
  if (result.checks) {
    return result.checks.map((item) => `${item.ok ? "ok" : item.optional ? "warn" : "fail"}: ${item.label || item.id} - ${item.detail}`).join("\n");
  }
  return `${result.connector} ${result.kind}: ${result.ok ? "ok" : "failed"}`;
}

export async function managedConnectorLaunchAgentStatus(id, {
  home = appHome(),
  launchAgentsPath = launchAgentsDir()
} = {}) {
  let config = null;
  try {
    config = await getManagedConnectorConfig(id, { home });
  } catch {
    config = { id, launchAgent: {} };
  }
  const label = launchAgentLabel(config);
  const plistPath = path.join(launchAgentsPath, `${label}.plist`);
  const installed = await pathExists(plistPath);
  const loaded = await launchAgentLoaded(label, launchAgentsPath);
  return {
    kind: "launch-agent",
    supported: launchAgentSupported(launchAgentsPath),
    canLoad: launchctlContext().supported,
    label,
    installed,
    loaded,
    plistPath,
    logPaths: managedConnectorLogPaths(config, { home }),
    home
  };
}

export async function managedConnectorLaunchAgentPlist(id, {
  home = appHome()
} = {}) {
  const config = await getManagedConnectorConfig(id, { home });
  const status = await managedConnectorStatus(id, { home });
  const processId = config.launchAgent?.process || "bot";
  const logPaths = managedConnectorLogPaths(config, { home });
  const env = {
    WAKEFIELD_HOME: home
  };
  const serviceConfig = await readJson(serviceConfigPath(home), {});
  if (serviceConfig.envFile) env.WAKEFIELD_ENV_FILE = serviceConfig.envFile;
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;

  return plist({
    Label: launchAgentLabel(config),
    ProgramArguments: [
      process.execPath,
      cliPath(),
      "managed-connectors",
      "run",
      config.id,
      "--process",
      processId
    ],
    WorkingDirectory: status.package.path,
    RunAtLoad: true,
    KeepAlive: config.launchAgent?.keepAlive !== false,
    ThrottleInterval: Number(config.launchAgent?.throttleInterval || DEFAULT_THROTTLE_INTERVAL),
    StandardOutPath: logPaths.out,
    StandardErrorPath: logPaths.err,
    EnvironmentVariables: env
  });
}

export async function installManagedConnectorLaunchAgent(id, {
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  load = false,
  reload = false,
  launchctlRunner = execFileAsync
} = {}) {
  const plistText = await managedConnectorLaunchAgentPlist(id, { home });
  const status = await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath });
  if (!dryRun) {
    assertLaunchAgentSupported(launchAgentsPath);
    await ensureDir(launchAgentsPath);
    await ensureDir(path.dirname(status.logPaths.out));
    await fs.writeFile(status.plistPath, plistText);
  }
  const loadResult = load || reload
    ? await loadManagedConnectorLaunchAgent(id, {
      home,
      launchAgentsPath,
      dryRun,
      reload,
      launchctlRunner
    })
    : null;
  return {
    dryRun,
    action: "install",
    plistPath: status.plistPath,
    label: status.label,
    plist: plistText,
    loadResult,
    status: await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath })
  };
}

export async function loadManagedConnectorLaunchAgent(id, {
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  reload = false,
  launchctlRunner = execFileAsync
} = {}) {
  const status = await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath });
  const context = launchctlContext();
  const commands = launchAgentLoadCommands({ plistPath: status.plistPath, label: status.label, reload, context });
  if (!dryRun) {
    assertLaunchAgentSupported(launchAgentsPath);
    assertLaunchctlSupported(context);
    if (!status.installed) throw new Error(`Managed connector LaunchAgent is not installed: ${status.plistPath}`);
    if (status.loaded && !reload) {
      return launchctlResult({
        action: "load",
        dryRun,
        ok: true,
        supported: context.supported,
        plistPath: status.plistPath,
        label: status.label,
        commands: [],
        skipped: "already-loaded",
        status
      });
    }
    await runLaunchctlCommands(commands, { runner: launchctlRunner, ignoreFirstBootoutFailure: Boolean(reload) });
  }
  return launchctlResult({
    action: reload ? "reload" : "load",
    dryRun,
    ok: true,
    supported: context.supported,
    plistPath: status.plistPath,
    label: status.label,
    commands,
    skipped: !context.supported ? "launchctl-unavailable" : null,
    status: await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath })
  });
}

export async function unloadManagedConnectorLaunchAgent(id, {
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  launchctlRunner = execFileAsync
} = {}) {
  const status = await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath });
  const context = launchctlContext();
  const commands = launchAgentUnloadCommands({ label: status.label, context });
  if (!dryRun) {
    assertLaunchAgentSupported(launchAgentsPath);
    assertLaunchctlSupported(context);
    await runLaunchctlCommands(commands, { runner: launchctlRunner, ignoreFirstBootoutFailure: true });
  }
  return launchctlResult({
    action: "unload",
    dryRun,
    ok: true,
    supported: context.supported,
    plistPath: status.plistPath,
    label: status.label,
    commands,
    skipped: !context.supported ? "launchctl-unavailable" : null,
    status: await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath })
  });
}

export async function uninstallManagedConnectorLaunchAgent(id, {
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  unload = false,
  launchctlRunner = execFileAsync
} = {}) {
  const status = await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath });
  const unloadResult = unload
    ? await unloadManagedConnectorLaunchAgent(id, { home, launchAgentsPath, dryRun, launchctlRunner })
    : null;
  if (!dryRun && status.installed) {
    assertLaunchAgentSupported(launchAgentsPath);
    await fs.unlink(status.plistPath);
  }
  return {
    dryRun,
    action: "uninstall",
    plistPath: status.plistPath,
    label: status.label,
    removed: status.installed && !dryRun,
    unloadResult,
    status: await managedConnectorLaunchAgentStatus(id, { home, launchAgentsPath })
  };
}

export function formatManagedLaunchAgentStatus(status) {
  return [
    "Managed connector LaunchAgent",
    `label: ${status.label}`,
    `supported: ${status.supported ? "yes" : "no"}`,
    `launchctl: ${status.canLoad ? "available" : "unavailable"}`,
    `installed: ${status.installed ? "yes" : "no"}`,
    `loaded: ${status.loaded == null ? "unknown" : status.loaded ? "yes" : "no"}`,
    `plist: ${status.plistPath}`,
    `logs: ${status.logPaths.out}, ${status.logPaths.err}`
  ].join("\n");
}

export function formatManagedLaunchAgentResult(result) {
  if (result.dryRun) return `${result.action} dry run: ${result.plistPath}`;
  if (result.action === "install") {
    const lines = [`Installed managed connector LaunchAgent: ${result.plistPath}`];
    if (result.loadResult) lines.push(formatManagedLaunchAgentResult(result.loadResult));
    return lines.join("\n");
  }
  if (result.action === "uninstall") {
    const lines = [
      result.removed
        ? `Removed managed connector LaunchAgent: ${result.plistPath}`
        : `Managed connector LaunchAgent was not installed: ${result.plistPath}`
    ];
    if (result.unloadResult) lines.unshift(formatManagedLaunchAgentResult(result.unloadResult));
    return lines.join("\n");
  }
  if (result.skipped === "already-loaded") return "Managed connector LaunchAgent is already loaded.";
  if (result.skipped === "launchctl-unavailable") return "Managed connector launchctl action was skipped because launchctl is unavailable.";
  return `${result.action === "reload" ? "Reloaded" : result.action === "unload" ? "Unloaded" : "Loaded"} managed connector LaunchAgent: ${result.plistPath}`;
}

export async function loadManagedConnectorConfigs({
  home = appHome()
} = {}) {
  const store = await readManagedConnectorStore({ home });
  return Object.values(store.connectors).map((config) => resolveManagedPackagePath(normalizeManagedConnectorConfig(config)));
}

export function managedConnectorAdapter(id) {
  const adapter = MANAGED_CONNECTOR_ADAPTERS.find((item) => item.id === id);
  if (!adapter) throw new Error(`Unknown managed connector adapter: ${id}`);
  return adapter;
}

function processSummary(processDef, config) {
  const command = processCommand(processDef, config);
  return {
    id: processDef.id,
    label: processDef.label,
    keepAlive: processDef.keepAlive !== false,
    command: [command.command, ...command.args],
    cwd: config.packagePath,
    runCommand: ["wakefield", "managed-connectors", "run", config.id, "--process", processDef.id]
  };
}

function managedConnectorCommands(adapter, config) {
  return {
    configure: configureCommand({ id: config.id, adapter: adapter.id, package: { path: config.packagePath }, connectorConfig: { path: config.configPath } }),
    status: ["wakefield", "managed-connectors", "status", config.id, "--json"],
    wizard: ["wakefield", "managed-connectors", "wizard", config.id, "--json"],
    launchAgentStatus: ["wakefield", "managed-connectors", "launch-agent", "status", config.id, "--json"],
    launchAgentInstall: ["wakefield", "managed-connectors", "launch-agent", "install", config.id, "--load", "--json"],
    mcp: mcpCommand(adapter, config)
  };
}

function configureCommand(status) {
  const command = [
    "wakefield",
    "managed-connectors",
    "configure",
    status.id,
    "--adapter",
    status.adapter || status.adapter?.id || status.package?.adapter || "$adapter",
    "--enable",
    "--set",
    `packagePath=${status.package?.path || "$packagePath"}`,
    "--set",
    `configPath=${status.connectorConfig?.path || "$configPath"}`
  ];
  return command;
}

async function getManagedConnectorConfig(id, {
  home = appHome()
} = {}) {
  const configs = await loadManagedConnectorConfigs({ home });
  const config = configs.find((item) => item.id === id);
  if (!config) throw new Error(`Managed connector is not configured: ${id}`);
  return config;
}

async function readManagedConnectorStore({ home }) {
  const store = await readJson(managedConnectorsConfigPath(home), null);
  if (!store) return { schemaVersion: CONFIG_SCHEMA_VERSION, connectors: {} };
  return {
    schemaVersion: store.schemaVersion || CONFIG_SCHEMA_VERSION,
    connectors: store.connectors && typeof store.connectors === "object" ? store.connectors : {}
  };
}

async function writeManagedConnectorStore(store, { home }) {
  await writeJson(managedConnectorsConfigPath(home), {
    schemaVersion: CONFIG_SCHEMA_VERSION,
    connectors: store.connectors || {}
  });
}

async function configureManagedConnectorEnvironment({
  home,
  envFile = null,
  clearEnvFile = false,
  dryRun = false
} = {}) {
  if (envFile == null && !clearEnvFile) return null;
  const current = await readJson(serviceConfigPath(home), {});
  const nextEnvFile = clearEnvFile ? null : resolveConfigPath(envFile, { cwd: process.cwd() });
  if (!dryRun) {
    await writeJson(serviceConfigPath(home), {
      ...current,
      envFile: nextEnvFile,
      updatedAt: new Date().toISOString()
    });
  }
  return {
    dryRun,
    changed: current.envFile !== nextEnvFile,
    envFile: nextEnvFile
  };
}

function managedConnectorConfigTemplate(adapter, config, agent, settings, { home }) {
  const targetId = setting(settings, "targetId", config.targetId || "default");
  const target = {
    id: targetId,
    displayName: setting(settings, "displayName", agent.name || targetId),
    threadId: setting(settings, "threadId", agent.threadId),
    cwd: setting(settings, "cwd", agent.cwd)
  };
  const eventLogPath = setting(settings, "eventLogPath", "");
  if (eventLogPath) target.eventLogPath = eventLogPath;

  if (adapter.id === "discord-codex") {
    const channelIds = listSetting(settings, "allowedChannelIds");
    const userIds = listSetting(settings, "allowedDmUserIds", "allowedUserIds");
    target.allowedGuildIds = listSetting(settings, "allowedGuildIds");
    target.allowedChannelIds = channelIds;
    target.allowedUserIds = userIds;
    target.requiredRoleIds = listSetting(settings, "requiredRoleIds");
    target.triggerUserIds = listSetting(settings, "triggerUserIds");
    target.allowDirectMessages = userIds.length > 0;
    return {
      bot: {
        tokenEnv: setting(settings, "tokenEnv", "DISCORD_BOT_TOKEN"),
        tokenFile: setting(settings, "tokenFile", null),
        commandPrefix: setting(settings, "commandPrefix", "!agent")
      },
      codex: defaultCodexConnectorSettings(settings, adapter.connectorId),
      discord: {
        allowedOutboundChannelIds: channelIds,
        allowedDmUserIds: userIds,
        typing: defaultTypingSettings(),
        presence: defaultPresenceSettings()
      },
      targets: [target]
    };
  }

  const addresses = listSetting(settings, "allowedAddresses", "allowedOutboundAddresses");
  const spaceIds = listSetting(settings, "allowedSpaceIds", "allowedOutboundSpaceIds");
  target.allowedAddresses = addresses;
  target.allowedSpaceIds = spaceIds;
  target.allowedChatIds = [];
  target.allowedChatGuids = [];
  target.allowGroupChats = booleanSetting(settings, "allowGroupChats", false);
  return {
    bot: {
      processLockRoot: setting(settings, "processLockRoot", "~/.codex/connectors/imessage-codex/locks")
    },
    codex: defaultCodexConnectorSettings(settings, adapter.connectorId),
    imessage: {
      provider: "spectrum",
      spectrum: {
        projectId: null,
        projectSecret: null,
        cloudUrl: setting(settings, "cloudUrl", null),
        projectIdEnv: setting(settings, "projectIdEnv", "PHOTON_PROJECT_ID"),
        projectSecretEnv: setting(settings, "projectSecretEnv", "PHOTON_SECRET_KEY"),
        ipcSocketPath: setting(settings, "ipcSocketPath", "~/.codex/connectors/imessage-codex/spectrum.sock"),
        attachmentDir: setting(settings, "attachmentDir", "~/.codex/connectors/imessage-codex/attachments"),
        statusPath: setting(settings, "statusPath", "~/.codex/connectors/imessage-codex/spectrum-status.json"),
        deliveryQueuePath: setting(settings, "deliveryQueuePath", "~/.codex/connectors/imessage-codex/spectrum-delivery-queue.json"),
        allowOutboundToKnownSpaces: booleanSetting(settings, "allowOutboundToKnownSpaces", true),
        flattenGroups: booleanSetting(settings, "flattenGroups", true),
        telemetry: booleanSetting(settings, "telemetry", false)
      },
      databasePath: setting(settings, "databasePath", "~/Library/Messages/chat.db"),
      statePath: setting(settings, "statePath", path.join(home, "connectors", `${config.id}-state.json`)),
      allowedOutboundAddresses: addresses,
      allowedOutboundChatIds: [],
      allowedOutboundChatGuids: [],
      allowedOutboundSpaceIds: spaceIds,
      advancedBridgeRequired: booleanSetting(settings, "advancedBridgeRequired", true),
      watch: {
        includeAttachments: true,
        convertAttachments: true,
        includeReactions: false,
        debounce: "500ms"
      },
      sendReadReceipts: booleanSetting(settings, "sendReadReceipts", true),
      typing: {
        ...defaultTypingSettings(),
        showWhileThinking: booleanSetting(settings, "showWhileThinking", true)
      },
      focus: {
        enabled: false
      }
    },
    identity: {
      contactsPath: setting(settings, "contactsPath", "")
    },
    targets: [target]
  };
}

function defaultCodexConnectorSettings(settings, connectorId = null) {
  const skillPrompt = setting(settings, "connectorSkillPrompt", connectorSkillPrompt(connectorId));
  return {
    ...(skillPrompt ? { connectorSkillPrompt: skillPrompt } : {}),
    requestTimeoutMs: numberSetting(settings, "requestTimeoutMs", 30000),
    connectTimeoutMs: numberSetting(settings, "connectTimeoutMs", 10000),
    lockTimeoutMs: numberSetting(settings, "lockTimeoutMs", 45000),
    lockStaleMs: numberSetting(settings, "lockStaleMs", 90000),
    deepLinkWake: {
      enabled: booleanSetting(settings, "deepLinkWake", true),
      waitMs: numberSetting(settings, "deepLinkWakeWaitMs", 30000),
      pollMs: numberSetting(settings, "deepLinkWakePollMs", 1000),
      reopenMs: numberSetting(settings, "deepLinkWakeReopenMs", 6000)
    },
    appServer: {
      controlSocketPath: setting(settings, "codexControlSocketPath", "~/.codex/app-server-control/app-server-control.sock"),
      codexPath: setting(settings, "codexPath", "~/.codex/packages/standalone/current/codex"),
      ensureDaemon: booleanSetting(settings, "ensureCodexDaemon", true),
      requireRemoteControlConnected: booleanSetting(settings, "requireRemoteControlConnected", true)
    }
  };
}

function defaultTypingSettings() {
  return {
    enabled: true,
    intervalMs: 6000,
    maxMs: 1800000,
    completionTimeoutMs: 1800000,
    completionPollMs: 1500
  };
}

function defaultPresenceSettings() {
  return {
    enabled: true,
    pollMs: 1500,
    rolloutRefreshMs: 30000,
    compactionStartGraceMs: 2000,
    compactionHoldMs: 15000,
    presenceRefreshMs: 5000,
    onlineStatus: "online",
    compactingStatus: "idle",
    compactingActivityName: "Codex compact",
    compactingActivityType: "Watching"
  };
}

function normalizeManagedConnectorConfig(config, {
  cwd = process.cwd()
} = {}) {
  const source = config && typeof config === "object" ? config : {};
  const adapter = source.adapter || source.type || source.id;
  const packagePath = source.packagePath ? resolveConfigPath(source.packagePath, { cwd }) : null;
  const configPath = source.configPath ? resolveConfigPath(source.configPath, { cwd: packagePath || cwd }) : null;
  return {
    id: source.id || adapter,
    adapter,
    name: source.name || null,
    enabled: Boolean(source.enabled),
    packagePath,
    configPath,
    targetId: source.targetId || null,
    codexConfigPath: source.codexConfigPath ? resolveConfigPath(source.codexConfigPath, { cwd }) : null,
    mcp: {
      enabled: source.mcp?.enabled !== false,
      serverName: source.mcp?.serverName || null,
      codexConfigPath: source.mcp?.codexConfigPath ? resolveConfigPath(source.mcp.codexConfigPath, { cwd }) : null
    },
    launchAgent: {
      enabled: source.launchAgent?.enabled !== false,
      label: source.launchAgent?.label || null,
      process: source.launchAgent?.process || "bot",
      keepAlive: source.launchAgent?.keepAlive !== false,
      throttleInterval: source.launchAgent?.throttleInterval || DEFAULT_THROTTLE_INTERVAL
    },
    sourcePath: source.sourcePath || null,
    createdAt: source.createdAt || null,
    updatedAt: source.updatedAt || null
  };
}

function resolveManagedPackagePath(config) {
  if (config.packagePath) return config;
  let adapter = null;
  try {
    adapter = managedConnectorAdapter(config.adapter);
  } catch {
    return config;
  }
  const packagePath = resolveInstalledPackagePath(adapter.packageName)
    || resolveWorkspacePackagePath(adapter.workspacePath);
  return packagePath ? { ...config, packagePath } : config;
}

function resolveInstalledPackagePath(packageName) {
  try {
    return path.dirname(require.resolve(`${packageName}/package.json`));
  } catch {
    return null;
  }
}

function resolveWorkspacePackagePath(workspacePath) {
  if (!workspacePath) return null;
  const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..");
  const candidate = path.join(root, workspacePath);
  try {
    const stat = statSync(path.join(candidate, "package.json"));
    return stat.isFile() ? candidate : null;
  } catch {
    return null;
  }
}

function resolveConfigPath(value, { cwd }) {
  const expanded = expandHome(String(value));
  return path.isAbsolute(expanded) ? expanded : path.resolve(cwd || process.cwd(), expanded);
}

async function inspectManagedPackage(adapter, config) {
  const checks = [];
  const packagePath = config.packagePath;
  checks.push(check("package path", Boolean(packagePath), packagePath || `${adapter.packageName} is not installed and packagePath is not set`));
  if (!packagePath) {
    return {
      ok: false,
      path: null,
      packageJsonPath: null,
      packageName: null,
      requiredFiles: adapter.requiredFiles,
      missingFiles: adapter.requiredFiles,
      checks
    };
  }
  const packageExists = await pathExists(packagePath);
  checks.push(check("package directory", packageExists, packagePath));
  const packageJsonPath = path.join(packagePath, "package.json");
  const packageJson = await readJson(packageJsonPath, null);
  checks.push(check("package.json", Boolean(packageJson), packageJsonPath));
  if (packageJson?.name) {
    checks.push(check("package name", packageJson.name === adapter.packageName, packageJson.name));
  }
  const missingFiles = [];
  for (const relative of adapter.requiredFiles) {
    const exists = await pathExists(path.join(packagePath, relative));
    if (!exists) missingFiles.push(relative);
  }
  checks.push(check("required files", missingFiles.length === 0, missingFiles.length === 0 ? "complete" : `missing: ${missingFiles.join(", ")}`));
  return {
    ok: checks.filter((item) => !item.optional).every((item) => item.ok),
    path: packagePath,
    packageJsonPath,
    packageName: packageJson?.name || null,
    bin: packageJson?.bin || {},
    scripts: packageJson?.scripts || {},
    private: Boolean(packageJson?.private),
    requiredFiles: adapter.requiredFiles,
    missingFiles,
    checks
  };
}

async function inspectConnectorConfig(adapter, config, { agent, now }) {
  const configPath = config.configPath;
  const checks = [check("config path", Boolean(configPath), configPath || "missing")];
  if (!configPath) {
    return {
      ok: false,
      path: null,
      parsed: false,
      targets: [],
      checks
    };
  }
  let raw = null;
  try {
    raw = JSON.parse(await fs.readFile(configPath, "utf8"));
    checks.push(check("config file", true, configPath));
  } catch (error) {
    checks.push(check("config file", false, error?.code === "ENOENT" ? "missing" : error.message));
    return {
      ok: false,
      path: configPath,
      parsed: false,
      targets: [],
      checks
    };
  }
  const targets = (raw.targets || []).map((target) => ({
    id: target.id || null,
    displayName: target.displayName || target.id || null,
    threadId: target.threadId || null,
    cwd: target.cwd ? resolveConfigPath(target.cwd, { cwd: path.dirname(configPath) }) : null,
    allowedGuildIds: asList(target.allowedGuildIds),
    allowedChannelIds: asList(target.allowedChannelIds),
    allowedUserIds: asList(target.allowedUserIds),
    requiredRoleIds: asList(target.requiredRoleIds),
    triggerUserIds: asList(target.triggerUserIds),
    allowedAddresses: asList(target.allowedAddresses),
    allowedSpaceIds: asList(target.allowedSpaceIds),
    allowGroupChats: target.allowGroupChats === true,
    eventLogPath: target.eventLogPath ? resolveConfigPath(target.eventLogPath, { cwd: path.dirname(configPath) }) : null
  }));
  checks.push(check("targets", targets.length > 0, `${targets.length} configured`));
  for (const target of targets) {
    checks.push(check(`target ${target.id || "unknown"} thread`, Boolean(target.threadId), target.threadId || "missing"));
    checks.push(check(`target ${target.id || "unknown"} cwd`, Boolean(target.cwd) && await pathExists(target.cwd), target.cwd || "missing"));
    checks.push(check(`target ${target.id || "unknown"} AGENTS.md`, Boolean(target.cwd) && await pathExists(path.join(target.cwd, "AGENTS.md")), target.cwd ? path.join(target.cwd, "AGENTS.md") : "missing"));
  }
  const selectedTarget = selectManagedTarget(targets, config.targetId);
  checks.push(check("selected target", Boolean(selectedTarget), config.targetId || (targets.length === 1 ? targets[0]?.id : "missing")));
  if (selectedTarget && agent?.threadId) {
    checks.push(check(
      "target selected thread",
      selectedTarget.threadId === agent.threadId,
      selectedTarget.threadId === agent.threadId
        ? selectedTarget.threadId
        : `connector ${selectedTarget.threadId || "missing"}; agent ${agent.threadId}`
    ));
  }
  if (selectedTarget && agent?.cwd) {
    checks.push(check(
      "target selected cwd",
      sameResolvedPath(selectedTarget.cwd, agent.cwd),
      sameResolvedPath(selectedTarget.cwd, agent.cwd)
        ? selectedTarget.cwd
        : `connector ${selectedTarget.cwd || "missing"}; agent ${agent.cwd}`
    ));
  }

  if (adapter.id === "discord-codex") {
    return inspectDiscordConnectorConfig(raw, {
      configPath,
      targets,
      selectedTarget,
      checks
    });
  }
  return inspectSpectrumConnectorConfig(raw, {
    configPath,
    targets,
    selectedTarget,
    checks,
    now
  });
}

function inspectDiscordConnectorConfig(raw, { configPath, targets, selectedTarget, checks }) {
  const tokenEnv = raw.bot?.tokenEnv || "DISCORD_BOT_TOKEN";
  const tokenFile = raw.bot?.tokenFile ? resolveConfigPath(raw.bot.tokenFile, { cwd: path.dirname(configPath) }) : null;
  const envSet = Boolean(process.env[tokenEnv]);
  const tokenFileExists = tokenFile ? fsAccessSyncish(tokenFile) : false;
  checks.push(check("bot token", envSet || tokenFileExists, envSet ? `${tokenEnv} set` : tokenFile ? tokenFileExists ? tokenFile : `${tokenFile} missing` : `${tokenEnv} missing`));
  checks.push(check("token file", !tokenFile || tokenFileExists, tokenFile || "not configured", { optional: true }));
  const allowedOutboundChannelIds = [
    ...(raw.discord?.allowedOutboundChannelIds || []),
    ...(raw.targets || []).flatMap((target) => target.allowedChannelIds || [])
  ].filter(Boolean);
  const allowedDmUserIds = [
    ...(raw.discord?.allowedDmUserIds || []),
    ...(raw.targets || []).flatMap((target) => target.allowedUserIds || [])
  ].filter(Boolean);
  checks.push(check("outbound allowlist", allowedOutboundChannelIds.length > 0 || allowedDmUserIds.length > 0, `${allowedOutboundChannelIds.length} channel(s), ${allowedDmUserIds.length} DM user(s)`));
  return {
    ok: checks.filter((item) => !item.optional).every((item) => item.ok),
    path: configPath,
    parsed: true,
    provider: "discord",
    targetId: selectedTarget?.id || null,
    targets,
    secretRefs: {
      tokenEnv,
      tokenEnvSet: envSet,
      tokenFile,
      tokenFileExists: tokenFile ? tokenFileExists : null
    },
    outbound: {
      channelIds: unique(allowedOutboundChannelIds),
      dmUserIds: unique(allowedDmUserIds)
    },
    checks
  };
}

function inspectSpectrumConnectorConfig(raw, { configPath, targets, selectedTarget, checks, now }) {
  const imessage = raw.imessage || {};
  const spectrum = imessage.spectrum || {};
  checks.push(check("provider", (imessage.provider || "spectrum") === "spectrum", imessage.provider || "spectrum"));
  const projectIdEnv = spectrum.projectIdEnv || "PHOTON_PROJECT_ID";
  const projectSecretEnv = spectrum.projectSecretEnv || "PHOTON_SECRET_KEY";
  const projectIdConfigured = Boolean(spectrum.projectId || process.env[projectIdEnv]);
  const projectSecretConfigured = Boolean(spectrum.projectSecret || process.env[projectSecretEnv]);
  checks.push(check("Photon project id", projectIdConfigured, spectrum.projectId ? "configured in file" : process.env[projectIdEnv] ? `${projectIdEnv} set` : `${projectIdEnv} missing`));
  checks.push(check("Photon secret", projectSecretConfigured, spectrum.projectSecret ? "configured in file" : process.env[projectSecretEnv] ? `${projectSecretEnv} set` : `${projectSecretEnv} missing`));
  const ipcSocketPath = spectrum.ipcSocketPath ? resolveConfigPath(spectrum.ipcSocketPath, { cwd: path.dirname(configPath) }) : null;
  const statusPath = spectrum.statusPath ? resolveConfigPath(spectrum.statusPath, { cwd: path.dirname(configPath) }) : null;
  const ipcExists = ipcSocketPath ? fsAccessSyncish(ipcSocketPath) : false;
  const status = readJsonSyncish(statusPath);
  const projectUsers = normalizePhotonProjectUsersCache(
    status?.projectUsers || raw.imessage?.spectrum?.projectUsersCache || null
  );
  const statusAgeMs = statusPath && status?.updatedAt ? now.getTime() - Date.parse(status.updatedAt) : null;
  checks.push(check("Spectrum IPC path", Boolean(ipcSocketPath), ipcSocketPath || "missing"));
  checks.push(check("Spectrum IPC socket", ipcExists, ipcSocketPath || "missing", { optional: true }));
  checks.push(check("Spectrum status file", Boolean(status), statusPath || "missing", { optional: true }));
  checks.push(check(
    "Photon shared users",
    projectUsers.users.length > 0,
    projectUsers.users.length > 0 ? `${projectUsers.users.length}/${projectUsers.total || projectUsers.users.length} configured` : "not synced yet",
    { optional: true }
  ));
  const allowedOutboundAddresses = [
    ...(imessage.allowedOutboundAddresses || []),
    ...(raw.targets || []).flatMap((target) => target.allowedAddresses || [])
  ].filter(Boolean);
  const allowedOutboundSpaceIds = [
    ...(imessage.allowedOutboundSpaceIds || []),
    ...(raw.targets || []).flatMap((target) => target.allowedSpaceIds || [])
  ].filter(Boolean);
  checks.push(check(
    "outbound allowlist",
    spectrum.allowOutboundToKnownSpaces !== false || allowedOutboundAddresses.length > 0 || allowedOutboundSpaceIds.length > 0,
    spectrum.allowOutboundToKnownSpaces !== false ? "known spaces allowed" : `${allowedOutboundAddresses.length} address(es), ${allowedOutboundSpaceIds.length} space(s)`
  ));
  return {
    ok: checks.filter((item) => !item.optional).every((item) => item.ok),
    path: configPath,
    parsed: true,
    provider: "spectrum",
    targetId: selectedTarget?.id || null,
    targets,
    secretRefs: {
      projectIdEnv,
      projectIdEnvSet: Boolean(process.env[projectIdEnv]),
      projectIdConfigured,
      projectSecretEnv,
      projectSecretEnvSet: Boolean(process.env[projectSecretEnv]),
      projectSecretConfigured
    },
    spectrum: {
      ipcSocketPath,
      ipcSocketExists: ipcExists,
      statusPath,
      cloudUrl: spectrum.cloudUrl || null,
      projectUsers,
      status: status ? {
        status: status.status || null,
        updatedAt: status.updatedAt || null,
        receiveLoop: status.receiveLoop || null,
        knownSpaceIds: status.knownSpaceIds || []
      } : null,
      statusAgeMs
    },
    outbound: {
      allowOutboundToKnownSpaces: spectrum.allowOutboundToKnownSpaces !== false,
      addresses: unique(allowedOutboundAddresses),
      spaceIds: unique(allowedOutboundSpaceIds)
    },
    checks
  };
}

async function inspectMcpConfig(adapter, config, { agent, codexConfigPath }) {
  const serverName = config.mcp.serverName || adapter.mcp.serverName;
  const command = mcpCommand(adapter, config);
  const resolvedCodexConfig = await resolveManagedCodexConfigPath(config, { agent, codexConfigPath });
  const checks = [
    check("MCP command", Boolean(command), command ? command.join(" ") : "missing"),
    check("Codex config", Boolean(resolvedCodexConfig) && await pathExists(resolvedCodexConfig), resolvedCodexConfig || "not found")
  ];
  let text = "";
  if (resolvedCodexConfig && await pathExists(resolvedCodexConfig)) {
    text = await fs.readFile(resolvedCodexConfig, "utf8");
  }
  const hasServer = text.includes(`[mcp_servers.${serverName}]`);
  const hasScript = config.packagePath ? text.includes(path.join(config.packagePath, adapter.mcp.script)) : false;
  const hasConfig = config.configPath ? text.includes(config.configPath) : false;
  checks.push(check("MCP server entry", hasServer, serverName));
  checks.push(check("MCP script path", hasScript, config.packagePath ? path.join(config.packagePath, adapter.mcp.script) : "missing"));
  checks.push(check("MCP config path", hasConfig, config.configPath || "missing"));
  for (const tool of adapter.mcp.tools) {
    checks.push(check(`tool ${tool}`, text.includes(`[mcp_servers.${serverName}.tools.${tool}]`) || text.includes(tool), tool, { optional: true }));
  }
  return {
    ok: checks.filter((item) => !item.optional).every((item) => item.ok),
    serverName,
    command,
    codexConfigPath: resolvedCodexConfig,
    tools: adapter.mcp.tools,
    checks
  };
}

function normalizePhotonProjectUsersCache(cache) {
  const source = cache && typeof cache === "object" ? cache : {};
  const users = (Array.isArray(source.users) ? source.users : [])
    .map((user) => ({
      id: String(user.id || "").trim() || null,
      type: String(user.type || "shared").trim(),
      displayName: String(user.displayName || [user.firstName, user.lastName].filter(Boolean).join(" ") || user.email || user.phoneNumber || "").trim() || null,
      firstName: String(user.firstName || "").trim() || null,
      lastName: String(user.lastName || "").trim() || null,
      email: String(user.email || "").trim() || null,
      phoneNumber: String(user.phoneNumber || "").trim() || null,
      assignedPhoneNumber: String(user.assignedPhoneNumber || "").trim() || null,
      projectOwner: user.projectOwner === true || user.meta?.project_owner === true,
      createdAt: String(user.createdAt || "").trim() || null,
      redirectUrl: String(user.redirectUrl || "").trim() || null
    }))
    .filter((user) => user.id || user.phoneNumber || user.assignedPhoneNumber);
  return {
    updatedAt: String(source.updatedAt || "").trim() || null,
    total: Number.isInteger(source.total) ? source.total : users.length,
    users
  };
}

async function resolveManagedCodexConfigPath(config, { agent, codexConfigPath }) {
  if (codexConfigPath) return path.resolve(expandHome(codexConfigPath));
  if (config.mcp.codexConfigPath) return config.mcp.codexConfigPath;
  if (config.codexConfigPath) return config.codexConfigPath;
  const startDir = agent?.cwd || config.packagePath || process.cwd();
  const found = await findNearestCodexConfig(startDir);
  if (found) return found;
  if (agent?.cwd) return path.join(agent.cwd, ".codex", "config.toml");
  return null;
}

function managedConnectorMcpBlock(adapter, config) {
  const serverName = config.mcp.serverName || adapter.mcp.serverName;
  const command = mcpCommand(adapter, config);
  if (!command) throw new Error(`Managed connector ${config.id} needs packagePath and configPath before MCP block generation.`);
  const [program, ...args] = command;
  return [
    `[mcp_servers.${serverName}]`,
    `command = ${tomlString(program)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    `startup_timeout_sec = ${Number(adapter.mcp.startupTimeoutSec || 30).toFixed(1)}`,
    `tool_timeout_sec = ${Number(adapter.mcp.toolTimeoutSec || 60).toFixed(1)}`,
    "",
    ...adapter.mcp.tools.flatMap((tool) => [
      `[mcp_servers.${serverName}.tools.${tool}]`,
      "approval_mode = \"approve\"",
      ""
    ])
  ].join("\n");
}

function managedConnectorMcpSectionNames(adapter, config) {
  const serverName = config.mcp.serverName || adapter.mcp.serverName;
  return new Set([
    `mcp_servers.${serverName}`,
    ...adapter.mcp.tools.map((tool) => `mcp_servers.${serverName}.tools.${tool}`)
  ]);
}

function upsertTomlSections(text, sectionNames, block) {
  const lines = text.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    const section = tomlSectionName(line);
    if (section) dropping = sectionNames.has(section);
    if (!dropping) kept.push(line);
  }
  const trimmed = kept.join("\n").trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ""}${block.trimEnd()}\n`;
}

function tomlSectionName(line) {
  const match = String(line).trim().match(/^\[([^\]]+)]$/);
  return match ? match[1] : null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

async function readText(file, fallback = null) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function loadManagedEnvironment({ home }) {
  const serviceConfig = await readJson(serviceConfigPath(home), {});
  return loadEnvFile(serviceConfig.envFile || process.env.WAKEFIELD_ENV_FILE || null);
}

function mcpCommand(adapter, config) {
  if (!config.packagePath || !config.configPath) return null;
  return [
    nodeExecutable(),
    path.join(config.packagePath, adapter.mcp.script),
    "--config",
    config.configPath
  ];
}

function processCommand(processDef, config) {
  return {
    command: nodeExecutable(),
    args: [
      path.join(config.packagePath, processDef.script),
      "--config",
      config.configPath
    ]
  };
}

function selectManagedTarget(targets, targetId) {
  if (targetId) return targets.find((target) => target.id === targetId) || null;
  return targets.length === 1 ? targets[0] : null;
}

function managedConnectorNextAction({ config, packageInspection, connectorConfig, mcp, launchAgent, health }) {
  if (!config.enabled) {
    return { id: "enable", label: "Enable connector package", reason: "The connector package is configured but disabled." };
  }
  if (!packageInspection.ok) {
    return { id: "fix-package", label: "Review connector package", reason: failedReasons(packageInspection.checks) };
  }
  if (!connectorConfig.ok) {
    return { id: "fix-config", label: "Review connector config", reason: failedReasons(connectorConfig.checks) };
  }
  if (!mcp.ok) {
    return { id: "configure-codex-tools", label: "Configure Codex tools", reason: failedReasons(mcp.checks) };
  }
  if (!launchAgent.installed) {
    return { id: "install-daemon", label: "Install connector daemon", reason: "The background connector process is not installed." };
  }
  if (launchAgent.loaded === false) {
    return { id: "load-daemon", label: "Load connector daemon", reason: "The background connector process is installed but not loaded." };
  }
  if (health && !health.ok) {
    return { id: "run-checks", label: "Run connector checks", reason: health.detail };
  }
  return { id: "run-checks", label: "Run connector checks", reason: "Connector package facts are in place." };
}

function failedReasons(checks) {
  const failed = checks.filter((item) => !item.ok && !item.optional).map((item) => item.label || item.id);
  return failed.length > 0 ? `Failed: ${failed.join(", ")}.` : null;
}

function managedConnectorWizardFields(status) {
  return [
    { id: "packagePath", label: "Connector package", required: true, pathMustExist: true, value: status.package.path || "" },
    { id: "configPath", label: "Connector config", required: true, pathMustExist: true, value: status.connectorConfig.path || "" },
    { id: "targetId", label: "Target", required: false, value: status.connectorConfig.targetId || "" },
    { id: "mcp.codexConfigPath", label: "Codex config", required: false, pathMustExist: true, value: status.mcp.codexConfigPath || "" },
    { id: "launchAgent.label", label: "LaunchAgent label", required: false, value: status.launchAgent.label || "" }
  ];
}

function managedConnectorSetupFields(adapter, status) {
  const defaults = managedConnectorSetupDefaults(adapter, status);
  return (adapter.setupFields || []).map((field) => {
    const value = defaults[field.id] ?? "";
    const envSet = field.secretEnv && value ? Boolean(process.env[String(value)]) : null;
    return {
      ...field,
      value,
      envSet
    };
  });
}

function managedConnectorSetupDefaults(adapter, status) {
  const target = status.connectorConfig?.targets?.find((item) => item.id === status.connectorConfig.targetId)
    || status.connectorConfig?.targets?.[0]
    || {};
  if (adapter.id === "discord-codex") {
    return {
      tokenEnv: status.connectorConfig?.secretRefs?.tokenEnv || "DISCORD_BOT_TOKEN",
      tokenFile: status.connectorConfig?.secretRefs?.tokenFile || "",
      commandPrefix: "!agent",
      allowedChannelIds: (status.connectorConfig?.outbound?.channelIds || target.allowedChannelIds || []).join(","),
      allowedDmUserIds: (status.connectorConfig?.outbound?.dmUserIds || target.allowedUserIds || []).join(","),
      allowedGuildIds: (target.allowedGuildIds || []).join(","),
      requiredRoleIds: (target.requiredRoleIds || []).join(","),
      triggerUserIds: (target.triggerUserIds || []).join(","),
      eventLogPath: target.eventLogPath || ""
    };
  }
  return {
    projectIdEnv: status.connectorConfig?.secretRefs?.projectIdEnv || "PHOTON_PROJECT_ID",
    projectSecretEnv: status.connectorConfig?.secretRefs?.projectSecretEnv || "PHOTON_SECRET_KEY",
    cloudUrl: status.connectorConfig?.spectrum?.cloudUrl || "",
    allowedAddresses: (status.connectorConfig?.outbound?.addresses || target.allowedAddresses || []).join(","),
    allowedSpaceIds: (status.connectorConfig?.outbound?.spaceIds || target.allowedSpaceIds || []).join(","),
    allowGroupChats: target.allowGroupChats ? "true" : "false",
    allowOutboundToKnownSpaces: status.connectorConfig?.outbound?.allowOutboundToKnownSpaces === false ? "false" : "true",
    contactsPath: "",
    eventLogPath: target.eventLogPath || ""
  };
}

function managedConnectorSmokePlan(adapter, status, kind) {
  const skillPrompt = connectorSkillPrompt(adapter.connectorId);
  if (adapter.id === "discord-codex") {
    if (kind === "reply-plan") {
      return {
        summary: "Use discord_send_message for same-channel replies.",
        items: [
          skillPrompt ? `Skill: ${skillPrompt}` : null,
          "Tool: discord_send_message",
          "Required fields: channelId, content",
          "Optional fields: replyToMessageId",
          `Allowed channels: ${status.connectorConfig.outbound?.channelIds?.join(", ") || "(none configured)"}`
        ].filter(Boolean)
      };
    }
    if (kind === "dm-plan") {
      return {
        summary: "Use discord_send_dm for allowed direct messages.",
        items: [
          skillPrompt ? `Skill: ${skillPrompt}` : null,
          "Tool: discord_send_dm",
          "Required fields: userId, content",
          `Allowed users: ${status.connectorConfig.outbound?.dmUserIds?.join(", ") || "(none configured)"}`
        ].filter(Boolean)
      };
    }
  }
  if (adapter.id === "imessage-spectrum") {
    if (kind === "diagnostic-plan") {
      return {
        summary: "Run the local-first Spectrum diagnostic CLI when receive-loop health is suspect.",
        items: [
          `Command: ${nodeExecutable()} ${path.join(status.package.path, "scripts/diagnose-spectrum-bridge.mjs")} --config ${status.connectorConfig.path}`,
          "Cloud-only check: add --deep --skip-local-history when local imsg is unavailable or you only need Photon auth/data-plane evidence.",
          "Optional: add --deep only when a human has approved Photon cloud/API probes.",
          "Optional: add --active-imsg-probe only when a human has approved a synthetic local iMessage probe.",
          "Optional: add --restart-on-stale only when a human has approved restarting the configured Spectrum LaunchAgent after stale evidence."
        ]
      };
    }
    if (kind === "reply-plan") {
      return {
        summary: "Use imessage_send_message with the source spaceId and optional replyToMessageId.",
        items: [
          skillPrompt ? `Skill: ${skillPrompt}` : null,
          "Tool: imessage_send_message",
          "Preferred fields: spaceId, replyToMessageId, text",
          "Fallback direct field: to",
          `Known-space outbound allowed: ${status.connectorConfig.outbound?.allowOutboundToKnownSpaces ? "yes" : "no"}`
        ].filter(Boolean)
      };
    }
    if (kind === "tapback-plan") {
      return {
        summary: "Use imessage_send_reaction for tapbacks, or /tapback through imessage_send_message as a compatibility path.",
        items: [
          skillPrompt ? `Skill: ${skillPrompt}` : null,
          "Tool: imessage_send_reaction",
          "Required fields: spaceId, messageId, reaction",
          "Tapback names: like, love, dislike, laugh, emphasize, question",
          "Compatibility: imessage_send_message with replyToMessageId and text '/tapback like'"
        ].filter(Boolean)
      };
    }
  }
  return {
    summary: "No specialized plan for this check.",
    items: status.commands ? Object.values(status.commands).filter(Array.isArray).map((command) => command.join(" ")) : []
  };
}

async function inspectManagedConnectorHealth(adapter, { connectorConfig, now = new Date() } = {}) {
  if (adapter.id === "imessage-spectrum") {
    const bridge = await spectrumBridgeStatus(connectorConfig.spectrum?.ipcSocketPath);
    const status = bridge.ok ? "connected" : "degraded";
    return {
      id: "spectrum-bridge",
      ok: bridge.ok,
      status,
      detail: bridge.detail,
      checkedAt: now.toISOString(),
      check: check("live bridge", bridge.ok, bridge.detail)
    };
  }
  return null;
}

async function spectrumBridgeStatus(ipcSocketPath) {
  if (!ipcSocketPath) {
    return { ok: false, detail: "Spectrum IPC socket path is not configured." };
  }
  if (!await pathExists(ipcSocketPath)) {
    return { ok: false, detail: `Spectrum IPC socket is missing: ${ipcSocketPath}` };
  }
  return new Promise((resolve) => {
    const socket = net.createConnection(ipcSocketPath);
    const timeout = setTimeout(() => {
      socket.destroy();
      resolve({ ok: false, detail: "Timed out waiting for Spectrum IPC status." });
    }, 3000);
    let text = "";
    socket.once("connect", () => {
      socket.write(`${JSON.stringify({ id: "wakefield-status", method: "status" })}\n`);
    });
    socket.on("data", (chunk) => {
      text += chunk.toString("utf8");
      if (!text.includes("\n")) return;
      clearTimeout(timeout);
      socket.end();
      try {
        const response = JSON.parse(text.trim().split("\n")[0]);
        const recentError = recentSpectrumBridgeError(response.result?.receiveLoop);
        const degradedStatus = degradedSpectrumBridgeStatus(response.result);
        resolve({
          ok: Boolean(response.ok) && !recentError && !degradedStatus,
          detail: recentError
            ? `Recent ${recentError.label}: ${recentError.message}`
            : degradedStatus
              ? degradedStatus.detail
              : response.ok ? response.result?.status || "status returned" : response.error || "status failed",
          response
        });
      } catch (error) {
        resolve({ ok: false, detail: `Invalid Spectrum IPC JSON: ${error.message}` });
      }
    });
    socket.once("error", (error) => {
      clearTimeout(timeout);
      resolve({ ok: false, detail: error.message });
    });
  });
}

function recentSpectrumBridgeError(receiveLoop, { now = Date.now(), maxAgeMs = 10 * 60 * 1000 } = {}) {
  if (!receiveLoop?.lastError) {
    return null;
  }
  const at = Date.parse(receiveLoop.lastErrorAt || "");
  if (!Number.isFinite(at) || now - at > maxAgeMs) {
    return null;
  }
  return {
    at: receiveLoop.lastErrorAt,
    message: firstLine(receiveLoop.lastError),
    label: spectrumBridgeErrorLabel(receiveLoop.lastError)
  };
}

function degradedSpectrumBridgeStatus(result) {
  const status = String(result?.status || "").trim();
  if (!/degraded|failed|errored|rate-limited|offline|restarting|rotating|stopping/i.test(status)) {
    return null;
  }
  const error = firstLine(result?.receiveLoop?.lastError);
  return {
    status,
    detail: error ? `${status}: ${error}` : status
  };
}

function firstLine(value) {
  return String(value || "").split(/\r?\n/)[0];
}

function spectrumBridgeErrorLabel(value) {
  const message = firstLine(value);
  if (/Authentication failed|unauth/i.test(message)) return "Photon auth error";
  if (/Target not allowed for this project/i.test(message)) return "Photon target authorization error";
  if (/Unknown server error|Service temporarily unavailable|internalError|Connection dropped/i.test(message)) return "Photon data-plane error";
  return "bridge error";
}

async function execFileJson(execFileImpl, command, args, {
  cwd,
  timeout,
  tolerateExitCodes = []
} = {}) {
  try {
    const result = await execFileImpl(command, args, {
      cwd,
      timeout
    });
    return {
      code: 0,
      text: result.stdout,
      json: parseMaybeJson(result.stdout)
    };
  } catch (error) {
    if (tolerateExitCodes.includes(error.code)) {
      return {
        code: error.code,
        text: error.stdout || error.stderr || error.message,
        json: parseMaybeJson(error.stdout || error.stderr)
      };
    }
    throw error;
  }
}

function parseMaybeJson(text) {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function findNearestCodexConfig(startDir) {
  if (!startDir) return null;
  let current = path.resolve(startDir);
  for (;;) {
    const candidate = path.join(current, ".codex", "config.toml");
    if (await pathExists(candidate)) return candidate;
    const next = path.dirname(current);
    if (next === current) return null;
    current = next;
  }
}

function managedConnectorLogPaths(config, { home }) {
  const root = path.join(logsDir(home), "managed-connectors");
  const label = launchAgentLabel(config);
  return {
    out: path.join(root, `${label}.out.log`),
    err: path.join(root, `${label}.err.log`)
  };
}

function launchAgentLabel(config) {
  return config.launchAgent?.label || `com.wakefield.connector.${safeId(config.id)}`;
}

function launchAgentSupported(launchAgentsPath) {
  return process.platform === "darwin" || Boolean(process.env.WAKEFIELD_LAUNCH_AGENTS_DIR) || !isDefaultLaunchAgentsPath(launchAgentsPath);
}

function assertLaunchAgentSupported(launchAgentsPath) {
  if (!launchAgentSupported(launchAgentsPath)) {
    throw new Error("Managed connector LaunchAgent install is only supported on macOS.");
  }
}

function assertLaunchctlSupported(context) {
  if (!context.supported) {
    throw new Error("Managed connector LaunchAgent load/unload is only supported through launchctl on macOS.");
  }
}

function isDefaultLaunchAgentsPath(value) {
  return path.resolve(value) === path.resolve(launchAgentsDir({}));
}

function launchctlContext() {
  const hasUid = typeof process.getuid === "function";
  const userTarget = hasUid ? `gui/${process.getuid()}` : null;
  return {
    supported: process.platform === "darwin" && hasUid,
    userTarget
  };
}

async function launchAgentLoaded(label, launchAgentsPath) {
  if (process.platform !== "darwin" || !isDefaultLaunchAgentsPath(launchAgentsPath) || typeof process.getuid !== "function") {
    return null;
  }
  try {
    await execFileAsync("launchctl", ["print", `gui/${process.getuid()}/${label}`]);
    return true;
  } catch {
    return false;
  }
}

function launchAgentLoadCommands({ plistPath, label, reload, context }) {
  const commands = [];
  if (!context.userTarget) return commands;
  if (reload) {
    commands.push({
      cmd: "launchctl",
      args: ["bootout", context.userTarget, plistPath],
      allowFailure: true
    });
  }
  commands.push({
    cmd: "launchctl",
    args: ["bootstrap", context.userTarget, plistPath],
    allowFailure: false
  });
  commands.push({
    cmd: "launchctl",
    args: ["kickstart", "-k", `${context.userTarget}/${label}`],
    allowFailure: true
  });
  return commands;
}

function launchAgentUnloadCommands({ label, context }) {
  if (!context.userTarget) return [];
  return [{
    cmd: "launchctl",
    args: ["bootout", `${context.userTarget}/${label}`],
    allowFailure: true
  }];
}

async function runLaunchctlCommands(commands, {
  runner,
  ignoreFirstBootoutFailure = false
} = {}) {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    try {
      await runner(command.cmd, command.args);
    } catch (error) {
      const ignore = command.allowFailure || (ignoreFirstBootoutFailure && index === 0 && command.args[0] === "bootout");
      if (!ignore) throw error;
    }
  }
}

function launchctlResult({ action, dryRun, ok, supported, plistPath, label, commands, skipped, status }) {
  return {
    action,
    dryRun: Boolean(dryRun),
    ok: Boolean(ok),
    supported: Boolean(supported),
    plistPath,
    label,
    commands,
    skipped,
    status
  };
}

function plist(value) {
  const lines = [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    renderPlistValue(value, 0),
    "</plist>"
  ];
  return `${lines.join("\n")}\n`;
}

function renderPlistValue(value, indent) {
  const pad = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return [`${pad}<array>`, ...value.map((item) => renderPlistValue(item, indent + 1)), `${pad}</array>`].join("\n");
  }
  if (value && typeof value === "object") {
    const lines = [`${pad}<dict>`];
    for (const [key, item] of Object.entries(value)) {
      if (item == null) continue;
      lines.push(`${"  ".repeat(indent + 1)}<key>${xmlEscape(key)}</key>`);
      lines.push(renderPlistValue(item, indent + 1));
    }
    lines.push(`${pad}</dict>`);
    return lines.join("\n");
  }
  if (typeof value === "boolean") return `${pad}<${value ? "true" : "false"}/>`;
  if (typeof value === "number") return `${pad}<integer>${Math.round(value)}</integer>`;
  return `${pad}<string>${xmlEscape(String(value))}</string>`;
}

function cliPath() {
  return new URL("cli.mjs", import.meta.url).pathname;
}

function xmlEscape(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}

function setNestedSetting(target, key, value) {
  const parts = String(key).split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current[part] = current[part] && typeof current[part] === "object" ? current[part] : {};
    current = current[part];
  }
  current[parts.at(-1)] = value;
}

function deleteNestedSetting(target, key) {
  const parts = String(key).split(".");
  let current = target;
  for (const part of parts.slice(0, -1)) {
    current = current?.[part];
    if (!current || typeof current !== "object") return;
  }
  delete current[parts.at(-1)];
}

function fsAccessSyncish(file) {
  if (!file) return false;
  try {
    const stat = statSync(file);
    return stat ? true : false;
  } catch {
    return false;
  }
}

function readJsonSyncish(file) {
  if (!file) return null;
  try {
    return JSON.parse(readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function unique(values) {
  return [...new Set(values.filter(Boolean).map(String))];
}

function asList(value) {
  return Array.isArray(value) ? value.filter(Boolean).map(String) : [];
}

function setting(settings, key, fallback = null) {
  const value = settings?.[key];
  if (value == null) return fallback;
  if (typeof value === "string" && value.trim() === "") return fallback;
  return value;
}

function listSetting(settings, key, fallbackKey = null) {
  const value = settings?.[key] ?? (fallbackKey ? settings?.[fallbackKey] : undefined);
  if (Array.isArray(value)) return unique(value);
  if (value == null || value === "") return [];
  return unique(String(value).split(",").map((item) => item.trim()));
}

function booleanSetting(settings, key, fallback = false) {
  const value = settings?.[key];
  if (value == null || value === "") return fallback;
  if (typeof value === "boolean") return value;
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}

function numberSetting(settings, key, fallback) {
  const value = settings?.[key];
  if (value == null || value === "") return fallback;
  const number = Number(value);
  return Number.isFinite(number) ? number : fallback;
}

function safeId(value) {
  return String(value || "connector").toLowerCase().replace(/[^a-z0-9.-]+/g, "-").replace(/^-+|-+$/g, "") || "connector";
}

function sameResolvedPath(left, right) {
  if (!left || !right) return false;
  return path.resolve(left) === path.resolve(right);
}

function check(id, ok, detail, { optional = false } = {}) {
  return {
    id: safeId(id),
    label: id,
    ok: Boolean(ok),
    detail,
    optional: Boolean(optional)
  };
}
