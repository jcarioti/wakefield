import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG = {
  bot: {
    tokenEnv: "DISCORD_BOT_TOKEN",
    tokenFile: null,
    commandPrefix: "!rick",
    ignoreBotMessages: true,
    processLockRoot: null,
    processLockStaleMs: 10000
  },
  codex: {
    connectorSkillPrompt: "Use $wakefield-discord for Discord connector routing.",
    socketPath: null,
    connectTimeoutMs: 10000,
    requestTimeoutMs: 30000,
    lockTimeoutMs: 45000,
    lockStaleMs: 90000,
    deepLinkWake: {
      enabled: true,
      waitMs: 30000,
      pollMs: 1000,
      reopenMs: 6000
    },
    appServer: {
      controlSocketPath: null,
      codexPath: null,
      ensureDaemon: true,
      requireRemoteControlConnected: true,
      connectTimeoutMs: 10000,
      requestTimeoutMs: 30000,
      startupTimeoutMs: 15000
    }
  },
  discord: {
    allowedOutboundChannelIds: [],
    allowedDmUserIds: [],
    typing: {
      enabled: true,
      intervalMs: 6000,
      maxMs: 1800000,
      completionTimeoutMs: 1800000,
      completionPollMs: 1500
    },
    presence: {
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
    }
  },
  targets: []
};

export function parseCliArgs(argv = process.argv.slice(2)) {
  const args = {};
  for (let i = 0; i < argv.length; i += 1) {
    const value = argv[i];
    if (value === "--config") {
      args.configPath = argv[++i];
    } else if (value?.startsWith("--config=")) {
      args.configPath = value.slice("--config=".length);
    } else if (value === "--target") {
      args.targetId = argv[++i];
    } else if (value?.startsWith("--target=")) {
      args.targetId = value.slice("--target=".length);
    } else if (value === "--mode") {
      args.mode = argv[++i];
    } else if (value?.startsWith("--mode=")) {
      args.mode = value.slice("--mode=".length);
    } else if (value === "--text") {
      args.text = argv[++i];
    } else if (value?.startsWith("--text=")) {
      args.text = value.slice("--text=".length);
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    }
  }
  return args;
}

export function expandPath(value, { cwd = process.cwd(), home = os.homedir() } = {}) {
  if (value == null || value === "") {
    return null;
  }
  if (value === "~") {
    return home;
  }
  if (value.startsWith("~/")) {
    return path.join(home, value.slice(2));
  }
  return path.isAbsolute(value) ? value : path.resolve(cwd, value);
}

export function defaultConfigPath(env = process.env) {
  return env.CODEX_DISCORD_CONFIG || "connectors/discord-codex/config.local.json";
}

export async function loadConnectorConfig({
  configPath = defaultConfigPath(),
  env = process.env,
  cwd = process.cwd(),
  required = true
} = {}) {
  const resolvedPath = expandPath(configPath, { cwd });
  let loaded = {};
  if (resolvedPath != null) {
    try {
      loaded = JSON.parse(await fs.readFile(resolvedPath, "utf8"));
    } catch (error) {
      if (error?.code !== "ENOENT" || required) {
        throw new Error(`Failed to read Discord Codex config at ${resolvedPath}: ${error.message}`);
      }
    }
  }

  const config = normalizeConfig(deepMerge(DEFAULT_CONFIG, loaded), {
    configPath: resolvedPath,
    cwd
  });

  if (env.CODEX_IPC_SOCKET) {
    config.codex.socketPath = env.CODEX_IPC_SOCKET;
  }

  return config;
}

export async function getDiscordBotCredential(config, env = process.env) {
  const key = config.bot?.tokenEnv || "DISCORD_BOT_TOKEN";
  const envValue = env[key];
  if (envValue) {
    return envValue.trim();
  }
  const tokenFile = config.bot?.tokenFile;
  if (tokenFile) {
    try {
      const fileValue = await fs.readFile(expandPath(tokenFile), "utf8");
      const trimmed = fileValue.trim();
      if (trimmed) {
        return trimmed;
      }
    } catch (error) {
      throw new Error(`Failed to read Discord bot token file ${tokenFile}: ${error.message}`);
    }
  }
  throw new Error(`Missing Discord bot credential. Set ${key} or bot.tokenFile in the connector config.`);
}

export function getTarget(config, targetId = null) {
  const targets = config.targets || [];
  if (targetId) {
    const target = targets.find((candidate) => candidate.id === targetId);
    if (!target) {
      throw new Error(`Unknown Discord Codex target: ${targetId}`);
    }
    return target;
  }
  if (targets.length === 1) {
    return targets[0];
  }
  throw new Error("Target id is required when the config has zero or multiple targets.");
}

export function getAllowedOutboundChannelIds(config) {
  const explicit = config.discord?.allowedOutboundChannelIds || [];
  const fromTargets = (config.targets || []).flatMap((target) => target.allowedChannelIds || []);
  return new Set([...explicit, ...fromTargets].filter(Boolean));
}

export function getAllowedDmUserIds(config) {
  const explicit = config.discord?.allowedDmUserIds || [];
  const fromTargets = (config.targets || []).flatMap((target) => target.allowedUserIds || []);
  return new Set([...explicit, ...fromTargets].filter(Boolean));
}

function normalizeConfig(config, { configPath, cwd }) {
  const configDir = configPath == null ? cwd : path.dirname(configPath);
  const targets = (config.targets || []).map((target) => ({
    ...target,
    displayName: target.displayName || target.id,
    cwd: expandPath(target.cwd, { cwd: configDir }),
    eventLogPath: expandPath(target.eventLogPath, { cwd: configDir }),
    rolloutPath: expandPath(target.rolloutPath, { cwd: configDir }),
    allowedGuildIds: target.allowedGuildIds || [],
    allowedChannelIds: target.allowedChannelIds || [],
    allowedUserIds: target.allowedUserIds || [],
    requiredRoleIds: target.requiredRoleIds || [],
    triggerUserIds: target.triggerUserIds || [],
    allowDirectMessages: target.allowDirectMessages !== false,
    alwaysRouteChannelMessages: target.alwaysRouteChannelMessages === true
  }));

  for (const target of targets) {
    if (!target.id) {
      throw new Error("Every Discord Codex target needs an id.");
    }
    if (!target.threadId) {
      throw new Error(`Target ${target.id} needs a Codex threadId.`);
    }
    if (!target.cwd) {
      throw new Error(`Target ${target.id} needs a cwd.`);
    }
  }

  return {
    ...config,
    bot: {
      ...DEFAULT_CONFIG.bot,
      ...(config.bot || {}),
      processLockRoot: expandPath(config.bot?.processLockRoot, { cwd: configDir })
    },
    codex: {
      ...DEFAULT_CONFIG.codex,
      ...(config.codex || {})
    },
    discord: {
      ...DEFAULT_CONFIG.discord,
      ...(config.discord || {})
    },
    targets
  };
}

function deepMerge(base, override) {
  if (!isObject(base) || !isObject(override)) {
    return override === undefined ? base : override;
  }
  const result = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      result[key] = value;
    } else if (isObject(value)) {
      result[key] = deepMerge(base[key] || {}, value);
    } else {
      result[key] = value;
    }
  }
  return result;
}

function isObject(value) {
  return value != null && typeof value === "object" && !Array.isArray(value);
}
