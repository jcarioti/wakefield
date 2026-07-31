import fs from "node:fs/promises";
import path from "node:path";
import { randomUUID } from "node:crypto";

const PRIVATE_FILE_MODE = 0o600;
const PRIVATE_DIR_MODE = 0o700;

export async function ensureDir(dir) {
  await fs.mkdir(dir, { recursive: true });
}

export async function pathExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(file, fallback = null) {
  try {
    return JSON.parse(await fs.readFile(file, "utf8"));
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

export async function writeJson(file, value, {
  mode = PRIVATE_FILE_MODE
} = {}) {
  const dir = path.dirname(file);
  await ensureDir(dir);
  const temporary = path.join(dir, `.${path.basename(file)}.${process.pid}.${randomUUID()}.tmp`);
  let handle = null;
  try {
    handle = await fs.open(temporary, "wx", mode);
    await handle.writeFile(`${JSON.stringify(value, null, 2)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = null;
    await fs.rename(temporary, file);
    await fs.chmod(file, mode);
    await syncDirectory(dir);
  } finally {
    await handle?.close().catch(() => {});
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

export async function appendJsonl(file, value) {
  return withFileMutationLock(file, async () => {
    await ensureDir(path.dirname(file));
    const handle = await fs.open(file, "a+", PRIVATE_FILE_MODE);
    try {
      await handle.chmod(PRIVATE_FILE_MODE);
      await repairJsonlTail(handle);
      await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
      await handle.sync();
    } finally {
      await handle.close();
    }
  });
}

export async function readJsonl(file) {
  if (!file) return [];
  let text;
  try {
    text = await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const lines = text.split(/\r?\n/g);
  const hasTerminatingNewline = /\r?\n$/.test(text);
  const entries = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    if (!line.trim()) continue;
    try {
      entries.push(JSON.parse(line));
    } catch (error) {
      const isUnterminatedTail = !hasTerminatingNewline && index === lines.length - 1;
      if (isUnterminatedTail) break;
      throw error;
    }
  }
  return entries;
}

export async function touch(file, {
  mode = PRIVATE_FILE_MODE
} = {}) {
  await ensureDir(path.dirname(file));
  const handle = await fs.open(file, "a", mode);
  try {
    await handle.chmod(mode);
  } finally {
    await handle.close();
  }
}

export async function withFileMutationLock(file, callback, {
  lockName = "memory-store",
  timeoutMs = 8000,
  staleMs = 30000,
  pollMs = 50
} = {}) {
  const lockRoot = path.join(path.dirname(file), ".locks");
  await fs.mkdir(lockRoot, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(lockRoot, PRIVATE_DIR_MODE);
  const safeName = String(lockName).replace(/[^a-zA-Z0-9._-]/g, "_");
  const lockPath = path.join(lockRoot, `${safeName}.lock`);
  const owner = {
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString()
  };
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath, { mode: PRIVATE_DIR_MODE });
      await fs.writeFile(path.join(lockPath, "owner.json"), `${JSON.stringify(owner)}\n`, {
        encoding: "utf8",
        mode: PRIVATE_FILE_MODE
      });
      break;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      const existingOwner = await readLockOwner(lockPath);
      const stat = await fs.stat(lockPath).catch(() => null);
      const stale = stat && Date.now() - stat.mtimeMs > staleMs;
      if ((existingOwner?.pid && !isProcessAlive(existingOwner.pid)) || (!existingOwner?.pid && stale)) {
        const abandoned = `${lockPath}.abandoned.${process.pid}.${randomUUID()}`;
        try {
          await fs.rename(lockPath, abandoned);
          await fs.rm(abandoned, { recursive: true, force: true });
          continue;
        } catch (reclaimError) {
          if (reclaimError?.code === "ENOENT") continue;
          throw reclaimError;
        }
      }
      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for memory lock ${lockName}.`);
      }
      await sleep(pollMs);
    }
  }

  try {
    return await callback();
  } finally {
    const currentOwner = await readLockOwner(lockPath);
    if (currentOwner?.pid === owner.pid && currentOwner?.nonce === owner.nonce) {
      await fs.rm(lockPath, { recursive: true, force: true });
    }
  }
}

export async function securePrivateDirectory(dir) {
  await fs.mkdir(dir, { recursive: true, mode: PRIVATE_DIR_MODE });
  await fs.chmod(dir, PRIVATE_DIR_MODE);
}

export async function securePrivateFile(file) {
  await fs.chmod(file, PRIVATE_FILE_MODE).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function repairJsonlTail(handle) {
  const stat = await handle.stat();
  if (stat.size === 0) return;
  const lastByte = Buffer.alloc(1);
  await handle.read(lastByte, 0, 1, stat.size - 1);
  if (lastByte[0] === 0x0a) return;

  const { text, start } = await readFinalLine(handle, stat.size);
  try {
    JSON.parse(text.replace(/\r$/, ""));
    await handle.writeFile("\n", "utf8");
  } catch {
    await handle.truncate(start);
  }
}

async function readFinalLine(handle, size) {
  const chunks = [];
  let position = size;
  while (position > 0) {
    const length = Math.min(64 * 1024, position);
    position -= length;
    const buffer = Buffer.alloc(length);
    await handle.read(buffer, 0, length, position);
    const newline = buffer.lastIndexOf(0x0a);
    if (newline >= 0) {
      chunks.unshift(buffer.subarray(newline + 1));
      return {
        text: Buffer.concat(chunks).toString("utf8"),
        start: position + newline + 1
      };
    }
    chunks.unshift(buffer);
  }
  return {
    text: Buffer.concat(chunks).toString("utf8"),
    start: 0
  };
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function isProcessAlive(pid) {
  try {
    process.kill(Number(pid), 0);
    return true;
  } catch (error) {
    return error?.code === "EPERM";
  }
}

async function syncDirectory(dir) {
  let handle;
  try {
    handle = await fs.open(dir, "r");
    await handle.sync();
  } catch (error) {
    if (!["EINVAL", "EISDIR", "ENOTSUP", "EPERM"].includes(error?.code)) throw error;
  } finally {
    await handle?.close().catch(() => {});
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
