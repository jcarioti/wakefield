import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { inspectAgentPack, installAgentPack } from "../src/agent-packs.mjs";
import { routePromptToCodex } from "../src/codex-ipc.mjs";
import { listRecentThreads, threadIdFromFilename } from "../src/codex-sessions.mjs";
import { configureConnector, connectorWizard, connectorWizards, CONNECTOR_SETUP_SLOTS, connectorStatuses } from "../src/connectors.mjs";
import { importContactsFile, loadContacts, resolveContact } from "../src/contacts.mjs";
import { archiveMatter, formatContextMemory, loadMatters, recallContext, upsertMatter, upsertNote } from "../src/context-memory.mjs";
import { discordMessageAllowed, ingestDiscordGatewayMessage, normalizeDiscordMessage } from "../src/discord-gateway.mjs";
import { doctor } from "../src/doctor.mjs";
import { configureDuty, configureWakeup, dutyStatuses, runDueDuties } from "../src/duties.mjs";
import { pollEmailImap } from "../src/email-imap.mjs";
import { ingestEmailRfc822, parseRfc822 } from "../src/email-rfc822.mjs";
import { acknowledgeExternalMessage, ingestExternalMessage, listExternalMessages } from "../src/external-messages.mjs";
import { hooksStatus, wakefieldHookCommand } from "../src/hook-manager.mjs";
import { handleHookInput } from "../src/hooks.mjs";
import { startHttpIntakeServer } from "../src/http-intake.mjs";
import { dispatchExternalMessage } from "../src/inbox-dispatch.mjs";
import { appleMessageDateToIso, imessageMessageAllowed, normalizeImessageRow, pollImessageChatDb } from "../src/imessage-chatdb.mjs";
import { isPhotonBackpressureError, shouldUsePhotonNativeFallback } from "../packages/imessage-spectrum/src/spectrum-client.mjs";
import { installWakefield } from "../src/install.mjs";
import { configureManagedConnector, importManagedConnectors, initializeManagedConnectorConfig, installManagedConnectorMcp, managedConnectorLaunchAgentPlist, managedConnectorLaunchAgentStatus, managedConnectorStatus, managedConnectorWizard, testManagedConnector } from "../src/managed-connectors.mjs";
import { wakefieldManifest } from "../src/manifest.mjs";
import { installMemoryMcp, memoryMcpStatus } from "../src/memory-mcp.mjs";
import { registerWakefieldMemoryTools } from "../src/mcp-memory-server.mjs";
import { menuSnapshot } from "../src/menu-snapshot.mjs";
import { memoryContext, processDreams, recordMemory } from "../src/memory.mjs";
import { initAgent, loadAgent, selectThread } from "../src/profile.mjs";
import { configureService, installLaunchAgent, launchAgentPlist, launchAgentStatus, loadLaunchAgent, runServiceOnce, serviceStatus, uninstallLaunchAgent, unloadLaunchAgent } from "../src/service.mjs";
import { runSelfTest } from "../src/self-test.mjs";
import { setupStatus } from "../src/setup.mjs";
import { runSetup } from "../src/setup-runner.mjs";
import { bundledWakefieldSkillNames, wakefieldSkillsStatus } from "../src/skills.mjs";
import { verifyWakefield } from "../src/verify.mjs";

const execFileAsync = promisify(execFile);

test("init creates a normal app-support profile and memory files", async () => {
  const home = await tempHome();
  const profile = await initAgent({
    name: "Mira Field",
    soul: "A quiet research companion.",
    home
  });

  assert.equal(profile.id, "mira-field");
  assert.equal(profile.name, "Mira Field");
  assert.equal(profile.cwd, path.join(home, "agents", "mira-field"));
  assert.equal(profile.soulPath, path.join(profile.cwd, "AGENTS.md"));
  assert.equal(profile.memory.externalMessagesPath, path.join(profile.cwd, "memory", "external-messages.jsonl"));
  assert.equal(profile.memory.notesPath, path.join(profile.cwd, "memory", "notes.json"));
  assert.equal(profile.memory.mattersPath, path.join(profile.cwd, "memory", "matters.json"));
  assert.equal((await loadAgent(null, home)).id, profile.id);

  const report = await doctor({ home });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.label === "Soul file").ok, true);
  assert.equal(report.checks.find((check) => check.label === "External inbox").ok, true);
  assert.equal(report.checks.find((check) => check.label === "Codex thread").ok, false);
  assert.match(await fs.readFile(profile.memory.externalMessagesPath, "utf8"), /^$/);
  assert.deepEqual(JSON.parse(await fs.readFile(profile.memory.notesPath, "utf8")).notes, []);
  assert.deepEqual(JSON.parse(await fs.readFile(profile.memory.mattersPath, "utf8")).matters, []);
});

test("local memory recall returns relevant journal entries", async () => {
  const home = await tempHome();
  const profile = await initAgent({ name: "Lantern", soul: "", home });

  await recordMemory(profile, {
    kind: "preference",
    text: "Lantern should prepare concise morning summaries.",
    source: "test"
  });

  const context = await memoryContext(profile, "morning summary");
  assert.match(context, /morning summaries/);
});

test("scoped notes and matters recall, archive, and forget temporary context", async () => {
  const home = await tempHome();
  const profile = await initAgent({ name: "Memory", soul: "", home });

  await upsertNote(profile, {
    id: "rma-white-box",
    title: "RMA white box SKU rule",
    text: "Use white-box replacement SKUs for RMA replacements unless explicitly authorized otherwise.",
    scope: {
      tasks: ["rma-support"],
      topics: ["rma"]
    }
  });
  await upsertMatter(profile, {
    id: "dominic-rma",
    title: "Dominic RMA",
    summary: "Dominic is waiting on a Pro white-box RMA replacement.",
    status: "waiting",
    scope: {
      people: ["dominic"],
      tasks: ["rma-support"],
      cases: ["rma-dominic"]
    },
    nextAction: "Check stock before promising a ship date."
  });

  const recalled = await recallContext(profile, {
    query: "Dominic Pro white box",
    scope: {
      people: ["Dominic"],
      tasks: ["rma-support"]
    }
  });
  assert.equal(recalled.notes[0].id, "rma-white-box");
  assert.equal(recalled.matters[0].id, "dominic-rma");
  assert.match(formatContextMemory(recalled), /Check stock/);

  const crossPersonSubject = await recallContext(profile, {
    query: "Did Dominic get the Pro white box?",
    scope: {
      people: ["joe"]
    }
  });
  assert.equal(crossPersonSubject.matters[0].id, "dominic-rma");

  const genericOtherPersonScope = await recallContext(profile, {
    query: "Any RMA update?",
    scope: {
      people: ["joe"]
    }
  });
  assert.deepEqual(genericOtherPersonScope.matters, []);

  await archiveMatter(profile, "dominic-rma", {
    reason: "Replacement shipped."
  });
  const afterArchive = await recallContext(profile, {
    query: "Dominic Pro white box",
    scope: {
      people: ["dominic"],
      tasks: ["rma-support"]
    }
  });
  assert.deepEqual(afterArchive.matters, []);
  assert.equal(afterArchive.notes[0].id, "rma-white-box");
});

test("memory CLI lists notes, matters, scoped recall, and archives matters", async () => {
  const home = await tempHome();
  await initAgent({ name: "Memory CLI", soul: "", home });
  const env = { ...process.env, WAKEFIELD_HOME: home };

  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "memory",
    "notes",
    "add",
    "--id",
    "shipping-style",
    "--text",
    "Use concise package updates.",
    "--person",
    "joe",
    "--topic",
    "package"
  ], { cwd: path.resolve("."), env });
  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "memory",
    "matters",
    "upsert",
    "--id",
    "joe-package",
    "--summary",
    "Joe is waiting for a package tracking follow-up.",
    "--person",
    "joe",
    "--topic",
    "package"
  ], { cwd: path.resolve("."), env });

  const { stdout: recallOut } = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "memory",
    "recall",
    "--query",
    "tracking package",
    "--person",
    "joe"
  ], { cwd: path.resolve("."), env });
  assert.match(recallOut, /shipping-style/);
  assert.match(recallOut, /joe-package/);

  await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "memory",
    "matters",
    "archive",
    "joe-package",
    "--reason",
    "Tracking sent."
  ], { cwd: path.resolve("."), env });
  const { stdout: afterArchive } = await execFileAsync(process.execPath, [
    "src/cli.mjs",
    "memory",
    "recall",
    "--query",
    "tracking package",
    "--person",
    "joe"
  ], { cwd: path.resolve("."), env });
  assert.match(afterArchive, /shipping-style/);
  assert.doesNotMatch(afterArchive, /joe-package/);
});

test("memory MCP installs Codex tool config for the selected agent", async () => {
  const home = await tempHome();
  const cwd = path.join(home, "agent-cwd");
  await fs.mkdir(path.join(cwd, ".codex"), { recursive: true });
  const profile = await initAgent({
    name: "Memory MCP",
    soul: "",
    cwd,
    home
  });

  const install = await installMemoryMcp({ home, agent: profile });
  assert.equal(install.changed, true);
  assert.equal(install.serverName, "wakefield-memory");
  assert.ok(install.tools.includes("wakefield_memory_recall"));

  const configText = await fs.readFile(path.join(cwd, ".codex", "config.toml"), "utf8");
  assert.match(configText, /mcp_servers\.wakefield-memory/);
  assert.match(configText, /wakefield_memory_upsert_matter/);
  assert.match(configText, /--home/);
  assert.match(configText, new RegExp(escapeRegExp(home)));

  const status = await memoryMcpStatus({ home, agent: profile });
  assert.equal(status.ok, true);
  assert.equal(status.tools.length, 10);
});

test("memory MCP tools recall, update, archive, and forget scoped memory", async () => {
  const home = await tempHome();
  const profile = await initAgent({ name: "Memory Tooling", soul: "", home });
  const server = fakeMcpServer();
  registerWakefieldMemoryTools(server, { agent: profile, home });

  await callMcpTool(server, "wakefield_memory_upsert_note", {
    id: "package-style",
    text: "Use concise package status updates.",
    person: "joe",
    topic: "package"
  });
  await callMcpTool(server, "wakefield_memory_upsert_matter", {
    id: "joe-package",
    summary: "Joe is waiting for a package tracking follow-up.",
    status: "waiting",
    person: "joe",
    topic: "package"
  });

  const recalled = await callMcpTool(server, "wakefield_memory_recall", {
    query: "tracking package",
    person: "joe"
  });
  assert.equal(recalled.notes[0].id, "package-style");
  assert.equal(recalled.matters[0].id, "joe-package");

  const archived = await callMcpTool(server, "wakefield_memory_archive_matter", {
    id: "joe-package",
    reason: "Tracking sent."
  });
  assert.equal(archived.matter.status, "archived");

  const afterArchive = await callMcpTool(server, "wakefield_memory_recall", {
    query: "tracking package",
    person: "joe"
  });
  assert.equal(afterArchive.notes[0].id, "package-style");
  assert.deepEqual(afterArchive.matters, []);

  await callMcpTool(server, "wakefield_memory_forget", {
    type: "note",
    id: "package-style"
  });
  const notes = await callMcpTool(server, "wakefield_memory_list_notes");
  assert.deepEqual(notes.notes, []);
});

test("selectThread attaches the current agent to a persistent Codex thread", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const profile = await initAgent({ name: "Threadwell", soul: "", home });
  const attached = await selectThread({
    threadId: "thread-123",
    cwd: "/tmp/threadwell",
    home
  });

  assert.equal(attached.id, profile.id);
  assert.equal(attached.threadId, "thread-123");
  assert.equal(attached.cwd, "/tmp/threadwell");

  const report = await doctor({ home, codexHomePath });
  assert.equal(report.ok, false);
  assert.equal(report.checks.find((check) => check.label === "Codex thread").ok, true);
});

test("install creates an agent and idempotent Codex hook config", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();

  const first = await installWakefield({
    name: "Wakefield",
    soul: "A field companion.",
    threadId: "thread-123",
    home,
    codexHomePath
  });
  const second = await installWakefield({ home, codexHomePath });

  assert.equal(first.createdAgent, true);
  assert.equal(first.doctor.ok, true);
  assert.equal(second.createdAgent, false);
  assert.equal(second.doctor.ok, true);
  assert.deepEqual(first.skillResult.installed.map((skill) => skill.name), await bundledWakefieldSkillNames());
  assert.equal(first.skillResult.configured, true);
  assert.equal(second.skillResult.installed.every((skill) => skill.changed === false), true);

  const status = await hooksStatus({
    command: wakefieldHookCommand({ home }),
    codexHomePath
  });
  assert.equal(status.configured, true);
  assert.equal(status.commands.length, 1);
  assert.match(status.commands[0], /WAKEFIELD_HOME=/);
  assert.match(status.commands[0], /hook$/);
  assert.equal((await wakefieldSkillsStatus({ codexHomePath })).configured, true);

  const hooksJson = await fs.readFile(status.hooksPath, "utf8");
  assert.equal((hooksJson.match(/Wakefield memory/g) || []).length, 6);
  const imessageSkill = await fs.readFile(path.join(codexHomePath, "skills", "wakefield-imessage", "SKILL.md"), "utf8");
  assert.match(imessageSkill, /Do not use `phone` as the recipient target/);
  assert.match(imessageSkill, /do not immediately retry the same iMessage action/);
  const externalSourceSkill = await fs.readFile(path.join(codexHomePath, "skills", "wakefield-external-source-replies", "SKILL.md"), "utf8");
  assert.match(externalSourceSkill, /external-source requests/);
});

test("Photon native fallbacks are skipped during transient upstream pressure", () => {
  assert.equal(isPhotonBackpressureError(new Error("[upstream] Service temporarily unavailable. Please retry.")), true);
  assert.equal(isPhotonBackpressureError({ status: 429, message: "Too many requests" }), true);
  assert.equal(isPhotonBackpressureError({ grpcCode: 14, message: "connection dropped" }), true);
  assert.equal(shouldUsePhotonNativeFallback(new Error("Photon/Spectrum message abc was not found.")), true);
  assert.equal(shouldUsePhotonNativeFallback(new Error("space does not expose message lookup")), true);
});

