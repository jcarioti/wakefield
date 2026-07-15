import fs from "node:fs/promises";
import { ingestExternalMessage } from "./external-messages.mjs";
import { appHome } from "./paths.mjs";

const MAX_EMAIL_TEXT_CHARS = 128_000;

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
    text: limitEmailText(parsed.text),
    metadata: {
      date: parsed.date,
      to: parsed.to,
      cc: parsed.cc,
      replyTo: parsed.replyTo,
      inReplyTo: parsed.inReplyTo,
      references: parsed.references,
      contentType: parsed.contentType,
      attachments: parsed.attachments,
      sourceFile
    },
    now
  });
}

export function parseRfc822(raw) {
  const source = parseEmailSource(raw);
  const { headers, body } = source;
  const mimeHeaders = source.mimeHeaders || headers;
  const contentType = source.contentType || firstHeader(mimeHeaders, "content-type") || "text/plain";
  const transferEncoding = source.transferEncoding || firstHeader(mimeHeaders, "content-transfer-encoding") || "";
  const extracted = extractMimePart({
    headers: mimeHeaders,
    body,
    contentType,
    transferEncoding
  });
  const attachments = uniqueAttachments([
    ...extracted.attachments,
    ...(source.outerParts || []).flatMap((part) => extractMimePart(part).attachments)
  ]);
  const references = firstHeader(headers, "references") || "";
  const inReplyTo = cleanMessageId(firstHeader(headers, "in-reply-to"));
  const conversationId = firstHeader(headers, "conversation") || null;
  const messageId = firstHeader(headers, "message-id") || firstHeader(headers, "message id") || "";

  return {
    from: decodeHeader(firstHeader(headers, "from") || ""),
    to: decodeHeader(firstHeader(headers, "to") || ""),
    cc: decodeHeader(firstHeader(headers, "cc") || ""),
    replyTo: decodeHeader(firstHeader(headers, "reply-to") || ""),
    subject: decodeHeader(firstHeader(headers, "subject") || ""),
    date: firstHeader(headers, "date") || null,
    messageId: cleanMessageId(messageId),
    inReplyTo,
    references,
    conversationId,
    threadId: inReplyTo || lastMessageId(references) || conversationId || null,
    contentType,
    text: extracted.text,
    attachments,
    envelope: Boolean(source.envelope)
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

function parseEmailSource(raw) {
  const text = normalizeNewlines(raw);
  const marker = text.match(/(?:^|\n)Message:[ \t]*\n/i);
  if (!marker) {
    const { headers, body } = splitMessage(text);
    return { headers, mimeHeaders: headers, body };
  }

  const envelopeHeaderText = text.slice(0, marker.index).replace(/^\n/, "");
  if (!/^\s*External Email message\b/im.test(envelopeHeaderText)
    || !/(?:^|\n)Connector:[ \t]*email[ \t]*$/im.test(envelopeHeaderText)) {
    const { headers, body } = splitMessage(text);
    return { headers, mimeHeaders: headers, body };
  }

  const envelopeHeaders = parseHeaders(envelopeHeaderText);
  const messageBody = text.slice(marker.index + marker[0].length);
  const boundaryMatch = messageBody.match(/^[ \t]*--([^ \t\r\n]+)[ \t]*(?:\n|$)/);
  if (boundaryMatch) {
    const outerParts = splitMultipart(messageBody, boundaryMatch[1]).map(parseMimePart);
    const container = outerParts.find((part) => /^multipart\//i.test(part.contentType));
    if (container) {
      return {
        headers: envelopeHeaders,
        mimeHeaders: container.headers,
        body: container.body,
        contentType: container.contentType,
        transferEncoding: container.transferEncoding,
        outerParts: outerParts.filter((part) => part !== container),
        envelope: true
      };
    }
  }

  const inner = splitMessage(messageBody);
  if (firstHeader(inner.headers, "content-type") || firstHeader(inner.headers, "from")) {
    const headers = mergeHeaderMaps(envelopeHeaders, inner.headers);
    return { headers, mimeHeaders: headers, body: inner.body, envelope: true };
  }

  return {
    headers: envelopeHeaders,
    mimeHeaders: envelopeHeaders,
    body: messageBody,
    envelope: true
  };
}

function splitMessage(raw) {
  const text = normalizeNewlines(raw);
  const index = text.search(/\n\n/);
  const headerText = index >= 0 ? text.slice(0, index) : text;
  const body = index >= 0 ? text.slice(index + 2) : "";
  return {
    headers: parseHeaders(headerText),
    body
  };
}

function normalizeNewlines(raw) {
  return String(raw || "").replace(/\r\n/g, "\n");
}

function mergeHeaderMaps(outer, inner) {
  const merged = new Map(inner);
  for (const [key, values] of outer) {
    if (!merged.has(key)) merged.set(key, values);
  }
  return merged;
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

function extractMimePart({
  headers = new Map(),
  body = "",
  contentType = "",
  transferEncoding = ""
} = {}) {
  const boundary = multipartBoundary(contentType);
  if (boundary) {
    const parts = splitMultipart(body, boundary).map(parseMimePart);
    const extracted = parts.map((part) => extractMimePart(part));
    const plainPart = extracted.find((part) => part.kind === "plain" && part.text);
    const htmlPart = extracted.find((part) => part.kind === "html" && part.text);
    return {
      kind: plainPart ? "plain" : htmlPart ? "html" : "multipart",
      text: plainPart?.text || htmlPart?.text || "",
      attachments: extracted.flatMap((part) => part.attachments)
    };
  }

  if (isAttachmentPart(headers, contentType)) {
    return {
      kind: "attachment",
      text: "",
      attachments: [attachmentMetadata(headers, contentType)]
    };
  }

  if (/^text\/plain\b/i.test(contentType)) {
    return {
      kind: "plain",
      text: cleanBody(decodeBody(body, transferEncoding)),
      attachments: []
    };
  }

  if (/^text\/html\b/i.test(contentType)) {
    return {
      kind: "html",
      text: cleanBody(stripHtml(decodeBody(body, transferEncoding))),
      attachments: []
    };
  }

  if (contentType && !/^text\//i.test(contentType)) {
    return {
      kind: "attachment",
      text: "",
      attachments: [attachmentMetadata(headers, contentType)]
    };
  }

  return { kind: "unknown", text: "", attachments: [] };
}

function parseMimePart(part) {
  const { headers, body } = splitMessage(part);
  return {
    headers,
    body,
    contentType: firstHeader(headers, "content-type") || "text/plain",
    transferEncoding: firstHeader(headers, "content-transfer-encoding") || ""
  };
}

function isAttachmentPart(headers, contentType) {
  const disposition = firstHeader(headers, "content-disposition");
  const filename = headerParameter(disposition, "filename") || headerParameter(contentType, "name");
  return /^attachment\b/i.test(disposition) || Boolean(filename);
}

function attachmentMetadata(headers, contentType) {
  const disposition = firstHeader(headers, "content-disposition");
  const filename = headerParameter(disposition, "filename") || headerParameter(contentType, "name");
  return {
    filename: filename ? decodeHeader(filename) : null,
    contentType: String(contentType || "application/octet-stream").split(";", 1)[0].trim() || null
  };
}

function headerParameter(value, name) {
  const match = String(value || "").match(new RegExp(`(?:^|;)\\s*${name}\\s*=\\s*(?:"([^"]*)"|([^;\\s]+))`, "i"));
  return match?.[1] ?? match?.[2] ?? null;
}

function uniqueAttachments(attachments) {
  const seen = new Set();
  return attachments.filter((attachment) => {
    const key = `${attachment.filename || ""}|${attachment.contentType || ""}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function limitEmailText(value) {
  const text = cleanBody(value);
  if (text.length <= MAX_EMAIL_TEXT_CHARS) return text;
  return `${text.slice(0, MAX_EMAIL_TEXT_CHARS)}\n\n[Email body truncated by Wakefield.]`;
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
