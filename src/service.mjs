import fs from "node:fs/promises";
import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import { connectorStatus } from "./connectors.mjs";
import { dutyStatuses, runDueDuties } from "./duties.mjs";
import { pollEmailImap } from "./email-imap.mjs";
import { loadEnvFile } from "./service-env.mjs";
import { ensureDir, pathExists, readJson, writeJson } from "./json-store.mjs";
import { dispatchExternalMessage } from "./inbox-dispatch.mjs";
import { pollImessageChatDb } from "./imessage-chatdb.mjs";
import { listExternalMessages } from "./external-messages.mjs";
import { processDreams } from "./memory.mjs";
import { nodeExecutable } from "./node-runtime.mjs";
import { appHome, expandHome, launchAgentsDir, logsDir, serviceConfigPath } from "./paths.mjs";
import { loadAgent } from "./profile.mjs";

const DEFAULT_INTERVAL_MINUTES = 15;
const DEFAULT_DISPATCH_LIMIT = 3;
const DEFAULT_DISPATCH_MODE = "ipc";
export const LAUNCH_AGENT_LABEL = "com.wakefield.service";
const execFileAsync = promisify(execFile);

export async function serviceStatus({
  home = appHome(),
  now = new Date()
} = {}) {
  const config = await loadServiceConfig(home);
  const environment = await loadServiceEnvironment(config);
  const agent = await loadAgent(null, home);
  const pendingExternalMessages = agent
    ? (await listExternalMessages(agent, { status: "pending", limit: 10000 })).length
    : 0;
  const duties = await dutyStatuses({ home, now });
  return {
    ok: Boolean(agent && config.enabled),
    enabled: Boolean(config.enabled),
    intervalMinutes: config.intervalMinutes,
    lastRunAt: config.lastRunAt || null,
    nextRunAt: nextRunAt(config),
    externalDispatch: {
      ...config.externalDispatch,
      pending: pendingExternalMessages
    },
    duties: {
      total: duties.wakeups.length,
      enabled: duties.wakeups.filter((duty) => duty.enabled).length,
      due: duties.wakeups.filter((duty) => duty.due).length,
      items: duties.wakeups
    },
    environment,
    scheduler: await launchAgentStatus({ home }),
    agent: agent ? {
      id: agent.id,
      name: agent.name,
      threadId: agent.threadId || null
    } : null,
    configPath: serviceConfigPath(home),
    now: now.toISOString()
  };
}

export async function configureService({
  home = appHome(),
  enabled = null,
  intervalMinutes = null,
  dispatchEnabled = null,
  dispatchMode = null,
  dispatchLimit = null,
  envFile = null,
  clearEnvFile = false
} = {}) {
  const current = await loadServiceConfig(home);
  const hasEnvFile = envFile != null && envFile !== false;
  const next = {
    ...current,
    enabled: enabled == null ? current.enabled : Boolean(enabled),
    intervalMinutes: intervalMinutes == null ? current.intervalMinutes : normalizeInterval(intervalMinutes),
    envFile: clearEnvFile
      ? null
      : hasEnvFile
        ? normalizeEnvFile(envFile)
        : current.envFile,
    externalDispatch: {
      ...current.externalDispatch,
      enabled: dispatchEnabled == null ? current.externalDispatch.enabled : Boolean(dispatchEnabled),
      mode: dispatchMode == null ? current.externalDispatch.mode : normalizeDispatchMode(dispatchMode),
      limit: dispatchLimit == null ? current.externalDispatch.limit : normalizeDispatchLimit(dispatchLimit)
    },
    updatedAt: new Date().toISOString()
  };
  await writeJson(serviceConfigPath(home), next);
  return serviceStatus({ home });
}