test("listRecentThreads returns local Codex transcripts newest first", async () => {
  const codexHomePath = await tempHome();
  const sessions = path.join(codexHomePath, "sessions", "2026", "06", "14");
  await fs.mkdir(sessions, { recursive: true });
  const older = path.join(sessions, "rollout-2026-06-14T10-00-00-019ecaaa-0000-7000-8000-000000000001.jsonl");
  const newer = path.join(sessions, "rollout-2026-06-14T11-00-00-019ecaaa-0000-7000-8000-000000000002.jsonl");
  await fs.writeFile(older, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/older", timestamp: "2026-06-14T10:00:00Z" } })}\n`);
  await fs.writeFile(newer, `${JSON.stringify({ type: "session_meta", payload: { cwd: "/tmp/newer", timestamp: "2026-06-14T11:00:00Z" } })}\n`);
  await fs.utimes(older, new Date("2026-06-14T10:00:00Z"), new Date("2026-06-14T10:00:00Z"));
  await fs.utimes(newer, new Date("2026-06-14T11:00:00Z"), new Date("2026-06-14T11:00:00Z"));

  const threads = await listRecentThreads({ codexHomePath, limit: 2 });
  assert.equal(threads[0].threadId, "019ecaaa-0000-7000-8000-000000000002");
  assert.equal(threads[0].cwd, "/tmp/newer");
  assert.equal(threads[1].threadId, "019ecaaa-0000-7000-8000-000000000001");
  assert.equal(threadIdFromFilename(path.basename(newer)), "019ecaaa-0000-7000-8000-000000000002");
});

test("setupStatus gives menu-bar friendly next steps and connector slots", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();

  const empty = await setupStatus({ home, codexHomePath });
  assert.equal(empty.manifest.schemaVersion, 1);
  assert.equal(empty.manifest.app.packageName, "wakefield");
  assert.equal(empty.manifest.setup.actionContract.schemaVersion, 1);
  assert.equal(empty.ok, false);
  assert.equal(empty.phase, "needs_setup");
  assert.equal(empty.agent, null);
  assert.match(empty.nextSteps[0], /pnpm wakefield install/);
  assert.equal(empty.actions.find((action) => action.id === "create-agent").enabled, true);
  assert.equal(empty.actions.find((action) => action.id === "install-hooks").enabled, false);
  assert.equal(empty.actions.find((action) => action.id === "install-base-skills").enabled, false);
  assert.equal(empty.actions.find((action) => action.id === "enable-service").enabled, false);
  assert.equal(empty.actions.find((action) => action.id === "configure-service-env-file").enabled, false);
  assert.equal(empty.actions.find((action) => action.id === "enable-external-dispatch").enabled, false);
  assert.equal(empty.actions.find((action) => action.id === "setup-connector-discord").enabled, true);
  assert.deepEqual(empty.connectors.find((connector) => connector.id === "discord").missingSettings, ["botTokenEnv"]);
  assert.deepEqual(
    empty.connectors.map((connector) => connector.id),
    CONNECTOR_SETUP_SLOTS.map((connector) => connector.id)
  );

  await installWakefield({
    name: "Menu",
    soul: "A setup companion.",
    threadId: "thread-123",
    home,
    codexHomePath
  });

  const ready = await setupStatus({ home, codexHomePath });
  assert.equal(ready.ok, true);
  assert.equal(ready.phase, "ready");
  assert.equal(ready.agent.name, "Menu");
  assert.equal(ready.actions.find((action) => action.id === "create-agent").enabled, false);
  assert.equal(ready.actions.find((action) => action.id === "install-base-skills").enabled, false);
  assert.equal(ready.actions.find((action) => action.id === "review-hooks").enabled, true);
  assert.equal(ready.actions.find((action) => action.id === "enable-service").enabled, true);
  assert.equal(ready.actions.find((action) => action.id === "configure-service-env-file").enabled, true);
  assert.equal(ready.actions.find((action) => action.id === "enable-external-dispatch").enabled, true);
  assert.equal(ready.service.enabled, false);
  assert.equal(ready.service.externalDispatch.enabled, false);
  assert.equal(ready.service.environment.configured, false);
  assert.match(ready.nextSteps.join("\n"), /\/hooks/);

  await fs.rm(path.join(codexHomePath, "skills", "wakefield-discord"), { recursive: true, force: true });
  const missingSkill = await setupStatus({ home, codexHomePath });
  assert.equal(missingSkill.actions.find((action) => action.id === "install-base-skills").enabled, true);
});

test("menuSnapshot gives a bounded read-only menu bar payload", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const empty = await menuSnapshot({ home, codexHomePath });
  assert.equal(empty.schemaVersion, 1);
  assert.equal(empty.ready, false);
  assert.equal(empty.headline, "Create an agent");
  assert.equal(empty.enabledActionIds.includes("create-agent"), true);

  const installed = await installWakefield({
    name: "Menu View",
    soul: "",
    threadId: "thread-menu",
    cwd: "/tmp/menu-view",
    home,
    codexHomePath
  });
  const profile = installed.profile;
  await configureService({
    home,
    enabled: true,
    dispatchEnabled: true,
    dispatchMode: "dry-run",
    dispatchLimit: 1
  });
  await ingestExternalMessage(profile, {
    connector: "email",
    sender: "person@example.com",
    messageId: "menu-message",
    subject: "Menu snapshot",
    text: "This message should appear in a bounded menu snapshot."
  });

  const snapshot = await menuSnapshot({ home, codexHomePath, messageLimit: 1 });
  assert.equal(snapshot.agent.name, "Menu View");
  assert.equal(snapshot.headline, "1 message pending");
  assert.equal(snapshot.service.enabled, true);
  assert.equal(snapshot.service.externalDispatch.enabled, true);
  assert.equal(snapshot.service.externalDispatch.mode, "dry-run");
  assert.equal(snapshot.inbox.pending, 1);
  assert.equal(snapshot.inbox.recent.length, 1);
  assert.equal(snapshot.inbox.recent[0].subject, "Menu snapshot");
  assert.equal(snapshot.threads.selectedThreadId, "thread-menu");
  assert.equal(snapshot.connectors.find((connector) => connector.id === "email").transports.find((transport) => transport.id === "rfc822").status, "available");
  assert.equal(snapshot.actions.find((action) => action.id === "enable-external-dispatch").enabled, false);
  assert.equal((await listExternalMessages(profile)).length, 1);
});

test("runSetup gives clone installs a one-command idempotent setup path", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const threadId = "019ecaaa-0000-7000-8000-000000000009";
  await writeCodexSession(codexHomePath, {
    threadId,
    timestamp: "2026-06-14T15:00:00Z",
    cwd: "/tmp/wakefield-thread"
  });

  const first = await runSetup({
    home,
    codexHomePath,
    name: "First Run",
    soul: "A clean setup companion.",
    latestThread: true,
    enableService: true,
    intervalMinutes: 9,
    enableDispatch: true,
    dispatchMode: "ipc",
    dispatchLimit: 2
  });

  assert.equal(first.ok, true);
  assert.equal(first.phase, "ready");
  assert.equal(first.actions.find((action) => action.id === "find-latest-thread").detail, threadId);
  assert.equal(first.actions.find((action) => action.id === "create-agent").status, "applied");
  assert.equal(first.actions.find((action) => action.id === "install-hooks").status, "applied");
  assert.equal(first.actions.find((action) => action.id === "install-base-skills").status, "applied");
  assert.match(first.actions.find((action) => action.id === "install-base-skills").detail, /Wakefield skill\(s\)/);
  assert.equal(first.actions.find((action) => action.id === "enable-service").detail, "9 minute interval");
  assert.equal(first.actions.find((action) => action.id === "enable-external-dispatch").detail, "ipc, limit 2");

  const agent = await loadAgent(null, home);
  assert.equal(agent.name, "First Run");
  assert.equal(agent.threadId, threadId);
  assert.equal((await serviceStatus({ home })).enabled, true);
  assert.equal((await serviceStatus({ home })).externalDispatch.enabled, true);
  assert.equal((await serviceStatus({ home })).externalDispatch.limit, 2);
  assert.equal((await hooksStatus({
    command: wakefieldHookCommand({ home }),
    codexHomePath
  })).configured, true);
  assert.equal((await wakefieldSkillsStatus({ codexHomePath })).configured, true);

  const second = await runSetup({
    home,
    codexHomePath,
    latestThread: true,
    enableService: true,
    intervalMinutes: 9
  });

  assert.equal(second.ok, true);
  assert.equal(second.actions.find((action) => action.id === "create-agent").status, "unchanged");
  assert.equal(second.actions.find((action) => action.id === "install-hooks").status, "unchanged");
  assert.equal(second.actions.find((action) => action.id === "install-base-skills").status, "unchanged");
});

test("agent packs install cwd, contacts, and duties without embedding app-specific code", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const packRoot = await tempHome();
  await fs.mkdir(path.join(packRoot, "state"), { recursive: true });
  await fs.mkdir(path.join(packRoot, "prompts"), { recursive: true });
  await fs.mkdir(path.join(packRoot, "skills", "pack-duty-skill"), { recursive: true });
  await fs.writeFile(path.join(packRoot, "AGENTS.md"), "# Pack Agent\n\nUse the pack cwd.\n");
  await fs.writeFile(path.join(packRoot, "skills", "pack-duty-skill", "SKILL.md"), [
    "---",
    "name: pack-duty-skill",
    "description: Use for the pack duty skill.",
    "---",
    "",
    "# Pack Duty Skill",
    "",
    "Run the pack duty from a skill."
  ].join("\n"));
  await fs.writeFile(path.join(packRoot, "state", "people.json"), JSON.stringify({
    version: 1,
    identity_resolution: {},
    people: {
      ada: {
        display_name: "Ada",
        discord_user_ids: ["user-ada"],
        roles: ["operator"]
      }
    }
  }));
  await fs.writeFile(path.join(packRoot, "prompts", "wake.md"), "Run the pack duty.");
  const packFile = path.join(packRoot, "wakefield-pack.json");
  await fs.writeFile(packFile, JSON.stringify({
    schemaVersion: 1,
    id: "pack-agent",
    agent: {
      name: "Pack Agent",
      cwd: ".",
      soulFile: "AGENTS.md"
    },
    contacts: {
      file: "state/people.json",
      format: "people-v1"
    },
    skills: {
      install: [
        { path: "skills/pack-duty-skill" }
      ],
      uninstall: [
        "old-pack-skill"
      ]
    },
    duties: [
      {
        id: "pack-duty",
        label: "Pack Duty",
        skills: ["pack-duty-skill"]
      }
    ],
    wakeups: [
      {
        id: "pack-morning",
        label: "Pack Morning",
        enabled: true,
        times: ["10:00"],
        dispatchMode: "dry-run",
        duties: ["pack-duty"]
      }
    ]
  }));
  await fs.mkdir(path.join(codexHomePath, "skills", "old-pack-skill"), { recursive: true });
  await fs.writeFile(path.join(codexHomePath, "skills", "old-pack-skill", "SKILL.md"), "old");

  const inspected = await inspectAgentPack(packFile);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.pack.agent.cwd, packRoot);
  assert.equal(inspected.pack.skills.install[0].name, "pack-duty-skill");

  const installed = await installAgentPack(packFile, {
    home,
    codexHomePath,
    threadId: "thread-pack",
    skipHooks: true
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.profile.name, "Pack Agent");
  assert.equal(installed.profile.cwd, packRoot);
  assert.equal(await fileExists(path.join(codexHomePath, "skills", "pack-duty-skill", "SKILL.md")), true);
  assert.equal(await fileExists(path.join(codexHomePath, "skills", "old-pack-skill", "SKILL.md")), false);
  assert.deepEqual(
    (await wakefieldSkillsStatus({ codexHomePath })).installed
      .filter((skill) => skill.installed)
      .map((skill) => skill.name),
    await bundledWakefieldSkillNames()
  );
  assert.equal((await loadContacts({ home })).contacts[0].id, "ada");

  const morningRunAt = new Date(2026, 5, 14, 10, 0, 0);
  const duties = await dutyStatuses({ home, now: morningRunAt });
  assert.equal(duties.duties[0].id, "pack-duty");
  assert.equal(duties.wakeups[0].id, "pack-morning");
  assert.equal(duties.wakeups[0].due, true);
  const run = await runDueDuties(installed.profile, {
    home,
    now: morningRunAt
  });
  assert.match(run.results[0].route.prompt, /Use \$wakefield-scheduled-wakeup\./);
  assert.match(run.results[0].route.prompt, /Duty skills: \$pack-duty-skill/);
  assert.match(run.results[0].route.prompt, /Due wake slot: 10:00 local/);
  assert.match(run.results[0].route.prompt, /Run these scheduled duties in this turn:\n- pack-duty: \$pack-duty-skill/);
  assert.doesNotMatch(run.results[0].route.prompt, /Load each duty skill/);
  assert.doesNotMatch(run.results[0].route.prompt, /Run the pack duty\./);

  await installAgentPack(packFile, {
    home,
    codexHomePath,
    threadId: "thread-pack",
    skipHooks: true
  });
  const afterReinstall = await dutyStatuses({ home, now: new Date(2026, 5, 14, 10, 1, 0) });
  assert.equal(afterReinstall.wakeups[0].lastRunAt, morningRunAt.toISOString());
  assert.equal(afterReinstall.wakeups[0].due, false);
});

