import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import * as wakefieldMemory from "../src/wakefield-memory.mjs";

const { recordWakefieldConnectorTurn } = wakefieldMemory;

test("connector memory module does not expose prompt injection", () => {
  assert.equal("wakefieldMemoryForConnectorMessage" in wakefieldMemory, false);
  assert.equal("formatContextMemory" in wakefieldMemory, false);
});

test("connector turns are mirrored into Wakefield memory for dreams", async () => {
  const { home, cwd, memoryDir } = await createMemoryHome();
  const result = await recordWakefieldConnectorTurn({
    home,
    target: {
      id: "rick",
      threadId: "thread-rick",
      cwd
    },
    connector: "discord",
    messageId: "message-1",
    prompt: "Photon/Spectrum iMessage appears down; Discord is reliable for now.",
    routeResult: {
      action: "start",
      turnId: "turn-photon"
    },
    completionStatus: {
      completed: true,
      reason: "task-complete",
      lastAgentMessage: "Acknowledged. Discord is the reliable channel until Photon/Spectrum recovers."
    },
    scope: {
      connector: "discord",
      sender: "1362496879681732688",
      conversation: "dm-joe"
    },
    now: new Date("2026-06-17T02:30:00.000Z")
  });

  assert.deepEqual(result, {
    ok: true,
    agentId: "rickbot",
    turnId: "turn-photon",
    written: ["user-prompt", "turn-stop", "dream-queued"]
  });

  const inbox = await readJsonl(path.join(memoryDir, "inbox.jsonl"));
  const journal = await readJsonl(path.join(memoryDir, "journal.jsonl"));
  const dreams = await readJsonl(path.join(memoryDir, "dreams.jsonl"));

  assert.equal(inbox[0].kind, "user-prompt");
  assert.match(inbox[0].text, /Photon\/Spectrum iMessage appears down/);
  assert.equal(journal[0].kind, "turn-stop");
  assert.match(journal[0].text, /Discord is the reliable channel/);
  assert.equal(dreams[0].kind, "dream-queued");
  assert.equal(dreams[0].data.turnId, "turn-photon");
  assert.equal(dreams[0].data.reason, "connector-turn");
});

async function createMemoryHome() {
  const home = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-memory-"));
  const cwd = path.join(home, "rickbot-cwd");
  const agentDir = path.join(home, "agents", "rickbot");
  const memoryDir = path.join(agentDir, "memory");
  await fs.mkdir(memoryDir, { recursive: true });
  await fs.mkdir(cwd, { recursive: true });

  await writeJson(path.join(home, "config.json"), {
    currentAgentId: "rickbot"
  });
  await writeJson(path.join(agentDir, "profile.json"), {
    id: "rickbot",
    threadId: "thread-rick",
    cwd,
    memory: {
      dreamsPath: path.join(memoryDir, "dreams.jsonl"),
      inboxPath: path.join(memoryDir, "inbox.jsonl"),
      journalPath: path.join(memoryDir, "journal.jsonl")
    }
  });

  return { home, cwd, memoryDir };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/g).filter(Boolean).map((line) => JSON.parse(line));
}