export async function runServiceOnce({
  home = appHome(),
  limit = 10,
  capture = true,
  connectorClients = {},
  dispatchClient = null,
  dispatchSocketPath = null,
  now = new Date()
} = {}) {
  const config = await loadServiceConfig(home);
  const environment = await loadServiceEnvironment(config);
  const agent = await loadAgent(null, home);
  if (!agent) {
    return {
      ok: false,
      ranAt: now.toISOString(),
      reason: "No Wakefield agent is initialized yet.",
      environment,
      dreamer: null,
      duties: null,
      externalDispatch: null,
      service: await serviceStatus({ home, now })
    };
  }

  const dreamer = await processDreams(agent, { limit, capture, now });
  const duties = await runDueDuties(agent, {
    home,
    dispatchClient,
    dispatchSocketPath,
    now
  });
  const connectorPolls = await pollReadyConnectors(agent, {
    home,
    connectorClients,
    now
  });
  const externalDispatch = config.externalDispatch.enabled
    ? await dispatchPendingExternalMessages(agent, {
      mode: config.externalDispatch.mode,
      limit: config.externalDispatch.limit,
      client: dispatchClient,
      socketPath: dispatchSocketPath,
      now
    })
    : {
      enabled: false,
      mode: config.externalDispatch.mode,
      limit: config.externalDispatch.limit,
      attempted: 0,
      delivered: 0,
      failed: 0,
      pending: (await listExternalMessages(agent, { status: "pending", limit: 10000 })).length,
      results: []
    };
  const nextConfig = {
    ...config,
    lastRunAt: now.toISOString(),
    updatedAt: now.toISOString()
  };
  await writeJson(serviceConfigPath(home), nextConfig);

  return {
    ok: true,
    ranAt: now.toISOString(),
    reason: null,
    environment,
    dreamer,
    duties,
    connectorPolls,
    externalDispatch,
    service: await serviceStatus({ home, now })
  };
}

export function formatServiceStatus(status) {
  const lines = [
    "Wakefield service",
    `enabled: ${status.enabled ? "yes" : "no"}`,
    `interval: ${status.intervalMinutes} minutes`,
    `external dispatch: ${status.externalDispatch.enabled ? `${status.externalDispatch.mode}, limit ${status.externalDispatch.limit}` : "disabled"}`,
    `env file: ${formatEnvironment(status.environment)}`,
    `duties: ${status.duties.enabled}/${status.duties.total} enabled, ${status.duties.due} due`,
    `pending external messages: ${status.externalDispatch.pending}`,
    `agent: ${status.agent ? `${status.agent.name} (${status.agent.id})` : "not configured"}`,
    `last run: ${status.lastRunAt || "never"}`,
    `next run: ${status.nextRunAt || "not scheduled"}`
  ];
  return lines.join("\n");
}

export function formatServiceRun(result) {
  if (!result.ok) return `Service did not run: ${result.reason}`;
  const queued = (result.connectorPolls || []).reduce((total, poll) => total + (poll.queued || 0), 0);
  return `Service ran. Dreams processed: ${result.dreamer.processed}. Wakeups attempted: ${result.duties.attempted}. Connector messages queued: ${queued}. External messages delivered: ${result.externalDispatch.delivered}.`;
}

export async function launchAgentStatus({
  home = appHome(),
  launchAgentsPath = launchAgentsDir()
} = {}) {
  const plistPath = launchAgentPath({ launchAgentsPath });
  const installed = await pathExists(plistPath);
  const loaded = await launchAgentLoaded(launchAgentsPath);
  const launchctl = launchctlContext();
  return {
    kind: "launch-agent",
    supported: launchAgentSupported(launchAgentsPath),
    canLoad: launchctl.supported,
    launchctlTarget: launchctl.serviceTarget,
    label: LAUNCH_AGENT_LABEL,
    installed,
    loaded,
    plistPath,
    expectedProgram: launchAgentCommand()[0],
    home
  };
}

export async function launchAgentPlist({
  home = appHome(),
  intervalMinutes = null
} = {}) {
  const config = await loadServiceConfig(home);
  const interval = normalizeInterval(intervalMinutes || config.intervalMinutes);
  const [nodePath, cliPath, ...args] = launchAgentCommand();
  const logRoot = logsDir(home);
  const env = {
    WAKEFIELD_HOME: home
  };
  if (config.envFile) env.WAKEFIELD_ENV_FILE = config.envFile;
  if (process.env.CODEX_HOME) env.CODEX_HOME = process.env.CODEX_HOME;

  return plist({
    Label: LAUNCH_AGENT_LABEL,
    ProgramArguments: [nodePath, cliPath, ...args],
    StartInterval: interval * 60,
    RunAtLoad: true,
    StandardOutPath: path.join(logRoot, "service.out.log"),
    StandardErrorPath: path.join(logRoot, "service.err.log"),
    EnvironmentVariables: env
  });
}

