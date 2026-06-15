import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { randomUUID } from "node:crypto";
import { promisify } from "node:util";
import {
  expandPath,
  loadConnectorConfig
} from "./config.mjs";
import {
  createPhotonImessageClients,
  normalizePhotonMessage,
  selectPhotonClient
} from "./photon-history.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_CHAT_ID = "1111";
const DEFAULT_SPACE_ID = "any;-;+13307669880";
const DEFAULT_HISTORY_LIMIT = 12;
const EVENT_MATCH_TOLERANCE_MS = 120000;
const STATUS_FRESH_MS = 180000;
const DEFAULT_PROBE_WAIT_MS = 30000;
const DEFAULT_PROBE_POLL_MS = 1000;

export async function runSpectrumBridgeDiagnostic({
  configPath = "connectors/imessage-codex/config.local.json",
  chatId = DEFAULT_CHAT_ID,
  spaceId = DEFAULT_SPACE_ID,
  statePath = null,
  artifactDir = "outputs/imessage-bridge-diagnostics",
  baselineCurrent = false,
  activeProbe = false,
  probeText = null,
  probeWaitMs = DEFAULT_PROBE_WAIT_MS,
  probePollMs = DEFAULT_PROBE_POLL_MS,
  restartOnStale = false,
  deep = false,
  execFileImpl = execFileAsync,
  now = new Date()
} = {}) {
  const config = await loadConnectorConfig({ configPath });
  const resolvedStatePath = statePath
    ? expandPath(statePath)
    : path.join(path.dirname(config.imessage.spectrum.statusPath), "spectrum-diagnostics-state.json");
  const resolvedArtifactDir = expandPath(artifactDir);
  const target = config.targets.find((entry) => entry.id === "rick") || config.targets[0] || {};

  const [status, state, localRows, eventRecords, outLogTail, errLogTail] = await Promise.all([
    readJsonFile(config.imessage.spectrum.statusPath),
    readJsonFile(resolvedStatePath, {}),
    readLocalMessagesHistory({
      imsgPath: config.imessage.imsgPath,
      databasePath: config.imessage.databasePath,
      chatId,
      limit: DEFAULT_HISTORY_LIMIT,
      execFileImpl
    }),
    readJsonlFile(target.eventLogPath),
    readTail(path.join(path.dirname(config.imessage.spectrum.statusPath), "logs", "launchd.out.log"), 120),
    readTail(path.join(path.dirname(config.imessage.spectrum.statusPath), "logs", "launchd.err.log"), 120)
  ]);

  if (baselineCurrent) {
    const latest = latestLocalOutbound(localRows);
    const nextState = {
      ...state,
      lastHandledLocalRowId: latest?.id || state.lastHandledLocalRowId || 0,
      lastBaselineAt: now.toISOString()
    };
    await writeJsonFile(resolvedStatePath, nextState);
    return {
      status: "baselined",
      statePath: resolvedStatePath,
      latestLocalRow: latest ? summarizeLocalRow(latest) : null,
      nextState
    };
  }

  if (activeProbe) {
    return runActiveImsgProbe({
      config,
      target,
      chatId,
      spaceId,
      state,
      resolvedStatePath,
      resolvedArtifactDir,
      probeText,
      probeWaitMs,
      probePollMs,
      restartOnStale,
      deep,
      execFileImpl,
      now
    });
  }

  const classification = classifySpectrumBridge({
    status,
    localRows,
    eventRecords,
    state,
    spaceId,
    now
  });

  let deepProbe = null;
  let restart = null;
  let artifactPath = null;
  let nextState = { ...state };

  if (classification.state === "healthy" && classification.stateUpdate) {
    nextState = {
      ...nextState,
      ...classification.stateUpdate,
      lastHealthyAt: now.toISOString()
    };
    await writeJsonFile(resolvedStatePath, nextState);
  }

  if (classification.state !== "healthy") {
    if (deep) {
      deepProbe = await runDeepPhotonProbe({
        spectrum: config.imessage.spectrum,
        spaceId,
        localRow: classification.latestLocalRow
      });
    }
    const evidenceSummary = summarizeIncidentEvidence({
      classification,
      deepProbe
    });

    const artifact = {
      createdAt: now.toISOString(),
      classification,
      status,
      localRows: localRows.slice(0, 8).map(summarizeLocalRow),
      eventRecords: recentRelevantEvents(eventRecords, spaceId),
      deepProbe,
      evidenceSummary,
      logs: {
        outTail: outLogTail,
        errTail: errLogTail
      }
    };
    artifactPath = await writeIncidentArtifact({
      artifactDir: resolvedArtifactDir,
      artifact,
      now,
      state: classification.state
    });

    if (classification.state === "stale" && restartOnStale && shouldRestartAfterIncident(evidenceSummary)) {
      restart = await restartSpectrumLaunchAgent({ execFileImpl });
      restart.afterStatus = await sleep(5000).then(() => readJsonFile(config.imessage.spectrum.statusPath));
    } else if (classification.state === "stale" && restartOnStale) {
      restart = {
        skipped: true,
        reason: "photon_auth_or_target_rejection"
      };
    }

    nextState = {
      ...nextState,
      lastReportedLocalRowId: classification.latestLocalRow?.id || nextState.lastReportedLocalRowId || 0,
      lastIncidentAt: now.toISOString(),
      lastIncidentArtifactPath: artifactPath
    };
    await writeJsonFile(resolvedStatePath, nextState);
  }

  return {
    status: classification.state,
    reason: classification.reason,
    statePath: resolvedStatePath,
    artifactPath,
    latestLocalRow: classification.latestLocalRow || null,
    matchingEvent: classification.matchingEvent || null,
    evidenceSummary: summarizeIncidentEvidence({
      classification,
      deepProbe
    }),
    bridge: {
      status: status?.status || null,
      knownSpaceIds: status?.knownSpaceIds || [],
      lastInboundAt: status?.lastInboundAt || null,
      lastMatchedInboundAt: status?.lastMatchedInboundAt || null,
      receiveLoop: status?.receiveLoop || null
    },
    deepProbe,
    restart,
    nextState
  };
}