test("agent packs can register mature connector packages without app-specific Wakefield code", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const packRoot = await tempHome();
  const connector = await createFakeManagedConnector(packRoot, "discord-codex", {
    targetCwd: packRoot,
    threadId: "thread-managed-pack"
  });
  await fs.mkdir(path.join(packRoot, "state"), { recursive: true });
  await fs.writeFile(path.join(packRoot, "AGENTS.md"), "# Managed Pack Agent\n");
  await fs.writeFile(path.join(packRoot, "state", "people.json"), JSON.stringify({ version: 1, people: {} }));
  const packFile = path.join(packRoot, "wakefield-pack.json");
  await fs.writeFile(packFile, JSON.stringify({
    schemaVersion: 1,
    id: "managed-pack",
    agent: {
      name: "Managed Pack",
      cwd: ".",
      soulFile: "AGENTS.md"
    },
    contacts: {
      file: "state/people.json",
      format: "people-v1"
    },
    managedConnectors: [
      {
        id: "discord-codex",
        adapter: "discord-codex",
        enabled: true,
        packagePath: "connector",
        configPath: "connector/config.local.json",
        targetId: "self-test",
        mcp: {
          codexConfigPath: ".codex/config.toml"
        },
        launchAgent: {
          label: "com.wakefield.{soul}.{connector}"
        }
      }
    ]
  }));

  const inspected = await inspectAgentPack(packFile);
  assert.equal(inspected.ok, true);
  assert.equal(inspected.pack.managedConnectors.length, 1);
  assert.equal(inspected.pack.managedConnectors[0].packagePath, connector.packagePath);
  assert.equal(inspected.pack.managedConnectors[0].launchAgent.label, "com.wakefield.managed-pack.discord-codex");

  const installed = await installAgentPack(packFile, {
    home,
    codexHomePath,
    threadId: "thread-managed-pack",
    skipHooks: true
  });
  assert.equal(installed.ok, true);
  assert.equal(installed.actions.find((action) => action.id === "managed-connectors").detail, "1 connector package(s)");

  const status = await managedConnectorStatus("discord-codex", {
    home,
    agent: installed.profile
  });
  assert.equal(status.ready, true);
  assert.equal(status.mcp.ok, true);
  assert.equal(status.launchAgent.label, "com.wakefield.managed-pack.discord-codex");
  assert.equal(status.connectorConfig.outbound.channelIds[0], "channel-1");
});

test("managed connector wizards expose package, MCP, daemon, and smoke-test facts", async () => {
  const home = await tempHome();
  const root = await tempHome();
  const connector = await createFakeManagedConnector(root, "discord-codex");
  const imported = await importManagedConnectors([
    {
      id: "discord-codex",
      adapter: "discord-codex",
      enabled: true,
      packagePath: connector.packagePath,
      configPath: connector.configPath,
      targetId: "self-test",
      mcp: {
        codexConfigPath: connector.codexConfigPath
      },
      launchAgent: {
        label: "com.wakefield.test.discord"
      }
    }
  ], { home });
  assert.equal(imported.imported, 1);

  const status = await managedConnectorStatus("discord-codex", { home });
  assert.equal(status.ready, true);
  assert.equal(status.running, false);
  assert.equal(status.package.packageName, "@wakefield/discord-codex");
  assert.equal(status.mcp.tools.includes("discord_send_message"), true);
  assert.equal(status.connectorSkill.name, "wakefield-discord");

  const wizard = await managedConnectorWizard("discord-codex", { home });
  assert.equal(wizard.steps.find((step) => step.id === "codex-tools").status, "complete");
  assert.equal(wizard.steps.find((step) => step.id === "daemon").status, "available");
  assert.equal(wizard.steps.find((step) => step.id === "smoke-tests").tests.some((item) => item.id === "reply-plan"), true);

  const smoke = await testManagedConnector("discord-codex", { home, kind: "reply-plan" });
  assert.equal(smoke.ok, true);
  assert.match(smoke.plan.summary, /discord_send_message/);
  assert.match(smoke.plan.items.join("\n"), /\$wakefield-discord/);

  const launchStatus = await managedConnectorLaunchAgentStatus("discord-codex", {
    home,
    launchAgentsPath: path.join(root, "LaunchAgents")
  });
  assert.equal(launchStatus.installed, false);
  assert.equal(launchStatus.label, "com.wakefield.test.discord");

  const plist = await managedConnectorLaunchAgentPlist("discord-codex", { home });
  assert.match(plist, /managed-connectors/);
  assert.match(plist, /com.wakefield.test.discord/);
});

test("managed connectors resolve installed package dependencies without packagePath", async () => {
  const home = await tempHome();
  const root = await tempHome();
  const targetCwd = path.join(root, "target");
  const configPath = path.join(root, "discord-config.json");
  await fs.mkdir(path.join(targetCwd, ".codex"), { recursive: true });
  await fs.writeFile(path.join(targetCwd, "AGENTS.md"), "# Dependency Resolved Agent\n");
  await fs.writeFile(configPath, JSON.stringify({
    bot: {
      tokenEnv: "WAKEFIELD_TEST_MANAGED_DISCORD_TOKEN"
    },
    targets: [
      {
        id: "self-test",
        displayName: "Self Test",
        threadId: "thread-installed-package",
        cwd: targetCwd,
        allowedChannelIds: ["channel-1"]
      }
    ]
  }));

  await importManagedConnectors([
    {
      id: "discord-codex",
      adapter: "discord-codex",
      enabled: true,
      configPath,
      targetId: "self-test",
      mcp: {
        codexConfigPath: path.join(targetCwd, ".codex", "config.toml")
      }
    }
  ], { home });

  const status = await managedConnectorStatus("discord-codex", { home });
  assert.equal(status.package.packageName, "@wakefield/discord-codex");
  assert.equal(status.package.ok, true);
  assert.match(status.package.path, /packages[\/\\]discord-codex$/);
  assert.equal(status.connectorConfig.targetId, "self-test");
});

test("managed connectors initialize local configs and install MCP entries for Discord and Photon Spectrum", async () => {
  const home = await tempHome();
  const root = await tempHome();
  const agent = {
    id: "setup-agent",
    name: "Setup Agent",
    threadId: "thread-setup",
    cwd: path.join(root, "target")
  };
  const discord = await createFakeManagedConnector(path.join(root, "discord"), "discord-codex", {
    targetCwd: agent.cwd,
    threadId: agent.threadId,
    withConfig: false,
    withMcp: false
  });
  const imessage = await createFakeManagedConnector(path.join(root, "imessage"), "imessage-spectrum", {
    targetCwd: agent.cwd,
    threadId: agent.threadId,
    withConfig: false,
    withMcp: false
  });
  process.env.WAKEFIELD_TEST_INIT_DISCORD_TOKEN = "discord-token";
  process.env.WAKEFIELD_TEST_INIT_PHOTON_ID = "project-id";
  process.env.WAKEFIELD_TEST_INIT_PHOTON_SECRET = "project-secret";
  try {
    await importManagedConnectors([
      {
        id: "discord-codex",
        adapter: "discord-codex",
        enabled: true,
        packagePath: discord.packagePath,
        configPath: discord.configPath,
        targetId: "setup",
        launchAgent: { label: "com.wakefield.test.init.discord" }
      },
      {
        id: "imessage-spectrum",
        adapter: "imessage-spectrum",
        enabled: true,
        packagePath: imessage.packagePath,
        configPath: imessage.configPath,
        targetId: "setup",
        launchAgent: { label: "com.wakefield.test.init.imessage" }
      }
    ], { home });

    const discordInit = await initializeManagedConnectorConfig("discord-codex", {
      home,
      agent,
      settings: {
        targetId: "setup",
        tokenEnv: "WAKEFIELD_TEST_INIT_DISCORD_TOKEN",
        allowedChannelIds: "channel-7",
        allowedDmUserIds: "user-7",
        allowedGuildIds: "guild-7"
      }
    });
    assert.equal(discordInit.changed, true);
    const discordConfig = JSON.parse(await fs.readFile(discord.configPath, "utf8"));
    assert.equal(discordConfig.targets[0].threadId, agent.threadId);
    assert.equal(discordConfig.codex.connectorSkillPrompt, "Use $wakefield-discord for Discord connector routing.");
    assert.deepEqual(discordConfig.discord.allowedOutboundChannelIds, ["channel-7"]);

    const discordMcp = await installManagedConnectorMcp("discord-codex", { home, agent });
    assert.equal(discordMcp.changed, true);
    assert.match(await fs.readFile(path.join(agent.cwd, ".codex", "config.toml"), "utf8"), /discord_send_message/);
    assert.equal((await managedConnectorStatus("discord-codex", { home, agent })).mcp.ok, true);

    const imessageInit = await initializeManagedConnectorConfig("imessage-spectrum", {
      home,
      agent,
      settings: {
        targetId: "setup",
        projectIdEnv: "WAKEFIELD_TEST_INIT_PHOTON_ID",
        projectSecretEnv: "WAKEFIELD_TEST_INIT_PHOTON_SECRET",
        allowedAddresses: "+15551234567",
        allowedSpaceIds: "space-7",
        allowGroupChats: "true"
      }
    });
    assert.equal(imessageInit.changed, true);
    const imessageConfig = JSON.parse(await fs.readFile(imessage.configPath, "utf8"));
    assert.equal(imessageConfig.identity.contactsPath, "");
    assert.equal(imessageConfig.codex.connectorSkillPrompt, "Use $wakefield-imessage for iMessage connector routing.");
    assert.deepEqual(imessageConfig.imessage.allowedOutboundSpaceIds, ["space-7"]);
    assert.equal(imessageConfig.targets[0].allowGroupChats, true);

    const imessageMcp = await installManagedConnectorMcp("imessage-spectrum", { home, agent });
    assert.equal(imessageMcp.changed, true);
    const codexText = await fs.readFile(path.join(agent.cwd, ".codex", "config.toml"), "utf8");
    assert.match(codexText, /imessage_send_reaction/);
    assert.match(codexText, /discord_send_message/);
    assert.equal((await managedConnectorStatus("imessage-spectrum", { home, agent })).mcp.ok, true);

    const imessageDiagnosticPlan = await testManagedConnector("imessage-spectrum", { home, kind: "diagnostic-plan" });
    assert.equal(imessageDiagnosticPlan.ok, true);
    assert.doesNotMatch(imessageDiagnosticPlan.plan.items[0], /--deep/);
    assert.match(imessageDiagnosticPlan.plan.items.join("\n"), /approved Photon cloud\/API probes/);
  } finally {
    delete process.env.WAKEFIELD_TEST_INIT_DISCORD_TOKEN;
    delete process.env.WAKEFIELD_TEST_INIT_PHOTON_ID;
    delete process.env.WAKEFIELD_TEST_INIT_PHOTON_SECRET;
  }
});

test("runSelfTest exercises clone-install paths in temporary state", async () => {
  const result = await runSelfTest();
  assert.equal(result.ok, true);
  assert.equal(result.kept, false);
  assert.equal(result.stateRoot, null);
  assert.equal(result.steps.find((step) => step.id === "agent-pack-inspect").ok, true);
  assert.equal(result.steps.find((step) => step.id === "agent-pack-install").ok, true);
  assert.equal(result.steps.find((step) => step.id === "setup-run").ok, true);
  assert.equal(result.steps.find((step) => step.id === "email-ingest").ok, true);
  assert.equal(result.steps.find((step) => step.id === "email-imap-poll").ok, true);
  assert.equal(result.steps.find((step) => step.id === "service-env-file-email-poll").ok, true);
  assert.equal(result.steps.find((step) => step.id === "discord-gateway-ingest").ok, true);
  assert.equal(result.steps.find((step) => step.id === "imessage-chatdb-poll").ok, true);
  assert.equal(result.steps.find((step) => step.id === "service-dispatch-dry-run").ok, true);
  assert.equal(result.steps.find((step) => step.id === "menu-snapshot").ok, true);
  assert.equal(result.steps.find((step) => step.id === "connector-wizard-contract").ok, true);
  assert.equal(result.steps.find((step) => step.id === "managed-connector-config").ok, true);
  assert.equal(result.steps.find((step) => step.id === "managed-connector-wizard").ok, true);
  assert.equal(result.steps.find((step) => step.id === "managed-connector-status-test").ok, true);
  assert.equal(result.steps.find((step) => step.id === "managed-connector-launch-agent-plan").ok, true);
  assert.equal(result.steps.find((step) => step.id === "http-intake").ok, true);
  assert.equal(result.steps.find((step) => step.id === "http-connector-wizard-api").ok, true);
  assert.equal(result.steps.find((step) => step.id === "http-managed-connector-wizard-api").ok, true);
  assert.equal(result.steps.find((step) => step.id === "http-managed-connector-init-config-api").ok, true);
  assert.equal(result.steps.find((step) => step.id === "http-managed-connector-mcp-install-api").ok, true);
  assert.equal(result.steps.find((step) => step.id === "http-managed-connector-launch-agent-install-api").ok, true);
  assert.equal(result.steps.find((step) => step.id === "launch-agent-temp-install").ok, true);
  assert.equal(result.steps.find((step) => step.id === "doctor").ok, true);
});

