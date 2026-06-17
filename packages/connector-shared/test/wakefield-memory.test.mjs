import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { recordWakefieldConnectorTurn, wakefieldMemoryForConnectorMessage } from "../src/wakefield-memory.mjs";

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

test("connector memory keeps topic matches narrow for broad sender-scoped follow-ups", async () => {
  const { home, cwd } = await createMemoryHome();
  const memory = await wakefieldMemoryForConnectorMessage({
    home,
    target: {
      id: "rick",
      threadId: "thread-rick",
      cwd
    },
    query: "What should we do about iMessage followups while Photon is down?",
    scope: {
      connector: "discord",
      sender: "1362496879681732688",
      conversation: "dm-joe"
    },
    injection: {
      record: false
    }
  });

  assert.match(memory, /photon-spectrum-imessage-outage/);
  assert.doesNotMatch(memory, /joe-package/);
  assert.doesNotMatch(memory, /rma-earle-20260514-01/);
});

test("connector memory skips same-thread source turns until compaction", async () => {
  const { home, cwd, memoryDir } = await createMemoryHome();
  const mattersPath = path.join(memoryDir, "matters.json");
  const matters = JSON.parse(await fs.readFile(mattersPath, "utf8"));
  const outage = matters.matters.find((matter) => matter.id === "photon-spectrum-imessage-outage");
  outage.sources = ["codex-turn:turn-photon"];
  await writeJson(mattersPath, matters);
  await fs.appendFile(path.join(memoryDir, "inbox.jsonl"), `${JSON.stringify({
    id: "prompt-photon",
    at: "2026-06-17T02:18:00.000Z",
    kind: "user-prompt",
    data: {
      sessionId: "thread-rick",
      turnId: "turn-photon"
    }
  })}\n`, "utf8");

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
  const query = "What should we do about iMessage followups while Photon is down?";

  const beforeCompact = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query,
    scope,
    injection: {
      record: false
    }
  });
  assert.equal(beforeCompact, "");

  await fs.appendFile(path.join(memoryDir, "dreams.jsonl"), `${JSON.stringify({
    id: "compact-after-photon",
    at: "2026-06-17T03:00:00.000Z",
    kind: "post-compact",
    data: {
      sessionId: "thread-rick",
      turnId: "turn-compact"
    }
  })}\n`, "utf8");

  const afterCompact = await wakefieldMemoryForConnectorMessage({
    home,
    target,
    query,
    scope,
    injection: {
      record: false
    }
  });
  assert.match(afterCompact, /photon-spectrum-imessage-outage/);
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
      inboxPath: path.join(memoryDir, "inbox.jsonl"),
      journalPath: path.join(memoryDir, "journal.jsonl"),
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
        id: "photon-spectrum-imessage-outage",
        title: "Photon/Spectrum iMessage down",
        summary: "Photon/Spectrum iMessage down; Discord is fallback.",
        status: "waiting",
        scope: {
          people: ["joe"],
          channels: ["discord", "imessage"],
          connectors: ["photon", "spectrum", "discord", "imessage"],
          topics: ["connector-outage", "imessage", "discord"],
          senders: ["joe"]
        }
      },
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

async function readJsonl(file) {
  const text = await fs.readFile(file, "utf8");
  return text.split(/\r?\n/g).filter(Boolean).map((line) => JSON.parse(line));
}
