#!/usr/bin/env node
import fs from "node:fs/promises";
import path from "node:path";
import { execFile } from "node:child_process";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { createClient } from "@photon-ai/advanced-imessage";

const DEFAULT_CLOUD_URL = "https://spectrum.photon.codes";
const DEFAULT_SHARED_ADDRESS = "imessage.spectrum.photon.codes:443";
const DEFAULT_WAIT_MS = 60000;
const DEFAULT_CATCHUP_MS = 8000;
const DEFAULT_HISTORY_WINDOW_MS = 5000;
const DEFAULT_IMSG_SEND_DELAY_MS = 1000;
const MAX_SAMPLE_EVENTS = 20;
const execFileAsync = promisify(execFile);
const require = createRequire(import.meta.url);

const args = parseArgs(process.argv.slice(2));

if (args.help) {
  printHelp();
  process.exit(0);
}

try {
  const result = await runRepro(args);
  const json = `${JSON.stringify(result, null, 2)}\n`;
  if (args.out) {
    await fs.mkdir(path.dirname(path.resolve(args.out)), { recursive: true });
    await fs.writeFile(args.out, json, "utf8");
  }
  process.stdout.write(json);
  if (result.conclusion === "history_visible_live_missed") {
    process.exitCode = 2;
  } else if (result.conclusion === "history_missing") {
    process.exitCode = 3;
  }
} catch (error) {
  process.stderr.write(`${JSON.stringify({
    status: "error",
    error: errorSummary(error)
  }, null, 2)}\n`);
  process.exitCode = 1;
}

async function runRepro(rawArgs) {
  const startedAt = new Date();
  const config = await loadHarnessConfig(rawArgs);
  const expectedText = rawArgs.text || `photon-live-repro ${startedAt.toISOString()}`;
  if (!config.chatGuid) {
    throw new Error("Pass --chat-guid any;-;+15555555555 for the iMessage DM/group to observe.");
  }
  if (!config.projectId || !config.projectSecret) {
    throw new Error("Pass --project-id/--project-secret, set PHOTON_PROJECT_ID/PHOTON_SECRET_KEY, or pass --config config.local.json.");
  }

  const tokenData = await issueImessageTokens(config);
  const selected = selectClient(tokenData, config);
  const client = createClient({
    address: selected.address,
    tls: true,
    token: selected.token
  });

  try {
    process.stderr.write([
      `Photon live repro started at ${startedAt.toISOString()}.`,
      `Send exactly this text into ${config.chatGuid}:`,
      expectedText,
      ""
    ].join("\n"));

    const live = await collectLiveEvents({
      client,
      chatGuid: config.chatGuid,
      expectedText,
      waitMs: config.waitMs,
      trigger: config.sendViaImsg
        ? () => sendViaImsg({ config, text: expectedText })
        : null,
      triggerDelayMs: config.imsgSendDelayMs
    });
    const history = await readHistoryWindow({
      client,
      chatGuid: config.chatGuid,
      expectedText,
      startedAt,
      historyWindowMs: config.historyWindowMs
    });
    const catchUp = await collectCatchUp({
      client,
      expectedText,
      waitMs: config.catchUpMs
    });
    const conclusion = classifyResult({ live, history, catchUp });

    return redactSecrets({
      status: "complete",
      conclusion,
      expectedText,
      startedAt: startedAt.toISOString(),
      endedAt: new Date().toISOString(),
      config: {
        cloudUrl: config.cloudUrl,
        chatGuid: config.chatGuid,
        waitMs: config.waitMs,
        catchUpMs: config.catchUpMs,
        historyWindowMs: config.historyWindowMs,
        sendViaImsg: config.sendViaImsg,
        imsgChatId: config.imsgChatId,
        imsgSendDelayMs: config.imsgSendDelayMs,
        selectedPhone: selected.phone,
        selectedInstanceId: selected.instanceId,
        selectedAddress: selected.address,
        tokenType: tokenData.type
      },
      versions: await packageVersions(),
      live,
      history,
      catchUp,
      photonPacket: packetSummary({ conclusion, live, history, catchUp })
    });
  } finally {
    await client.close?.();
  }
}