test("connector config stores setup state without pretending transport is ready", async () => {
  const home = await tempHome();
  const before = await connectorStatuses({ home });
  const beforeDiscord = before.find((connector) => connector.id === "discord");
  const beforeEmail = before.find((connector) => connector.id === "email");
  const beforeImessage = before.find((connector) => connector.id === "imessage");
  assert.equal(beforeDiscord.configured, false);
  assert.deepEqual(beforeDiscord.missingSettings, ["botTokenEnv"]);
  assert.equal(beforeEmail.transports.find((transport) => transport.id === "rfc822").status, "available");
  assert.equal(beforeEmail.transports.find((transport) => transport.id === "imap").status, "available");
  assert.deepEqual(beforeEmail.missingSettings, ["imapHost", "username", "passwordEnv"]);
  assert.equal(beforeImessage.transports.find((transport) => transport.id === "chatdb").status, "available");
  assert.equal(beforeImessage.available, true);

  const discord = await configureConnector("discord", {
    home,
    enabled: true,
    settings: {
      botTokenEnv: "DISCORD_BOT_TOKEN",
      allowedTargets: "123,456"
    }
  });

  assert.equal(discord.enabled, true);
  assert.equal(discord.configured, true);
  assert.equal(discord.ready, false);
  assert.equal(discord.ingestAvailable, true);
  assert.equal(discord.settings.botTokenEnv, "DISCORD_BOT_TOKEN");
  assert.deepEqual(discord.missingSecrets, ["DISCORD_BOT_TOKEN"]);
  assert.equal(discord.implementationStatus, "available");

  const status = await setupStatus({ home, codexHomePath: await tempHome() });
  const action = status.actions.find((item) => item.id === "setup-connector-discord");
  assert.equal(action.kind, "connector-config");
  assert.equal(action.command[0], "wakefield");
  assert.match(action.reason, /Missing environment variable/);
  assert.equal(status.manifest.connectors.find((connector) => connector.id === "discord").configured, true);
});

test("connector wizards expose menu-bar setup contracts without raw secrets", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_WIZARD_DISCORD_TOKEN";
  delete process.env[envName];
  try {
    const all = await connectorWizards({ home });
    assert.deepEqual(all.map((wizard) => wizard.connectorId), ["discord", "imessage", "email"]);
    assert.equal(all.find((wizard) => wizard.connectorId === "discord").nextAction.id, "enter-settings");
    assert.equal(all.find((wizard) => wizard.connectorId === "imessage").nextAction.id, "save-settings");

    const missingSecret = await configureConnector("discord", {
      home,
      enabled: true,
      settings: {
        botTokenEnv: envName,
        allowedTargets: "channel-1"
      }
    });
    assert.equal(missingSecret.ready, false);

    const wizard = await connectorWizard("discord", { home });
    assert.equal(wizard.schemaVersion, 1);
    assert.equal(wizard.id, "connector-wizard-discord");
    assert.equal(wizard.nextAction.id, "set-environment");
    assert.equal(wizard.fields.find((field) => field.id === "botTokenEnv").value, envName);
    assert.equal(wizard.fields.find((field) => field.id === "botTokenEnv").envSet, false);
    assert.equal(wizard.steps.find((step) => step.id === "settings").command[0], "wakefield");
    assert.equal(wizard.steps.find((step) => step.id === "run").commands[0].command.join(" "), "wakefield discord listen");

    process.env[envName] = "discord-token";
    const readyWizard = await connectorWizard("discord", { home });
    assert.equal(readyWizard.ready, true);
    assert.equal(readyWizard.nextAction.id, "run-connector");
    assert.equal(readyWizard.fields.find((field) => field.id === "botTokenEnv").envSet, true);
  } finally {
    delete process.env[envName];
  }
});

test("contacts import legacy people maps and annotate external messages", async () => {
  const home = await tempHome();
  const contactsFile = path.join(home, "people.json");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(contactsFile, JSON.stringify({
    version: 1,
    identity_resolution: {
      phone_rule: "normalize"
    },
    people: {
      terence: {
        display_name: "Terence",
        discord_user_ids: ["426146080498122762"],
        phone_numbers: ["+18018975452"],
        roles: ["sales", "business leadership"],
        notes: ["Cofounder."]
      }
    }
  }));

  const imported = await importContactsFile(contactsFile, {
    home,
    format: "people-v1"
  });
  assert.equal(imported.contacts.length, 1);
  assert.equal((await loadContacts({ home })).contacts[0].displayName, "Terence");

  const discord = await resolveContact({
    connector: "discord",
    metadata: {
      authorId: "426146080498122762"
    }
  }, { home });
  assert.equal(discord.contact.id, "terence");

  const imessage = await resolveContact({
    connector: "imessage",
    sender: "(801) 897-5452"
  }, { home });
  assert.equal(imessage.contact.displayName, "Terence");

  const profile = await initAgent({
    name: "Contacts",
    soul: "",
    threadId: "thread-contacts",
    cwd: "/tmp/contacts",
    home
  });
  const ingested = await ingestExternalMessage(profile, {
    home,
    connector: "discord",
    sender: "terence",
    messageId: "contact-msg-1",
    text: "Can you check this?",
    metadata: {
      authorId: "426146080498122762"
    }
  });
  assert.equal(ingested.message.contactId, "terence");
  assert.match(ingested.route.prompt, /Contact: Terence/);
  assert.match(ingested.route.prompt, /business leadership/);
});

test("external message memory follows a contact across connectors without leaking to other people", async () => {
  const home = await tempHome();
  const contactsFile = path.join(home, "people.json");
  await fs.mkdir(home, { recursive: true });
  await fs.writeFile(contactsFile, JSON.stringify({
    version: 1,
    identity_resolution: {
      phone_rule: "normalize"
    },
    people: {
      joe: {
        display_name: "Joe",
        discord_user_ids: ["joe-discord"],
        phone_numbers: ["+15550001000"]
      },
      terence: {
        display_name: "Terence",
        discord_user_ids: ["terence-discord"],
        phone_numbers: ["+15550002000"]
      }
    }
  }));
  await importContactsFile(contactsFile, {
    home,
    format: "people-v1"
  });
  const profile = await initAgent({
    name: "Cross Channel",
    soul: "",
    threadId: "thread-cross-channel",
    cwd: "/tmp/cross-channel",
    home
  });
  await upsertMatter(profile, {
    id: "joe-package-followup",
    title: "Joe package follow-up",
    summary: "Joe asked about tracking for a replacement package on Discord.",
    scope: {
      people: ["joe"],
      topics: ["package", "tracking"]
    }
  });

  const discord = await ingestExternalMessage(profile, {
    home,
    connector: "discord",
    sender: "joe-discord",
    messageId: "joe-discord-1",
    text: "Any update on that package?",
    metadata: {
      authorId: "joe-discord"
    }
  });
  assert.match(discord.route.prompt, /Wakefield context for this external message/);
  assert.match(discord.route.prompt, /joe-package-followup/);

  const imessage = await ingestExternalMessage(profile, {
    home,
    connector: "imessage",
    sender: "(555) 000-1000",
    messageId: "joe-imessage-1",
    text: "Following up from yesterday on the tracking."
  });
  assert.match(imessage.route.prompt, /joe-package-followup/);

  const terence = await ingestExternalMessage(profile, {
    home,
    connector: "discord",
    sender: "terence-discord",
    messageId: "terence-discord-1",
    text: "Any update on that package?",
    metadata: {
      authorId: "terence-discord"
    }
  });
  assert.doesNotMatch(terence.route.prompt, /joe-package-followup/);
});

test("Discord connector is ready only when its bot token env var exists", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_DISCORD_TOKEN_READY";
  delete process.env[envName];
  try {
    const withoutSecret = await configureConnector("discord", {
      home,
      enabled: true,
      settings: {
        botTokenEnv: envName,
        allowedTargets: "channel-1"
      }
    });
    assert.equal(withoutSecret.configured, true);
    assert.equal(withoutSecret.ready, false);
    assert.deepEqual(withoutSecret.missingSecrets, [envName]);

    process.env[envName] = "discord-token";
    const withSecret = (await connectorStatuses({ home })).find((connector) => connector.id === "discord");
    assert.equal(withSecret.ready, true);
    assert.deepEqual(withSecret.missingSecrets, []);
  } finally {
    delete process.env[envName];
  }
});

test("email connector is ready only when its password env var exists", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_EMAIL_PASSWORD_READY";
  delete process.env[envName];
  try {
    const withoutSecret = await configureConnector("email", {
      home,
      enabled: true,
      settings: {
        imapHost: "imap.example.com",
        username: "agent@example.com",
        passwordEnv: envName
      }
    });
    assert.equal(withoutSecret.configured, true);
    assert.equal(withoutSecret.ready, false);
    assert.deepEqual(withoutSecret.missingSecrets, [envName]);

    process.env[envName] = "test-password";
    const withSecret = (await connectorStatuses({ home })).find((connector) => connector.id === "email");
    assert.equal(withSecret.ready, true);
    assert.deepEqual(withSecret.missingSecrets, []);
  } finally {
    delete process.env[envName];
  }
});

test("iMessage connector is ready only when its Messages database is readable", async () => {
  const home = await tempHome();
  const databasePath = path.join(home, "chat.db");
  const missing = await configureConnector("imessage", {
    home,
    enabled: true,
    settings: {
      databasePath
    }
  });
  assert.equal(missing.configured, true);
  assert.equal(missing.ready, false);
  assert.deepEqual(missing.missingPaths, [databasePath]);
  const missingStatus = await setupStatus({ home, codexHomePath: await tempHome() });
  assert.match(missingStatus.actions.find((item) => item.id === "setup-connector-imessage").reason, /Missing readable file/);

  await fs.writeFile(databasePath, "");
  const ready = (await connectorStatuses({ home })).find((connector) => connector.id === "imessage");
  assert.equal(ready.ready, true);
  assert.deepEqual(ready.missingPaths, []);

  const status = await setupStatus({ home, codexHomePath: await tempHome() });
  const action = status.actions.find((item) => item.id === "setup-connector-imessage");
  assert.equal(action.kind, "connector-config");
  assert.equal(action.reason, null);
});

test("RFC822 email ingest parses .eml content into the external inbox", async () => {
  const home = await tempHome();
  const profile = await initAgent({
    name: "Mailer",
    soul: "",
    threadId: "thread-mail",
    cwd: "/tmp/mailer",
    home
  });
  const raw = [
    "From: Ada <ada@example.com>",
    "To: wakefield@example.com",
    "Subject: =?UTF-8?Q?Release_note_check?=",
    "Message-ID: <email-1@example.com>",
    "Date: Sun, 14 Jun 2026 17:30:00 -0700",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: quoted-printable",
    "",
    "Can you check=20",
    "the release note?"
  ].join("\r\n");

  const parsed = parseRfc822(raw);
  assert.equal(parsed.from, "Ada <ada@example.com>");
  assert.equal(parsed.subject, "Release note check");
  assert.equal(parsed.messageId, "email-1@example.com");
  assert.match(parsed.text, /Can you check/);

  const first = await ingestEmailRfc822(profile, {
    raw,
    sourceFile: "/tmp/message.eml",
    now: new Date("2026-06-14T17:30:00Z")
  });
  const second = await ingestEmailRfc822(profile, {
    raw,
    sourceFile: "/tmp/message.eml",
    now: new Date("2026-06-14T17:31:00Z")
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(first.message.connector, "email");
  assert.equal(first.message.messageId, "email-1@example.com");
  assert.equal(first.message.subject, "Release note check");
  assert.equal(first.message.metadata.sourceFile, "/tmp/message.eml");
  assert.equal(first.route.status, "ready");
  assert.match(first.route.prompt, /External Email message/);
  assert.match(first.route.prompt, /Release note check/);
  assert.equal((await listExternalMessages(profile)).length, 1);
});

test("RFC822 email ingest extracts text from multipart messages", () => {
  const raw = [
    "From: person@example.com",
    "Subject: Multipart",
    "Message-ID: <multipart@example.com>",
    "Content-Type: multipart/alternative; boundary=\"wakefield-boundary\"",
    "",
    "--wakefield-boundary",
    "Content-Type: text/html",
    "",
    "<p>HTML body</p>",
    "--wakefield-boundary",
    "Content-Type: text/plain; charset=utf-8",
    "Content-Transfer-Encoding: base64",
    "",
    Buffer.from("Plain body wins.").toString("base64"),
    "--wakefield-boundary--"
  ].join("\n");

  const parsed = parseRfc822(raw);
  assert.equal(parsed.text, "Plain body wins.");
});

test("IMAP email poll queues allowed messages and records processed state", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_EMAIL_PASSWORD";
  process.env[envName] = "test-password";
  try {
    const profile = await initAgent({
      name: "Mailbox",
      soul: "",
      threadId: "thread-mailbox",
      cwd: "/tmp/mailbox",
      home
    });
    await configureConnector("email", {
      home,
      enabled: true,
      settings: {
        imapHost: "imap.example.com",
        username: "agent@example.com",
        passwordEnv: envName,
        allowedSenders: "ada@example.com",
        maxMessagesPerPoll: "5"
      }
    });

    const mailbox = fakeMailbox([
      { id: "101", raw: testEmail({ from: "Ada <ada@example.com>", messageId: "imap-101@example.com", subject: "Allowed", body: "Please remember this IMAP note." }) },
      { id: "102", raw: testEmail({ from: "Mallory <mallory@example.com>", messageId: "imap-102@example.com", subject: "Denied", body: "Do not queue this." }) }
    ]);
    const first = await pollEmailImap(profile, {
      home,
      mailboxClient: mailbox,
      now: new Date("2026-06-14T19:00:00Z")
    });

    assert.equal(first.ok, true);
    assert.equal(first.checked, 2);
    assert.equal(first.queued, 1);
    assert.equal(first.skipped, 1);
    assert.equal(first.results.find((result) => result.id === "102").reason, "sender_not_allowed");
    assert.deepEqual(mailbox.marked, ["101", "102"]);

    const pending = await listExternalMessages(profile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].subject, "Allowed");
    assert.equal(pending[0].metadata.sourceFile, "imap:agent@example.com:101");

    const second = await pollEmailImap(profile, {
      home,
      mailboxClient: fakeMailbox([
        { id: "101", raw: testEmail({ from: "Ada <ada@example.com>", messageId: "imap-101@example.com", subject: "Allowed", body: "Please remember this IMAP note." }) }
      ]),
      now: new Date("2026-06-14T19:01:00Z")
    });
    assert.equal(second.queued, 0);
    assert.equal(second.results[0].reason, "already_processed");
  } finally {
    delete process.env[envName];
  }
});

