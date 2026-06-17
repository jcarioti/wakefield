#!/usr/bin/env node
import fs from "node:fs/promises";
import { createInterface } from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { formatAgentPackInspection, formatAgentPackInstall, inspectAgentPack, installAgentPack } from "./agent-packs.mjs";
import { listRecentThreads } from "./codex-sessions.mjs";
import { asArray, configureConnector, connectorStatuses, connectorWizard, connectorWizards, CONNECTOR_SETUP_SLOTS, formatConnectorStatuses, formatConnectorWizard, parseSettings } from "./connectors.mjs";
import { formatContactResolution, formatContacts, importContactsFile, loadContacts, resolveContact } from "./contacts.mjs";
import { archiveMatter, contextMemory, forgetMemoryItem, formatContextMemory, formatMatters, formatNotes, loadMatters, loadNotes, matterFromCli, noteFromCli, recallContext, scopeFromOptions, upsertMatter, upsertNote } from "./context-memory.mjs";
import { startDiscordGateway } from "./discord-gateway.mjs";
import { doctor, formatDoctor } from "./doctor.mjs";
import { configureDuty, configureWakeup, dutyStatuses, formatDutyRun, formatDutyStatuses, importDuties, runDueDuties } from "./duties.mjs";
import { formatEmailPoll, pollEmailImap } from "./email-imap.mjs";
import { formatEmailIngest, ingestEmailRfc822, readEmailInput } from "./email-rfc822.mjs";
import { acknowledgeExternalMessage, formatExternalIngest, formatExternalMessages, ingestExternalMessage, listExternalMessages } from "./external-messages.mjs";
import { hookConfig, runHookFromStdin } from "./hooks.mjs";
import { wakefieldHookCommand } from "./hook-manager.mjs";
import { httpIntakeUrl, startHttpIntakeServer } from "./http-intake.mjs";
import { dispatchExternalMessage, formatDispatchResult } from "./inbox-dispatch.mjs";
import { formatImessagePoll, pollImessageChatDb } from "./imessage-chatdb.mjs";
import { installWakefield } from "./install.mjs";
import { formatManifest, wakefieldManifest } from "./manifest.mjs";
import { configureManagedConnector, formatManagedConnectorConfigInit, formatManagedConnectorMcpInstall, formatManagedConnectorStatuses, formatManagedConnectorTest, formatManagedConnectorWizard, formatManagedLaunchAgentResult, formatManagedLaunchAgentStatus, importManagedConnectors, initializeManagedConnectorConfig, installManagedConnectorMcp, managedConnectorLaunchAgentPlist, managedConnectorLaunchAgentStatus, managedConnectorStatus, managedConnectorStatuses, managedConnectorWizard, managedConnectorWizards, printManagedConnectorMcp, runManagedConnectorProcess, testManagedConnector, installManagedConnectorLaunchAgent, loadManagedConnectorLaunchAgent, unloadManagedConnectorLaunchAgent, uninstallManagedConnectorLaunchAgent } from "./managed-connectors.mjs";
import { formatMemoryCaptureResult, processMemoryCaptures } from "./memory-capture.mjs";
import { formatMemoryMcpInstall, formatMemoryMcpStatus, installMemoryMcp, memoryMcpStatus, printMemoryMcp } from "./memory-mcp.mjs";
import { formatMenuSnapshot, menuSnapshot } from "./menu-snapshot.mjs";
import { compact, formatDreamResult, memoryContext, processDreams, recordMemory } from "./memory.mjs";
import { appHome } from "./paths.mjs";
import { ensureAgentMemory, initAgent, loadAgent, selectThread } from "./profile.mjs";
import { configureService, formatLaunchAgentResult, formatLaunchAgentStatus, formatServiceRun, formatServiceStatus, installLaunchAgent, launchAgentPlist, launchAgentStatus, loadLaunchAgent, runServiceOnce, serviceStatus, uninstallLaunchAgent, unloadLaunchAgent } from "./service.mjs";
import { formatSelfTest, runSelfTest } from "./self-test.mjs";
import { formatActions, formatConnectors, formatNextSteps, formatSetupStatus, setupStatus } from "./setup.mjs";
import { formatSetupRun, runSetup } from "./setup-runner.mjs";
import { formatVerification, verifyWakefield } from "./verify.mjs";

