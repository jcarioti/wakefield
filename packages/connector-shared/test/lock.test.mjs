import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { acquireSingletonProcessLock } from "../src/lock.mjs";

test("acquireSingletonProcessLock rejects a second live owner", async () => {
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-codex-lock-test-"));
  const release = await acquireSingletonProcessLock("rick", { lockRoot });

  await assert.rejects(
    () => acquireSingletonProcessLock("rick", { lockRoot }),
    /already running/
  );

  await release();
  await fs.rm(lockRoot, { recursive: true, force: true });
});

test("acquireSingletonProcessLock replaces a stale dead owner", async () => {
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-codex-lock-test-"));
  const lockPath = path.join(lockRoot, "rick.process-lock");
  await fs.mkdir(lockPath);
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ pid: 999999, nonce: "dead", createdAt: new Date().toISOString() }),
    "utf8"
  );

  const release = await acquireSingletonProcessLock("rick", { lockRoot });
  await release();

  await assert.rejects(
    () => fs.stat(lockPath),
    /ENOENT/
  );
  await fs.rm(lockRoot, { recursive: true, force: true });
});

test("acquireSingletonProcessLock records a process fingerprint", async () => {
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-codex-lock-test-"));
  const lockPath = path.join(lockRoot, "rick.process-lock");
  const release = await acquireSingletonProcessLock("rick", { lockRoot });
  const owner = JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"));

  assert.equal(owner.pid, process.pid);
  assert.equal(owner.process.execPath, process.execPath);
  assert.deepEqual(owner.process.argv, process.argv);
  assert.equal(owner.process.cwd, process.cwd());
  assert.ok("startTime" in owner.process);

  await release();
  await fs.rm(lockRoot, { recursive: true, force: true });
});

test("acquireSingletonProcessLock keeps a stale legacy lock when the owner still looks live", async () => {
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-codex-lock-test-"));
  const lockPath = path.join(lockRoot, "rick.process-lock");
  const oldDate = new Date(Date.now() - 60000);
  await fs.mkdir(lockPath);
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ pid: process.pid, nonce: "legacy-live", createdAt: oldDate.toISOString() }),
    "utf8"
  );
  await fs.utimes(lockPath, oldDate, oldDate);

  await assert.rejects(
    () => acquireSingletonProcessLock("rick", { lockRoot, staleMs: 1 }),
    /already running/
  );

  await fs.rm(lockRoot, { recursive: true, force: true });
});

test("acquireSingletonProcessLock replaces a stale legacy lock after pid reuse", async (t) => {
  const lockRoot = await fs.mkdtemp(path.join(os.tmpdir(), "discord-codex-lock-test-"));
  const unrelatedProcess = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], {
    stdio: "ignore"
  });
  t.after(async () => {
    unrelatedProcess.kill();
    await fs.rm(lockRoot, { recursive: true, force: true });
  });
  await waitForLiveProcess(unrelatedProcess.pid);

  const lockPath = path.join(lockRoot, "rick.process-lock");
  const oldDate = new Date(Date.now() - 60000);
  await fs.mkdir(lockPath);
  await fs.writeFile(
    path.join(lockPath, "owner.json"),
    JSON.stringify({ pid: unrelatedProcess.pid, nonce: "reused", createdAt: oldDate.toISOString() }),
    "utf8"
  );
  await fs.utimes(lockPath, oldDate, oldDate);

  const release = await acquireSingletonProcessLock("rick", {
    lockRoot,
    staleMs: 1
  });
  await release();

  await assert.rejects(
    () => fs.stat(lockPath),
    /ENOENT/
  );
});

async function waitForLiveProcess(pid) {
  for (let i = 0; i < 20; i += 1) {
    try {
      process.kill(pid, 0);
      return;
    } catch {
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  }
  throw new Error(`Timed out waiting for process ${pid}`);
}