export async function installLaunchAgent({
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  intervalMinutes = null,
  dryRun = false,
  load = false,
  reload = false,
  launchctlRunner = execFileAsync
} = {}) {
  const config = await loadServiceConfig(home);
  const interval = normalizeInterval(intervalMinutes || config.intervalMinutes);
  const plistText = await launchAgentPlist({ home, intervalMinutes: interval });
  const plistPath = launchAgentPath({ launchAgentsPath });

  if (!dryRun) {
    assertLaunchAgentSupported(launchAgentsPath);
    await configureService({ home, enabled: true, intervalMinutes: interval });
    await ensureDir(launchAgentsPath);
    await ensureDir(logsDir(home));
    await fs.writeFile(plistPath, plistText);
  }

  const shouldLoad = Boolean(load || reload);
  const loadResult = shouldLoad
    ? await loadLaunchAgent({
      home,
      launchAgentsPath,
      dryRun,
      reload: Boolean(reload),
      launchctlRunner
    })
    : null;

  return {
    dryRun: Boolean(dryRun),
    action: "install",
    plistPath,
    label: LAUNCH_AGENT_LABEL,
    intervalMinutes: interval,
    plist: plistText,
    loadResult,
    status: dryRun ? await launchAgentStatus({ home, launchAgentsPath }) : await launchAgentStatus({ home, launchAgentsPath })
  };
}

export async function uninstallLaunchAgent({
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  unload = false,
  launchctlRunner = execFileAsync
} = {}) {
  const plistPath = launchAgentPath({ launchAgentsPath });
  const existed = await pathExists(plistPath);
  const unloadResult = unload
    ? await unloadLaunchAgent({
      home,
      launchAgentsPath,
      dryRun,
      launchctlRunner
    })
    : null;
  if (!dryRun && existed) {
    assertLaunchAgentSupported(launchAgentsPath);
    await fs.unlink(plistPath);
  }
  if (!dryRun) {
    await configureService({ home, enabled: false });
  }
  return {
    dryRun: Boolean(dryRun),
    action: "uninstall",
    plistPath,
    label: LAUNCH_AGENT_LABEL,
    removed: existed && !dryRun,
    unloadResult,
    status: await launchAgentStatus({ home, launchAgentsPath })
  };
}

export async function loadLaunchAgent({
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  reload = false,
  launchctlRunner = execFileAsync
} = {}) {
  const plistPath = launchAgentPath({ launchAgentsPath });
  const context = launchctlContext();
  const installed = await pathExists(plistPath);
  const commands = launchAgentLoadCommands({ plistPath, reload, context });

  if (!dryRun) {
    assertLaunchAgentSupported(launchAgentsPath);
    assertLaunchctlSupported(context);
    if (!installed) throw new Error(`Wakefield LaunchAgent is not installed: ${plistPath}`);
    const loaded = await launchAgentLoaded(launchAgentsPath);
    if (loaded && !reload) {
      return launchctlResult({
        action: "load",
        dryRun,
        ok: true,
        supported: context.supported,
        plistPath,
        commands: [],
        skipped: "already-loaded",
        status: await launchAgentStatus({ home, launchAgentsPath })
      });
    }
    await runLaunchctlCommands(commands, { runner: launchctlRunner, ignoreFirstBootoutFailure: Boolean(reload) });
  }

  return launchctlResult({
    action: reload ? "reload" : "load",
    dryRun,
    ok: true,
    supported: context.supported,
    plistPath,
    commands,
    skipped: !context.supported ? "launchctl-unavailable" : null,
    status: await launchAgentStatus({ home, launchAgentsPath })
  });
}

export async function unloadLaunchAgent({
  home = appHome(),
  launchAgentsPath = launchAgentsDir(),
  dryRun = false,
  launchctlRunner = execFileAsync
} = {}) {
  const plistPath = launchAgentPath({ launchAgentsPath });
  const context = launchctlContext();
  const commands = launchAgentUnloadCommands({ context });

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
    plistPath,
    commands,
    skipped: !context.supported ? "launchctl-unavailable" : null,
    status: await launchAgentStatus({ home, launchAgentsPath })
  });
}

export function formatLaunchAgentStatus(status) {
  return [
    "Wakefield LaunchAgent",
    `supported: ${status.supported ? "yes" : "no"}`,
    `launchctl: ${status.canLoad ? "available" : "unavailable"}`,
    `installed: ${status.installed ? "yes" : "no"}`,
    `loaded: ${status.loaded == null ? "unknown" : status.loaded ? "yes" : "no"}`,
    `label: ${status.label}`,
    `plist: ${status.plistPath}`
  ].join("\n");
}