test("iMessage chat.db poll queues allowed inbound messages and records cursor state", async () => {
  const home = await tempHome();
  const databasePath = path.join(home, "chat.db");
  await fs.writeFile(databasePath, "");
  const profile = await initAgent({
    name: "Messages",
    soul: "",
    threadId: "thread-imessage",
    cwd: "/tmp/imessage",
    home
  });
  await configureConnector("imessage", {
    home,
    enabled: true,
    settings: {
      databasePath,
      allowedSenders: "+15551234567",
      maxMessagesPerPoll: "5"
    }
  });

  assert.equal(appleMessageDateToIso(1_000_000_000_000_000_000), "2032-09-09T01:46:40.000Z");
  const normalized = normalizeImessageRow(imessageRow({
    id: 10,
    sender: "+1 (555) 123-4567",
    text: "Please queue this iMessage."
  }));
  assert.equal(normalized.receivedAt, "2032-09-09T01:46:40.000Z");
  assert.equal(imessageMessageAllowed(normalized, { allowedSenders: "+15551234567" }), true);
  assert.equal(imessageMessageAllowed({ ...normalized, isGroup: true }, { allowedSenders: "+15551234567" }), false);
  assert.equal(imessageMessageAllowed({ ...normalized, isGroup: true, chatGuid: "group-guid" }, { allowedChats: "group-guid" }), true);

  const first = await pollImessageChatDb(profile, {
    home,
    rows: [
      imessageRow({
        id: 10,
        sender: "+1 (555) 123-4567",
        text: "Please queue this iMessage."
      }),
      imessageRow({
        id: 11,
        sender: "+15557654321",
        text: "Please ignore this sender."
      })
    ],
    now: new Date("2026-06-14T21:00:00Z")
  });

  assert.equal(first.ok, true);
  assert.equal(first.checked, 2);
  assert.equal(first.queued, 1);
  assert.equal(first.skipped, 1);
  assert.equal(first.results.find((result) => result.id === 11).reason, "not_allowed");
  const pending = await listExternalMessages(profile);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].connector, "imessage");
  assert.equal(pending[0].sender, "+1 (555) 123-4567");
  assert.equal(pending[0].metadata.rowId, 10);
  assert.match(pending[0].text, /queue this iMessage/);

  const state = JSON.parse(await fs.readFile(path.join(home, "connectors", "imessage-state.json"), "utf8"));
  assert.equal(state.lastRowId, 11);

  const second = await pollImessageChatDb(profile, {
    home,
    rows: [imessageRow({ id: 10, sender: "+1 (555) 123-4567", text: "Old message." })],
    now: new Date("2026-06-14T21:01:00Z")
  });
  assert.equal(second.queued, 0);
  assert.equal(second.results[0].reason, "already_processed");
});

test("external inbox queues connector messages with Codex route metadata", async () => {
  const home = await tempHome();
  const profile = await initAgent({
    name: "Relay",
    soul: "",
    threadId: "thread-abc",
    cwd: "/tmp/relay",
    home
  });

  const first = await ingestExternalMessage(profile, {
    connector: "discord",
    conversationId: "channel-123",
    sender: "Ada",
    messageId: "discord-msg-1",
    text: "Can you check the release note?",
    metadata: {
      guildId: "guild-1"
    },
    now: new Date("2026-06-14T12:30:00Z")
  });
  const second = await ingestExternalMessage(profile, {
    connector: "discord",
    conversationId: "channel-123",
    sender: "Ada",
    messageId: "discord-msg-1",
    text: "Can you check the release note?",
    now: new Date("2026-06-14T12:31:00Z")
  });

  assert.equal(first.duplicate, false);
  assert.equal(second.duplicate, true);
  assert.equal(second.message.id, first.message.id);
  assert.equal(first.route.status, "ready");
  assert.equal(first.route.threadId, "thread-abc");
  assert.equal(first.route.cwd, "/tmp/relay");
  assert.match(first.route.prompt, /External Discord message/);
  assert.match(first.route.prompt, /Use \$wakefield-discord for Discord connector routing\./);
  assert.match(first.route.prompt, /Wakefield external ID/);
  assert.match(first.route.prompt, /Can you check the release note/);

  const pending = await listExternalMessages(profile);
  assert.equal(pending.length, 1);
  assert.equal(pending[0].connector, "discord");
  assert.equal(pending[0].metadata.guildId, "guild-1");

  const inbox = await fs.readFile(profile.memory.inboxPath, "utf8");
  assert.match(inbox, /external-message/);
  assert.match(inbox, /release note/);

  const delivered = await acknowledgeExternalMessage(profile, first.message.id, {
    status: "delivered",
    reason: "sent to Codex",
    now: new Date("2026-06-14T12:32:00Z")
  });
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.statusReason, "sent to Codex");
  assert.deepEqual(await listExternalMessages(profile), []);
  assert.equal((await listExternalMessages(profile, { status: "delivered" }))[0].id, first.message.id);
});

test("Discord gateway messages queue through the external inbox", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_DISCORD_TOKEN";
  process.env[envName] = "discord-token";
  try {
    const profile = await initAgent({
      name: "Discord",
      soul: "",
      threadId: "thread-discord",
      cwd: "/tmp/discord",
      home
    });
    await configureConnector("discord", {
      home,
      enabled: true,
      settings: {
        botTokenEnv: envName,
        allowedTargets: "channel-1",
        allowedUsers: "user-1"
      }
    });

    const raw = discordMessage({
      id: "discord-1",
      channelId: "channel-1",
      guildId: "guild-1",
      authorId: "user-1",
      content: "Please queue this Discord message."
    });
    const normalized = normalizeDiscordMessage(raw);
    assert.equal(normalized.url, "https://discord.com/channels/guild-1/channel-1/discord-1");
    assert.equal(discordMessageAllowed(normalized, { allowedTargets: "channel-1", allowedUsers: "user-1" }), true);

    const queued = await ingestDiscordGatewayMessage(profile, raw, {
      home,
      now: new Date("2026-06-14T20:00:00Z")
    });
    assert.equal(queued.ok, true);
    assert.equal(queued.status, "queued");
    assert.equal(queued.ingest.message.connector, "discord");
    assert.equal(queued.ingest.message.conversationId, "channel-1");
    assert.equal(queued.ingest.message.metadata.guildId, "guild-1");
    assert.match(queued.ingest.route.prompt, /External Discord message/);
    assert.match(queued.ingest.route.prompt, /Please queue this Discord message/);

    const duplicate = await ingestDiscordGatewayMessage(profile, raw, { home });
    assert.equal(duplicate.status, "duplicate");

    const disallowed = await ingestDiscordGatewayMessage(profile, discordMessage({
      id: "discord-2",
      channelId: "channel-2",
      guildId: "guild-1",
      authorId: "user-1",
      content: "Wrong channel."
    }), { home });
    assert.equal(disallowed.ok, false);
    assert.equal(disallowed.status, "not-allowed");
    assert.equal((await listExternalMessages(profile)).length, 1);

    const dm = normalizeDiscordMessage(discordMessage({
      id: "discord-dm-1",
      channelId: "dm-channel",
      guildId: null,
      authorId: "user-2",
      content: "DMs are allowed when targets are empty."
    }));
    assert.equal(discordMessageAllowed(dm, { allowedTargets: "", allowedUsers: "" }), true);
  } finally {
    delete process.env[envName];
  }
});

test("HTTP intake queues external messages and exposes snapshots", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const profile = await initAgent({
    name: "HTTP",
    soul: "",
    threadId: "thread-http",
    cwd: "/tmp/http",
    home
  });
  const server = await startHttpIntakeServer({
    home,
    codexHomePath,
    port: 0,
    logger: null
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;
    const health = await fetch(`${base}/health`).then((response) => response.json());
    assert.equal(health.ok, true);
    assert.equal(health.agent.id, profile.id);

    const response = await fetch(`${base}/messages`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        connector: "discord",
        sender: "Ada",
        conversationId: "channel-http",
        messageId: "http-msg-1",
        text: "Hello from HTTP intake."
      })
    });
    const body = await response.json();
    assert.equal(response.status, 202);
    assert.equal(body.ok, true);
    assert.equal(body.ingest.message.connector, "discord");
    assert.equal(body.ingest.route.status, "ready");
    assert.equal((await listExternalMessages(profile)).length, 1);

    const snapshot = await fetch(`${base}/snapshot`).then((item) => item.json());
    assert.equal(snapshot.inbox.pending, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP local API drives menu-bar setup actions", async () => {
  const home = await tempHome();
  const codexHomePath = await tempHome();
  const threadId = "019ecaaa-0000-7000-8000-000000000010";
  await writeCodexSession(codexHomePath, {
    threadId,
    timestamp: "2026-06-14T16:00:00Z",
    cwd: "/tmp/http-api-thread"
  });

  const server = await startHttpIntakeServer({
    home,
    codexHomePath,
    port: 0,
    logger: null
  });
  try {
    const address = server.address();
    const base = `http://${address.address}:${address.port}`;

    const manifest = await fetch(`${base}/manifest`).then((response) => response.json());
    assert.equal(manifest.app.packageName, "wakefield");

    const actionsBefore = await fetch(`${base}/setup/actions`).then((response) => response.json());
    assert.equal(actionsBefore.actions.find((action) => action.id === "create-agent").enabled, true);

    const threads = await fetch(`${base}/threads`).then((response) => response.json());
    assert.equal(threads.threads[0].threadId, threadId);

    const setupResponse = await fetch(`${base}/setup/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        name: "HTTP Setup",
        soul: "A menu-bar setup companion.",
        latestThread: true,
        enableService: true,
        intervalMinutes: 6
      })
    });
    const setup = await setupResponse.json();
    assert.equal(setupResponse.status, 200);
    assert.equal(setup.ok, true);
    assert.equal(setup.status.agent.name, "HTTP Setup");
    assert.equal(setup.status.agent.threadId, threadId);

    const selected = await fetch(`${base}/select-thread`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        threadId,
        cwd: "/tmp/http-api-selected"
      })
    }).then((response) => response.json());
    assert.equal(selected.ok, true);
    assert.equal(selected.agent.cwd, "/tmp/http-api-selected");

    const discord = await fetch(`${base}/connectors/discord/configure`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        enabled: true,
        settings: {
          botTokenEnv: "DISCORD_BOT_TOKEN"
        }
      })
    }).then((response) => response.json());
    assert.equal(discord.configured, true);
    assert.equal(discord.enabled, true);
    assert.equal(discord.ready, false);

    const connectors = await fetch(`${base}/connectors`).then((response) => response.json());
    assert.equal(connectors.connectors.find((connector) => connector.id === "discord").configured, true);

    const peopleFile = path.join(home, "http-people.json");
    await fs.writeFile(peopleFile, JSON.stringify({
      version: 1,
      identity_resolution: {},
      people: {
        http_person: {
          display_name: "HTTP Person",
          discord_user_ids: ["http-user"]
        }
      }
    }));
    const contacts = await fetch(`${base}/contacts/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        file: peopleFile,
        format: "people-v1"
      })
    }).then((response) => response.json());
    assert.equal(contacts.contacts.length, 1);

    const duties = await fetch(`${base}/duties/import`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        duties: [
          {
            id: "http-duty",
            label: "HTTP Duty",
            enabled: true,
            intervalMinutes: 5,
            dispatchMode: "dry-run",
            prompt: "Run the HTTP duty."
          }
        ]
      })
    }).then((response) => response.json());
    assert.equal(duties.duties.length, 1);
    const dutyRun = await fetch(`${base}/duties/run`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        id: "http-duty",
        force: true
      })
    }).then((response) => response.json());
    assert.equal(dutyRun.ok, true);
    assert.equal(dutyRun.results[0].status, "dry-run");

    const wizards = await fetch(`${base}/connectors/wizards`).then((response) => response.json());
    assert.equal(wizards.wizards.length, 3);
    assert.equal(wizards.wizards.find((wizard) => wizard.connectorId === "discord").nextAction.id, "set-environment");

    const discordWizard = await fetch(`${base}/connectors/discord/wizard`).then((response) => response.json());
    assert.equal(discordWizard.id, "connector-wizard-discord");
    assert.equal(discordWizard.fields.find((field) => field.id === "botTokenEnv").value, "DISCORD_BOT_TOKEN");
    assert.equal(discordWizard.steps.find((step) => step.id === "settings").command[0], "wakefield");

    const status = await fetch(`${base}/setup/status`).then((response) => response.json());
    assert.equal(status.phase, "ready");
    assert.equal(status.service.intervalMinutes, 6);
    assert.equal(status.contacts.total, 1);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});

test("HTTP intake requires a token outside loopback", async () => {
  await assert.rejects(
    () => startHttpIntakeServer({
      host: "0.0.0.0",
      port: 0,
      logger: null
    }),
    /requires a bearer token/
  );
});

test("external inbox dispatch can dry-run or deliver pending messages through Codex IPC", async () => {
  const home = await tempHome();
  const profile = await initAgent({
    name: "Dispatcher",
    soul: "",
    threadId: "thread-dispatch",
    cwd: "/tmp/dispatcher",
    home
  });
  const ingested = await ingestExternalMessage(profile, {
    connector: "imessage",
    conversationId: "chat-1",
    sender: "+15551234567",
    messageId: "sms-1",
    text: "Are you around?"
  });

  const dryRun = await dispatchExternalMessage(profile, {
    id: ingested.message.id,
    mode: "dry-run"
  });
  assert.equal(dryRun.ok, true);
  assert.equal(dryRun.status, "dry-run");
  assert.match(dryRun.route.prompt, /External iMessage message/);
  assert.equal((await listExternalMessages(profile)).length, 1);

  const calls = [];
  const delivered = await dispatchExternalMessage(profile, {
    id: ingested.message.id,
    mode: "ipc",
    client: {
      async steerThreadFollowerTurn(params) {
        calls.push(["steer", params.conversationId, params.cwd, params.text]);
        throw Object.assign(new Error("no active turn"), { code: "inactive-turn" });
      },
      async startThreadFollowerTurn(params) {
        calls.push(["start", params.conversationId, params.cwd, params.text]);
        return { turnId: "turn-123" };
      }
    },
    now: new Date("2026-06-14T16:30:00Z")
  });

  assert.equal(delivered.ok, true);
  assert.equal(delivered.status, "delivered");
  assert.equal(delivered.dispatch.action, "start");
  assert.equal(delivered.dispatch.turnId, "turn-123");
  assert.equal(calls[0][0], "steer");
  assert.equal(calls[1][0], "start");
  assert.equal(calls[1][1], "thread-dispatch");
  assert.equal(calls[1][2], "/tmp/dispatcher");
  assert.match(calls[1][3], /Are you around/);
  assert.deepEqual(await listExternalMessages(profile), []);
  assert.equal((await listExternalMessages(profile, { status: "delivered" }))[0].statusReason, "Codex start");
});