export function classifySpectrumBridge({
  status,
  localRows,
  eventRecords,
  state = {},
  spaceId = DEFAULT_SPACE_ID,
  now = new Date()
}) {
  const ignoredThrough = Math.max(
    Number(state.lastHandledLocalRowId || 0),
    Number(state.lastReportedLocalRowId || 0),
    Number(state.lastReportedStaleLocalRowId || 0)
  );
  const newOutboundRows = localOutboundRows(localRows, { afterRowId: ignoredThrough });
  if (newOutboundRows.length === 0) {
    return {
      state: "healthy",
      reason: "no_new_local_outbound_rows",
      latestLocalRow: null
    };
  }

  let lastMatchedRow = null;
  let lastMatchingEvent = null;
  for (const row of [...newOutboundRows].sort(compareRowsOldestFirst)) {
    const match = findMatchingConnectorEvent({
      localRow: row,
      eventRecords,
      spaceId
    });
    if (!match) {
      return classifyUnmatchedLocalRow({
        row,
        status,
        now
      });
    }
    lastMatchedRow = row;
    lastMatchingEvent = match;
  }

  return {
    state: "healthy",
    reason: "matched_connector_event",
    latestLocalRow: summarizeLocalRow(lastMatchedRow),
    matchingEvent: summarizeEventRecord(lastMatchingEvent),
    stateUpdate: {
      lastHandledLocalRowId: lastMatchedRow.id
    }
  };
}

function classifyUnmatchedLocalRow({
  row,
  status,
  now = new Date()
}) {
  const statusFreshness = statusFreshnessSummary(status, now);
  const receiveLoop = status?.receiveLoop || {};
  const lastBridgeActivity = newestIso([
    status?.lastInboundAt,
    receiveLoop.lastActivityAt,
    receiveLoop.startedAt
  ]);
  const latestAt = Date.parse(row.created_at);
  const bridgeAt = lastBridgeActivity ? Date.parse(lastBridgeActivity) : null;
  const bridgeIsOlder = bridgeAt == null || latestAt > bridgeAt;
  if (!statusFreshness.fresh) {
    return {
      state: "stale",
      reason: "status_file_not_fresh",
      latestLocalRow: summarizeLocalRow(row),
      lastBridgeActivity,
      statusFreshness
    };
  }
  if (receiveLoop.state === "running" && !receiveLoop.lastError && bridgeIsOlder) {
    return {
      state: "stale",
      reason: "local_message_newer_than_running_spectrum_receive_loop",
      latestLocalRow: summarizeLocalRow(row),
      lastBridgeActivity,
      statusFreshness
    };
  }

  return {
    state: "suspect",
    reason: "local_message_has_no_matching_connector_event",
    latestLocalRow: summarizeLocalRow(row),
    lastBridgeActivity,
    statusFreshness,
    receiveLoop: {
      state: receiveLoop.state || null,
      lastError: receiveLoop.lastError || null
    }
  };
}