export function formatLaunchAgentResult(result) {
  const verb = {
    install: "Install",
    uninstall: "Uninstall",
    load: "Load",
    reload: "Reload",
    unload: "Unload"
  }[result.action] || "LaunchAgent";
  const past = {
    load: "Loaded",
    reload: "Reloaded",
    unload: "Unloaded"
  }[result.action] || `${verb}ed`;
  if (result.dryRun) return `${verb} dry run: ${result.plistPath}`;
  if (result.action === "install") {
    const lines = [`Installed Wakefield LaunchAgent: ${result.plistPath}`];
    if (result.loadResult) lines.push(formatLaunchAgentResult(result.loadResult));
    return lines.join("\n");
  }
  if (result.action === "uninstall") {
    const lines = [
      result.removed
        ? `Removed Wakefield LaunchAgent: ${result.plistPath}`
        : `Wakefield LaunchAgent was not installed: ${result.plistPath}`
    ];
    if (result.unloadResult) lines.unshift(formatLaunchAgentResult(result.unloadResult));
    return lines.join("\n");
  }
  if (result.skipped === "already-loaded") return "Wakefield LaunchAgent is already loaded.";
  if (result.skipped === "launchctl-unavailable") return "Wakefield LaunchAgent launchctl action was skipped because launchctl is unavailable.";
  return `${past} Wakefield LaunchAgent: ${result.plistPath}`;
}

async function loadServiceConfig(home) {
  const current = await readJson(serviceConfigPath(home), {});
  return {
    enabled: Boolean(current.enabled),
    intervalMinutes: normalizeInterval(current.intervalMinutes || DEFAULT_INTERVAL_MINUTES),
    externalDispatch: normalizeExternalDispatch(current.externalDispatch),
    envFile: normalizeEnvFile(current.envFile || process.env.WAKEFIELD_ENV_FILE || null),
    lastRunAt: current.lastRunAt || null,
    updatedAt: current.updatedAt || null
  };
}

export async function loadServiceEnvironment(config, options = {}) {
  return loadEnvFile(config?.envFile || null, options);
}

async function dispatchPendingExternalMessages(agent, {
  mode,
  limit,
  client,
  socketPath,
  now
}) {
  const max = normalizeDispatchLimit(limit);
  const results = [];

  for (let index = 0; index < max; index += 1) {
    const pending = await listExternalMessages(agent, { status: "pending", limit: 1 });
    if (pending.length === 0) break;
    const result = await dispatchExternalMessage(agent, {
      id: pending[0].id,
      mode,
      client,
      socketPath,
      now
    });
    results.push(result);
    if (result.status !== "delivered") break;
  }

  const pending = await listExternalMessages(agent, { status: "pending", limit: 10000 });
  return {
    enabled: true,
    mode,
    limit: max,
    attempted: results.length,
    delivered: results.filter((result) => result.status === "delivered").length,
    failed: results.filter((result) => !result.ok).length,
    pending: pending.length,
    results
  };
}

async function pollReadyConnectors(agent, {
  home,
  connectorClients,
  now
}) {
  const polls = [];
  const email = await connectorStatus("email", { home });
  if (email.ready) {
    polls.push(await pollEmailImap(agent, {
      home,
      mailboxClient: connectorClients.email || null,
      now
    }));
  }
  const imessage = await connectorStatus("imessage", { home });
  if (imessage.ready) {
    polls.push(await pollImessageChatDb(agent, {
      home,
      rows: connectorClients.imessageRows || null,
      sqlitePath: connectorClients.sqlitePath || "sqlite3",
      now
    }));
  }
  return polls;
}

function normalizeInterval(value) {
  const interval = Number(value);
  if (!Number.isFinite(interval) || interval < 1) {
    throw new Error("Service interval must be at least 1 minute.");
  }
  return Math.round(interval);
}

function normalizeExternalDispatch(value = {}) {
  const source = value && typeof value === "object" ? value : {};
  return {
    enabled: Boolean(source.enabled),
    mode: normalizeDispatchMode(source.mode || DEFAULT_DISPATCH_MODE),
    limit: normalizeDispatchLimit(source.limit || DEFAULT_DISPATCH_LIMIT)
  };
}

function normalizeDispatchMode(value) {
  const mode = String(value || DEFAULT_DISPATCH_MODE).trim();
  if (["ipc", "auto", "steer", "start", "dry-run", "manual"].includes(mode)) return mode;
  throw new Error("External dispatch mode must be ipc, auto, steer, start, dry-run, or manual.");
}

function normalizeDispatchLimit(value) {
  const limit = Number(value);
  if (!Number.isFinite(limit) || limit < 1) {
    throw new Error("External dispatch limit must be at least 1.");
  }
  return Math.round(limit);
}

function normalizeEnvFile(value) {
  if (value == null || value === false) return null;
  const text = String(value).trim();
  return text ? expandHome(text) : null;
}

function formatEnvironment(environment = {}) {
  if (!environment.configured) return "not configured";
  const state = environment.loaded
    ? `loaded ${environment.loadedKeys?.length || 0}/${environment.keys?.length || 0} variable(s)`
    : environment.exists
      ? "not loaded"
      : "missing";
  const warning = environment.warnings?.length > 0
    ? `; ${environment.warnings.join(" ")}`
    : "";
  return `${environment.path || "unknown"} (${state}${warning})`;
}