test("Codex IPC routing deep-link wakes missing follower clients", async () => {
  const calls = [];
  const wakes = [];
  const client = {
    async steerThreadFollowerTurn(params) {
      calls.push(["steer", params]);
      if (calls.length === 1) {
        throw Object.assign(new Error("no-client-found"), {
          code: "codex-ipc-request-failed",
          method: "thread-follower-steer-turn"
        });
      }
      throw Object.assign(new Error("no active turn"), { code: "inactive-turn" });
    },
    async startThreadFollowerTurn(params) {
      calls.push(["start", params]);
      return { turnId: "turn-after-wake" };
    },
    disconnect() {}
  };

  const result = await routePromptToCodex({
    threadId: "thread-wake",
    cwd: "/tmp/wakefield",
    prompt: "hello",
    client,
    deepLinkWake: { waitMs: 200, pollMs: 1, reopenMs: 0 },
    wakeThread: async (wake) => {
      wakes.push(wake);
    },
    logger: null
  });

  assert.equal(result.action, "start");
  assert.equal(result.turnId, "turn-after-wake");
  assert.equal(wakes.length, 1);
  assert.equal(wakes[0].url, "codex://threads/thread-wake");
  assert.deepEqual(calls.map((call) => call[0]), ["steer", "steer", "start"]);
});

test("external inbox is explicit when no Codex thread is selected", async () => {
  const home = await tempHome();
  const profile = await initAgent({ name: "Unthreaded", soul: "", home });

  const result = await ingestExternalMessage(profile, {
    connector: "email",
    sender: "person@example.com",
    subject: "Question",
    text: "What should I do next?"
  });

  assert.equal(result.route.status, "needs-thread");
  assert.match(result.route.reason, /Select a persistent Codex thread/);
  assert.equal(result.route.threadId, null);
  assert.match(result.route.prompt, /External Email message/);

  const dispatch = await dispatchExternalMessage(profile, {
    id: result.message.id,
    mode: "ipc"
  });
  assert.equal(dispatch.ok, false);
  assert.equal(dispatch.status, "needs-thread");
});

test("manifest describes package, core features, setup commands, and connector slots", async () => {
  const manifest = await wakefieldManifest({ connectors: CONNECTOR_SETUP_SLOTS });

  assert.equal(manifest.schemaVersion, 1);
  assert.equal(manifest.app.name, "Wakefield");
  assert.equal(manifest.app.packageName, "wakefield");
  assert.equal(manifest.runtime.binary, "wakefield");
  assert.deepEqual(
    manifest.core.filter((feature) => feature.status === "available").map((feature) => feature.id),
    ["agent-profile", "soul", "thread-selection", "agent-packs", "codex-hooks", "contacts", "local-memory", "scoped-memory-notes", "active-context-matters", "scoped-memory-recall", "memory-mcp-tools", "local-dreamer", "external-message-ingest", "discord-gateway", "email-rfc822-ingest", "email-imap-poll", "imessage-chatdb-poll", "http-intake", "http-setup-api", "external-message-dispatch", "service-tick", "scheduled-duties", "service-env-file", "service-external-dispatch", "macos-launch-agent", "setup-actions", "menu-snapshot", "clone-self-test", "clone-verify", "one-command-setup", "connector-config", "connector-wizards", "managed-connector-packages", "managed-connector-wizards", "managed-connector-config-init", "managed-connector-mcp-install", "managed-connector-launch-agents"]
  );
  assert.deepEqual(
    manifest.connectors.map((connector) => connector.setupActionId),
    CONNECTOR_SETUP_SLOTS.map((connector) => connector.setupActionId)
  );
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield verify --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield self-test --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield setup actions --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield setup run --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield pack inspect --file $packFile --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield menu snapshot --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield contacts list --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield duties list --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield wakeups list --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield connectors status --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield connectors wizards --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield connectors wizard discord --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield managed-connectors status --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield managed-connectors wizards --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield mcp memory status --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield mcp memory install --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield managed-connectors test $connectorId --kind status --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield managed-connectors launch-agent status $connectorId --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield discord listen"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield email ingest --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield email poll --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield imessage poll --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield inbox pending --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield inbox dispatch --mode dry-run --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield memory notes list --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield memory matters list --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield memory recall --query $query --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield memory capture --dry-run --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield dream --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield service configure --env-file $envFile --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield service run-once --json"));
  assert.ok(manifest.setup.jsonCommands.some((command) => command.join(" ") === "wakefield service launch-agent status --json"));
  assert.equal(
    manifest.connectors.find((connector) => connector.id === "email").transports.find((transport) => transport.id === "rfc822").status,
    "available"
  );
  assert.equal(
    manifest.connectors.find((connector) => connector.id === "imessage").transports.find((transport) => transport.id === "chatdb").status,
    "available"
  );
});

test("verifyWakefield is a clone-install confidence gate", async () => {
  const result = await verifyWakefield({
    now: new Date("2026-06-14T19:00:00Z")
  });

  assert.equal(result.ok, true);
  assert.equal(result.manifest.app.packageName, "wakefield");
  assert.equal(result.manifest.runtime.binary, "wakefield");
  assert.equal(result.checks.find((check) => check.label === "required features").ok, true);
  assert.equal(result.checks.find((check) => check.label === "setup json commands").ok, true);
  assert.equal(result.checks.find((check) => check.label === "self-test").ok, true);
  assert.equal(result.selfTest.ok, true);
  assert.equal(result.selfTest.kept, false);
  assert.equal(result.selfTest.steps.find((step) => step.id === "launch-agent-load-plan").ok, true);
});