export function latestLocalOutbound(rows, { afterRowId = 0 } = {}) {
  return localOutboundRows(rows, { afterRowId })[0] || null;
}

function localOutboundRows(rows, { afterRowId = 0 } = {}) {
  return rows
    .filter((row) => Number(row?.id || 0) > Number(afterRowId || 0))
    .filter((row) => row?.is_from_me === true)
    .filter((row) => String(row?.text || "").trim())
    .sort(compareRowsNewestFirst);
}

export function findMatchingConnectorEvent({
  localRow,
  eventRecords,
  spaceId = DEFAULT_SPACE_ID,
  toleranceMs = EVENT_MATCH_TOLERANCE_MS
}) {
  const localAt = Date.parse(localRow?.created_at || "");
  if (!Number.isFinite(localAt)) {
    return null;
  }
  const text = normalizeText(localRow.text);
  return eventRecords.find((record) => {
    if (record?.platform !== "imessage") return false;
    if (spaceId && record?.space_id !== spaceId) return false;
    if (normalizeText(record?.text) !== text) return false;
    const eventAt = Date.parse(record?.received_at || record?.time_local || "");
    return Number.isFinite(eventAt) && Math.abs(eventAt - localAt) <= toleranceMs;
  }) || null;
}

export function findMatchingStatusMessage({
  status,
  text,
  spaceId = DEFAULT_SPACE_ID
} = {}) {
  const expectedText = normalizeText(text);
  const message = status?.lastMatchedInboundMessage || null;
  if (!message) {
    return null;
  }
  if (spaceId && message.spaceId !== spaceId) {
    return null;
  }
  if (normalizeText(message.text) !== expectedText) {
    return null;
  }
  return message;
}

export function parseJsonLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

export function findMatchingPhotonHistoryMessage({
  localRow,
  deepProbe,
  toleranceMs = EVENT_MATCH_TOLERANCE_MS
} = {}) {
  const messages = deepProbe?.listInChat?.value?.messages || [];
  const localAt = Date.parse(localRow?.createdAt || localRow?.created_at || "");
  const text = normalizeText(localRow?.text);
  return messages.find((message) => {
    if (normalizeText(message?.text) !== text) return false;
    if (!Number.isFinite(localAt)) return true;
    const receivedAt = Date.parse(message?.receivedAt || "");
    return Number.isFinite(receivedAt) && Math.abs(receivedAt - localAt) <= toleranceMs;
  }) || null;
}

export function summarizeIncidentEvidence({
  classification,
  deepProbe
} = {}) {
  if (classification?.state === "healthy") {
    return null;
  }
  if (!deepProbe) {
    return {
      conclusion: "deep_probe_not_run",
      nextStep: "Run with --deep only after approving Photon cloud/API probes; otherwise keep using local status, logs, and event evidence."
    };
  }

  const photonHistoryMatch = findMatchingPhotonHistoryMessage({
    localRow: classification.latestLocalRow,
    deepProbe
  });
  if (photonHistoryMatch) {
    return {
      conclusion: "photon_history_has_message_but_live_stream_missed_it",
      photonHistoryMessage: photonHistoryMatch,
      nextStep: "Escalate the live subscription path: Spectrum/advanced-imessage history sees the message, but the live app.messages stream did not deliver it to the Wakefield connector."
    };
  }
  if (deepProbe.listInChat?.ok === true) {
    return {
      conclusion: "local_sender_has_message_but_photon_history_does_not",
      nextStep: "Escalate account/server delivery with Photon: the Joe-side Messages database has the sent message, but Photon history for the Rick chat does not expose it."
    };
  }
  return {
    conclusion: "photon_history_probe_failed",
    listInChat: deepProbe.listInChat || null,
    nextStep: "Fix or escalate the Photon history/API failure before classifying the stale live stream."
  };
}