async function collectLiveEvents({
  client,
  chatGuid,
  expectedText,
  waitMs,
  trigger = null,
  triggerDelayMs = DEFAULT_IMSG_SEND_DELAY_MS
}) {
  const stream = client.messages.subscribeEvents();
  const startedAt = new Date();
  let matched = null;
  let error = null;
  let triggerResult = null;
  const samples = [];
  const timer = setTimeout(() => {
    stream.close?.().catch(() => {});
  }, waitMs);

  try {
    if (trigger) {
      setTimeout(() => {
        trigger()
          .then((result) => {
            triggerResult = result;
          })
          .catch((caught) => {
            triggerResult = {
              status: "error",
              error: errorSummary(caught)
            };
            stream.close?.().catch(() => {});
          });
      }, positiveInteger(triggerDelayMs, DEFAULT_IMSG_SEND_DELAY_MS));
    }
    for await (const event of stream) {
      const summary = summarizeMessageEvent(event);
      if (summary) {
        if (samples.length >= MAX_SAMPLE_EVENTS) samples.shift();
        samples.push(summary);
      }
      if (summary && summary.chatGuid === chatGuid && summary.text === expectedText) {
        matched = summary;
        await stream.close?.();
        break;
      }
    }
  } catch (caught) {
    error = errorSummary(caught);
  } finally {
    clearTimeout(timer);
  }

  return {
    status: matched ? "matched" : (error ? "error" : "timeout_or_closed"),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    trigger: triggerResult,
    matched,
    sampleCount: samples.length,
    samples,
    error
  };
}

async function readHistoryWindow({
  client,
  chatGuid,
  expectedText,
  startedAt,
  historyWindowMs
}) {
  const after = new Date(startedAt.getTime() - historyWindowMs);
  const before = new Date(Date.now() + 60000);
  try {
    const page = await client.messages.listInChat(chatGuid, {
      pageSize: 100,
      after,
      before
    });
    const messages = (page.messages || []).map(summarizeHistoryMessage).filter(Boolean);
    const matched = messages.find((message) => message.text === expectedText) || null;
    return {
      status: matched ? "matched" : "not_found",
      after: after.toISOString(),
      before: before.toISOString(),
      nextPageToken: page.nextPageToken || null,
      matched,
      sampleCount: messages.length,
      samples: messages.slice(0, MAX_SAMPLE_EVENTS)
    };
  } catch (error) {
    return {
      status: "error",
      after: after.toISOString(),
      before: before.toISOString(),
      error: errorSummary(error)
    };
  }
}

async function collectCatchUp({
  client,
  expectedText,
  waitMs
}) {
  const stream = client.events.catchUp(0);
  const startedAt = new Date();
  let matched = null;
  let complete = null;
  let error = null;
  const samples = [];
  const timer = setTimeout(() => {
    stream.close?.().catch(() => {});
  }, waitMs);

  try {
    for await (const event of stream) {
      const summary = summarizeCatchUpEvent(event);
      if (summary) {
        if (samples.length >= MAX_SAMPLE_EVENTS) samples.shift();
        samples.push(summary);
      }
      if (event.type === "catchup.complete") {
        complete = {
          headSequence: event.headSequence
        };
        await stream.close?.();
        break;
      }
      if (summary?.text === expectedText) {
        matched = summary;
        await stream.close?.();
        break;
      }
    }
  } catch (caught) {
    error = errorSummary(caught);
  } finally {
    clearTimeout(timer);
  }

  return {
    status: matched ? "matched" : (complete ? "complete_without_match" : (error ? "error" : "timeout_or_closed")),
    startedAt: startedAt.toISOString(),
    durationMs: Date.now() - startedAt.getTime(),
    matched,
    complete,
    sampleCount: samples.length,
    samples,
    error
  };
}

function classifyResult({ live, history, catchUp }) {
  if (live.matched) {
    return "live_delivered";
  }
  if (history.matched) {
    return "history_visible_live_missed";
  }
  if (history.status === "error") {
    return "history_probe_error";
  }
  if (catchUp.matched) {
    return "catchup_visible_live_missed";
  }
  return "history_missing";
}

function packetSummary({ conclusion, live, history, catchUp }) {
  if (conclusion === "history_visible_live_missed") {
    return {
      issue: "Photon history returned the exact message, but messages.subscribeEvents() did not emit it during the live wait window.",
      liveStatus: live.status,
      historyMessage: history.matched,
      catchUpStatus: catchUp.status
    };
  }
  if (conclusion === "history_missing") {
    return {
      issue: "The expected message was not visible in Photon history during the queried window.",
      liveStatus: live.status,
      historyStatus: history.status,
      catchUpStatus: catchUp.status
    };
  }
  return {
    issue: "The minimal Photon live repro did not reproduce a live-stream miss.",
    liveStatus: live.status,
    historyStatus: history.status,
    catchUpStatus: catchUp.status
  };
}

