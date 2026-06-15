import fs from "node:fs/promises";
import { spawnSync } from "node:child_process";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";

const DEFAULT_LOCK_ROOT = path.join(os.tmpdir(), "discord-codex-locks");

export async function withFileLock(lockName, options, callback) {
  const release = await acquireFileLock(lockName, options);
  try {
    return await callback();
  } finally {
    await release();
  }
}

export async function acquireFileLock(lockName, {
  lockRoot = DEFAULT_LOCK_ROOT,
  timeoutMs = 8000,
  staleMs = 30000,
  pollMs = 100
} = {}) {
  lockRoot ||= DEFAULT_LOCK_ROOT;
  await fs.mkdir(lockRoot, { recursive: true });
  const safeName = lockName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const lockPath = path.join(lockRoot, `${safeName}.lock`);
  const owner = createLockOwner();
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner, null, 2), "utf8");
      return async () => {
        await fs.rm(lockPath, { recursive: true, force: true });
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const stat = await fs.stat(lockPath).catch(() => null);
      if (stat != null && Date.now() - stat.mtimeMs > staleMs) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Codex thread lock ${lockName}.`);
      }
      await sleep(pollMs);
    }
  }
}

export async function acquireSingletonProcessLock(lockName, {
  lockRoot = DEFAULT_LOCK_ROOT,
  timeoutMs = 1000,
  staleMs = 10000,
  pollMs = 100
} = {}) {
  lockRoot ||= DEFAULT_LOCK_ROOT;
  await fs.mkdir(lockRoot, { recursive: true });
  const safeName = lockName.replace(/[^a-zA-Z0-9._-]/g, "_");
  const lockPath = path.join(lockRoot, `${safeName}.process-lock`);
  const owner = createProcessLockOwner();
  const startedAt = Date.now();

  while (true) {
    try {
      await fs.mkdir(lockPath);
      await fs.writeFile(path.join(lockPath, "owner.json"), JSON.stringify(owner, null, 2), "utf8");
      return async () => {
        await releaseOwnedProcessLock(lockPath, owner);
      };
    } catch (error) {
      if (error?.code !== "EEXIST") {
        throw error;
      }

      const stat = await fs.stat(lockPath).catch(() => null);
      const stale = stat != null && Date.now() - stat.mtimeMs > staleMs;
      const existingOwner = await readLockOwner(lockPath);
      const ownerState = getProcessLockOwnerState(existingOwner, { stale });
      if (ownerState === "active") {
        throw new Error(`Codex connector is already running for ${lockName} under pid ${existingOwner.pid}.`);
      }
      if (ownerState === "unknown" && !stale) {
        if (Date.now() - startedAt >= timeoutMs) {
          throw new Error(`Timed out waiting for Codex connector process lock ${lockName}.`);
        }
        await sleep(pollMs);
        continue;
      }
      if (existingOwner?.pid || stale) {
        await fs.rm(lockPath, { recursive: true, force: true });
        continue;
      }

      if (Date.now() - startedAt >= timeoutMs) {
        throw new Error(`Timed out waiting for Discord Codex process lock ${lockName}.`);
      }
      await sleep(pollMs);
    }
  }
}

function createLockOwner() {
  return {
    pid: process.pid,
    nonce: randomUUID(),
    createdAt: new Date().toISOString()
  };
}

function createProcessLockOwner() {
  return {
    ...createLockOwner(),
    process: {
      execPath: process.execPath,
      argv: process.argv,
      cwd: process.cwd(),
      startTime: readProcessStartTime(process.pid)
    }
  };
}

function getProcessLockOwnerState(owner, { stale } = {}) {
  if (!owner?.pid) return "unknown";
  if (!isProcessAlive(owner.pid)) return "dead";

  const liveProcess = readLiveProcessInfo(owner.pid);
  const ownerStartTime = owner.process?.startTime || owner.processStartTime;
  const ownerArgv = owner.process?.argv || owner.argv;

  if (ownerStartTime && liveProcess.startTime) {
    if (ownerStartTime !== liveProcess.startTime) return "reused";
    if (Array.isArray(ownerArgv) && ownerArgv.length > 0 && liveProcess.command) {
      const argvMatches = commandMatchesArgv(liveProcess.command, ownerArgv);
      if (argvMatches != null) return argvMatches ? "active" : "reused";
    }
    return "active";
  }

  if (Array.isArray(ownerArgv) && ownerArgv.length > 0 && liveProcess.command) {
    const argvMatches = commandMatchesArgv(liveProcess.command, ownerArgv);
    if (argvMatches != null) return argvMatches ? "active" : "reused";
  }

  // Legacy locks only contain a PID. Keep them if that PID still looks like
  // this connector process; otherwise allow stale locks to recover from PID reuse.
  if (liveProcess.command && commandLooksLikeCurrentProcess(liveProcess.command)) {
    return "active";
  }
  return stale ? "reused" : "unknown";
}

async function releaseOwnedProcessLock(lockPath, owner) {
  const currentOwner = await readLockOwner(lockPath);
  if (currentOwner?.pid === owner.pid && currentOwner?.nonce === owner.nonce) {
    await fs.rm(lockPath, { recursive: true, force: true });
  }
}

async function readLockOwner(lockPath) {
  try {
    return JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));
  } catch {
    return null;
  }
}

function readLiveProcessInfo(pid) {
  return {
    startTime: readProcessStartTime(pid),
    command: readProcessCommand(pid)
  };
}

function readProcessStartTime(pid) {
  return readProcessField(pid, "lstart");
}

function readProcessCommand(pid) {
  return readProcessField(pid, "command", ["-ww"]);
}

function readProcessField(pid, field, extraArgs = []) {
  const result = spawnSync("ps", ["-p", String(pid), ...extraArgs, "-o", `${field}=`], {
    encoding: "utf8"
  });
  if (result.status !== 0) return null;
  return result.stdout.trim() || null;
}

function commandMatchesArgv(command, argv) {
  const tokens = processIdentityTokens(argv);
  if (tokens.length === 0) return null;
  return tokens.some((token) => command.includes(token));
}

function commandLooksLikeCurrentProcess(command) {
  return processIdentityTokens(process.argv).some((token) => command.includes(token));
}

function processIdentityTokens(argv) {
  const ignored = new Set(["node", "env", "pnpm", "--config", "config.local.json"]);
  const tokens = [];
  for (const value of argv) {
    if (typeof value !== "string" || value.startsWith("-")) continue;
    const basename = path.basename(value);
    if (ignored.has(value) || ignored.has(basename)) continue;
    for (const token of [value, basename]) {
      if (token.length < 4 || ignored.has(token)) continue;
      tokens.push(token);
    }
  }
  return [...new Set(tokens)];
}

function isProcessAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