test("UserPromptSubmit hook records prompt and injects relevant memory", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Morrow", soul: "", home });
    await upsertNote(profile, {
      id: "weekly-planning-style",
      title: "Weekly planning style",
      text: "Morrow likes a compact weekly planning style.",
      scope: {
        topics: ["weekly planning"]
      }
    });

    const output = await handleHookInput({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: profile.cwd,
      prompt: "Can you make a weekly plan?"
    });

    assert.equal(output.hookSpecificOutput.hookEventName, "UserPromptSubmit");
    assert.match(output.hookSpecificOutput.additionalContext, /Wakefield scoped memory relevant to this turn/);
    assert.match(output.hookSpecificOutput.additionalContext, /weekly planning/);
    assert.doesNotMatch(output.hookSpecificOutput.additionalContext, /Wakefield soul/);

    const inbox = await fs.readFile(profile.memory.inboxPath, "utf8");
    assert.match(inbox, /weekly plan/);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("UserPromptSubmit hook suppresses repeated memory until compaction", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Morrow", soul: "", home });
    await upsertNote(profile, {
      id: "weekly-planning-style",
      title: "Weekly planning style",
      text: "Morrow likes a compact weekly planning style.",
      scope: {
        topics: ["weekly planning"]
      }
    });

    const first = await handleHookInput({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: profile.cwd,
      prompt: "Can you make a weekly plan?"
    });
    const second = await handleHookInput({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-2",
      cwd: profile.cwd,
      prompt: "Can you make another weekly plan?"
    });

    assert.match(first.hookSpecificOutput.additionalContext, /weekly planning/);
    assert.equal(second, null);

    await handleHookInput({
      hook_event_name: "PreCompact",
      session_id: "session-1",
      turn_id: "turn-compact",
      cwd: profile.cwd,
      trigger: "manual"
    });
    await handleHookInput({
      hook_event_name: "PostCompact",
      session_id: "session-1",
      turn_id: "turn-compact",
      cwd: profile.cwd,
      trigger: "manual"
    });

    const afterCompact = await handleHookInput({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-3",
      cwd: profile.cwd,
      prompt: "Can you make another weekly plan?"
    });
    assert.match(afterCompact.hookSpecificOutput.additionalContext, /weekly planning/);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("SessionStart and compaction hooks record lifecycle edges without injecting context", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Morrow", soul: "A careful planning companion.", home });

    const sessionStart = await handleHookInput({
      hook_event_name: "SessionStart",
      session_id: "session-1",
      cwd: profile.cwd,
      source: "compact"
    });
    const preCompact = await handleHookInput({
      hook_event_name: "PreCompact",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: profile.cwd,
      trigger: "manual"
    });
    const postCompact = await handleHookInput({
      hook_event_name: "PostCompact",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: profile.cwd,
      trigger: "manual"
    });

    assert.equal(sessionStart, null);
    assert.deepEqual(preCompact, {});
    assert.deepEqual(postCompact, {});
    assert.match(await fs.readFile(profile.memory.journalPath, "utf8"), /session-start/);
    const dreams = await fs.readFile(profile.memory.dreamsPath, "utf8");
    assert.match(dreams, /pre-compact/);
    assert.match(dreams, /post-compact/);
    assert.doesNotMatch(dreams, /Wakefield soul/);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("hook matching follows the selected Codex session id outside the agent cwd", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({
      name: "Thread Soul",
      soul: "",
      threadId: "session-abc",
      home
    });

    const output = await handleHookInput({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-abc",
      turn_id: "turn-1",
      cwd: "/tmp/a-different-project",
      prompt: "Please remember this selected thread."
    });

    assert.equal(output, null);
    const inbox = await fs.readFile(profile.memory.inboxPath, "utf8");
    assert.match(inbox, /selected thread/);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("Stop hook queues a dream without continuing the turn", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Stillwake", soul: "", home });
    const output = await handleHookInput({
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: profile.cwd,
      last_assistant_message: "I finished the requested setup."
    });

    assert.deepEqual(output, {});
    const dreams = await fs.readFile(profile.memory.dreamsPath, "utf8");
    assert.match(dreams, /dream-queued/);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("dreamer processes queued hook events into durable state once", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Dreamwell", soul: "", threadId: "session-1", home });

    await handleHookInput({
      hook_event_name: "PostToolUse",
      session_id: "session-1",
      turn_id: "turn-42",
      cwd: profile.cwd,
      tool_name: "functions.exec_command",
      tool_input: {
        command: "apply schema migration"
      }
    });
    await handleHookInput({
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-42",
      cwd: profile.cwd,
      last_assistant_message: "Updated the schema migration setup."
    });

    const first = await processDreams(profile);
    assert.equal(first.processed, 1);
    assert.match(first.summaries[0].summary, /schema migration/);

    const state = JSON.parse(await fs.readFile(profile.memory.statePath, "utf8"));
    assert.equal(state.recentTurns.length, 1);
    assert.match(state.recentTurns[0].summary, /Updated the schema migration setup/);
    assert.match(state.recentTurns[0].changes[0], /apply schema migration/);

    const context = await memoryContext(profile, "schema migration");
    assert.match(context, /schema migration/);

    const second = await processDreams(profile);
    assert.equal(second.processed, 0);
    assert.equal(JSON.parse(await fs.readFile(profile.memory.statePath, "utf8")).recentTurns.length, 1);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("dreamer captures passive operational incidents into active context", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Incident Memory", soul: "", threadId: "session-1", home });
    let providerPayload = null;

    await handleHookInput({
      hook_event_name: "UserPromptSubmit",
      session_id: "session-1",
      turn_id: "turn-photon",
      cwd: profile.cwd,
      prompt: "Small context: the Photon/Spectrum iMessage path still seems down, so Discord is probably the safe channel for now."
    });
    await handleHookInput({
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-photon",
      cwd: profile.cwd,
      last_assistant_message: "Got it. I will treat Discord as the reliable path while Photon/Spectrum looks unhealthy."
    });

    const result = await processDreams(profile, {
      captureProvider: async (payload) => {
        providerPayload = payload;
        return {
          deltas: [{
            action: "create_active_context",
            id: "incident-photon-spectrum-imessage",
            title: "Photon/Spectrum iMessage delivery degraded",
            text: null,
            summary: "Photon/Spectrum iMessage delivery appears unreliable; Discord is currently the reliable external channel.",
            status: "active",
            statusReason: null,
            scope: {
              people: [],
              rooms: [],
              channels: ["imessage", "discord"],
              tasks: [],
              topics: ["photon", "spectrum", "connector-outage"],
              cases: [],
              connectors: ["imessage"],
              senders: [],
              conversations: []
            },
            nextAction: "Retest iMessage receive/send before relying on it.",
            notifyWhen: null,
            tags: ["incident", "connector"],
            sources: [],
            confidence: "high",
            rationale: "The turn states an unresolved connector reliability issue."
          }]
        };
      }
    });

    assert.equal(result.processed, 1);
    assert.match(providerPayload.turn.summary, /Photon\/Spectrum iMessage path still seems down/);
    assert.equal(result.capture.applied[0].id, "incident-photon-spectrum-imessage");

    const matters = await loadMatters(profile);
    const incident = matters.matters.find((matter) => matter.id === "incident-photon-spectrum-imessage");
    assert.equal(incident.status, "active");
    assert.match(incident.summary, /Discord is currently the reliable external channel/);

    const recalled = await recallContext(profile, {
      query: "photon spectrum imessage",
      limitMatters: 1
    });
    assert.equal(recalled.matters[0].id, "incident-photon-spectrum-imessage");

    const second = await processDreams(profile, {
      captureProvider: async () => {
        throw new Error("capture should not run twice for the same summary");
      }
    });
    assert.equal(second.capture.reviewed, 0);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("dreamer folds compact start and finish into one durable memory", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({ name: "Compact", soul: "", threadId: "session-1", home });
    await handleHookInput({
      hook_event_name: "PreCompact",
      session_id: "session-1",
      turn_id: "turn-compact",
      cwd: profile.cwd,
      trigger: "manual"
    });
    await handleHookInput({
      hook_event_name: "PostCompact",
      session_id: "session-1",
      turn_id: "turn-compact",
      cwd: profile.cwd,
      trigger: "manual"
    });

    const first = await processDreams(profile);
    assert.equal(first.processed, 1);
    assert.equal(first.pending, 0);
    assert.match(first.summaries[0].summary, /Manual compaction completed/);
    assert.equal(first.summaries[0].sourceDreamIds.length, 2);

    const state = JSON.parse(await fs.readFile(profile.memory.statePath, "utf8"));
    assert.equal(state.recentTurns.length, 1);
    assert.match(state.recentTurns[0].summary, /Manual compaction completed/);
    assert.equal(state.dreamer.processedIds.length, 2);

    const second = await processDreams(profile);
    assert.equal(second.processed, 0);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("duties can be configured and run through dry-run routing", async () => {
  const home = await tempHome();
  const profile = await initAgent({
    name: "Duty Runner",
    soul: "",
    threadId: "thread-duty",
    cwd: "/tmp/duty-runner",
    home
  });

  await configureDuty("morning-check", {
    home,
    label: "Morning Check",
    prompt: "Check overnight work and report blockers.",
    intervalMinutes: 60,
    dispatchMode: "dry-run",
    requiredTools: ["calendar"]
  });
  await upsertMatter(profile, {
    id: "morning-check-context",
    title: "Morning check context",
    summary: "Review the overnight blocker queue before summarizing.",
    scope: {
      tasks: ["morning-check"]
    }
  });
  await upsertMatter(profile, {
    id: "joe-package-chat",
    title: "Joe package chat",
    summary: "Joe asked about a package in a human conversation.",
    scope: {
      people: ["joe"],
      topics: ["package"]
    }
  });

  const before = await dutyStatuses({
    home,
    now: new Date("2026-06-14T09:00:00Z")
  });
  assert.equal(before.wakeups[0].due, true);

  const run = await runDueDuties(profile, {
    home,
    now: new Date("2026-06-14T09:00:00Z")
  });
  assert.equal(run.ok, true);
  assert.equal(run.attempted, 1);
  assert.equal(run.results[0].status, "dry-run");
  assert.match(run.results[0].route.prompt, /Scheduled Wakefield wakeup: Morning Check/);
  assert.match(run.results[0].route.prompt, /Use \$wakefield-scheduled-wakeup\./);
  assert.match(run.results[0].route.prompt, /Required tools: calendar/);
  assert.match(run.results[0].route.prompt, /morning-check-context/);
  assert.doesNotMatch(run.results[0].route.prompt, /joe-package-chat/);

  const after = await dutyStatuses({
    home,
    now: new Date("2026-06-14T09:01:00Z")
  });
  assert.equal(after.wakeups[0].due, false);

  const service = await serviceStatus({
    home,
    now: new Date("2026-06-14T09:01:00Z")
  });
  assert.equal(service.duties.total, 1);
  assert.equal(service.duties.enabled, 1);
});

test("wakeups bundle multiple duties into one scheduled turn", async () => {
  const home = await tempHome();
  const profile = await initAgent({
    name: "Wakeup Runner",
    soul: "",
    threadId: "thread-wakeup",
    cwd: "/tmp/wakeup-runner",
    home
  });

  await configureDuty("inventory", {
    home,
    label: "Inventory",
    skills: ["inventory-skill"],
    requiredTools: ["inventory-api"]
  });
  await configureDuty("shipping", {
    home,
    label: "Shipping",
    skills: ["shipping-skill"],
    requiredTools: ["shipping-api"]
  });
  await configureDuty("support", {
    home,
    label: "Support",
    skills: ["support-skill"]
  });
  await configureWakeup("morning-ops", {
    home,
    label: "Morning Ops",
    wakeTimes: ["04:00"],
    duties: ["inventory", "shipping", "support"],
    dispatchMode: "dry-run"
  });

  const runAt = new Date(2026, 5, 14, 4, 15, 0);
  const before = await dutyStatuses({ home, now: runAt });
  assert.equal(before.wakeups[0].due, true);
  assert.deepEqual(before.wakeups[0].dutyIds, ["inventory", "shipping", "support"]);
  assert.deepEqual(before.wakeups[0].skills, ["inventory-skill", "shipping-skill", "support-skill"]);

  const run = await runDueDuties(profile, {
    home,
    now: runAt
  });
  assert.equal(run.attempted, 1);
  assert.match(run.results[0].route.prompt, /Wakeup ID: morning-ops/);
  assert.match(run.results[0].route.prompt, /Duties: inventory, shipping, support/);
  assert.match(run.results[0].route.prompt, /Use \$wakefield-scheduled-wakeup\./);
  assert.match(run.results[0].route.prompt, /- inventory: \$inventory-skill/);
  assert.match(run.results[0].route.prompt, /- shipping: \$shipping-skill/);
  assert.match(run.results[0].route.prompt, /- support: \$support-skill/);

  const after = await dutyStatuses({ home, now: new Date(2026, 5, 14, 4, 16, 0) });
  assert.equal(after.wakeups[0].due, false);
});

test("duties configure CLI preserves required tools when changing dispatch mode", async () => {
  const home = await tempHome();
  await configureDuty("morning-check", {
    home,
    label: "Morning Check",
    prompt: "Check overnight work and report blockers.",
    intervalMinutes: 60,
    dispatchMode: "dry-run",
    requiredTools: ["calendar", "email"]
  });

  const cliPath = new URL("../src/cli.mjs", import.meta.url).pathname;
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "duties",
    "configure",
    "morning-check",
    "--dispatch-mode",
    "ipc",
    "--json"
  ], {
    env: {
      ...process.env,
      WAKEFIELD_HOME: home
    }
  });

  const result = JSON.parse(stdout);
  assert.deepEqual(result.duties[0].requiredTools, ["calendar", "email"]);
  assert.equal(result.duties[0].dispatchMode, "ipc");
});

test("duties configure CLI can attach skill-backed duty prompts", async () => {
  const home = await tempHome();
  await configureDuty("morning-check", {
    home,
    label: "Morning Check",
    intervalMinutes: 60,
    dispatchMode: "dry-run"
  });

  const cliPath = new URL("../src/cli.mjs", import.meta.url).pathname;
  const { stdout } = await execFileAsync(process.execPath, [
    cliPath,
    "duties",
    "configure",
    "morning-check",
    "--skill",
    "first-duty",
    "--skill",
    "$second-duty",
    "--json"
  ], {
    env: {
      ...process.env,
      WAKEFIELD_HOME: home
    }
  });

  const result = JSON.parse(stdout);
  assert.deepEqual(result.duties[0].skills, ["first-duty", "second-duty"]);
  const run = await runDueDuties({
    threadId: "thread-duty",
    cwd: "/tmp/duty"
  }, {
    home,
    now: new Date("2026-06-14T09:00:00Z")
  });
  assert.match(run.results[0].route.prompt, /Duty skills: \$first-duty, \$second-duty/);
});

test("service tick can be configured and run the local dreamer once", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const before = await serviceStatus({ home });
    assert.equal(before.enabled, false);
    assert.equal(before.agent, null);
    assert.equal(before.externalDispatch.enabled, false);
    assert.equal(before.externalDispatch.pending, 0);

    const profile = await initAgent({ name: "Servicer", soul: "", threadId: "session-1", home });
    const configured = await configureService({ home, enabled: true, intervalMinutes: 7 });
    assert.equal(configured.enabled, true);
    assert.equal(configured.intervalMinutes, 7);
    assert.equal(configured.agent.id, profile.id);

    await handleHookInput({
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-service",
      cwd: profile.cwd,
      last_assistant_message: "Prepared a scheduled memory run."
    });

    const result = await runServiceOnce({ home, now: new Date("2026-06-14T12:00:00Z") });
    assert.equal(result.ok, true);
    assert.equal(result.dreamer.processed, 1);
    assert.equal(result.externalDispatch.enabled, false);
    assert.equal(result.externalDispatch.delivered, 0);
    assert.equal(result.service.lastRunAt, "2026-06-14T12:00:00.000Z");
    assert.equal(result.service.nextRunAt, "2026-06-14T12:07:00.000Z");

    const status = await setupStatus({ home, codexHomePath: await tempHome() });
    assert.equal(status.service.enabled, true);
    assert.equal(status.actions.find((action) => action.id === "enable-service").enabled, false);
    assert.equal(status.actions.find((action) => action.id === "run-service-once").enabled, true);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("service tick can dispatch pending external messages when explicitly enabled", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({
      name: "Dispatch Service",
      soul: "",
      threadId: "thread-service-dispatch",
      cwd: "/tmp/service-dispatch",
      home
    });
    await configureService({
      home,
      enabled: true,
      dispatchEnabled: true,
      dispatchMode: "ipc",
      dispatchLimit: 2
    });
    await ingestExternalMessage(profile, {
      connector: "discord",
      conversationId: "channel-1",
      sender: "Ada",
      messageId: "dispatch-1",
      text: "Please route me from the service."
    });

    const calls = [];
    const result = await runServiceOnce({
      home,
      now: new Date("2026-06-14T17:00:00Z"),
      dispatchClient: {
        async steerThreadFollowerTurn(params) {
          calls.push(["steer", params.conversationId, params.cwd, params.text]);
          throw Object.assign(new Error("no active turn"), { code: "inactive-turn" });
        },
        async startThreadFollowerTurn(params) {
          calls.push(["start", params.conversationId, params.cwd, params.text]);
          return { turnId: "turn-service-dispatch" };
        }
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.externalDispatch.enabled, true);
    assert.equal(result.externalDispatch.attempted, 1);
    assert.equal(result.externalDispatch.delivered, 1);
    assert.equal(result.externalDispatch.pending, 0);
    assert.equal(result.externalDispatch.results[0].dispatch.turnId, "turn-service-dispatch");
    assert.equal(calls[0][0], "steer");
    assert.equal(calls[1][0], "start");
    assert.match(calls[1][3], /Please route me from the service/);
    assert.deepEqual(await listExternalMessages(profile), []);
    assert.equal((await serviceStatus({ home })).externalDispatch.pending, 0);
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("service tick polls ready email connectors before dispatch", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_SERVICE_EMAIL_PASSWORD";
  process.env[envName] = "test-password";
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({
      name: "Email Service",
      soul: "",
      threadId: "thread-email-service",
      cwd: "/tmp/email-service",
      home
    });
    await configureConnector("email", {
      home,
      enabled: true,
      settings: {
        imapHost: "imap.example.com",
        username: "agent@example.com",
        passwordEnv: envName
      }
    });
    await configureService({ home, enabled: true });

    const result = await runServiceOnce({
      home,
      now: new Date("2026-06-14T18:30:00Z"),
      connectorClients: {
        email: fakeMailbox([
          { id: "service-1", raw: testEmail({ messageId: "service-1@example.com", subject: "Service poll", body: "Queue me from the scheduler." }) }
        ])
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.connectorPolls.length, 1);
    assert.equal(result.connectorPolls[0].queued, 1);
    const pending = await listExternalMessages(profile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].subject, "Service poll");
  } finally {
    delete process.env[envName];
    delete process.env.WAKEFIELD_HOME;
  }
});

test("service env file feeds connector readiness and scheduled email polling", async () => {
  const home = await tempHome();
  const envName = "WAKEFIELD_TEST_SERVICE_ENV_FILE_EMAIL_PASSWORD";
  const envFile = path.join(home, "wakefield.env");
  delete process.env[envName];
  process.env.WAKEFIELD_HOME = home;
  try {
    await fs.mkdir(home, { recursive: true });
    await fs.writeFile(envFile, `export ${envName}="env-file-password"\n# ignored comment\n`, { mode: 0o600 });
    const profile = await initAgent({
      name: "Env File Service",
      soul: "",
      threadId: "thread-env-file-service",
      cwd: "/tmp/env-file-service",
      home
    });
    await configureConnector("email", {
      home,
      enabled: true,
      settings: {
        imapHost: "imap.example.com",
        username: "agent@example.com",
        passwordEnv: envName
      }
    });

    const missing = (await connectorStatuses({ home })).find((connector) => connector.id === "email");
    assert.equal(missing.ready, false);
    assert.deepEqual(missing.missingSecrets, [envName]);

    const configured = await configureService({ home, enabled: true, envFile });
    assert.equal(configured.environment.path, envFile);
    assert.equal(configured.environment.loaded, true);
    assert.deepEqual(configured.environment.keys, [envName]);
    assert.deepEqual(configured.environment.loadedKeys, [envName]);

    const status = await setupStatus({ home, codexHomePath: await tempHome() });
    assert.equal(status.service.environment.configured, true);
    assert.equal(status.service.environment.secure, true);
    assert.equal(status.connectors.find((connector) => connector.id === "email").ready, true);
    assert.equal(status.actions.find((action) => action.id === "configure-service-env-file").enabled, false);

    const snapshot = await menuSnapshot({ home, codexHomePath: await tempHome() });
    assert.equal(snapshot.service.environment.loaded, true);

    const result = await runServiceOnce({
      home,
      now: new Date("2026-06-14T18:35:00Z"),
      connectorClients: {
        email: fakeMailbox([
          { id: "service-env-file-1", raw: testEmail({ messageId: "service-env-file-1@example.com", subject: "Env file poll", body: "Queue me from the service env file." }) }
        ])
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.environment.loaded, true);
    assert.equal(result.environment.keys.includes(envName), true);
    assert.equal(result.connectorPolls.length, 1);
    assert.equal(result.connectorPolls[0].queued, 1);
    const pending = await listExternalMessages(profile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].subject, "Env file poll");

    const plist = await launchAgentPlist({ home });
    assert.match(plist, /WAKEFIELD_ENV_FILE/);
    assert.match(plist, /wakefield\.env/);
  } finally {
    delete process.env[envName];
    delete process.env.WAKEFIELD_HOME;
  }
});

test("service tick polls ready iMessage connectors before dispatch", async () => {
  const home = await tempHome();
  const databasePath = path.join(home, "chat.db");
  await fs.writeFile(databasePath, "");
  process.env.WAKEFIELD_HOME = home;
  try {
    const profile = await initAgent({
      name: "iMessage Service",
      soul: "",
      threadId: "thread-imessage-service",
      cwd: "/tmp/imessage-service",
      home
    });
    await configureConnector("imessage", {
      home,
      enabled: true,
      settings: {
        databasePath,
        allowedSenders: "+15551234567"
      }
    });
    await configureService({ home, enabled: true });

    const result = await runServiceOnce({
      home,
      now: new Date("2026-06-14T18:45:00Z"),
      connectorClients: {
        imessageRows: [
          imessageRow({
            id: 21,
            sender: "+15551234567",
            text: "Queue me from Messages."
          })
        ]
      }
    });

    assert.equal(result.ok, true);
    assert.equal(result.connectorPolls.length, 1);
    assert.equal(result.connectorPolls[0].queued, 1);
    const pending = await listExternalMessages(profile);
    assert.equal(pending.length, 1);
    assert.equal(pending[0].connector, "imessage");
    assert.equal(pending[0].text, "Queue me from Messages.");
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

test("launch agent helpers install and remove a scheduler plist in a chosen directory", async () => {
  const home = await tempHome();
  const launchAgentsPath = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  process.env.WAKEFIELD_LAUNCH_AGENTS_DIR = launchAgentsPath;
  try {
    await initAgent({ name: "Launchy", soul: "", threadId: "session-1", home });
    await configureService({ home, enabled: true, intervalMinutes: 3 });

    const plist = await launchAgentPlist({ home });
    assert.match(plist, /<key>Label<\/key>/);
    assert.match(plist, /com\.wakefield\.service/);
    assert.match(plist, /<integer>180<\/integer>/);
    assert.match(plist, /WAKEFIELD_HOME/);

    const before = await launchAgentStatus({ home, launchAgentsPath });
    assert.equal(before.supported, true);
    assert.equal(before.installed, false);

    const installed = await installLaunchAgent({ home, launchAgentsPath });
    assert.equal(installed.dryRun, false);
    assert.equal(installed.status.installed, true);
    assert.match(await fs.readFile(installed.plistPath, "utf8"), /service<\/string>/);

    const setup = await setupStatus({ home, codexHomePath: await tempHome() });
    assert.equal(setup.actions.find((action) => action.id === "install-launch-agent").enabled, false);
    assert.equal(setup.actions.find((action) => action.id === "reload-launch-agent").enabled, process.platform === "darwin");
    assert.equal(setup.actions.find((action) => action.id === "uninstall-launch-agent").enabled, true);

    const loadPlan = await loadLaunchAgent({ home, launchAgentsPath, dryRun: true });
    assert.equal(loadPlan.dryRun, true);
    assert.deepEqual(loadPlan.commands.map((command) => command.args[0]), ["bootstrap", "enable", "kickstart"]);
    assert.equal(loadPlan.commands[0].args[2], installed.plistPath);

    const reloadPlan = await loadLaunchAgent({ home, launchAgentsPath, dryRun: true, reload: true });
    assert.deepEqual(reloadPlan.commands.map((command) => command.args[0]), ["bootout", "bootstrap", "enable", "kickstart"]);

    const unloadPlan = await unloadLaunchAgent({ home, launchAgentsPath, dryRun: true });
    assert.deepEqual(unloadPlan.commands.map((command) => command.args[0]), ["bootout"]);

    const removed = await uninstallLaunchAgent({ home, launchAgentsPath });
    assert.equal(removed.removed, true);
    assert.equal((await launchAgentStatus({ home, launchAgentsPath })).installed, false);
    assert.equal((await serviceStatus({ home })).enabled, false);
  } finally {
    delete process.env.WAKEFIELD_HOME;
    delete process.env.WAKEFIELD_LAUNCH_AGENTS_DIR;
  }
});

test("non-matching Stop hooks return a JSON no-op", async () => {
  const home = await tempHome();
  process.env.WAKEFIELD_HOME = home;
  try {
    const output = await handleHookInput({
      hook_event_name: "Stop",
      session_id: "session-1",
      turn_id: "turn-1",
      cwd: "/tmp/not-a-wakefield-agent"
    });

    assert.deepEqual(output, {});
  } finally {
    delete process.env.WAKEFIELD_HOME;
  }
});

async function tempHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wakefield-test-"));
}

function fakeMailbox(messages) {
  const byId = new Map(messages.map((message) => [message.id, message.raw]));
  return {
    marked: [],
    async listMessages({ maxResults = 10 } = {}) {
      return messages.slice(0, maxResults).map((message) => ({
        id: message.id,
        raw: message.raw
      }));
    },
    async getMessage(id) {
      return byId.get(id);
    },
    async markProcessed(id) {
      this.marked.push(id);
    }
  };
}

function testEmail({
  from = "Ada <ada@example.com>",
  messageId = "message@example.com",
  subject = "Wakefield email",
  body = "Hello from email."
} = {}) {
  return [
    `From: ${from}`,
    "To: Wakefield <wakefield@example.com>",
    `Subject: ${subject}`,
    `Message-ID: <${messageId}>`,
    "Date: Sun, 14 Jun 2026 19:00:00 -0700",
    "Content-Type: text/plain; charset=utf-8",
    "",
    body
  ].join("\r\n");
}

function discordMessage({
  id = "discord-message",
  channelId = "channel-1",
  guildId = "guild-1",
  authorId = "user-1",
  username = "Ada",
  content = "Hello from Discord.",
  bot = false
} = {}) {
  return {
    type: 0,
    id,
    channel_id: channelId,
    guild_id: guildId,
    content,
    author: {
      id: authorId,
      username,
      global_name: username,
      bot
    },
    attachments: []
  };
}

function imessageRow({
  id = 1,
  guid = `imessage-${id}`,
  text = "Hello from iMessage.",
  date = 1_000_000_000_000_000_000,
  isFromMe = false,
  sender = "+15551234567",
  service = "iMessage",
  chatId = 7,
  chatGuid = "iMessage;-;+15551234567",
  chatIdentifier = "+15551234567",
  chatName = "Ada",
  isGroup = false
} = {}) {
  return {
    id,
    guid,
    text,
    date,
    is_from_me: isFromMe ? 1 : 0,
    sender,
    service,
    chat_id: chatId,
    chat_guid: chatGuid,
    chat_identifier: chatIdentifier,
    chat_name: chatName,
    is_group: isGroup ? 1 : 0
  };
}

async function createFakeManagedConnector(root, adapterId = "discord-codex", {
  targetCwd = path.join(root, "target"),
  threadId = "thread-managed",
  withConfig = true,
  withMcp = true
} = {}) {
  const packagePath = path.join(root, "connector");
  const codexConfigPath = path.join(targetCwd, ".codex", "config.toml");
  await fs.mkdir(path.join(packagePath, "src"), { recursive: true });
  await fs.mkdir(path.join(packagePath, "scripts"), { recursive: true });
  await fs.mkdir(path.join(targetCwd, ".codex"), { recursive: true });
  await fs.writeFile(path.join(targetCwd, "AGENTS.md"), "# Fake Managed Connector Agent\n");
  const configPath = path.join(packagePath, "config.local.json");

  if (adapterId === "discord-codex") {
    await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({
      name: "@wakefield/discord-codex",
      type: "module",
      bin: {
        "discord-codex-bot": "src/discord-bot.mjs",
        "discord-codex-mcp": "src/mcp-server.mjs",
        "discord-codex-probe-follower": "src/codex-follower-probe.mjs",
        "discord-codex-send": "src/codex-send.mjs"
      }
    }));
    for (const file of ["discord-bot.mjs", "mcp-server.mjs", "codex-follower-probe.mjs", "codex-send.mjs"]) {
      await fs.writeFile(path.join(packagePath, "src", file), "export {};\n");
    }
    const tokenFile = path.join(root, "discord-token");
    await fs.writeFile(tokenFile, "fake-token\n", { mode: 0o600 });
    if (withConfig) {
      await fs.writeFile(configPath, JSON.stringify({
        bot: {
          tokenEnv: "WAKEFIELD_TEST_MANAGED_DISCORD_TOKEN",
          tokenFile
        },
        discord: {
          allowedOutboundChannelIds: ["channel-1"],
          allowedDmUserIds: ["user-1"]
        },
        targets: [
          {
            id: "self-test",
            displayName: "Self Test",
            threadId,
            cwd: targetCwd,
            allowedGuildIds: ["guild-1"],
            allowedChannelIds: ["channel-1"],
            allowedUserIds: ["user-1"]
          }
        ]
      }));
    }
    if (withMcp) {
      await fs.writeFile(codexConfigPath, [
        "[mcp_servers.discord-codex]",
        "command = \"node\"",
        `args = [\"${path.join(packagePath, "src/mcp-server.mjs")}\", \"--config\", \"${configPath}\"]`,
        "",
        "[mcp_servers.discord-codex.tools.discord_bridge_status]",
        "approval_mode = \"approve\"",
        "[mcp_servers.discord-codex.tools.discord_read_messages]",
        "approval_mode = \"approve\"",
        "[mcp_servers.discord-codex.tools.discord_read_recent_batch]",
        "approval_mode = \"approve\"",
        "[mcp_servers.discord-codex.tools.discord_send_message]",
        "approval_mode = \"approve\"",
        "[mcp_servers.discord-codex.tools.discord_send_dm]",
        "approval_mode = \"approve\"",
        ""
      ].join("\n"));
    }
  } else if (adapterId === "imessage-spectrum") {
    await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({
      name: "@wakefield/imessage-spectrum",
      type: "module",
      bin: {
        "imessage-codex-bot": "src/spectrum-bot.mjs",
        "imessage-codex-mcp": "src/mcp-server.mjs"
      }
    }));
    for (const file of ["spectrum-bot.mjs", "mcp-server.mjs", "spectrum-ipc.mjs"]) {
      await fs.writeFile(path.join(packagePath, "src", file), "export {};\n");
    }
    await fs.writeFile(path.join(packagePath, "scripts", "diagnose-spectrum-bridge.mjs"), "export {};\n");
    if (withConfig) {
      await fs.writeFile(configPath, JSON.stringify({
        imessage: {
          provider: "spectrum",
          spectrum: {
            projectIdEnv: "WAKEFIELD_TEST_PHOTON_ID",
            projectSecretEnv: "WAKEFIELD_TEST_PHOTON_SECRET",
            ipcSocketPath: path.join(root, "spectrum.sock"),
            statusPath: path.join(root, "spectrum-status.json")
          },
          allowedOutboundAddresses: ["+15551234567"],
          allowedOutboundSpaceIds: ["space-1"]
        },
        identity: {
          contactsPath: ""
        },
        targets: [
          {
            id: "self-test",
            displayName: "Self Test",
            threadId,
            cwd: targetCwd,
            allowedAddresses: ["+15551234567"],
            allowedSpaceIds: ["space-1"]
          }
        ]
      }));
    }
    if (withMcp) {
      await fs.writeFile(codexConfigPath, [
        "[mcp_servers.imessage-codex]",
        "command = \"node\"",
        `args = [\"${path.join(packagePath, "src/mcp-server.mjs")}\", \"--config\", \"${configPath}\"]`,
        "",
        "[mcp_servers.imessage-codex.tools.imessage_bridge_status]",
        "approval_mode = \"approve\"",
        "[mcp_servers.imessage-codex.tools.imessage_read_recent_batch]",
        "approval_mode = \"approve\"",
        "[mcp_servers.imessage-codex.tools.imessage_lookup_message]",
        "approval_mode = \"approve\"",
        "[mcp_servers.imessage-codex.tools.imessage_send_message]",
        "approval_mode = \"approve\"",
        "[mcp_servers.imessage-codex.tools.imessage_send_reaction]",
        "approval_mode = \"approve\"",
        "[mcp_servers.imessage-codex.tools.imessage_start_typing]",
        "approval_mode = \"approve\"",
        "[mcp_servers.imessage-codex.tools.imessage_stop_typing]",
        "approval_mode = \"approve\"",
        ""
      ].join("\n"));
    }
  } else {
    throw new Error(`Unknown fake managed connector adapter: ${adapterId}`);
  }

  return {
    packagePath,
    configPath,
    codexConfigPath,
    targetCwd
  };
}

function fakeMcpServer() {
  const tools = new Map();
  return {
    tools,
    registerTool(name, config, handler) {
      tools.set(name, { config, handler });
    }
  };
}

async function callMcpTool(server, name, input = {}) {
  const tool = server.tools.get(name);
  assert.ok(tool, `missing MCP tool ${name}`);
  const result = await tool.handler(input);
  assert.equal(result.content[0].type, "text");
  return JSON.parse(result.content[0].text);
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

async function writeCodexSession(codexHomePath, {
  threadId,
  timestamp,
  cwd
}) {
  const date = timestamp.slice(0, 10).split("-");
  const sessions = path.join(codexHomePath, "sessions", date[0], date[1], date[2]);
  await fs.mkdir(sessions, { recursive: true });
  const file = path.join(sessions, `rollout-${timestamp.replaceAll(":", "-")}-${threadId}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { cwd, timestamp } })}\n`);
  await fs.utimes(file, new Date(timestamp), new Date(timestamp));
  return file;
}

async function fileExists(file) {
  try {
    await fs.access(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}
