import fs from "node:fs/promises";
import { ingestExternalMessage } from "./external-messages.mjs";
import { appHome } from "./paths.mjs";

export async function readEmailInput({
  file = null,
  stdin = process.stdin
} = {}) {
  if (file) return fs.readFile(file, "utf8");
  const chunks = [];
  for await (const chunk of stdin) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

export async function ingestEmailRfc822(agent, {
  home = appHome(),
  raw,
  sourceFile = null,
  now = new Date()
} = {}) {
  if (!agent) throw new Error("ingestEmailRfc822 needs an agent profile.");
  const parsed = parseRfc822(raw);
  if (!parsed.text) throw new Error("Email message body is empty.");

  return ingestExternalMessage(agent, {
    home,
    connector: "email",
    conversationId: parsed.threadId || parsed.messageId || parsed.from || null,
    sender: parsed.from,
    messageId: parsed.messageId,
    subject: parsed.subject,
    text: parsed.text,
    metadata: {
      date: parsed.date,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      contentType: parsed.contentType,
      sourceFile
    },
    now
  });
}

export function parseRfc822(raw) {
  const { headers, body } = splitMessage(raw);
  const contentType = firstHeader(headers, "content-type") || "text/plain";
  const transferEncoding = firstHeader(headers, "content-transfer-encoding") || "";
  const text = extractTextBody(body, contentType, transferEncoding);
  const references = firstHeader(headers, "references") || "";
  const inReplyTo = cleanMessageId(firstHeader(headers, "in-reply-to"));

  return {
    from: decodeHeader(firstHeader(headers, "from") || ""),
    to: decodeHeader(firstHeader(headers, "to") || ""),
    cc: decodeHeader(firstHeader(headers, "cc") || ""),
    replyTo: decodeHeader(firstHeader(headers, "reply-to") || ""),
    subject: decodeHeader(firstHeader(headers, "subject") || ""),
    date: firstHeader(headers, "date") || null,
    messageId: cleanMessageId(firstHeader(headers, "message-id")),
    inReplyTo,
    references,
    threadId: inReplyTo || lastMessageId(references) || null,
    contentType,
    text
  };
}

export function formatEmailIngest(result) {
  const duplicate = result.duplicate ? "Already queued" : "Queued";
  return [
    `${duplicate} email message: ${result.message.id}`,
    `from: ${result.message.sender || "unknown"}`,
    `subject: ${result.message.subject || "(no subject)"}`,
    `route: ${result.route.status}`
  ].join("\n");
}

function splitMessage(raw) {
  const text = String(raw || "").replace(/\r\n/g, "\n");
  const index = text.search(/\n\n/);
  const headerText = index >= 0 ? text.slice(0, index) : text;
  const body = index >= 0 ? text.slice(index + 2) : "";
  return {
    headers: parseHeaders(headerText),
    body
  };
}

function parseHeaders(headerText) {
  const headers = new Map();
  const lines = [];
  for (const line of String(headerText || "").split("\n")) {
    if (/^[ \t]/.test(line) && lines.length > 0) {
      lines[lines.length - 1] += ` ${line.trim()}`;
    } else {
      lines.push(line);
    }
  }

  for (const line of lines) {
    const index = line.indexOf(":");
    if (index <= 0) continue;
    const key = line.slice(0, index).trim().toLowerCase();
    const value = line.slice(index + 1).trim();
    const values = headers.get(key) || [];
    values.push(value);
    headers.set(key, values);
  }
  return headers;
}

function firstHeader(headers, name) {
  return headers.get(name)?.[0] || "";
}

function extractTextBody(body, contentType, transferEncoding) {
  const boundary = multipartBoundary(contentType);
  if (boundary) {
    const plainPart = splitMultipart(body, boundary)
      .map((part) => splitMessage(part))
      .map(({ headers, body: partBody }) => ({
        contentType: firstHeader(headers, "content-type") || "text/plain",
        transferEncoding: firstHeader(headers, "content-transfer-encoding") || "",
        body: partBody
      }))
      .find((part) => /^text\/plain\b/i.test(part.contentType));
    if (plainPart) return cleanBody(decodeBody(plainPart.body, plainPart.transferEncoding));
  }

  const decoded = decodeBody(body, transferEncoding);
  return /^text\/html\b/i.test(contentType)
    ? cleanBody(stripHtml(decoded))
    : cleanBody(decoded);
}

function splitMultipart(body, boundary) {
  const marker = `--${boundary}`;
  return String(body || "")
    .split(marker)
    .slice(1)
    .map((part) => part.replace(/^--\s*/, "").trim())
    .filter(Boolean);
}

function multipartBoundary(contentType) {
  const match = String(contentType || "").match(/\bboundary=(?:"([^"]+)"|([^;\s]+))/i);
  return match?.[1] || match?.[2] || null;
}

function decodeBody(body, transferEncoding) {
  const encoding = String(transferEncoding || "").toLowerCase();
  if (encoding === "base64") {
    return Buffer.from(String(body || "").replace(/\s+/g, ""), "base64").toString("utf8");
  }
  if (encoding === "quoted-printable") return decodeQuotedPrintable(body);
  return String(body || "");
}

function decodeQuotedPrintable(value) {
  return String(value || "")
    .replace(/=\n/g, "")
    .replace(/=([0-9a-f]{2})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)));
}

function stripHtml(value) {
  return String(value || "")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/p>/gi, "\n")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"');
}

function cleanBody(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function decodeHeader(value) {
  return String(value || "").replace(/=\?([^?]+)\?([bq])\?([^?]+)\?=/gi, (_, charset, encoding, text) => {
    const normalizedCharset = String(charset || "").toLowerCase();
    const bytes = encoding.toLowerCase() === "b"
      ? Buffer.from(text, "base64")
      : Buffer.from(String(text).replace(/_/g, " ").replace(/=([0-9a-f]{2})/gi, (_match, hex) => String.fromCharCode(parseInt(hex, 16))), "binary");
    if (normalizedCharset === "utf-8" || normalizedCharset === "us-ascii") return bytes.toString("utf8");
    return bytes.toString();
  });
}

function cleanMessageId(value) {
  const match = String(value || "").match(/<([^>]+)>/);
  return (match?.[1] || String(value || "")).trim() || null;
}

function lastMessageId(value) {
  const matches = [...String(value || "").matchAll(/<([^>]+)>/g)].map((match) => match[1]);
  return matches.at(-1) || null;
}