function nextRunAt(config) {
  if (!config.enabled || !config.lastRunAt) return null;
  const last = new Date(config.lastRunAt);
  if (Number.isNaN(last.getTime())) return null;
  return new Date(last.getTime() + config.intervalMinutes * 60 * 1000).toISOString();
}

function launchAgentPath({ launchAgentsPath = launchAgentsDir() } = {}) {
  return path.join(launchAgentsPath, `${LAUNCH_AGENT_LABEL}.plist`);
}

async function launchAgentLoaded(launchAgentsPath) {
  if (process.platform !== "darwin" || !isDefaultLaunchAgentsPath(launchAgentsPath) || typeof process.getuid !== "function") {
    return null;
  }
  try {
    await execFileAsync("launchctl", ["print", `gui/${process.getuid()}/${LAUNCH_AGENT_LABEL}`]);
    return true;
  } catch {
    return false;
  }
}

function launchAgentSupported(launchAgentsPath) {
  return process.platform === "darwin" || Boolean(process.env.WAKEFIELD_LAUNCH_AGENTS_DIR) || !isDefaultLaunchAgentsPath(launchAgentsPath);
}

function assertLaunchAgentSupported(launchAgentsPath) {
  if (!launchAgentSupported(launchAgentsPath)) {
    throw new Error("Wakefield LaunchAgent install is only supported on macOS.");
  }
}

function assertLaunchctlSupported(context) {
  if (!context.supported) {
    throw new Error("Wakefield LaunchAgent load/unload is only supported through launchctl on macOS.");
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
    userTarget,
    serviceTarget: userTarget ? `${userTarget}/${LAUNCH_AGENT_LABEL}` : null
  };
}

function launchAgentLoadCommands({ plistPath, reload, context }) {
  const commands = [];
  if (!context.userTarget || !context.serviceTarget) return commands;
  if (reload) commands.push(["bootout", context.serviceTarget]);
  commands.push(["bootstrap", context.userTarget, plistPath]);
  commands.push(["enable", context.serviceTarget]);
  commands.push(["kickstart", "-k", context.serviceTarget]);
  return commands.map(launchctlCommand);
}

function launchAgentUnloadCommands({ context }) {
  if (!context.serviceTarget) return [];
  return [launchctlCommand(["bootout", context.serviceTarget])];
}

function launchctlCommand(args) {
  return {
    executable: "launchctl",
    args
  };
}

async function runLaunchctlCommands(commands, {
  runner,
  ignoreFirstBootoutFailure = false
} = {}) {
  for (let index = 0; index < commands.length; index += 1) {
    const command = commands[index];
    try {
      await runner(command.executable, command.args);
    } catch (error) {
      if (ignoreFirstBootoutFailure && index === 0 && command.args[0] === "bootout") continue;
      throw error;
    }
  }
}

function launchctlResult({
  action,
  dryRun,
  ok,
  supported,
  plistPath,
  commands,
  skipped,
  status
}) {
  return {
    action,
    dryRun: Boolean(dryRun),
    ok: Boolean(ok),
    supported: Boolean(supported),
    plistPath,
    label: LAUNCH_AGENT_LABEL,
    commands,
    skipped,
    status
  };
}

function launchAgentCommand() {
  const cliPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  return [nodeExecutable(), cliPath, "service", "run-once"];
}

function plist(value) {
  const body = plistValue(value, 1);
  return [
    '<?xml version="1.0" encoding="UTF-8"?>',
    '<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">',
    '<plist version="1.0">',
    body,
    "</plist>",
    ""
  ].join("\n");
}

function plistValue(value, indent) {
  const prefix = "  ".repeat(indent);
  if (Array.isArray(value)) {
    return [
      `${prefix}<array>`,
      ...value.map((item) => plistValue(item, indent + 1)),
      `${prefix}</array>`
    ].join("\n");
  }
  if (value && typeof value === "object") {
    return [
      `${prefix}<dict>`,
      ...Object.entries(value).flatMap(([key, item]) => [
        `${"  ".repeat(indent + 1)}<key>${escapeXml(key)}</key>`,
        plistValue(item, indent + 1)
      ]),
      `${prefix}</dict>`
    ].join("\n");
  }
  if (typeof value === "boolean") return `${prefix}<${value ? "true" : "false"}/>`;
  if (typeof value === "number") return `${prefix}<integer>${value}</integer>`;
  return `${prefix}<string>${escapeXml(value)}</string>`;
}

function escapeXml(value) {
  return String(value)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&apos;");
}
