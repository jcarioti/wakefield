import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { wakefieldMemoryForConnectorMessage } from "../src/wakefield-memory.mjs";

test("connector memory recalls named subject even when sender is another contact", async () => {
  const { home, cwd } = await createMemoryHome();
  const memory = await wakefieldMemoryForConnectorMessage({
    home,
    target: {
      id: "rick",
      threadId: "thread-rick",
      cwd
    },
    query: "Hey Rick, do you know if we have closed out Earle's RMA escalation?",
    scope: {
      connector: "imessage",
      sender: "+13307669880",
      conversation: "any;-;+13307669880"
    }
  });

  assert.match(memory, /Wakefield context for this external message/);
  assert.match(memory, /rma-earle-20260514-01/);
  assert.match(memory, /returned failed unit must be physically identified/);
  assert.match(memory, /rma-replacement-release-safety/);
});

test("connector memory uses Wakefield contacts for vague same-person follow-ups", async () => {
  const { home, cwd } = await createMemoryHome();
  const memory = await wakefieldMemoryForConnectorMessage({
    home,
    target: {
      id: "rick",
      threadId: "thread-rick",
      cwd
    },
    query: "Any update?",
    scope: {
      connector: "discord",
      sender: "1362496879681732688",
      conversation: "dm-joe"
    }
  });

  assert.match(memory, /joe-package/);
  assert.doesNotMatch(memory, /rma-earle-20260514-01/);
});

test("connector memory suppresses unchanged repeats in the same compact epoch", async () => {
  const { home, cwd } = await createMemoryHome();
  const target = {
    id: "rick",
    threadId: "thread-rick",
    cwd
  };
  const scope = {
    connector: "discord",
    sender: "1362496879681732688",
    conversation: "dm-joe"
  };

  const first = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Earle RMA follow-up",
    scope
  });
  const second = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Earle RMA follow-up",
    scope
  });

  assert.match(first, /rma-earle-20260514-01/);
  assert.equal(second, "");
});

test("connector memory reinjects explicit recall requests in the same compact epoch", async () => {
  const { home, cwd } = await createMemoryHome();
  const target = {
    id: "rick",
    threadId: "thread-rick",
    cwd
  };
  const scope = {
    connector: "discord",
    sender: "1362496879681732688",
    conversation: "dm-joe"
  };

  await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Earle RMA follow-up",
    scope
  });
  const recalled = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Can you remind me what is going on with Earle's RMA?",
    scope
  });

  assert.match(recalled, /rma-earle-20260514-01/);
});

test("connector memory reinjects after compaction or memory changes", async () => {
  const { home, cwd, memoryDir } = await createMemoryHome();
  const target = {
    id: "rick",
    threadId: "thread-rick",
    cwd
  };
  const scope = {
    connector: "discord",
    sender: "1362496879681732688",
    conversation: "dm-joe"
  };

  await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Earle RMA follow-up",
    scope
  });
  await fs.appendFile(path.join(memoryDir, "dreams.jsonl"), `${JSON.stringify({
    id: "compact-1",
    at: "2026-06-16T20:00:00.000Z",
    kind: "post-compact"
  })}\n`, "utf8");
  const afterCompact = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Earle RMA follow-up",
    scope
  });
  assert.match(afterCompact, /rma-earle-20260514-01/);

  const mattersPath = path.join(memoryDir, "matters.json");
  const matters = JSON.parse(await fs.readFile(mattersPath, "utf8"));
  matters.matters[0].summary = "Earle's returned unit has new handling notes that need review.";
  matters.matters[0].updatedAt = "2026-06-16T20:01:00.000Z";
  await writeJson(mattersPath, matters);
  const afterChange = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query: "Earle RMA follow-up",
    scope
  });
  assert.match(afterChange, /new handling notes/);
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
  await writeJson(path.join(home, "contacts.json"), {
    schemaVersion: 1,
    contacts: [{
      id: "joe",
      displayName: "Joe",
      identities: [
        { connector: "imessage", address: "+13307669880" },
        { connector: "discord", id: "1362496879681732688" }
      ]
    }]
  });
  await writeJson(path.join(agentDir, "profile.json"), {
    id: "rickbot",
    threadId: "thread-rick",
    cwd,
    memory: {
      notesPath: path.join(memoryDir, "notes.json"),
      mattersPath: path.join(memoryDir, "matters.json"),
      dreamsPath: path.join(memoryDir, "dreams.jsonl"),
      statePath: path.join(memoryDir, "state.json")
    }
  });
  await writeJson(path.join(memoryDir, "notes.json"), {
    notes: [{
      id: "rma-replacement-release-safety",
      title: "RMA replacement release safety",
      text: "Do not release an RMA replacement without clear return, advance, waiver, or human approval evidence.",
      scope: {
        topics: ["rma"]
      }
    }]
  });
  await writeJson(path.join(memoryDir, "matters.json"), {
    matters: [
      {
        id: "rma-earle-20260514-01",
        title: "Earle Robertson RMA-20260514-01",
        summary: "Earle's replacement is delivered, but the returned failed unit must be physically identified before completion.",
        status: "waiting",
        scope: {
          people: ["earle-robertson"],
          cases: ["rma-20260514-01"],
          topics: ["rma"]
        }
      },
      {
        id: "joe-package",
        title: "Joe package follow-up",
        summary: "Joe is waiting on a package tracking follow-up.",
        status: "active",
        scope: {
          people: ["joe"],
          topics: ["package"]
        }
      }
    ]
  });

  return { home, cwd, memoryDir };
}

async function writeJson(file, value) {
  await fs.mkdir(path.dirname(file), { recursive: true });
  await fs.writeFile(file, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}
