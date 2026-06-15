import { connectorStatus } from "./connectors.mjs";
import { ingestEmailRfc822, parseRfc822 } from "./email-rfc822.mjs";
import { readJson, writeJson } from "./json-store.mjs";
import { appHome, connectorStatePath } from "./paths.mjs";

const DEFAULT_MAX_MESSAGES = 10;

export async function pollEmailImap(agent, {
  home = appHome(),
  mailboxClient = null,
  limit = null,
  now = new Date()
} = {}) {
  if (!agent) throw new Error("pollEmailImap needs an agent profile.");
  const connector = await connectorStatus("email", { home });
  const statePath = connectorStatePath("email", home);

  if (!connector.enabled) {
    return pollResult({
      ok: false,
      status: "disabled",
      reason: "Email connector is disabled.",
      connector,
      statePath
    });
  }

  if (!connector.configured) {
    return pollResult({
      ok: false,
      status: "needs-setup",
      reason: `Email connector is missing: ${connector.missingSettings.join(", ")}.`,
      connector,
      statePath
    });
  }

  if (connector.missingSecrets.length > 0) {
    return pollResult({
      ok: false,
      status: "missing-secret",
      reason: `Missing password environment variable: ${connector.missingSecrets.join(", ")}.`,
      connector,
      statePath
    });
  }

  const settings = connector.settings;
  const mailbox = mailboxClient || await createImapMailboxClient(settings);
  const closeMailbox = !mailboxClient;
  let state = await loadEmailPollState(statePath);
  const results = [];

  try {
    const summaries = await mailbox.listMessages({
      maxResults: normalizeLimit(limit || settings.maxMessagesPerPoll || DEFAULT_MAX_MESSAGES)
    });

    for (const summary of summaries) {
      const providerMessageId = providerId(summary);
      if (!providerMessageId) {
        results.push({ skipped: true, reason: "missing_provider_id" });
        continue;
      }
      if (state.processed[providerMessageId]) {
        results.push({ id: providerMessageId, skipped: true, reason: "already_processed" });
        continue;
      }

      const raw = normalizeRawMessage(summary.raw || summary.source || await mailbox.getMessage(providerMessageId));
      const parsed = parseRfc822(raw);
      if (!senderAllowed(parsed.from, settings.allowedSenders)) {
        await markMailboxProcessed(mailbox, providerMessageId);
        state = markProcessed(state, providerMessageId, now);
        await writeJson(statePath, state);
        results.push({ id: providerMessageId, skipped: true, reason: "sender_not_allowed", sender: parsed.from || null });
        continue;
      }

      const ingested = await ingestEmailRfc822(agent, {
        raw,
        sourceFile: `imap:${settings.username}:${providerMessageId}`,
        now
      });
      await markMailboxProcessed(mailbox, providerMessageId);
      state = markProcessed(state, providerMessageId, now);
      await writeJson(statePath, state);
      results.push({
        id: providerMessageId,
        queued: !ingested.duplicate,
        duplicate: Boolean(ingested.duplicate),
        externalMessageId: ingested.message.id,
        routeStatus: ingested.route.status,
        subject: ingested.message.subject || null
      });
    }
  } finally {
    if (closeMailbox && typeof mailbox.close === "function") await mailbox.close();
  }

  return pollResult({
    ok: true,
    status: "poll-complete",
    reason: null,
    connector,
    statePath,
    results
  });
}

export async function createImapMailboxClient(settings, {
  imapFlowFactory = null,
  logger = false
} = {}) {
  const { ImapFlow } = imapFlowFactory ? { ImapFlow: imapFlowFactory } : await import("imapflow");
  return new WakefieldImapMailboxClient({
    host: settings.imapHost,
    port: settings.imapPort || 993,
    secure: settings.secure == null ? true : truthy(settings.secure),
    user: settings.username,
    password: process.env[String(settings.passwordEnv)],
    mailbox: settings.mailbox || "INBOX",
    processedMailbox: settings.processedMailbox || null,
    markSeen: settings.markSeen == null ? true : truthy(settings.markSeen),
    unseenOnly: settings.unseenOnly == null ? true : truthy(settings.unseenOnly),
    sinceDays: settings.sinceDays || 14,
    logger,
    imapFlowFactory: (options) => new ImapFlow(options)
  });
}

export class WakefieldImapMailboxClient {
  constructor({
    host,
    port = 993,
    secure = true,
    user,
    password,
    mailbox = "INBOX",
    processedMailbox = null,
    markSeen = true,
    unseenOnly = true,
    sinceDays = 14,
    logger = false,
    imapFlowFactory
  }) {
    this.host = host;
    this.port = Number(port);
    this.secure = Boolean(secure);
    this.user = user;
    this.password = password;
    this.mailbox = mailbox || "INBOX";
    this.processedMailbox = processedMailbox || null;
    this.markSeen = markSeen !== false;
    this.unseenOnly = unseenOnly !== false;
    this.sinceDays = Number(sinceDays || 14);
    this.logger = logger;
    this.imapFlowFactory = imapFlowFactory;
    this.client = null;
  }