async function loadHarnessConfig(args) {
  const fromFile = args.config ? await loadConfigFile(args.config) : {};
  const spectrum = fromFile.imessage?.spectrum || {};
  const imessage = fromFile.imessage || {};
  const target = (fromFile.targets || []).find((entry) => entry.id === "rick") || {};
  return {
    projectId: args.projectId || process.env.PHOTON_PROJECT_ID || spectrum.projectId,
    projectSecret: args.projectSecret || process.env.PHOTON_SECRET_KEY || spectrum.projectSecret,
    cloudUrl: normalizeCloudUrl(args.cloudUrl || process.env.SPECTRUM_CLOUD_URL || spectrum.cloudUrl || DEFAULT_CLOUD_URL),
    address: args.address || process.env.SPECTRUM_IMESSAGE_ADDRESS || DEFAULT_SHARED_ADDRESS,
    phone: args.phone || target.phone || null,
    instanceId: args.instanceId || null,
    chatGuid: args.chatGuid || target.spaceId || null,
    waitMs: positiveInteger(args.waitMs, DEFAULT_WAIT_MS),
    catchUpMs: positiveInteger(args.catchUpMs, DEFAULT_CATCHUP_MS),
    historyWindowMs: positiveInteger(args.historyWindowMs, DEFAULT_HISTORY_WINDOW_MS),
    sendViaImsg: args.sendViaImsg === true,
    imsgPath: args.imsgPath || imessage.imsgPath || "imsg",
    imsgChatId: args.imsgChatId || null,
    imsgDatabasePath: args.imsgDb || imessage.databasePath || null,
    imsgSendDelayMs: positiveInteger(args.imsgSendDelayMs, DEFAULT_IMSG_SEND_DELAY_MS)
  };
}

async function loadConfigFile(configPath) {
  const resolved = configPath.startsWith("~/")
    ? path.join(process.env.HOME || "", configPath.slice(2))
    : path.resolve(configPath);
  return JSON.parse(await fs.readFile(resolved, "utf8"));
}

async function issueImessageTokens(config) {
  const response = await fetch(`${config.cloudUrl}/projects/${encodeURIComponent(config.projectId)}/imessage/tokens`, {
    method: "POST",
    headers: {
      Authorization: `Basic ${Buffer.from(`${config.projectId}:${config.projectSecret}`).toString("base64")}`
    }
  });
  const text = await response.text();
  if (!response.ok) {
    throw new Error(`Photon token request failed (${response.status}): ${text}`);
  }
  const json = JSON.parse(text);
  if (json?.succeed === false) {
    throw new Error(`Photon token request returned succeed=false: ${json.message || json.code || text}`);
  }
  const data = Object.hasOwn(json || {}, "data") ? json.data : json;
  if (data?.type !== "shared" && data?.type !== "dedicated") {
    throw new Error(`Unsupported token response type: ${data?.type || "missing"}`);
  }
  return data;
}

function selectClient(tokenData, config) {
  if (tokenData.type === "shared") {
    return {
      phone: "shared",
      instanceId: null,
      address: config.address,
      token: tokenData.token
    };
  }
  const entries = Object.entries(tokenData.auth || {});
  const selected = entries.find(([instanceId]) => instanceId === config.instanceId) ||
    entries.find(([instanceId]) => tokenData.numbers?.[instanceId] === config.phone) ||
    entries[0];
  if (!selected) {
    throw new Error("Dedicated Photon token response did not include any iMessage instances.");
  }
  const [instanceId, token] = selected;
  return {
    phone: tokenData.numbers?.[instanceId] || null,
    instanceId,
    address: `${instanceId}.imsg.photon.codes:443`,
    token
  };
}

async function sendViaImsg({ config, text }) {
  if (!config.imsgChatId) {
    throw new Error("Pass --imsg-chat-id with --send-via-imsg.");
  }
  const args = ["send", "--chat-id", String(config.imsgChatId), "--text", text, "--json"];
  if (config.imsgDatabasePath) {
    args.push("--db", config.imsgDatabasePath);
  }
  const sentAt = new Date().toISOString();
  const { stdout } = await execFileAsync(config.imsgPath, args, { maxBuffer: 1024 * 1024 * 10 });
  return {
    status: "sent",
    sentAt,
    imsgPath: config.imsgPath,
    imsgChatId: config.imsgChatId,
    result: parseJsonLines(stdout)
  };
}

