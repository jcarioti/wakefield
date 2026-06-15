import fs from "node:fs/promises";
import path from "node:path";
import { codexHome } from "./hook-manager.mjs";

const THREAD_ID_RE = /([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\.jsonl$/i;

export async function listRecentThreads({
  codexHomePath = codexHome(),
  limit = 10
} = {}) {
  const sessionsDir = path.join(codexHomePath, "sessions");
  const files = [];
  await walkSessions(sessionsDir, files);
  files.sort((left, right) => right.mtimeMs - left.mtimeMs);

  const seen = new Set();
  const threads = [];
  for (const file of files) {
    const threadId = threadIdFromFilename(path.basename(file.path));
    if (!threadId || seen.has(threadId)) continue;
    seen.add(threadId);
    threads.push({
      threadId,
      path: file.path,
      updatedAt: new Date(file.mtimeMs).toISOString(),
      ...await readSessionMeta(file.path)
    });
    if (threads.length >= limit) break;
  }
  return threads;
}

export function threadIdFromFilename(name) {
  return String(name || "").match(THREAD_ID_RE)?.[1] || null;
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

async function readSessionMeta(file) {
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch {
    return {};
  }
  for (const line of text.split("\n").slice(0, 20)) {
    if (!line.trim()) continue;
    let entry;
    try {
      entry = JSON.parse(line);
    } catch {
      continue;
    }
    if (entry.type !== "session_meta") continue;
    const payload = entry.payload || {};
    return {
      cwd: payload.cwd || null,
      originator: payload.originator || null,
      createdAt: payload.timestamp || entry.timestamp || null
    };
  }
  return {};
}