  async listMessages({ maxResults = DEFAULT_MAX_MESSAGES } = {}) {
    await this.ensureOpen();
    const query = {};
    if (this.unseenOnly) query.seen = false;
    if (this.sinceDays > 0) {
      query.since = new Date(Date.now() - this.sinceDays * 24 * 60 * 60 * 1000);
    }
    const uids = await this.client.search(query, { uid: true });
    return (uids || [])
      .slice(-normalizeLimit(maxResults))
      .map((uid) => ({ id: String(uid), uid }));
  }

  async getMessage(id) {
    await this.ensureOpen();
    const fetched = await this.client.fetchOne(String(id), { uid: true, source: true }, { uid: true });
    if (!fetched) throw new Error(`IMAP message UID ${id} was not found in ${this.mailbox}.`);
    return fetched.source;
  }

  async markProcessed(id) {
    await this.ensureOpen();
    if (this.markSeen) await this.client.messageFlagsAdd(String(id), ["\\Seen"], { uid: true });
    if (this.processedMailbox) await this.client.messageMove(String(id), this.processedMailbox, { uid: true });
  }

  async close() {
    if (!this.client) return;
    const client = this.client;
    this.client = null;
    if (typeof client.logout === "function") await client.logout();
  }

  async ensureOpen() {
    if (this.client) return;
    if (!this.host || !this.user || !this.password) {
      throw new Error("IMAP host, username, and password environment variable are required.");
    }
    const client = this.imapFlowFactory({
      host: this.host,
      port: this.port,
      secure: this.secure,
      auth: {
        user: this.user,
        pass: this.password
      },
      logger: this.logger
    });
    await client.connect();
    await client.mailboxOpen(this.mailbox);
    this.client = client;
  }
}

export function formatEmailPoll(result) {
  const lines = [
    `Email poll: ${result.status}`,
    `checked: ${result.checked}`,
    `queued: ${result.queued}`,
    `duplicates: ${result.duplicates}`,
    `skipped: ${result.skipped}`
  ];
  if (result.reason) lines.push(`reason: ${result.reason}`);
  return lines.join("\n");
}

export function senderAllowed(from, allowedSenders = "") {
  const rules = parseList(allowedSenders).map((item) => item.toLowerCase());
  if (rules.length === 0) return true;
  const sender = emailAddress(from).toLowerCase();
  if (!sender) return false;
  return rules.some((rule) => rule.startsWith("@") ? sender.endsWith(rule) : sender === rule);
}

function pollResult({
  ok,
  status,
  reason = null,
  connector,
  statePath,
  results = []
}) {
  return {
    ok,
    status,
    reason,
    connector: {
      id: connector.id,
      ready: connector.ready,
      enabled: connector.enabled,
      configured: connector.configured,
      missingSettings: connector.missingSettings,
      missingSecrets: connector.missingSecrets
    },
    checked: results.length,
    queued: results.filter((result) => result.queued).length,
    duplicates: results.filter((result) => result.duplicate).length,
    skipped: results.filter((result) => result.skipped).length,
    statePath,
    results
  };
}

async function loadEmailPollState(statePath) {
  const current = await readJson(statePath, {});
  return {
    processed: current.processed && typeof current.processed === "object" ? current.processed : {},
    updatedAt: current.updatedAt || null
  };
}

function markProcessed(state, providerMessageId, now) {
  const at = now.toISOString();
  return {
    processed: {
      ...state.processed,
      [providerMessageId]: at
    },
    updatedAt: at
  };
}

function providerId(summary) {
  return summary?.id == null ? null : String(summary.id);
}

function normalizeRawMessage(value) {
  if (Buffer.isBuffer(value)) return value.toString("utf8");
  if (value?.source) return normalizeRawMessage(value.source);
  return String(value || "");
}

async function markMailboxProcessed(mailbox, providerMessageId) {
  if (typeof mailbox.markProcessed === "function") await mailbox.markProcessed(providerMessageId);
}

function normalizeLimit(value) {
  const limit = Number(value || DEFAULT_MAX_MESSAGES);
  if (!Number.isFinite(limit) || limit < 1) throw new Error("Email poll limit must be at least 1.");
  return Math.round(limit);
}

function parseList(value) {
  return Array.isArray(value)
    ? value.flatMap(parseList)
    : String(value || "").split(",").map((item) => item.trim()).filter(Boolean);
}

function emailAddress(value) {
  const text = String(value || "").trim();
  const angle = text.match(/<([^>]+)>/);
  if (angle) return angle[1].trim();
  const plain = text.match(/[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}/i);
  return (plain?.[0] || text).trim();
}

function truthy(value) {
  return ["1", "true", "yes", "on"].includes(String(value).trim().toLowerCase());
}