export function shouldRestartAfterIncident(evidenceSummary) {
  const evidence = JSON.stringify(evidenceSummary || {});
  return !/Authentication failed|Target not allowed for this project/i.test(evidence);
}

async function runActiveImsgProbe({
  config,
  target,
  chatId,
  spaceId,
  state,
  resolvedStatePath,
  resolvedArtifactDir,
  probeText,
  probeWaitMs,
  probePollMs,
  restartOnStale,
  deep,
  execFileImpl,
  now
}) {
  const startedAt = new Date().toISOString();
  const text = probeText || buildActiveProbeText(now);
  const sendResult = await sendLocalImsgProbe({
    imsgPath: config.imessage.imsgPath,
    databasePath: config.imessage.databasePath,
    chatId,
    text,
    execFileImpl
  });

  const deadline = Date.now() + normalizePositiveInteger(probeWaitMs, DEFAULT_PROBE_WAIT_MS);
  const pollMs = normalizePositiveInteger(probePollMs, DEFAULT_PROBE_POLL_MS);
  let status = null;
  let localRows = [];
  let eventRecords = [];
  let localRow = null;
  let matchingStatusMessage = null;
  let matchingEvent = null;
  let attempts = 0;

  while (Date.now() <= deadline) {
    attempts += 1;
    [status, localRows, eventRecords] = await Promise.all([
      readJsonFile(config.imessage.spectrum.statusPath),
      readLocalMessagesHistory({
        imsgPath: config.imessage.imsgPath,
        databasePath: config.imessage.databasePath,
        chatId,
        limit: DEFAULT_HISTORY_LIMIT,
        execFileImpl
      }),
      readJsonlFile(target.eventLogPath)
    ]);
    localRow = findLocalOutboundByText(localRows, text);
    matchingStatusMessage = findMatchingStatusMessage({ status, text, spaceId });
    matchingEvent = localRow ? findMatchingConnectorEvent({ localRow, eventRecords, spaceId }) : null;
    if (matchingStatusMessage || matchingEvent) {
      break;
    }
    await sleep(pollMs);
  }

  const success = Boolean(matchingStatusMessage || matchingEvent);
  const classification = {
    state: success ? "healthy" : "stale",
    reason: success
      ? (matchingStatusMessage ? "active_probe_matched_live_status" : "active_probe_matched_event_log")
      : "active_probe_not_seen_by_live_status",
    latestLocalRow: localRow ? summarizeLocalRow(localRow) : null,
    matchingEvent: matchingEvent ? summarizeEventRecord(matchingEvent) : null,
    activeProbe: {
      text,
      startedAt,
      waitMs: normalizePositiveInteger(probeWaitMs, DEFAULT_PROBE_WAIT_MS),
      pollMs,
      attempts,
      sendResult,
      matchingStatusMessage
    }
  };

  let deepProbe = null;
  let restart = null;
  let artifactPath = null;
  const [outLogTail, errLogTail] = await Promise.all([
    readTail(path.join(path.dirname(config.imessage.spectrum.statusPath), "logs", "launchd.out.log"), 120),
    readTail(path.join(path.dirname(config.imessage.spectrum.statusPath), "logs", "launchd.err.log"), 120)
  ]);
  let nextState = { ...state };

  if (success) {
    nextState = {
      ...nextState,
      lastHandledLocalRowId: localRow?.id || nextState.lastHandledLocalRowId || 0,
      lastActiveProbeAt: new Date().toISOString(),
      lastActiveProbeText: text,
      lastHealthyAt: new Date().toISOString()
    };
    await writeJsonFile(resolvedStatePath, nextState);
  } else {
    if (deep && localRow) {
      deepProbe = await runDeepPhotonProbe({
        spectrum: config.imessage.spectrum,
        spaceId,
        localRow: classification.latestLocalRow
      });
    }
    const evidenceSummary = summarizeIncidentEvidence({ classification, deepProbe });

    const artifact = {
      createdAt: new Date().toISOString(),
      classification,
      status,
      localRows: localRows.slice(0, 8).map(summarizeLocalRow),
      eventRecords: recentRelevantEvents(eventRecords, spaceId),
      deepProbe,
      evidenceSummary,
      logs: {
        outTail: outLogTail,
        errTail: errLogTail
      }
    };
    artifactPath = await writeIncidentArtifact({
      artifactDir: resolvedArtifactDir,
      artifact,
      now: new Date(),
      state: classification.state
    });

    if (restartOnStale && shouldRestartAfterIncident(evidenceSummary)) {
      restart = await restartSpectrumLaunchAgent({ execFileImpl });
      restart.afterStatus = await sleep(5000).then(() => readJsonFile(config.imessage.spectrum.statusPath));
    } else if (restartOnStale) {
      restart = {
        skipped: true,
        reason: "photon_auth_or_target_rejection"
      };
    }

    nextState = {
      ...nextState,
      lastReportedLocalRowId: localRow?.id || nextState.lastReportedLocalRowId || 0,
      lastIncidentAt: new Date().toISOString(),
      lastIncidentArtifactPath: artifactPath
    };
    await writeJsonFile(resolvedStatePath, nextState);
  }

  return {
    status: classification.state,
    reason: classification.reason,
    statePath: resolvedStatePath,
    artifactPath,
    latestLocalRow: classification.latestLocalRow,
    matchingEvent: classification.matchingEvent,
    activeProbe: classification.activeProbe,
    evidenceSummary: summarizeIncidentEvidence({ classification, deepProbe }),
    bridge: {
      status: status?.status || null,
      knownSpaceIds: status?.knownSpaceIds || [],
      lastInboundAt: status?.lastInboundAt || null,
      lastMatchedInboundAt: status?.lastMatchedInboundAt || null,
      lastInboundMessage: status?.lastInboundMessage || null,
      lastMatchedInboundMessage: status?.lastMatchedInboundMessage || null,
      receiveLoop: status?.receiveLoop || null
    },
    deepProbe,
    restart,
    nextState
  };
}