function summarizeMessageEvent(event) {
  if (!event || typeof event !== "object") return null;
  return {
    type: event.type,
    sequence: event.sequence ?? null,
    chatGuid: event.chatGuid || event.message?.chatGuids?.[0] || null,
    messageGuid: event.message?.guid || event.messageGuid || null,
    sender: event.actor?.address || event.message?.sender?.address || null,
    isFromMe: event.message?.isFromMe ?? null,
    occurredAt: isoOrNull(event.occurredAt),
    text: event.message?.content?.text || ""
  };
}

function summarizeHistoryMessage(message) {
  if (!message || typeof message !== "object") return null;
  return {
    messageGuid: message.guid || null,
    chatGuid: message.chatGuids?.[0] || null,
    sender: message.sender?.address || (message.isFromMe ? "me" : null),
    isFromMe: message.isFromMe === true,
    dateCreated: isoOrNull(message.dateCreated),
    text: message.content?.text || ""
  };
}

function summarizeCatchUpEvent(event) {
  if (!event || typeof event !== "object") return null;
  if (event.type === "catchup.complete") {
    return {
      type: event.type,
      headSequence: event.headSequence
    };
  }
  return summarizeMessageEvent(event);
}

function isoOrNull(value) {
  if (value instanceof Date) return value.toISOString();
  if (!value) return null;
  const date = new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : null;
}

async function packageVersions() {
  return {
    node: process.version,
    advancedImessage: await packageVersion("@photon-ai/advanced-imessage/package.json"),
    harnessPackage: await packageVersion("../package.json")
  };
}

async function packageVersion(specifier) {
  try {
    const packageJsonPath = specifier.startsWith(".")
      ? new URL(specifier, import.meta.url)
      : require.resolve(specifier);
    const json = JSON.parse(await fs.readFile(packageJsonPath, "utf8"));
    return json.version || null;
  } catch {
    return null;
  }
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--config") {
      parsed.config = argv[++i];
    } else if (arg.startsWith("--config=")) {
      parsed.config = arg.slice("--config=".length);
    } else if (arg === "--project-id") {
      parsed.projectId = argv[++i];
    } else if (arg.startsWith("--project-id=")) {
      parsed.projectId = arg.slice("--project-id=".length);
    } else if (arg === "--project-secret") {
      parsed.projectSecret = argv[++i];
    } else if (arg.startsWith("--project-secret=")) {
      parsed.projectSecret = arg.slice("--project-secret=".length);
    } else if (arg === "--cloud-url") {
      parsed.cloudUrl = argv[++i];
    } else if (arg.startsWith("--cloud-url=")) {
      parsed.cloudUrl = arg.slice("--cloud-url=".length);
    } else if (arg === "--address") {
      parsed.address = argv[++i];
    } else if (arg.startsWith("--address=")) {
      parsed.address = arg.slice("--address=".length);
    } else if (arg === "--phone") {
      parsed.phone = argv[++i];
    } else if (arg.startsWith("--phone=")) {
      parsed.phone = arg.slice("--phone=".length);
    } else if (arg === "--instance-id") {
      parsed.instanceId = argv[++i];
    } else if (arg.startsWith("--instance-id=")) {
      parsed.instanceId = arg.slice("--instance-id=".length);
    } else if (arg === "--chat-guid") {
      parsed.chatGuid = argv[++i];
    } else if (arg.startsWith("--chat-guid=")) {
      parsed.chatGuid = arg.slice("--chat-guid=".length);
    } else if (arg === "--text") {
      parsed.text = argv[++i];
    } else if (arg.startsWith("--text=")) {
      parsed.text = arg.slice("--text=".length);
    } else if (arg === "--wait-ms") {
      parsed.waitMs = argv[++i];
    } else if (arg.startsWith("--wait-ms=")) {
      parsed.waitMs = arg.slice("--wait-ms=".length);
    } else if (arg === "--catchup-ms") {
      parsed.catchUpMs = argv[++i];
    } else if (arg.startsWith("--catchup-ms=")) {
      parsed.catchUpMs = arg.slice("--catchup-ms=".length);
    } else if (arg === "--history-window-ms") {
      parsed.historyWindowMs = argv[++i];
    } else if (arg.startsWith("--history-window-ms=")) {
      parsed.historyWindowMs = arg.slice("--history-window-ms=".length);
    } else if (arg === "--send-via-imsg") {
      parsed.sendViaImsg = true;
    } else if (arg === "--imsg-path") {
      parsed.imsgPath = argv[++i];
    } else if (arg.startsWith("--imsg-path=")) {
      parsed.imsgPath = arg.slice("--imsg-path=".length);
    } else if (arg === "--imsg-chat-id") {
      parsed.imsgChatId = argv[++i];
    } else if (arg.startsWith("--imsg-chat-id=")) {
      parsed.imsgChatId = arg.slice("--imsg-chat-id=".length);
    } else if (arg === "--imsg-db") {
      parsed.imsgDb = argv[++i];
    } else if (arg.startsWith("--imsg-db=")) {
      parsed.imsgDb = arg.slice("--imsg-db=".length);
    } else if (arg === "--imsg-send-delay-ms") {
      parsed.imsgSendDelayMs = argv[++i];
    } else if (arg.startsWith("--imsg-send-delay-ms=")) {
      parsed.imsgSendDelayMs = arg.slice("--imsg-send-delay-ms=".length);
    } else if (arg === "--out") {
      parsed.out = argv[++i];
    } else if (arg.startsWith("--out=")) {
      parsed.out = arg.slice("--out=".length);
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  return parsed;
}

