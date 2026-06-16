import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const DEFAULT_CONFIG = {
  bot: {
    processLockRoot: null,
    processLockStaleMs: 10000
  },
  codex: {
    connectorSkillPrompt: "Use $wakefield-imessage for iMessage connector routing.",
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
  imessage: {
    provider: "spectrum",
    imsgPath: "imsg",
    databasePath: "~/Library/Messages/chat.db",
    statePath: "~/.codex/connectors/imessage-codex/state.json",
    allowedOutboundAddresses: [],
    allowedOutboundChatIds: [],
    allowedOutboundChatGuids: [],
    allowedOutboundSpaceIds: [],
    service: "auto",
    region: "US",
    advancedBridgeRequired: true,
    sendReadReceipts: true,
    spectrum: {
      projectId: null,
      projectSecret: null,
      cloudUrl: null,
      projectIdEnv: "PHOTON_PROJECT_ID",
      projectSecretEnv: "PHOTON_SECRET_KEY",
      ipcSocketPath: "~/.codex/connectors/imessage-codex/spectrum.sock",
      attachmentDir: "~/.codex/connectors/imessage-codex/attachments",
      statusPath: "~/.codex/connectors/imessage-codex/spectrum-status.json",
      deliveryQueuePath: "~/.codex/connectors/imessage-codex/spectrum-delivery-queue.json",
      allowOutboundToKnownSpaces: true,
      flattenGroups: true,
      startupReplayEnabled: true,
      startupReplayLookbackMs: 60 * 60 * 1000,
      startupReplayDelayMs: 30000,
      startupReplayPageSize: 30,
      deliveryRetryMs: 60000,
      outboundRequestMinIntervalMs: 2000,
      receiveLoopMaxAgeMs: 110 * 60 * 1000,
      appOperationTimeoutMs: 120000,
      telemetry: false
    },
    watch: {
      includeAttachments: true,
      convertAttachments: true,
      includeReactions: false,
      debounce: "500ms"
    },
    typing: {
      enabled: true,
      showWhileThinking: true,
      intervalMs: 6000,
      maxMs: 1800000,
      completionTimeoutMs: 1800000,
      completionPollMs: 1500,
      duration: "10s"
    },
    focus: {
      enabled: false,
      pollMs: 1500,
      rolloutRefreshMs: 30000,
      compactionStartGraceMs: 2000,
      compactionHoldMs: 15000,
      compactingShortcutName: null,
      onlineShortcutName: null,
      offlineShortcutName: null
    }
  },
  identity: {
    contactsPath: ""
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
    } else if (value === "--help" || value === "-h") {
      args.help = true;
    }
  }
  return args;
}

export function defaultConfigPath(env = process.env) {
  return env.CODEX_IMESSAGE_CONFIG || "packages/imessage-spectrum/config.local.json";
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
        throw new Error(`Failed to read iMessage Codex config at ${resolvedPath}: ${error.message}`);
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
  if (env.IMSG_PATH) {
    config.imessage.imsgPath = env.IMSG_PATH;
  }
  applySpectrumEnvOverrides(config, env);

  return config;
}

export function getAllowedOutboundAddresses(config) {
  const explicit = config.imessage?.allowedOutboundAddresses || [];
  const fromTargets = (config.targets || []).flatMap((target) => target.allowedAddresses || []);
  return new Set([...explicit, ...fromTargets].map(normalizeAddress).filter(Boolean));
}

export function getAllowedOutboundChatIds(config) {
  const explicit = config.imessage?.allowedOutboundChatIds || [];
  const fromTargets = (config.targets || []).flatMap((target) => target.allowedChatIds || []);
  return new Set([...explicit, ...fromTargets].map(normalizeChatId).filter(Boolean));
}

export function getAllowedOutboundChatGuids(config) {
  const explicit = config.imessage?.allowedOutboundChatGuids || [];
  const fromTargets = (config.targets || []).flatMap((target) => target.allowedChatGuids || []);
  return new Set([...explicit, ...fromTargets].map(normalizeString).filter(Boolean));
}

export function getAllowedOutboundSpaceIds(config) {
  const explicit = config.imessage?.allowedOutboundSpaceIds || [];
  const fromTargets = (config.targets || []).flatMap((target) => target.allowedSpaceIds || []);
  return new Set([...explicit, ...fromTargets].map(normalizeString).filter(Boolean));
}

export function normalizeAddress(value) {
  return String(value || "").trim().toLowerCase();
}