async function readLocalMessagesHistory({
  imsgPath,
  databasePath,
  chatId,
  limit,
  execFileImpl
}) {
  const args = ["history", "--chat-id", String(chatId), "--limit", String(limit), "--json"];
  if (databasePath) {
    args.push("--db", databasePath);
  }
  const { stdout } = await execFileImpl(imsgPath, args, { maxBuffer: 1024 * 1024 * 10 });
  return parseJsonLines(stdout);
}

async function sendLocalImsgProbe({
  imsgPath,
  databasePath,
  chatId,
  text,
  execFileImpl
}) {
  const args = ["send", "--chat-id", String(chatId), "--text", text, "--json"];
  if (databasePath) {
    args.push("--db", databasePath);
  }
  const { stdout } = await execFileImpl(imsgPath, args, { maxBuffer: 1024 * 1024 * 10 });
  return parseJsonLines(stdout);
}

async function runDeepPhotonProbe({ spectrum, spaceId, localRow }) {
  const result = {
    cloud: {},
    addresses: {},
    listInChat: null,
    subscribeEvents: null
  };

  // Keep the deep probe below Spectrum Cloud's low per-second request ceiling.
  // createPhotonImessageClients issues the one token request needed for data-plane checks.
  result.cloud.imessage = await fetchSpectrumCloud({ spectrum, route: "imessage/" });
  result.cloud.platforms = await fetchSpectrumCloud({ spectrum, route: "platforms/" });
  const clientSet = await createPhotonImessageClients({ spectrum });
  result.tokenType = clientSet.tokenType;
  try {
    const selected = selectPhotonClient({ clients: clientSet.clients });
    const client = selected?.client;
    if (!selected || !client) {
      result.clientError = "No Photon iMessage client returned.";
      return result;
    }
    for (const address of addressesToProbe(spaceId)) {
      result.addresses[address] = {
        get: await capture(() => client.addresses.get(address)),
        isIMessageAvailable: await capture(() => client.addresses.isIMessageAvailable(address))
      };
    }
    result.listInChat = await capture(() => listPhotonMessagesInChatWithClient({
      client,
      chatGuid: spaceId,
      phone: selected.phone,
      tokenType: clientSet.tokenType,
      pageSize: 100,
      ...historyWindowForLocalRow(localRow)
    }));
    result.subscribeEvents = await probeSubscription(client);
  } finally {
    await clientSet.closeAll();
  }

  return result;
}