async function main(argv = process.argv.slice(2)) {
  const [command, ...rest] = argv;

  if (!command || command === "-h" || command === "--help") {
    console.log(usage());
    return;
  }

  if (command === "init") {
    const options = parseOptions(rest);
    const name = options.name || await ask("Agent name");
    const soul = options.soul || await ask("Soul, in one sentence", { fallback: "" });
    const profile = await initAgent({
      name,
      soul,
      threadId: options.threadId || null,
      cwd: options.cwd || null,
      overwrite: Boolean(options.overwrite)
    });
    console.log(`Created ${profile.name} at ${profile.cwd}`);
    console.log(`Wakefield home: ${appHome()}`);
    return;
  }

  if (command === "doctor") {
    const options = parseOptions(rest);
    const result = await doctor();
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDoctor(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "manifest") {
    const options = parseOptions(rest);
    const agent = await loadAgent();
    const manifest = await wakefieldManifest({
      connectors: CONNECTOR_SETUP_SLOTS,
      managedConnectors: await managedConnectorStatuses({ agent })
    });
    console.log(options.json ? JSON.stringify(manifest, null, 2) : formatManifest(manifest));
    return;
  }

  if (command === "self-test") {
    const options = parseOptions(rest);
    const result = await runSelfTest({
      keep: Boolean(options.keep)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSelfTest(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "verify") {
    const options = parseOptions(rest);
    const result = await verifyWakefield({
      keep: Boolean(options.keep)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatVerification(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "install") {
    const options = parseOptions(rest);
    const hasAgent = await loadAgent();
    const name = options.name || (hasAgent ? null : await ask("Agent name", { fallback: "Wakefield" }));
    const soul = options.soul || (hasAgent ? "" : await ask("Soul, in one sentence", { fallback: "" }));
    const result = await installWakefield({
      name: name || "Wakefield",
      soul,
      threadId: options.latestThread ? await latestThreadId() : options.threadId || null,
      cwd: options.cwd || null,
      overwriteAgent: Boolean(options.overwriteAgent),
      skipHooks: Boolean(options.skipHooks)
    });
    console.log(`${result.createdAgent ? "Created" : "Using"} agent: ${result.profile.name}`);
    if (result.hookResult) {
      console.log(`Codex hooks: ${result.hookResult.changed ? "installed" : "already installed"} at ${result.hookResult.hooksPath}`);
      console.log("Open Codex and run /hooks if it asks you to review and trust the Wakefield hook.");
    }
    if (result.skillResult) {
      const changed = result.skillResult.installed.filter((skill) => skill.changed).length;
      console.log(`Wakefield base skills: ${changed > 0 ? "installed" : "already installed"} (${result.skillResult.installed.length}) at ${result.skillResult.skillsRoot}`);
    }
    console.log("");
    console.log(formatDoctor(result.doctor));
    process.exitCode = result.doctor.ok ? 0 : 1;
    return;
  }

  if (command === "select-thread") {
    const options = parseOptions(rest);
    const profile = await selectThread({
      threadId: options.latest ? await latestThreadId() : options.threadId || options.id,
      cwd: options.cwd || null
    });
    console.log(`Selected Codex thread for ${profile.name}: ${profile.threadId}`);
    console.log(`Codex cwd: ${profile.cwd}`);
    return;
  }

  if (command === "threads" && (rest[0] === "list" || !rest[0])) {
    const options = parseOptions(rest[0] === "list" ? rest.slice(1) : rest);
    const threads = await listRecentThreads({ limit: Number(options.limit || 10) });
    if (options.json) {
      console.log(JSON.stringify({ threads }, null, 2));
      return;
    }
    if (threads.length === 0) {
      console.log("No local Codex thread transcripts found.");
      return;
    }
    for (const thread of threads) {
      const cwd = thread.cwd ? ` ${thread.cwd}` : "";
      console.log(`${thread.threadId}  ${thread.updatedAt}${cwd}`);
    }
    return;
  }

  if (command === "setup" && (rest[0] === "status" || !rest[0])) {
    const options = parseOptions(rest[0] === "status" ? rest.slice(1) : rest);
    const status = await setupStatus({ threadLimit: Number(options.limit || 5) });
    console.log(options.json ? JSON.stringify(status, null, 2) : formatSetupStatus(status));
    return;
  }

  if (command === "setup" && rest[0] === "next") {
    const options = parseOptions(rest.slice(1));
    const status = await setupStatus({ threadLimit: Number(options.limit || 5) });
    console.log(options.json ? JSON.stringify({ nextSteps: status.nextSteps }, null, 2) : formatNextSteps(status));
    return;
  }

  if (command === "setup" && rest[0] === "actions") {
    const options = parseOptions(rest.slice(1));
    const status = await setupStatus({ threadLimit: Number(options.limit || 5) });
    console.log(options.json ? JSON.stringify({ actions: status.actions }, null, 2) : formatActions(status.actions));
    return;
  }

  if (command === "setup" && rest[0] === "run") {
    const options = parseOptions(rest.slice(1));
    const hasAgent = await loadAgent();
    const nonInteractive = Boolean(options.json || options.yes);
    const name = options.name || (hasAgent || nonInteractive ? "Wakefield" : await ask("Agent name", { fallback: "Wakefield" }));
    const soul = options.soul || (hasAgent || nonInteractive ? "" : await ask("Soul, in one sentence", { fallback: "" }));
    const result = await runSetup({
      name,
      soul,
      threadId: options.threadId || null,
      latestThread: Boolean(options.latestThread || options.latest),
      cwd: options.cwd || null,
      skipHooks: Boolean(options.skipHooks),
      enableService: Boolean(options.enableService),
      intervalMinutes: options.intervalMinutes || options.interval,
      enableDispatch: Boolean(options.enableDispatch),
      dispatchMode: options.dispatchMode || null,
      dispatchLimit: options.dispatchLimit || null,
      envFile: options.envFile || null,
      installScheduler: Boolean(options.installLaunchAgent || options.installScheduler),
      loadScheduler: Boolean(options.loadLaunchAgent || options.loadScheduler || options.reloadLaunchAgent || options.reloadScheduler),
      reloadScheduler: Boolean(options.reloadLaunchAgent || options.reloadScheduler)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatSetupRun(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "pack" && (rest[0] === "inspect" || rest[0] === "status")) {
    const options = parseOptions(rest.slice(1));
    const packFile = options.file || options.pack || rest.find((item, index) => index > 0 && !item.startsWith("--"));
    if (!packFile) throw new Error("pack inspect needs --file PATH.");
    const result = await inspectAgentPack(packFile);
    console.log(options.json ? JSON.stringify(result, null, 2) : formatAgentPackInspection(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "pack" && rest[0] === "install") {
    const options = parseOptions(rest.slice(1));
    const packFile = options.file || options.pack || rest.find((item, index) => index > 0 && !item.startsWith("--"));
    if (!packFile) throw new Error("pack install needs --file PATH.");
    const result = await installAgentPack(packFile, {
      threadId: options.threadId || null,
      latestThread: Boolean(options.latestThread || options.latest),
      overwriteAgent: Boolean(options.overwriteAgent),
      skipHooks: Boolean(options.skipHooks),
      enableService: Boolean(options.enableService),
      dryRun: Boolean(options.dryRun)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatAgentPackInstall(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "menu" && (rest[0] === "snapshot" || !rest[0])) {
    const options = parseOptions(rest[0] === "snapshot" ? rest.slice(1) : rest);
    const snapshot = await menuSnapshot({
      threadLimit: Number(options.threadLimit || options.limit || 5),
      messageLimit: Number(options.messageLimit || 5)
    });
    console.log(options.json ? JSON.stringify(snapshot, null, 2) : formatMenuSnapshot(snapshot));
    return;
  }

  if (command === "connectors" && (rest[0] === "list" || !rest[0])) {
    const options = parseOptions(rest[0] === "list" ? rest.slice(1) : rest);
    console.log(options.json ? JSON.stringify({ connectors: CONNECTOR_SETUP_SLOTS }, null, 2) : formatConnectors());
    return;
  }

  if (command === "connectors" && rest[0] === "status") {
    const options = parseOptions(rest.slice(1));
    const connectors = await connectorStatuses();
    console.log(options.json ? JSON.stringify({ connectors }, null, 2) : formatConnectorStatuses(connectors));
    return;
  }

  if (command === "connectors" && (rest[0] === "wizards" || rest[0] === "wizard")) {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    if (!connectorArg && !options.id && !options.connector && rest[0] === "wizard") {
      throw new Error("connectors wizard needs a connector id.");
    }
    const result = connectorArg || options.id || options.connector
      ? await connectorWizard(connectorArg || options.id || options.connector)
      : await connectorWizards();
    console.log(options.json
      ? JSON.stringify(Array.isArray(result) ? { wizards: result } : result, null, 2)
      : Array.isArray(result) ? result.map(formatConnectorWizard).join("\n\n") : formatConnectorWizard(result));
    return;
  }

  if (command === "connectors" && rest[0] === "configure") {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    const connectorId = connectorArg || options.id || options.connector;
    const status = await configureConnector(connectorId, {
      enabled: options.enable ? true : options.disable ? false : null,
      settings: parseSettings(options.set),
      unset: asArray(options.unset)
    });
    console.log(options.json ? JSON.stringify(status, null, 2) : formatConnectorStatuses([status]));
    return;
  }

  if (command === "managed-connectors" && (rest[0] === "list" || rest[0] === "status" || !rest[0])) {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest[0] ? rest.slice(1) : rest);
    const agent = await loadAgent();
    const result = connectorArg || options.id
      ? await managedConnectorStatus(connectorArg || options.id, { agent })
      : await managedConnectorStatuses({ agent });
    console.log(options.json
      ? JSON.stringify(Array.isArray(result) ? { connectors: result } : result, null, 2)
      : Array.isArray(result) ? formatManagedConnectorStatuses(result) : formatManagedConnectorStatuses([result]));
    return;
  }

  if (command === "managed-connectors" && (rest[0] === "wizard" || rest[0] === "wizards")) {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    if (!connectorArg && !options.id && rest[0] === "wizard") {
      throw new Error("managed-connectors wizard needs a connector id.");
    }
    const agent = await loadAgent();
    const result = connectorArg || options.id
      ? await managedConnectorWizard(connectorArg || options.id, { agent })
      : await managedConnectorWizards({ agent });
    console.log(options.json
      ? JSON.stringify(Array.isArray(result) ? { wizards: result } : result, null, 2)
      : Array.isArray(result) ? result.map(formatManagedConnectorWizard).join("\n\n") : formatManagedConnectorWizard(result));
    return;
  }

  if (command === "managed-connectors" && rest[0] === "configure") {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    const connectorId = connectorArg || options.id;
    if (!connectorId) throw new Error("managed-connectors configure needs a connector id.");
    const status = await configureManagedConnector(connectorId, {
      adapter: options.adapter || null,
      enabled: options.enable ? true : options.disable ? false : null,
      settings: parseSettings(options.set),
      unset: asArray(options.unset)
    });
    console.log(options.json ? JSON.stringify(status, null, 2) : formatManagedConnectorStatuses([status]));
    return;
  }

  if (command === "managed-connectors" && rest[0] === "init-config") {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    const connectorId = connectorArg || options.id;
    if (!connectorId) throw new Error("managed-connectors init-config needs a connector id.");
    const agent = await loadAgent();
    const result = await initializeManagedConnectorConfig(connectorId, {
      agent,
      settings: parseSettings(options.set),
      overwrite: Boolean(options.overwrite)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedConnectorConfigInit(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "managed-connectors" && rest[0] === "import") {
    const options = parseOptions(rest.slice(1));
    if (!options.file) throw new Error("managed-connectors import needs --file PATH.");
    const raw = JSON.parse(await fs.readFile(options.file, "utf8"));
    const result = await importManagedConnectors(raw.managedConnectors || raw.connectors || raw, {
      source: { path: options.file }
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedConnectorStatuses(result.connectors));
    return;
  }

  if (command === "managed-connectors" && rest[0] === "test") {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    const connectorId = connectorArg || options.id;
    if (!connectorId) throw new Error("managed-connectors test needs a connector id.");
    const agent = await loadAgent();
    const result = await testManagedConnector(connectorId, {
      kind: options.kind || "status",
      agent
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedConnectorTest(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "managed-connectors" && rest[0] === "mcp") {
    const action = rest[1] || "status";
    const connectorArg = rest[2] && !rest[2].startsWith("--") ? rest[2] : null;
    const options = parseOptions(connectorArg ? rest.slice(3) : rest.slice(2));
    const connectorId = connectorArg || options.id;
    if (!connectorId) throw new Error("managed-connectors mcp needs a connector id.");
    const agent = await loadAgent();
    if (action === "status") {
      const status = await managedConnectorStatus(connectorId, { agent });
      console.log(options.json ? JSON.stringify(status.mcp, null, 2) : formatManagedConnectorTest({
        connector: connectorId,
        kind: "mcp-status",
        checks: status.mcp.checks
      }));
      process.exitCode = status.mcp.ok ? 0 : 1;
      return;
    }
    if (action === "print") {
      process.stdout.write(await printManagedConnectorMcp(connectorId));
      return;
    }
    if (action === "install") {
      const result = await installManagedConnectorMcp(connectorId, {
        agent,
        codexConfigPath: options.codexConfig || options.codexConfigPath || null,
        dryRun: Boolean(options.dryRun)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedConnectorMcpInstall(result));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    throw new Error(`Unknown managed connector MCP action: ${action}`);
  }

  if (command === "mcp" && rest[0] === "memory") {
    const action = rest[1] || "status";
    const options = parseOptions(rest.slice(2));
    const agent = await loadAgent();
    if (action === "status") {
      const status = await memoryMcpStatus({
        agent,
        codexConfigPath: options.codexConfig || options.codexConfigPath || null
      });
      console.log(options.json ? JSON.stringify(status, null, 2) : formatMemoryMcpStatus(status));
      process.exitCode = status.ok ? 0 : 1;
      return;
    }
    if (action === "print") {
      process.stdout.write(await printMemoryMcp({
        agentId: options.agentId || agent?.id || null
      }));
      return;
    }
    if (action === "install") {
      const result = await installMemoryMcp({
        agent,
        agentId: options.agentId || null,
        codexConfigPath: options.codexConfig || options.codexConfigPath || null,
        dryRun: Boolean(options.dryRun)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatMemoryMcpInstall(result));
      return;
    }
    throw new Error(`Unknown memory MCP action: ${action}`);
  }

  if (command === "managed-connectors" && rest[0] === "run") {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    const connectorId = connectorArg || options.id;
    if (!connectorId) throw new Error("managed-connectors run needs a connector id.");
    const result = await runManagedConnectorProcess(connectorId, {
      processId: options.process || "bot"
    });
    process.exitCode = result.ok ? 0 : result.code || 1;
    return;
  }

  if (command === "managed-connectors" && rest[0] === "launch-agent") {
    const action = rest[1] || "status";
    const connectorArg = rest[2] && !rest[2].startsWith("--") ? rest[2] : null;
    const options = parseOptions(connectorArg ? rest.slice(3) : rest.slice(2));
    const connectorId = connectorArg || options.id;
    if (!connectorId) throw new Error("managed-connectors launch-agent needs a connector id.");
    if (action === "status") {
      const status = await managedConnectorLaunchAgentStatus(connectorId);
      console.log(options.json ? JSON.stringify(status, null, 2) : formatManagedLaunchAgentStatus(status));
      return;
    }
    if (action === "print") {
      process.stdout.write(await managedConnectorLaunchAgentPlist(connectorId));
      return;
    }
    if (action === "install") {
      const result = await installManagedConnectorLaunchAgent(connectorId, {
        dryRun: Boolean(options.dryRun),
        load: Boolean(options.load || options.reload || options.loadNow),
        reload: Boolean(options.reload)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedLaunchAgentResult(result));
      return;
    }
    if (action === "load" || action === "reload") {
      const result = await loadManagedConnectorLaunchAgent(connectorId, {
        dryRun: Boolean(options.dryRun),
        reload: action === "reload" || Boolean(options.reload)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedLaunchAgentResult(result));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (action === "unload") {
      const result = await unloadManagedConnectorLaunchAgent(connectorId, {
        dryRun: Boolean(options.dryRun)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedLaunchAgentResult(result));
      process.exitCode = result.ok ? 0 : 1;
      return;
    }
    if (action === "uninstall") {
      const result = await uninstallManagedConnectorLaunchAgent(connectorId, {
        dryRun: Boolean(options.dryRun),
        unload: Boolean(options.unload)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatManagedLaunchAgentResult(result));
      return;
    }
    throw new Error(`Unknown managed connector launch-agent action: ${action}`);
  }

  if (command === "contacts" && (rest[0] === "list" || rest[0] === "status" || !rest[0])) {
    const options = parseOptions(rest[0] ? rest.slice(1) : rest);
    const contacts = await loadContacts();
    console.log(options.json ? JSON.stringify(contacts, null, 2) : formatContacts(contacts));
    return;
  }

  if (command === "contacts" && rest[0] === "import") {
    const options = parseOptions(rest.slice(1));
    if (!options.file) throw new Error("contacts import needs --file PATH.");
    const contacts = await importContactsFile(options.file, {
      format: options.format || "auto"
    });
    console.log(options.json ? JSON.stringify(contacts, null, 2) : formatContacts(contacts));
    return;
  }

  if (command === "contacts" && rest[0] === "resolve") {
    const options = parseOptions(rest.slice(1));
    const result = await resolveContact({
      connector: options.connector,
      sender: options.sender || options.from || options.id || null,
      metadata: parseSettings(options.meta)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatContactResolution(result));
    return;
  }

  if (command === "duties" && (rest[0] === "list" || rest[0] === "status" || !rest[0])) {
    const options = parseOptions(rest[0] ? rest.slice(1) : rest);
    const duties = await dutyStatuses();
    console.log(options.json ? JSON.stringify(duties, null, 2) : formatDutyStatuses(duties));
    return;
  }

  if (command === "duties" && rest[0] === "import") {
    const options = parseOptions(rest.slice(1));
    if (!options.file) throw new Error("duties import needs --file PATH.");
    const raw = JSON.parse(await fs.readFile(options.file, "utf8"));
    const duties = await importDuties(raw, {
      source: { path: options.file, format: options.format || "wakefield-duties-v1" }
    });
    console.log(options.json ? JSON.stringify(duties, null, 2) : formatDutyStatuses(await dutyStatuses()));
    return;
  }

  if (command === "duties" && rest[0] === "configure") {
    const dutyId = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(dutyId ? rest.slice(2) : rest.slice(1));
    const resolvedDutyId = dutyId || options.id;
    if (!resolvedDutyId) throw new Error("duties configure needs a duty id.");
    const duties = await configureDuty(resolvedDutyId, {
      label: options.label || null,
      prompt: options.prompt || null,
      promptFile: options.promptFile || null,
      skills: options.skill == null && options.skills == null
        ? null
        : asArray(options.skill || options.skills),
      wakeTimes: options.wakeTime == null && options.wakeTimes == null
        ? null
        : asArray(options.wakeTime || options.wakeTimes),
      enabled: options.enable ? true : options.disable ? false : null,
      intervalMinutes: options.intervalMinutes || options.interval || null,
      clearInterval: Boolean(options.clearInterval),
      clearWakeTimes: Boolean(options.clearWakeTimes),
      dispatchMode: options.dispatchMode || null,
      requiredTools: options.requiredTool == null && options.requiredTools == null
        ? null
        : asArray(options.requiredTool || options.requiredTools),
      resetSchedule: Boolean(options.resetSchedule)
    });
    console.log(options.json ? JSON.stringify(duties, null, 2) : formatDutyStatuses(await dutyStatuses()));
    return;
  }

  if (command === "wakeups" && (rest[0] === "list" || rest[0] === "status" || !rest[0])) {
    const options = parseOptions(rest[0] ? rest.slice(1) : rest);
    const duties = await dutyStatuses();
    console.log(options.json ? JSON.stringify(duties, null, 2) : formatDutyStatuses(duties));
    return;
  }

  if (command === "wakeups" && rest[0] === "configure") {
    const wakeupId = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(wakeupId ? rest.slice(2) : rest.slice(1));
    const resolvedWakeupId = wakeupId || options.id;
    if (!resolvedWakeupId) throw new Error("wakeups configure needs a wakeup id.");
    const duties = await configureWakeup(resolvedWakeupId, {
      label: options.label || null,
      duties: options.duty == null && options.duties == null
        ? null
        : asArray(options.duty || options.duties),
      skills: options.skill == null && options.skills == null
        ? null
        : asArray(options.skill || options.skills),
      wakeTimes: options.time == null && options.wakeTime == null && options.wakeTimes == null
        ? null
        : asArray(options.time || options.wakeTime || options.wakeTimes),
      enabled: options.enable ? true : options.disable ? false : null,
      intervalMinutes: options.intervalMinutes || options.interval || null,
      clearInterval: Boolean(options.clearInterval),
      clearWakeTimes: Boolean(options.clearWakeTimes),
      dispatchMode: options.dispatchMode || null,
      requiredTools: options.requiredTool == null && options.requiredTools == null
        ? null
        : asArray(options.requiredTool || options.requiredTools),
      resetSchedule: Boolean(options.resetSchedule)
    });
    console.log(options.json ? JSON.stringify(duties, null, 2) : formatDutyStatuses(await dutyStatuses()));
    return;
  }

  if (command === "wakeups" && rest[0] === "run") {
    const wakeupId = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(wakeupId ? rest.slice(2) : rest.slice(1));
    const agent = await requireAgent();
    const result = await runDueDuties(agent, {
      only: wakeupId || options.id || null,
      force: Boolean(options.force)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDutyRun(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "duties" && rest[0] === "run") {
    const dutyId = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(dutyId ? rest.slice(2) : rest.slice(1));
    const agent = await requireAgent();
    const result = await runDueDuties(agent, {
      only: dutyId || options.id || null,
      force: Boolean(options.force)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDutyRun(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "email" && rest[0] === "ingest") {
    const options = parseOptions(rest.slice(1));
    const agent = await requireAgent();
    const raw = await readEmailInput({
      file: options.file || null,
      stdin: process.stdin
    });
    const result = await ingestEmailRfc822(agent, {
      raw,
      sourceFile: options.file || null
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatEmailIngest(result));
    return;
  }

  if (command === "email" && rest[0] === "poll") {
    const options = parseOptions(rest.slice(1));
    const agent = await requireAgent();
    const result = await pollEmailImap(agent, {
      limit: options.limit || options.maxMessages || null
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatEmailPoll(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "discord" && rest[0] === "listen") {
    const options = parseOptions(rest.slice(1));
    const agent = await requireAgent();
    await startDiscordGateway(agent, {
      dispatchMode: options.dispatchMode || null
    });
    console.log("Wakefield Discord listener is running.");
    await new Promise(() => {});
    return;
  }

  if (command === "imessage" && rest[0] === "poll") {
    const options = parseOptions(rest.slice(1));
    const agent = await requireAgent();
    const result = await pollImessageChatDb(agent, {
      limit: options.limit || options.maxMessages || null,
      dispatchMode: options.dispatchMode || null
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatImessagePoll(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "http" && rest[0] === "serve") {
    const options = parseOptions(rest.slice(1));
    const host = options.host || "127.0.0.1";
    const port = Number(options.port || 8787);
    const tokenEnv = options.tokenEnv || null;
    const token = tokenEnv ? process.env[tokenEnv] : options.token || null;
    if (tokenEnv && !token) throw new Error(`Token environment variable is not set: ${tokenEnv}`);
    const server = await startHttpIntakeServer({
      host,
      port,
      token
    });
    const address = server.address();
    console.log(`Wakefield HTTP intake: ${httpIntakeUrl({ host: address.address, port: address.port })}`);
    await new Promise(() => {});
    return;
  }

  if (command === "inbox" && (rest[0] === "pending" || !rest[0])) {
    const options = parseOptions(rest[0] === "pending" ? rest.slice(1) : rest);
    const agent = await requireAgent();
    const messages = await listExternalMessages(agent, {
      status: options.status || "pending",
      limit: Number(options.limit || 20)
    });
    console.log(options.json ? JSON.stringify({ messages }, null, 2) : formatExternalMessages(messages));
    return;
  }

  if (command === "inbox" && rest[0] === "add") {
    const connectorArg = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(connectorArg ? rest.slice(2) : rest.slice(1));
    const agent = await requireAgent();
    const result = await ingestExternalMessage(agent, {
      connector: connectorArg || options.connector,
      conversationId: options.conversationId || options.conversation || options.channelId || null,
      sender: options.sender || options.from || null,
      text: options.text || options._.join(" "),
      messageId: options.messageId || null,
      subject: options.subject || null,
      url: options.url || null,
      metadata: parseSettings(options.meta)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatExternalIngest(result));
    return;
  }

  if (command === "inbox" && rest[0] === "ack") {
    const messageId = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(messageId ? rest.slice(2) : rest.slice(1));
    const agent = await requireAgent();
    const message = await acknowledgeExternalMessage(agent, messageId || options.id, {
      status: options.status || "delivered",
      reason: options.reason || null
    });
    console.log(options.json ? JSON.stringify(message, null, 2) : `${message.id}: ${message.status}`);
    return;
  }

  if (command === "inbox" && rest[0] === "dispatch") {
    const messageId = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
    const options = parseOptions(messageId ? rest.slice(2) : rest.slice(1));
    const agent = await requireAgent();
    const result = await dispatchExternalMessage(agent, {
      id: messageId || options.id || null,
      mode: options.mode || "dry-run",
      socketPath: options.socketPath || null
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDispatchResult(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "remember") {
    const options = parseOptions(rest);
    const agent = await requireAgent();
    const text = options.text || rest.join(" ");
    if (!text) throw new Error("remember needs --text or a trailing note.");
    const entry = await recordMemory(agent, {
      channel: options.channel || "journal",
      kind: options.kind || "note",
      text,
      source: "cli"
    });
    console.log(`Remembered ${entry.kind}: ${compact(entry.text, 120)}`);
    return;
  }

  if (command === "recall") {
    const options = parseOptions(rest);
    const agent = await requireAgent();
    const query = options.query || rest.join(" ");
    const context = await memoryContext(agent, query, { limit: Number(options.limit || 5) });
    console.log(context || "No matching Wakefield memory yet.");
    return;
  }

  if (command === "memory") {
    const agent = await requireAgent();
    const group = rest[0] || "recall";
    const action = rest[1] || "list";

    if (group === "notes" && (action === "list" || action === "status")) {
      const options = parseOptions(rest.slice(2));
      const notes = await loadNotes(agent);
      console.log(options.json ? JSON.stringify(notes, null, 2) : formatNotes(notes));
      return;
    }

    if (group === "notes" && (action === "add" || action === "upsert")) {
      const options = parseOptions(rest.slice(2));
      const note = noteFromCli(options, options._.join(" "));
      const notes = await upsertNote(agent, note);
      console.log(options.json ? JSON.stringify(notes.notes.find((item) => item.id === note.id), null, 2) : `Saved note ${note.id}`);
      return;
    }

    if ((group === "matters" || group === "active-context") && (action === "list" || action === "status")) {
      const options = parseOptions(rest.slice(2));
      const matters = await loadMatters(agent);
      console.log(options.json ? JSON.stringify(matters, null, 2) : formatMatters(matters, {
        includeArchived: Boolean(options.all || options.includeArchived)
      }));
      return;
    }

    if ((group === "matters" || group === "active-context") && (action === "upsert" || action === "add")) {
      const options = parseOptions(rest.slice(2));
      const matter = matterFromCli(options, options._.join(" "));
      const matters = await upsertMatter(agent, matter);
      console.log(options.json ? JSON.stringify(matters.matters.find((item) => item.id === matter.id), null, 2) : `Saved matter ${matter.id}`);
      return;
    }

    if ((group === "matters" || group === "active-context") && action === "archive") {
      const id = rest[2] && !rest[2].startsWith("--") ? rest[2] : null;
      const options = parseOptions(id ? rest.slice(3) : rest.slice(2));
      const matters = await archiveMatter(agent, id || options.id, {
        reason: options.reason || null
      });
      console.log(options.json ? JSON.stringify(matters.matters.find((item) => item.id === (id || options.id)), null, 2) : `Archived matter ${id || options.id}`);
      return;
    }

    if (group === "forget") {
      const type = rest[1] && !rest[1].startsWith("--") ? rest[1] : null;
      const id = rest[2] && !rest[2].startsWith("--") ? rest[2] : null;
      const options = parseOptions(id ? rest.slice(3) : rest.slice(1));
      await forgetMemoryItem(agent, type || options.type, id || options.id);
      console.log(`Forgot ${type || options.type} ${id || options.id}`);
      return;
    }

    if (group === "recall" || group === "context") {
      const options = parseOptions(rest.slice(1));
      const query = options.query || options._.join(" ");
      const recalled = await recallContext(agent, {
        query,
        scope: scopeFromOptions(options),
        limitNotes: Number(options.limitNotes || options.limit || 3),
        limitMatters: Number(options.limitMatters || options.limit || 3),
        includeArchived: Boolean(options.all || options.includeArchived)
      });
      const formatted = formatContextMemory(recalled, {
        heading: "Wakefield scoped memory recall"
      });
      console.log(options.json ? JSON.stringify(recalled, null, 2) : formatted || "No matching Wakefield scoped memory.");
      return;
    }

    if (group === "context-preview") {
      const options = parseOptions(rest.slice(1));
      const preview = await contextMemory(agent, {
        query: options.query || options._.join(" "),
        scope: scopeFromOptions(options),
        limitNotes: Number(options.limitNotes || options.limit || 3),
        limitMatters: Number(options.limitMatters || options.limit || 3),
        maxChars: Number(options.maxChars || 1200)
      });
      console.log(preview || "No matching Wakefield scoped memory.");
      return;
    }

    if (group === "capture") {
      const options = parseOptions(rest.slice(1));
      const result = await processMemoryCaptures(agent, {
        limit: Number(options.limit || 5),
        dryRun: Boolean(options.dryRun)
      });
      console.log(options.json ? JSON.stringify(result, null, 2) : formatMemoryCaptureResult(result));
      return;
    }

    throw new Error(`Unknown memory command: ${rest.join(" ") || "(missing)"}`);
  }

  if (command === "dream") {
    const options = parseOptions(rest);
    const agent = await requireAgent();
    const result = await processDreams(agent, {
      limit: Number(options.limit || 10),
      dryRun: Boolean(options.dryRun),
      capture: !Boolean(options.noCapture)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatDreamResult(result));
    return;
  }

  if (command === "service" && (rest[0] === "status" || !rest[0])) {
    const options = parseOptions(rest[0] === "status" ? rest.slice(1) : rest);
    const status = await serviceStatus();
    console.log(options.json ? JSON.stringify(status, null, 2) : formatServiceStatus(status));
    return;
  }

  if (command === "service" && rest[0] === "configure") {
    const options = parseOptions(rest.slice(1));
    const status = await configureService({
      enabled: options.enable ? true : options.disable ? false : null,
      intervalMinutes: options.intervalMinutes || options.interval,
      dispatchEnabled: options.enableDispatch ? true : options.disableDispatch ? false : null,
      dispatchMode: options.dispatchMode,
      dispatchLimit: options.dispatchLimit,
      envFile: options.envFile || null,
      clearEnvFile: Boolean(options.clearEnvFile)
    });
    console.log(options.json ? JSON.stringify(status, null, 2) : formatServiceStatus(status));
    return;
  }

  if (command === "service" && rest[0] === "run-once") {
    const options = parseOptions(rest.slice(1));
    const result = await runServiceOnce({
      limit: Number(options.limit || 10)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatServiceRun(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && (rest[1] === "status" || !rest[1])) {
    const options = parseOptions(rest[1] === "status" ? rest.slice(2) : rest.slice(1));
    const status = await launchAgentStatus();
    console.log(options.json ? JSON.stringify(status, null, 2) : formatLaunchAgentStatus(status));
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && rest[1] === "print") {
    process.stdout.write(await launchAgentPlist());
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && rest[1] === "install") {
    const options = parseOptions(rest.slice(2));
    const result = await installLaunchAgent({
      intervalMinutes: options.intervalMinutes || options.interval,
      dryRun: Boolean(options.dryRun),
      load: Boolean(options.load || options.reload || options.loadNow),
      reload: Boolean(options.reload)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatLaunchAgentResult(result));
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && rest[1] === "load") {
    const options = parseOptions(rest.slice(2));
    const result = await loadLaunchAgent({
      dryRun: Boolean(options.dryRun),
      reload: Boolean(options.reload)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatLaunchAgentResult(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && rest[1] === "reload") {
    const options = parseOptions(rest.slice(2));
    const result = await loadLaunchAgent({
      dryRun: Boolean(options.dryRun),
      reload: true
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatLaunchAgentResult(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && rest[1] === "uninstall") {
    const options = parseOptions(rest.slice(2));
    const result = await uninstallLaunchAgent({
      dryRun: Boolean(options.dryRun),
      unload: Boolean(options.unload)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatLaunchAgentResult(result));
    return;
  }

  if (command === "service" && rest[0] === "launch-agent" && rest[1] === "unload") {
    const options = parseOptions(rest.slice(2));
    const result = await unloadLaunchAgent({
      dryRun: Boolean(options.dryRun)
    });
    console.log(options.json ? JSON.stringify(result, null, 2) : formatLaunchAgentResult(result));
    process.exitCode = result.ok ? 0 : 1;
    return;
  }

  if (command === "hook") {
    await runHookFromStdin();
    return;
  }

  if (command === "hooks" && rest[0] === "print-config") {
    const config = hookConfig({ command: wakefieldHookCommand({ home: appHome() }), statusMessage: "Wakefield memory" });
    console.log(JSON.stringify(config, null, 2));
    return;
  }

  throw new Error(`Unknown command: ${command}`);
}

function usage() {
  return [
    "Usage:",
    "  wakefield install [--name NAME] [--soul TEXT] [--thread-id ID|--latest-thread] [--cwd PATH]",
    "  wakefield init [--name NAME] [--soul TEXT] [--thread-id ID] [--cwd PATH]",
    "  wakefield select-thread --thread-id ID|--latest [--cwd PATH]",
    "  wakefield threads list [--json] [--limit N]",
    "  wakefield manifest [--json]",
    "  wakefield self-test [--keep] [--json]",
    "  wakefield verify [--keep] [--json]",
    "  wakefield doctor [--json]",
    "  wakefield setup status [--json]",
    "  wakefield setup next [--json]",
    "  wakefield setup actions [--json]",
    "  wakefield setup run [--name NAME] [--soul TEXT] [--thread-id ID|--latest-thread] [--enable-service] [--enable-dispatch] [--env-file PATH] [--install-launch-agent] [--load-launch-agent] [--json]",
    "  wakefield pack inspect --file pack.json [--json]",
    "  wakefield pack install --file pack.json [--thread-id ID|--latest-thread] [--enable-service] [--dry-run] [--json]",
    "  wakefield menu snapshot [--json]",
    "  wakefield connectors list [--json]",
    "  wakefield connectors status [--json]",
    "  wakefield connectors wizard CONNECTOR [--json]",
    "  wakefield connectors wizards [--json]",
    "  wakefield connectors configure CONNECTOR [--enable|--disable] [--set key=value] [--unset key] [--json]",
    "  wakefield managed-connectors status [ID] [--json]",
    "  wakefield managed-connectors wizard ID [--json]",
    "  wakefield managed-connectors wizards [--json]",
    "  wakefield managed-connectors configure ID --adapter ADAPTER [--enable|--disable] [--set key=value] [--json]",
    "  wakefield managed-connectors init-config ID [--set key=value] [--overwrite] [--json]",
    "  wakefield managed-connectors mcp status ID [--json]",
    "  wakefield managed-connectors mcp print ID",
    "  wakefield managed-connectors mcp install ID [--codex-config PATH] [--dry-run] [--json]",
    "  wakefield mcp memory status [--codex-config PATH] [--json]",
    "  wakefield mcp memory print",
    "  wakefield mcp memory install [--codex-config PATH] [--dry-run] [--json]",
    "  wakefield managed-connectors test ID [--kind status|follower-probe|spectrum-bridge|reply-plan|tapback-plan] [--json]",
    "  wakefield managed-connectors launch-agent status ID [--json]",
    "  wakefield managed-connectors launch-agent print ID",
    "  wakefield managed-connectors launch-agent install ID [--load|--reload] [--dry-run] [--json]",
    "  wakefield managed-connectors launch-agent load ID [--reload] [--dry-run] [--json]",
    "  wakefield managed-connectors launch-agent unload ID [--dry-run] [--json]",
    "  wakefield managed-connectors launch-agent uninstall ID [--unload] [--dry-run] [--json]",
    "  wakefield contacts list [--json]",
    "  wakefield contacts import --file contacts.json [--format FORMAT] [--json]",
    "  wakefield contacts resolve --connector CONNECTOR --sender ID [--meta key=value] [--json]",
    "  wakefield duties list [--json]",
    "  wakefield duties import --file duties.json [--json]",
    "  wakefield duties configure ID [--enable|--disable] [--wake-time HH:mm] [--interval-minutes N|--clear-interval] [--skill NAME] [--prompt TEXT|--prompt-file PATH] [--dispatch-mode dry-run|manual|ipc] [--json]",
    "  wakefield duties run [ID] [--force] [--json]",
    "  wakefield wakeups list [--json]",
    "  wakefield wakeups configure ID --time HH:mm --duty DUTY_ID [--duty DUTY_ID] [--dispatch-mode dry-run|manual|ipc] [--json]",
    "  wakefield wakeups run [ID] [--force] [--json]",
    "  wakefield discord listen [--dispatch-mode dry-run|manual|ipc|auto|steer|start]",
    "  wakefield email ingest [--file message.eml] [--json]",
    "  wakefield email poll [--limit N] [--json]",
    "  wakefield imessage poll [--limit N] [--dispatch-mode dry-run|manual|ipc|auto|steer|start] [--json]",
    "  wakefield http serve [--host 127.0.0.1] [--port 8787] [--token-env ENV]",
    "  wakefield inbox add CONNECTOR --text TEXT [--conversation-id ID] [--sender NAME] [--message-id ID] [--json]",
    "  wakefield inbox pending [--status pending|delivered|ignored|failed|all] [--json]",
    "  wakefield inbox ack ID [--status delivered|ignored|failed] [--json]",
    "  wakefield inbox dispatch [ID] [--mode dry-run|manual|ipc|auto|steer|start] [--json]",
    "  wakefield memory notes list [--json]",
    "  wakefield memory notes add --text TEXT [--id ID] [--title TITLE] [--person ID] [--task ID] [--topic TOPIC] [--json]",
    "  wakefield memory matters list [--all] [--json]",
    "  wakefield memory matters upsert --summary TEXT [--id ID] [--title TITLE] [--status active|waiting|resolved|archived] [--person ID] [--task ID] [--case ID] [--json]",
    "  wakefield memory matters archive ID [--reason TEXT] [--json]",
    "  wakefield memory forget note|matter ID",
    "  wakefield memory recall [--query TEXT] [--person ID] [--task ID] [--topic TOPIC] [--json]",
    "  wakefield memory capture [--limit N] [--dry-run] [--json]",
    "  wakefield remember --text TEXT [--kind KIND] [--channel journal|inbox|dreams]",
    "  wakefield recall --query TEXT [--limit N]",
    "  wakefield dream [--limit N] [--dry-run] [--no-capture] [--json]",
    "  wakefield service status [--json]",
    "  wakefield service configure [--enable|--disable] [--interval-minutes N] [--enable-dispatch|--disable-dispatch] [--dispatch-mode MODE] [--dispatch-limit N] [--env-file PATH|--clear-env-file] [--json]",
    "  wakefield service run-once [--limit N] [--json]",
    "  wakefield service launch-agent status [--json]",
    "  wakefield service launch-agent print",
    "  wakefield service launch-agent install [--interval-minutes N] [--load|--reload] [--dry-run] [--json]",
    "  wakefield service launch-agent load [--reload] [--dry-run] [--json]",
    "  wakefield service launch-agent reload [--dry-run] [--json]",
    "  wakefield service launch-agent unload [--dry-run] [--json]",
    "  wakefield service launch-agent uninstall [--unload] [--dry-run] [--json]",
    "  wakefield hook",
    "  wakefield hooks print-config"
  ].join("\n");
}

async function requireAgent() {
  const agent = await loadAgent();
  if (!agent) throw new Error("No Wakefield agent is initialized yet. Run wakefield init first.");
  return ensureAgentMemory(agent);
}

async function ask(label, { fallback = null } = {}) {
  const rl = createInterface({ input, output });
  try {
    const answer = await rl.question(`${label}: `);
    return answer || fallback;
  } finally {
    rl.close();
  }
}

function parseOptions(args) {
  const options = {};
  const positional = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index];
    if (!arg.startsWith("--")) {
      positional.push(arg);
      continue;
    }
    const [rawKey, inlineValue] = arg.slice(2).split("=", 2);
    const key = camelCase(rawKey);
    if (inlineValue != null) {
      assignOption(options, key, inlineValue);
      continue;
    }
    const next = args[index + 1];
    if (next == null || next.startsWith("--")) {
      assignOption(options, key, true);
    } else {
      assignOption(options, key, next);
      index += 1;
    }
  }
  options._ = positional;
  return options;
}

function assignOption(options, key, value) {
  if (!(key in options)) {
    options[key] = value;
    return;
  }
  options[key] = Array.isArray(options[key])
    ? [...options[key], value]
    : [options[key], value];
}

function camelCase(value) {
  return value.replace(/-([a-z])/g, (_, char) => char.toUpperCase());
}

async function latestThreadId() {
  const [thread] = await listRecentThreads({ limit: 1 });
  if (!thread) throw new Error("No local Codex thread transcripts found. Open or create a Codex thread first.");
  return thread.threadId;
}

main().catch((error) => {
  console.error(error.message);
  process.exitCode = 1;
});
