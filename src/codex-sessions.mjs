import fs from "node:fs/promises";
import path from "node:path";
import { codexHome } from "./hook-manager.mjs";
import { expandHome } from "./paths.mjs";

const THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function listRecentThreads({
  codexHomePath = codexHome(),
  limit = 10
} = {}) {
  const sessionsDir = path.join(codexHomePath, "sessions");
  const indexedTitles = await readSessionIndex(path.join(codexHomePath, "session_index.jsonl"));
  const files = [];
  await walkSessions(sessionsDir, files);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const seen = new Set();
  const threads = [];
  for (const file of files) {
    const threadId = threadIdFromFilename(path.basename(file.path));
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    const sessionMeta = await readSessionMeta(file.path);
    const indexed = indexedTitles.get(threadId);
    threads.push({
      threadId,
      path: file.path,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      ...sessionMeta,
      title: indexed?.threadName || sessionMeta.title || null
    });
    if (threads.length >= limit) break;
  }
  return threads;
}

export function threadIdFromFilename(name) {
  return String(name || "").match(THREAD_ID_RE)?.[1] || null;
}

export async function findRecentThreadByPrompt({
  codexHomePath = codexHome(),
  cwd = null,
  prompt,
  limit = 50
} = {}) {
  const needle = normalizeTranscriptText(prompt);
  if (!needle) throw new Error("Finding a Codex thread by prompt needs prompt text.");
  const resolvedCwd = cwd ? path.resolve(expandHome(cwd)) : null;
  const threads = await listRecentThreads({ codexHomePath, limit });
  for (const thread of threads) {
    if (resolvedCwd && (!thread.cwd || path.resolve(expandHome(thread.cwd)) !== resolvedCwd)) continue;
    const transcriptText = await readSessionUserText(thread.path);
    if (normalizeTranscriptText(transcriptText).includes(needle)) {
      return {
        ...thread,
        matchedPrompt: true
      };
    }
  }
  return null;
}

export async function waitForThreadByPrompt({
  timeoutMs = 120000,
  pollMs = 2000,
  ...options
} = {}) {
  const deadline = Date.now() + Number(timeoutMs || 0);
  const interval = Math.max(250, Number(pollMs || 2000));
  do {
    const thread = await findRecentThreadByPrompt(options);
    if (thread) return thread;
    if (Date.now() >= deadline) break;
    await sleep(Math.min(interval, Math.max(0, deadline - Date.now())));
  } while (Date.now() <= deadline);
  return null;
}

async function walkSessions(dir, files, depth = 0) {
  if (depth > 6) return;
  let entries;
  try {
    entries = await fs.readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }

  for (const entry of entries) {
    const entryPath = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      await walkSessions(entryPath, files, depth + 1);
    } else if (entry.isFile() && entry.name.startsWith("rollout-") && entry.name.endsWith(".jsonl")) {
      const stat = await fs.stat(entryPath).catch(() => null);
      files.push({ path: entryPath, mtimeMs: stat?.mtimeMs || 0 });
    }
  }
}

async function readSessionIndex(file) {
  const titles = new Map();
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return titles;
  }

  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const id = String(entry.id || "");
    const threadName = String(entry.thread_name || "").trim();
    if (!id || !threadName) continue;
    const updatedAt = Date.parse(entry.updated_at || "");
    const previous = titles.get(id);
    if (!previous || Number.isNaN(previous.updatedAt) || (!Number.isNaN(updatedAt) && updatedAt >= previous.updatedAt)) {
      titles.set(id, { threadName, updatedAt });
    }
  }
  return titles;
}

async function readSessionMeta(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  const meta = {};
  let title = null;
  for (const line of text.split("\n").slice(0, 120)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type === "session_meta") {
      const payload = entry.payload || {};
      meta.cwd = payload.cwd || null;
      meta.originator = payload.originator || null;
      meta.createdAt = payload.timestamp || entry.timestamp || null;
      continue;
    }
    if (!title) title = titleFromEntry(entry);
    if (meta.cwd !== undefined && title) break;
  }
  return {
    ...meta,
    title
  };
}

function titleFromEntry(entry) {
  if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
    return titleFromText(entry.payload.message);
  }
  if (entry.type !== "response_item") return null;
  const payload = entry.payload || {};
  if (payload.type !== "message" || payload.role !== "user") return null;
  const text = (payload.content || [])
    .filter((item) => item?.type === "input_text")
    .map((item) => item.text)
    .join("\n")
    .trim();
  return titleFromText(text);
}

async function readSessionUserText(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return "";
  }
  const chunks = [];
  for (const line of text.split("\n")) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    const userText = userTextFromEntry(entry);
    if (userText) chunks.push(userText);
  }
  return chunks.join("\n\n");
}

function userTextFromEntry(entry) {
  if (entry.type === "event_msg" && entry.payload?.type === "user_message") {
    return String(entry.payload.message || "");
  }
  if (entry.type !== "response_item") return "";
  const payload = entry.payload || {};
  if (payload.type !== "message" || payload.role !== "user") return "";
  return (payload.content || [])
    .filter((item) => item?.type === "input_text")
    .map((item) => item.text)
    .join("\n")
    .trim();
}

function normalizeTranscriptText(value) {
  return String(value || "")
    .replace(/\r\n/g, "\n")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function titleFromText(value) {
  const text = String(value || "")
    .replace(/\s+/g, " ")
    .trim();
  if (!text) return null;
  if (text.startsWith("# AGENTS.md instructions")) return null;
  if (text.startsWith("<permissions instructions>")) return null;
  if (text.startsWith("<environment_context>")) return null;
  if (text.startsWith("<app-context>")) return null;
  const sentence = text.split(/(?<=[.!?])\s+/)[0] || text;
  return sentence.length > 84 ? `${sentence.slice(0, 81).trimEnd()}...` : sentence;
}