export function normalizeChatId(value) {
  const text = String(value ?? "").trim();
  return text ? text : null;
}

function normalizeConfig(config, { configPath, cwd }) {
  const configDir = configPath == null ? cwd : path.dirname(configPath);
  const imessage = {
    ...DEFAULT_CONFIG.imessage,
    ...(config.imessage || {})
  };
  imessage.provider = normalizeProvider(imessage.provider);
  imessage.imsgPath = String(imessage.imsgPath || "imsg");
  imessage.databasePath = expandPath(imessage.databasePath, { cwd: configDir });
  imessage.statePath = expandPath(imessage.statePath, { cwd: configDir });
  imessage.allowedOutboundAddresses = normalizeAddressList(imessage.allowedOutboundAddresses);
  imessage.allowedOutboundChatIds = normalizeChatIdList(imessage.allowedOutboundChatIds);
  imessage.allowedOutboundChatGuids = normalizeStringList(imessage.allowedOutboundChatGuids);
  imessage.allowedOutboundSpaceIds = normalizeStringList(imessage.allowedOutboundSpaceIds);
  imessage.service = normalizeService(imessage.service);
  imessage.region = String(imessage.region || DEFAULT_CONFIG.imessage.region);
  imessage.advancedBridgeRequired = imessage.advancedBridgeRequired !== false;
  imessage.sendReadReceipts = imessage.sendReadReceipts !== false;
  imessage.spectrum = normalizeSpectrum(imessage.spectrum, { cwd: configDir });
  imessage.watch = normalizeWatch(imessage.watch);
  imessage.typing = normalizeTyping(imessage.typing);
  imessage.focus = normalizeFocus(imessage.focus);

  const targets = (config.targets || []).map((target) => ({
    ...target,
    displayName: target.displayName || target.id,
    cwd: expandPath(target.cwd, { cwd: configDir }),
    eventLogPath: expandPath(target.eventLogPath, { cwd: configDir }),
    rolloutPath: expandPath(target.rolloutPath, { cwd: configDir }),
    allowedAddresses: normalizeAddressList(target.allowedAddresses),
    allowedChatIds: normalizeChatIdList(target.allowedChatIds),
    allowedChatGuids: normalizeStringList(target.allowedChatGuids),
    allowedSpaceIds: normalizeStringList(target.allowedSpaceIds),
    allowGroupChats: target.allowGroupChats === true,
    allowAllAddresses: target.allowAllAddresses === true
  }));

  for (const target of targets) {
    if (!target.id) {
      throw new Error("Every iMessage Codex target needs an id.");
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
    imessage,
    identity: {
      contactsPath: expandPath(config.identity?.contactsPath ?? DEFAULT_CONFIG.identity.contactsPath, { cwd: configDir })
    },
    targets
  };
}

function normalizeProvider(value) {
  const provider = String(value || DEFAULT_CONFIG.imessage.provider).toLowerCase();
  if (!["spectrum", "imsg"].includes(provider)) {
    throw new Error(`Unsupported iMessage provider: ${value}`);
  }
  return provider;
}

function normalizeSpectrum(spectrum = {}, { cwd }) {
  const merged = {
    ...DEFAULT_CONFIG.imessage.spectrum,
    ...spectrum
  };
  return {
    ...merged,
    projectId: normalizeString(merged.projectId) || null,
    projectSecret: normalizeString(merged.projectSecret || merged.secretKey) || null,
    cloudUrl: normalizeString(merged.cloudUrl) || null,
    projectIdEnv: normalizeString(merged.projectIdEnv) || DEFAULT_CONFIG.imessage.spectrum.projectIdEnv,
    projectSecretEnv: normalizeString(merged.projectSecretEnv) || DEFAULT_CONFIG.imessage.spectrum.projectSecretEnv,
    ipcSocketPath: expandPath(merged.ipcSocketPath, { cwd }),
    attachmentDir: expandPath(merged.attachmentDir, { cwd }),
    statusPath: expandPath(merged.statusPath, { cwd }),
    deliveryQueuePath: expandPath(merged.deliveryQueuePath, { cwd }),
    allowOutboundToKnownSpaces: merged.allowOutboundToKnownSpaces !== false,
    flattenGroups: merged.flattenGroups !== false,
    startupReplayEnabled: merged.startupReplayEnabled !== false,
    startupReplayLookbackMs: positiveInteger(
      merged.startupReplayLookbackMs,
      DEFAULT_CONFIG.imessage.spectrum.startupReplayLookbackMs
    ),
    startupReplayDelayMs: nonNegativeInteger(
      merged.startupReplayDelayMs,
      DEFAULT_CONFIG.imessage.spectrum.startupReplayDelayMs
    ),
    startupReplayPageSize: positiveInteger(
      merged.startupReplayPageSize,
      DEFAULT_CONFIG.imessage.spectrum.startupReplayPageSize
    ),
    deliveryRetryMs: positiveInteger(
      merged.deliveryRetryMs,
      DEFAULT_CONFIG.imessage.spectrum.deliveryRetryMs
    ),
    outboundRequestMinIntervalMs: nonNegativeInteger(
      merged.outboundRequestMinIntervalMs,
      DEFAULT_CONFIG.imessage.spectrum.outboundRequestMinIntervalMs
    ),
    receiveLoopMaxAgeMs: positiveInteger(
      merged.receiveLoopMaxAgeMs,
      DEFAULT_CONFIG.imessage.spectrum.receiveLoopMaxAgeMs
    ),
    appOperationTimeoutMs: positiveInteger(
      merged.appOperationTimeoutMs,
      DEFAULT_CONFIG.imessage.spectrum.appOperationTimeoutMs
    ),
    telemetry: merged.telemetry === true
  };
}

function normalizeWatch(watch = {}) {
  return {
    ...DEFAULT_CONFIG.imessage.watch,
    ...watch,
    debounce: String(watch.debounce || DEFAULT_CONFIG.imessage.watch.debounce)
  };
}

function normalizeTyping(typing = {}) {
  return {
    ...DEFAULT_CONFIG.imessage.typing,
    ...typing,
    showWhileThinking: typing.showWhileThinking === true,
    intervalMs: positiveInteger(typing.intervalMs, DEFAULT_CONFIG.imessage.typing.intervalMs),
    maxMs: positiveInteger(typing.maxMs, DEFAULT_CONFIG.imessage.typing.maxMs),
    completionTimeoutMs: positiveInteger(typing.completionTimeoutMs, DEFAULT_CONFIG.imessage.typing.completionTimeoutMs),
    completionPollMs: positiveInteger(typing.completionPollMs, DEFAULT_CONFIG.imessage.typing.completionPollMs),
    duration: String(typing.duration || DEFAULT_CONFIG.imessage.typing.duration)
  };
}

function normalizeFocus(focus = {}) {
  return {
    ...DEFAULT_CONFIG.imessage.focus,
    ...focus,
    pollMs: positiveInteger(focus.pollMs, DEFAULT_CONFIG.imessage.focus.pollMs),
    rolloutRefreshMs: positiveInteger(focus.rolloutRefreshMs, DEFAULT_CONFIG.imessage.focus.rolloutRefreshMs),
    compactionStartGraceMs: positiveInteger(focus.compactionStartGraceMs, DEFAULT_CONFIG.imessage.focus.compactionStartGraceMs),
    compactionHoldMs: positiveInteger(focus.compactionHoldMs, DEFAULT_CONFIG.imessage.focus.compactionHoldMs)
  };
}

function normalizeService(value) {
  const service = String(value || "auto").toLowerCase();
  if (!["auto", "imessage", "sms"].includes(service)) {
    throw new Error(`Unsupported iMessage service: ${value}`);
  }
  return service;
}

function normalizeAddressList(values = []) {
  return normalizeStringList(values).map(normalizeAddress);
}

function normalizeChatIdList(values = []) {
  return normalizeStringList(values).map(normalizeChatId).filter(Boolean);
}

function normalizeStringList(values = []) {
  return [...new Set((values || []).map(normalizeString).filter(Boolean))];
}

function normalizeString(value) {
  return String(value || "").trim();
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function nonNegativeInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? Math.floor(number) : fallback;
}

function applySpectrumEnvOverrides(config, env) {
  const spectrum = config.imessage.spectrum;
  const projectId = env[spectrum.projectIdEnv] || env.SPECTRUM_PROJECT_ID || env.PHOTON_PROJECT_ID;
  const projectSecret = env[spectrum.projectSecretEnv] || env.SPECTRUM_PROJECT_SECRET || env.PHOTON_SECRET_KEY;
  if (projectId) {
    spectrum.projectId = projectId;
  }
  if (projectSecret) {
    spectrum.projectSecret = projectSecret;
  }
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