function printHelp() {
  const script = path.relative(process.cwd(), fileURLToPath(import.meta.url));
  process.stdout.write(`Usage:
  node ${script} --config config.local.json --chat-guid 'any;-;+13307669880' --text 'unique repro text'

Environment alternative:
  PHOTON_PROJECT_ID=... PHOTON_SECRET_KEY=... node ${script} --chat-guid 'any;-;+13307669880'

What it does:
  1. Opens @photon-ai/advanced-imessage messages.subscribeEvents().
  2. Waits for the exact --text value. Send that text manually from the other iMessage account, or pass --send-via-imsg with --imsg-chat-id.
  3. Reads messages.listInChat() for the same chat/time window.
  4. Timeboxes events.catchUp(0).
  5. Emits a redacted JSON artifact suitable for Photon support.

Options:
  --config <path>             Optional local connector config.
  --project-id <id>           Photon project id.
  --project-secret <secret>   Photon project secret.
  --cloud-url <url>           Spectrum cloud URL. Default: ${DEFAULT_CLOUD_URL}
  --address <host:port>       Shared iMessage gRPC address. Default: ${DEFAULT_SHARED_ADDRESS}
  --phone <phone>             Dedicated-client phone selector.
  --instance-id <id>          Dedicated-client instance selector.
  --chat-guid <guid>          Required chat GUID, for example any;-;+13307669880.
  --text <text>               Exact text to wait for. Defaults to a generated nonce.
  --wait-ms <ms>              Live subscription wait. Default: ${DEFAULT_WAIT_MS}
  --catchup-ms <ms>           Catch-up probe wait. Default: ${DEFAULT_CATCHUP_MS}
  --history-window-ms <ms>    History lookback before harness start. Default: ${DEFAULT_HISTORY_WINDOW_MS}
  --send-via-imsg             After live subscribe opens, send --text through local imsg.
  --imsg-path <path>          imsg binary path. Defaults to config imessage.imsgPath or imsg.
  --imsg-chat-id <id>         Local Messages chat id to send to when --send-via-imsg is set.
  --imsg-db <path>            Optional local Messages chat.db path for imsg.
  --imsg-send-delay-ms <ms>   Delay after subscribe starts before imsg send. Default: ${DEFAULT_IMSG_SEND_DELAY_MS}
  --out <path>                Also write JSON output to a file.
  --help                      Show this help.

Exit codes:
  0 live delivered or non-repro result
  2 history-visible live-stream miss reproduced
  3 expected message missing from Photon history
  1 harness/setup error
`);
}

function normalizeCloudUrl(value) {
  return String(value || DEFAULT_CLOUD_URL).replace(/\/+$/, "");
}

function positiveInteger(value, fallback) {
  const number = Number(value);
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback;
}

function parseJsonLines(text) {
  return String(text || "")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => JSON.parse(line));
}

function errorSummary(error) {
  return {
    name: error?.name || "Error",
    message: error?.message || String(error),
    code: error?.code || null,
    grpcCode: error?.grpcCode || null,
    status: error?.status || null,
    retryable: error?.retryable ?? null
  };
}

function redactSecrets(value) {
  if (Array.isArray(value)) {
    return value.map(redactSecrets);
  }
  if (value && typeof value === "object") {
    return Object.fromEntries(Object.entries(value).map(([key, entry]) => [
      key,
      /secret|authorization|password/i.test(key) ? "[redacted]" : redactSecrets(entry)
    ]));
  }
  if (typeof value === "string" && /^[A-Za-z0-9_-]{32,}$/.test(value)) {
    return `${value.slice(0, 6)}...redacted...${value.slice(-4)}`;
  }
  return value;
}
