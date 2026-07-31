import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { loadNotes } from "../src/context-memory.mjs";
import { doctor } from "../src/doctor.mjs";
import { appendJsonl, readJsonl } from "../src/json-store.mjs";
import { processMemoryCaptures } from "../src/memory-capture.mjs";
import { processDreams } from "../src/memory.mjs";
import { initAgent } from "../src/profile.mjs";

const execFileAsync = promisify(execFile);

test("JSONL append repairs a torn final record and keeps private permissions", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-jsonl-"));
  const file = path.join(dir, "journal.jsonl");
  await fs.writeFile(file, '{"id":"complete"}\n{"id":"torn"', { mode: 0o644 });

  assert.deepEqual(await readJsonl(file), [{ id: "complete" }]);
  await appendJsonl(file, { id: "next" });

  assert.deepEqual(await readJsonl(file), [{ id: "complete" }, { id: "next" }]);
  assert.equal((await fs.stat(file)).mode & 0o777, 0o600);
  assert.doesNotMatch(await fs.readFile(file, "utf8"), /torn/);
});

test("memory initialization makes the store private", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-private-"));
  const profile = await initAgent({ name: "Private Memory", soul: "", home });
  const memoryDir = path.dirname(profile.memory.statePath);

  assert.equal((await fs.stat(memoryDir)).mode & 0o777, 0o700);
  for (const file of [
    profile.memory.statePath,
    profile.memory.notesPath,
    profile.memory.mattersPath,
    profile.memory.inboxPath,
    profile.memory.journalPath,
    profile.memory.dreamsPath,
    profile.memory.capturePath,
    profile.memory.externalMessagesPath
  ]) {
    assert.equal((await fs.stat(file)).mode & 0o777, 0o600, file);
  }
});

test("doctor reports memory permission drift", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-permissions-doctor-"));
  const profile = await initAgent({ name: "Permission Doctor", soul: "", home });
  await fs.chmod(profile.memory.notesPath, 0o644);

  const report = await doctor({
    home,
    runtimeProbe: async () => ({
      status: "compatible",
      socketPath: "/tmp/test-codex.sock",
      sessionsReadable: true,
      sessionsPath: "/tmp/test-sessions"
    }),
    desktopControllerProbe: async () => ({
      ok: false,
      socket: { ok: false, path: "/tmp/test-control.sock" },
      daemon: { ok: false, detail: "socket missing" },
      protocol: { ok: false, detail: "socket missing" },
      remote: { ok: false, status: "unknown", detail: "socket missing" },
      mcp: { ok: false, count: null, detail: "socket missing" }
    })
  });
  const permissions = report.checks.find((check) => check.label === "Memory permissions");
  assert.equal(permissions.ok, false);
  assert.match(permissions.detail, /notes\.json is 0644/);
});

test("concurrent processes preserve every scoped note update", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-concurrent-"));
  const profile = await initAgent({ name: "Concurrent Memory", soul: "", home });
  const profileModule = pathToFileURL(path.resolve("src/profile.mjs")).href;
  const contextModule = pathToFileURL(path.resolve("src/context-memory.mjs")).href;
  const script = [
    `import { loadAgent } from ${JSON.stringify(profileModule)};`,
    `import { upsertNote } from ${JSON.stringify(contextModule)};`,
    "const agent = await loadAgent(null, process.env.TEST_WAKEFIELD_HOME);",
    "await upsertNote(agent, { id: process.env.TEST_NOTE_ID, title: process.env.TEST_NOTE_ID, text: process.env.TEST_NOTE_ID });"
  ].join("\n");

  await Promise.all(Array.from({ length: 12 }, (_, index) => execFileAsync(process.execPath, [
    "--input-type=module",
    "-e",
    script
  ], {
    env: {
      ...process.env,
      TEST_WAKEFIELD_HOME: home,
      TEST_NOTE_ID: `note-${index}`
    }
  })));

  const notes = await loadNotes(profile);
  assert.deepEqual(notes.notes.map((note) => note.id).sort(), Array.from({ length: 12 }, (_, index) => `note-${index}`).sort());
});

test("dream summaries remain the durable deduplication record beyond the state cache", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-dream-dedup-"));
  const profile = await initAgent({ name: "Durable Dreams", soul: "", home });
  const queued = Array.from({ length: 650 }, (_, index) => ({
    id: `dream-${index}`,
    at: new Date(1_700_000_000_000 + index).toISOString(),
    agentId: profile.id,
    source: "test",
    kind: "dream-queued",
    text: `Turn ${index} stopped.`,
    data: { sessionId: "session", turnId: `turn-${index}` }
  }));
  const summaries = queued.slice(0, 600).map((entry) => ({
    id: `summary-${entry.id}`,
    at: entry.at,
    agentId: profile.id,
    source: "wakefield-dreamer",
    kind: "dream-summary",
    text: `Summary for ${entry.id}`,
    data: {
      sourceDreamId: entry.id,
      sourceDreamIds: [entry.id],
      sessionId: entry.data.sessionId,
      turnId: entry.data.turnId
    }
  }));
  await fs.writeFile(profile.memory.dreamsPath, `${[...queued, ...summaries].map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await fs.writeFile(profile.memory.statePath, `${JSON.stringify({
    recentTurns: [],
    dreamer: { processedIds: queued.slice(100, 600).map((entry) => entry.id) }
  }, null, 2)}\n`);

  const first = await processDreams(profile, { limit: 100, capture: false });
  assert.equal(first.processed, 50);
  assert.equal(first.pending, 0);
  assert.equal(first.summaries[0].sourceDreamId, "dream-600");
  assert.equal((await readJsonl(profile.memory.dreamsPath)).filter((entry) => entry.kind === "dream-summary").length, 650);

  const second = await processDreams(profile, { limit: 100, capture: false });
  assert.equal(second.processed, 0);
  assert.equal(second.pending, 0);
});

test("capture audit remains the durable deduplication record beyond the state cache", async () => {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-capture-dedup-"));
  const profile = await initAgent({ name: "Durable Capture", soul: "", home });
  await fs.writeFile(profile.memory.dreamsPath, `${JSON.stringify({
    id: "summary-0",
    at: "2026-01-01T00:00:00.000Z",
    agentId: profile.id,
    source: "wakefield-dreamer",
    kind: "dream-summary",
    text: "Already reviewed summary.",
    data: { sourceDreamId: "source-0", sourceDreamIds: ["source-0"] }
  })}\n`);
  const audit = Array.from({ length: 1001 }, (_, index) => ({
    at: new Date(1_700_000_000_000 + index).toISOString(),
    agentId: profile.id,
    key: `source-${index}`,
    summaryKey: `source-${index}`,
    error: null,
    decisions: [],
    applied: []
  }));
  await fs.writeFile(profile.memory.capturePath, `${audit.map((entry) => JSON.stringify(entry)).join("\n")}\n`);
  await fs.writeFile(profile.memory.statePath, `${JSON.stringify({
    memoryCapture: { processedIds: audit.slice(1).map((entry) => entry.key) }
  }, null, 2)}\n`);

  const result = await processMemoryCaptures(profile, {
    captureProvider: async () => {
      throw new Error("durably audited summary should not be reviewed again");
    }
  });
  assert.equal(result.reviewed, 0);
});