async function listPhotonMessagesInChatWithClient({
  client,
  chatGuid,
  phone,
  tokenType,
  pageSize = 100,
  pageToken,
  before,
  after
}) {
  const options = removeNullish({
    pageSize,
    pageToken,
    before: normalizeOptionalDate(before),
    after: normalizeOptionalDate(after)
  });
  const page = await client.messages.listInChat(chatGuid, options);
  return {
    chatGuid,
    phone,
    tokenType,
    pageSize: options.pageSize,
    pageToken: options.pageToken || null,
    nextPageToken: page.nextPageToken || null,
    messages: (page.messages || []).map((message) => normalizePhotonMessage(message, { chatGuid }))
  };
}

function normalizeOptionalDate(value) {
  if (value == null || value === "") {
    return undefined;
  }
  return value instanceof Date ? value : new Date(value);
}

function removeNullish(value) {
  return Object.fromEntries(
    Object.entries(value).filter(([, entry]) => entry !== undefined && entry !== null)
  );
}

async function probeSubscription(client) {
  const stream = client.messages.subscribeEvents();
  const startedAt = new Date().toISOString();
  let timeout = null;
  try {
    const result = await Promise.race([
      (async () => {
        for await (const event of stream) {
          return {
            status: "event",
            startedAt,
            event
          };
        }
        return {
          status: "ended",
          startedAt
        };
      })(),
      new Promise((resolve) => {
        timeout = setTimeout(() => resolve({
          status: "open_no_events",
          startedAt,
          durationMs: 5000
        }), 5000);
      })
    ]);
    await stream.close?.();
    return result;
  } catch (error) {
    return errorSummary(error);
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

async function fetchSpectrumCloud({ spectrum, route, method = "GET" }) {
  const cloudUrl = String(spectrum.cloudUrl || "https://spectrum.photon.codes").replace(/\/+$/, "");
  const response = await fetch(`${cloudUrl}/projects/${encodeURIComponent(spectrum.projectId)}/${route}`, {
    method,
    headers: {
      Authorization: `Basic ${Buffer.from(`${spectrum.projectId}:${spectrum.projectSecret}`).toString("base64")}`
    }
  });
  const text = await response.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    body = text;
  }
  return {
    ok: response.ok,
    status: response.status,
    body: redactSecrets(body)
  };
}

async function restartSpectrumLaunchAgent({ execFileImpl }) {
  const label = "com.wakefield.imessage-spectrum-connector";
  const domain = `gui/${process.getuid?.() || 502}/${label}`;
  const startedAt = new Date().toISOString();
  const result = await capture(() => execFileImpl("launchctl", ["kickstart", "-k", domain]));
  return {
    startedAt,
    domain,
    result
  };
}

async function readJsonFile(filePath, fallback = null) {
  if (!filePath) return fallback;
  try {
    return JSON.parse(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

async function writeJsonFile(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonlFile(filePath) {
  if (!filePath) return [];
  try {
    return parseJsonLines(await fs.readFile(filePath, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }
}

async function readTail(filePath, lines = 120) {
  try {
    const text = await fs.readFile(filePath, "utf8");
    return text.split(/\r?\n/).slice(-lines).join("\n");
  } catch (error) {
    if (error?.code === "ENOENT") return "";
    throw error;
  }
}

async function writeIncidentArtifact({ artifactDir, artifact, now, state = "incident" }) {
  await fs.mkdir(artifactDir, { recursive: true });
  const fileName = `${now.toISOString().replace(/[:.]/g, "-")}-spectrum-bridge-${state}.json`;
  const filePath = path.join(artifactDir, fileName);
  await fs.writeFile(filePath, `${JSON.stringify(artifact, null, 2)}\n`, "utf8");
  return filePath;
}

async function capture(fn) {
  try {
    return {
      ok: true,
      value: redactSecrets(await fn())
    };
  } catch (error) {
    return {
      ok: false,
      error: errorSummary(error)
    };
  }
}

function errorSummary(error) {
  return {
    message: error.message,
    code: error.code || null,
    grpcCode: error.grpcCode || null,
    status: error.status || null,
    retryable: error.retryable ?? null
  };
}

function summarizeLocalRow(row) {
  return row ? {
    id: row.id,
    guid: row.guid,
    createdAt: row.created_at,
    text: row.text,
    isFromMe: row.is_from_me,
    chatGuid: row.chat_guid,
    chatIdentifier: row.chat_identifier
  } : null;
}

function findLocalOutboundByText(rows, text) {
  const expected = normalizeText(text);
  return localOutboundRows(rows)
    .find((row) => normalizeText(row.text) === expected) || null;
}

function summarizeEventRecord(record) {
  return record ? {
    messageId: record.message_id,
    receivedAt: record.received_at,
    timeLocal: record.time_local,
    spaceId: record.space_id,
    text: record.text
  } : null;
}

function recentRelevantEvents(records, spaceId) {
  return records
    .filter((record) => record?.platform === "imessage")
    .filter((record) => !spaceId || record.space_id === spaceId)
    .slice(-20)
    .map(summarizeEventRecord);
}

function addressesToProbe(spaceId) {
  const match = String(spaceId || "").match(/(?:^|;)-;([^;]+)$/);
  return [...new Set([match?.[1], "+13304421678"].filter(Boolean))];
}

function compareRowsNewestFirst(a, b) {
  const aId = Number(a?.id || 0);
  const bId = Number(b?.id || 0);
  if (aId !== bId) return bId - aId;
  return Date.parse(b?.created_at || 0) - Date.parse(a?.created_at || 0);
}

function compareRowsOldestFirst(a, b) {
  return -compareRowsNewestFirst(a, b);
}

function statusFreshnessSummary(status, now = new Date()) {
  if (!status) {
    return {
      fresh: false,
      reason: "status_missing",
      updatedAt: null,
      ageMs: null,
      maxAgeMs: STATUS_FRESH_MS
    };
  }
  const updatedAtMs = Date.parse(status.updatedAt || "");
  const nowMs = now instanceof Date ? now.getTime() : Date.parse(now);
  if (!Number.isFinite(updatedAtMs) || !Number.isFinite(nowMs)) {
    return {
      fresh: false,
      reason: "status_updated_at_invalid",
      updatedAt: status.updatedAt || null,
      ageMs: null,
      maxAgeMs: STATUS_FRESH_MS
    };
  }
  const ageMs = nowMs - updatedAtMs;
  return {
    fresh: ageMs <= STATUS_FRESH_MS,
    reason: ageMs <= STATUS_FRESH_MS ? "fresh" : "status_updated_at_too_old",
    updatedAt: status.updatedAt,
    ageMs,
    maxAgeMs: STATUS_FRESH_MS
  };
}

function historyWindowForLocalRow(localRow) {
  const createdAt = Date.parse(localRow?.createdAt || localRow?.created_at || "");
  if (!Number.isFinite(createdAt)) {
    return {};
  }
  return {
    after: new Date(createdAt - EVENT_MATCH_TOLERANCE_MS).toISOString(),
    before: new Date(createdAt + EVENT_MATCH_TOLERANCE_MS).toISOString()
  };
}

function buildActiveProbeText(now = new Date()) {
  return `Rick bridge active probe ${now.toISOString()} ${randomUUID().slice(0, 8)}`;
}

function normalizePositiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function normalizeText(value) {
  return String(value || "").trim();
}

function newestIso(values) {
  return values
    .filter(Boolean)
    .sort((a, b) => Date.parse(b) - Date.parse(a))[0] || null;
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /token|secret|auth/i.test(key) ? "[redacted]" : redactSecrets(entry)
    ]));
  }
  if (typeof value === "string" && /^[A-Za-z0-9_-]{32,}$/.test(value)) {
    return `${value.slice(0, 6)}...redacted...${value.slice(-4)}`;
  }
  return value;
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
