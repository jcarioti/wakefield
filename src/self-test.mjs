import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { inspectAgentPack, installAgentPack } from "./agent-packs.mjs";
import { configureConnector, connectorWizard, connectorWizards } from "./connectors.mjs";
import { ingestDiscordGatewayMessage } from "./discord-gateway.mjs";
import { pollEmailImap } from "./email-imap.mjs";
import { ingestEmailRfc822 } from "./email-rfc822.mjs";
import { listExternalMessages } from "./external-messages.mjs";
import { handleHookInput } from "./hooks.mjs";
import { startHttpIntakeServer } from "./http-intake.mjs";
import { pollImessageChatDb } from "./imessage-chatdb.mjs";
import { configureManagedConnector, managedConnectorLaunchAgentPlist, managedConnectorLaunchAgentStatus, managedConnectorStatus, managedConnectorWizard, testManagedConnector } from "./managed-connectors.mjs";
import { menuSnapshot } from "./menu-snapshot.mjs";
import { doctor } from "./doctor.mjs";
import { loadAgent } from "./profile.mjs";
import { configureService, installLaunchAgent, loadLaunchAgent, uninstallLaunchAgent, unloadLaunchAgent, runServiceOnce } from "./service.mjs";
import { runSetup } from "./setup-runner.mjs";

const SELF_TEST_THREAD_ID = "019ecaaa-0000-7000-8000-000000000123";

export async function runSelfTest({
  keep = false,
  now = new Date("2026-06-14T18:00:00Z")
} = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-self-test-"));
  const home = path.join(root, "home");
  const codexHomePath = path.join(root, "codex");
  const launchAgentsPath = path.join(root, "LaunchAgents");
  const steps = [];
  const previousHome = process.env.WAKEFIELD_HOME;
  const previousDiscordToken = process.env.WAKEFIELD_SELF_TEST_DISCORD_TOKEN;
  const previousEmailPassword = process.env.WAKEFIELD_SELF_TEST_EMAIL_PASSWORD;
  const previousEnvFileEmailPassword = process.env.WAKEFIELD_SELF_TEST_ENV_FILE_EMAIL_PASSWORD;

  try {
    await writeCodexSession(codexHomePath, {
      threadId: SELF_TEST_THREAD_ID,
      timestamp: now.toISOString(),
      cwd: path.join(root, "agent-cwd")
    });
    steps.push(pass("fake-codex-thread", SELF_TEST_THREAD_ID));

    const pack = await createSelfTestPack(root);
    const packInspection = await inspectAgentPack(pack.packFile);
    steps.push(check("agent-pack-inspect", packInspection.ok, packInspection.pack.agent.cwd));
    const packInstall = await installAgentPack(pack.packFile, {
      home: path.join(root, "pack-home"),
      codexHomePath,
      threadId: SELF_TEST_THREAD_ID,
      skipHooks: true
    });
    steps.push(check(
      "agent-pack-install",
      packInstall.ok && packInstall.profile.cwd === pack.cwd,
      packInstall.profile?.cwd || "missing"
    ));

    const setup = await runSetup({
      home,
      codexHomePath,
      name: "Wakefield Self Test",
      soul: "A temporary self-test companion.",
      latestThread: true,
      enableService: true,
      enableDispatch: true,
      dispatchMode: "dry-run",
      dispatchLimit: 1
    });
    steps.push(check("setup-run", setup.ok, setup.phase));

    const agent = await loadAgent(null, home);
    steps.push(check("agent-created", Boolean(agent), agent?.id || "missing"));

    const email = await ingestEmailRfc822(agent, {
      raw: selfTestEmail(),
      sourceFile: "self-test.eml",
      now
    });
    steps.push(check("email-ingest", !email.duplicate && email.route.status === "ready", email.message.messageId));

    process.env.WAKEFIELD_HOME = home;
    await handleHookInput({
      hook_event_name: "Stop",
      session_id: agent.threadId,
      turn_id: "self-test-turn",
      cwd: agent.cwd,
      last_assistant_message: "Self-test hook memory event."
    });
    steps.push(pass("hook-memory", "queued dream"));

    const service = await runServiceOnce({ home, now });
    steps.push(check("service-run", service.ok && service.dreamer.processed === 1, `dreams=${service.dreamer.processed}`));
    steps.push(check(
      "service-dispatch-dry-run",
      service.externalDispatch.enabled && service.externalDispatch.attempted === 1 && service.externalDispatch.delivered === 0,
      `attempted=${service.externalDispatch.attempted}`
    ));

    const pending = await listExternalMessages(agent);
    steps.push(check("pending-preserved", pending.length === 1, `pending=${pending.length}`));

    const snapshot = await menuSnapshot({ home, codexHomePath });
    steps.push(check("menu-snapshot", snapshot.ready && snapshot.inbox.pending === 1, snapshot.headline));

    const wizards = await connectorWizards({ home });
    const discordWizard = await connectorWizard("discord", { home });
    steps.push(check(
      "connector-wizard-contract",
      wizards.length === 3 && discordWizard.steps.some((step) => step.id === "settings"),
      `${wizards.length} wizard(s)`
    ));

    const managedFixture = await createManagedConnectorFixture(root, {
      targetCwd: agent.cwd
    });
    const managedStatus = await configureManagedConnector("self-test-discord-codex", {
      home,
      adapter: "discord-codex",
      enabled: true,
      settings: {
        packagePath: managedFixture.packagePath,
        configPath: managedFixture.configPath,
        targetId: "self-test",
        "mcp.codexConfigPath": managedFixture.codexConfigPath,
        "launchAgent.label": "com.wakefield.self-test.discord"
      }
    });
    steps.push(check(
      "managed-connector-config",
      managedStatus.ready && managedStatus.mcp.ok,
      managedStatus.nextAction?.id || "missing"
    ));
    const managedWizard = await managedConnectorWizard("self-test-discord-codex", { home, agent });
    steps.push(check(
      "managed-connector-wizard",
      managedWizard.steps.some((step) => step.id === "codex-tools") && managedWizard.steps.some((step) => step.id === "daemon"),
      managedWizard.nextAction.id
    ));
    const managedTest = await testManagedConnector("self-test-discord-codex", { home, kind: "status", agent });
    steps.push(check("managed-connector-status-test", managedTest.ok, `${managedTest.checks.length} check(s)`));
    const managedLaunchStatus = await managedConnectorLaunchAgentStatus("self-test-discord-codex", {
      home,
      launchAgentsPath
    });
    const managedPlist = await managedConnectorLaunchAgentPlist("self-test-discord-codex", { home });
    steps.push(check(
      "managed-connector-launch-agent-plan",
      managedLaunchStatus.installed === false && managedPlist.includes("com.wakefield.self-test.discord"),
      managedLaunchStatus.plistPath
    ));

    const server = await startHttpIntakeServer({
      home,
      codexHomePath,
      port: 0,
      logger: null
    });
    try {
      const address = server.address();
      const response = await fetch(`http://${address.address}:${address.port}/messages`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          connector: "email",
          sender: "http-self-test@example.com",
          messageId: "wakefield-http-self-test",
          text: "HTTP intake self-test message."
        })
      });
      const body = await response.json();
      steps.push(check("http-intake", response.status === 202 && body.ok, `status=${response.status}`));

      const setupStatus = await fetch(`http://${address.address}:${address.port}/setup/status`).then((item) => item.json());
      steps.push(check(
        "http-setup-api",
        setupStatus.phase === "ready" && setupStatus.actions.some((action) => action.id === "select-thread"),
        setupStatus.phase
      ));

      const wizard = await fetch(`http://${address.address}:${address.port}/connectors/discord/wizard`).then((item) => item.json());
      steps.push(check(
        "http-connector-wizard-api",
        wizard.id === "connector-wizard-discord" && wizard.steps.some((step) => step.id === "readiness"),
        wizard.nextAction?.id || "missing"
      ));

      const managedHttp = await fetch(`http://${address.address}:${address.port}/managed-connectors/self-test-discord-codex/wizard`).then((item) => item.json());
      steps.push(check(
        "http-managed-connector-wizard-api",
        managedHttp.id === "managed-connector-wizard-self-test-discord-codex" && managedHttp.steps.some((step) => step.id === "codex-tools"),
        managedHttp.nextAction?.id || "missing"
      ));

      const managedInit = await fetch(`http://${address.address}:${address.port}/managed-connectors/self-test-discord-codex/init-config`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({})
      }).then((item) => item.json());
      steps.push(check(
        "http-managed-connector-init-config-api",
        managedInit.ok && managedInit.skipped === "exists",
        managedInit.skipped || "not skipped"
      ));

      const managedMcp = await fetch(`http://${address.address}:${address.port}/managed-connectors/self-test-discord-codex/mcp/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true })
      }).then((item) => item.json());
      steps.push(check(
        "http-managed-connector-mcp-install-api",
        managedMcp.ok && managedMcp.dryRun === true && managedMcp.block.includes("discord_send_message"),
        managedMcp.serverName || "missing"
      ));

      const managedLaunchInstall = await fetch(`http://${address.address}:${address.port}/managed-connectors/self-test-discord-codex/launch-agent/install`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ dryRun: true, load: true })
      }).then((item) => item.json());
      steps.push(check(
        "http-managed-connector-launch-agent-install-api",
        managedLaunchInstall.dryRun === true && managedLaunchInstall.action === "install",
        managedLaunchInstall.label || "missing"
      ));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }

    process.env.WAKEFIELD_SELF_TEST_EMAIL_PASSWORD = "self-test-password";
    await configureConnector("email", {
      home,
      enabled: true,
      settings: {
        imapHost: "imap.example.com",
        username: "wakefield@example.com",
        passwordEnv: "WAKEFIELD_SELF_TEST_EMAIL_PASSWORD"
      }
    });
    const imapPoll = await pollEmailImap(agent, {
      home,
      mailboxClient: fakeMailbox([
        { id: "self-test-imap-1", raw: imapSelfTestEmail() }
      ]),
      now
    });
    steps.push(check("email-imap-poll", imapPoll.ok && imapPoll.queued === 1, `queued=${imapPoll.queued}`));

    delete process.env.WAKEFIELD_SELF_TEST_ENV_FILE_EMAIL_PASSWORD;
    const envFile = path.join(root, "wakefield.env");
    await fs.writeFile(envFile, 'WAKEFIELD_SELF_TEST_ENV_FILE_EMAIL_PASSWORD="self-test-env-file-password"\n', { mode: 0o600 });
    await configureConnector("email", {
      home,
      enabled: true,
      settings: {
        imapHost: "imap.example.com",
        username: "wakefield@example.com",
        passwordEnv: "WAKEFIELD_SELF_TEST_ENV_FILE_EMAIL_PASSWORD"
      }
    });
    await configureService({ home, enabled: true, envFile });
    const envFileService = await runServiceOnce({
      home,
      connectorClients: {
        email: fakeMailbox([
          { id: "self-test-env-file-imap-1", raw: imapEnvFileSelfTestEmail() }
        ])
      },
      now
    });
    steps.push(check(
      "service-env-file-email-poll",
      envFileService.ok
        && envFileService.environment.loaded
        && envFileService.environment.keys.includes("WAKEFIELD_SELF_TEST_ENV_FILE_EMAIL_PASSWORD")
        && envFileService.connectorPolls.some((poll) => poll.connector?.id === "email" && poll.queued === 1),
      `queued=${envFileService.connectorPolls?.find((poll) => poll.connector?.id === "email")?.queued || 0}`
    ));

    process.env.WAKEFIELD_SELF_TEST_DISCORD_TOKEN = "self-test-discord-token";
    await configureConnector("discord", {
      home,
      enabled: true,
      settings: {
        botTokenEnv: "WAKEFIELD_SELF_TEST_DISCORD_TOKEN",
        allowedTargets: "self-test-channel"
      }
    });
    const discord = await ingestDiscordGatewayMessage(agent, selfTestDiscordMessage(), {
      home,
      now
    });
    steps.push(check("discord-gateway-ingest", discord.ok && discord.status === "queued", discord.status));

    const messagesDbPath = path.join(root, "chat.db");
    await fs.writeFile(messagesDbPath, "");
    await configureConnector("imessage", {
      home,
      enabled: true,
      settings: {
        databasePath: messagesDbPath,
        allowedSenders: "+15551234567"
      }
    });
    const imessage = await pollImessageChatDb(agent, {
      home,
      rows: [selfTestImessageRow()],
      now
    });
    steps.push(check("imessage-chatdb-poll", imessage.ok && imessage.queued === 1, `queued=${imessage.queued}`));

    const launchAgent = await installLaunchAgent({ home, launchAgentsPath });
    steps.push(check("launch-agent-temp-install", launchAgent.status.installed, launchAgent.plistPath));
    const launchAgentLoadPlan = await loadLaunchAgent({ home, launchAgentsPath, dryRun: true });
    steps.push(check(
      "launch-agent-load-plan",
      launchAgentLoadPlan.supported
        ? launchAgentLoadPlan.commands.some((command) => command.args[0] === "bootstrap")
        : launchAgentLoadPlan.skipped === "launchctl-unavailable",
      `${launchAgentLoadPlan.commands.length} command(s)`
    ));
    const launchAgentUnloadPlan = await unloadLaunchAgent({ home, launchAgentsPath, dryRun: true });
    steps.push(check(
      "launch-agent-unload-plan",
      launchAgentUnloadPlan.supported
        ? launchAgentUnloadPlan.commands.some((command) => command.args[0] === "bootout")
        : launchAgentUnloadPlan.skipped === "launchctl-unavailable",
      `${launchAgentUnloadPlan.commands.length} command(s)`
    ));
    const removedLaunchAgent = await uninstallLaunchAgent({ home, launchAgentsPath });
    steps.push(check("launch-agent-temp-remove", removedLaunchAgent.removed, removedLaunchAgent.plistPath));

    const report = await doctor({ home, codexHomePath });
    steps.push(check("doctor", report.ok, report.ok ? "ok" : "setup gaps"));

    const ok = steps.every((step) => step.ok);
    return {
      ok,
      kept: Boolean(keep),
      stateRoot: keep ? root : null,
      home: keep ? home : null,
      codexHome: keep ? codexHomePath : null,
      steps
    };
  } finally {
    restoreEnv("WAKEFIELD_HOME", previousHome);
    restoreEnv("WAKEFIELD_SELF_TEST_DISCORD_TOKEN", previousDiscordToken);
    restoreEnv("WAKEFIELD_SELF_TEST_EMAIL_PASSWORD", previousEmailPassword);
    restoreEnv("WAKEFIELD_SELF_TEST_ENV_FILE_EMAIL_PASSWORD", previousEnvFileEmailPassword);
    if (!keep) {
      await fs.rm(root, { recursive: true, force: true });
    }
  }
}

export function formatSelfTest(result) {
  const lines = [
    result.ok ? "Wakefield self-test passed." : "Wakefield self-test failed."
  ];
  for (const step of result.steps) {
    lines.push(`${step.ok ? "ok" : "fail"}: ${step.id} - ${step.detail}`);
  }
  if (result.kept) {
    lines.push(`state: ${result.stateRoot}`);
  }
  return lines.join("\n");
}

function pass(id, detail) {
  return { id, ok: true, detail };
}

function check(id, ok, detail) {
  return { id, ok: Boolean(ok), detail: String(detail || "") };
}

function restoreEnv(name, value) {
  if (value == null) {
    delete process.env[name];
  } else {
    process.env[name] = value;
  }
}

async function writeCodexSession(codexHomePath, {
  threadId,
  timestamp,
  cwd
}) {
  const date = timestamp.slice(0, 10).split("-");
  const sessions = path.join(codexHomePath, "sessions", date[0], date[1], date[2]);
  await fs.mkdir(sessions, { recursive: true });
  const safeTimestamp = timestamp.replaceAll(":", "-");
  const file = path.join(sessions, `rollout-${safeTimestamp}-${threadId}.jsonl`);
  await fs.writeFile(file, `${JSON.stringify({ type: "session_meta", payload: { cwd, timestamp } })}\n`);
  await fs.utimes(file, new Date(timestamp), new Date(timestamp));
  return file;
}

async function createManagedConnectorFixture(root, {
  targetCwd = path.join(root, "managed-discord-target")
} = {}) {
  const packagePath = path.join(root, "managed-discord-package");
  const codexConfigPath = path.join(targetCwd, ".codex", "config.toml");
  await fs.mkdir(path.join(packagePath, "src"), { recursive: true });
  await fs.mkdir(path.join(targetCwd, ".codex"), { recursive: true });
  await fs.writeFile(path.join(targetCwd, "AGENTS.md"), "# Managed Connector Self Test\n");
  await fs.writeFile(path.join(packagePath, "package.json"), JSON.stringify({
    name: "@wakefield/discord-codex-connector",
    type: "module",
    bin: {
      "discord-codex-bot": "src/discord-bot.mjs",
      "discord-codex-mcp": "src/mcp-server.mjs"
    }
  }));
  for (const file of ["discord-bot.mjs", "mcp-server.mjs", "codex-follower-probe.mjs", "codex-send.mjs"]) {
    await fs.writeFile(path.join(packagePath, "src", file), "export {};\n");
  }
  const tokenFile = path.join(root, "managed-discord-token");
  await fs.writeFile(tokenFile, "self-test-token\n", { mode: 0o600 });
  const configPath = path.join(packagePath, "config.local.json");
  await fs.writeFile(configPath, JSON.stringify({
    bot: {
      tokenEnv: "WAKEFIELD_SELF_TEST_MANAGED_DISCORD_TOKEN",
      tokenFile
    },
    discord: {
      allowedOutboundChannelIds: ["self-test-channel"],
      allowedDmUserIds: ["self-test-user"]
    },
    targets: [
      {
        id: "self-test",
        threadId: SELF_TEST_THREAD_ID,
        cwd: targetCwd,
        allowedChannelIds: ["self-test-channel"],
        allowedUserIds: ["self-test-user"]
      }
    ]
  }));
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
  return {
    packagePath,
    configPath,
    codexConfigPath,
    targetCwd
  };
}

async function createSelfTestPack(root) {
  const cwd = path.join(root, "pack-cwd");
  await fs.mkdir(path.join(cwd, "state"), { recursive: true });
  await fs.mkdir(path.join(cwd, "prompts"), { recursive: true });
  await fs.writeFile(path.join(cwd, "AGENTS.md"), "# Wakefield Pack Self Test\n\nUse this cwd.\n");
  await fs.writeFile(path.join(cwd, "state", "people.json"), JSON.stringify({
    version: 1,
    identity_resolution: {},
    people: {
      selftest: {
        display_name: "Self Test",
        discord_user_ids: ["wakefield-pack-self-test-user"],
        roles: ["tester"]
      }
    }
  }));
  await fs.writeFile(path.join(cwd, "prompts", "wake.md"), "Run the self-test pack duty.");
  const packFile = path.join(cwd, "wakefield-pack.json");
  await fs.writeFile(packFile, JSON.stringify({
    schemaVersion: 1,
    id: "wakefield-pack-self-test",
    agent: {
      name: "Wakefield Pack Self Test",
      cwd: ".",
      soulFile: "AGENTS.md"
    },
    contacts: {
      file: "state/people.json",
      format: "people-v1"
    },
    duties: [
      {
        id: "pack-self-test-duty",
        label: "Pack Self Test Duty",
        enabled: true,
        intervalMinutes: 60,
        dispatchMode: "dry-run",
        promptFile: "prompts/wake.md"
      }
    ]
  }));
  return { cwd, packFile };
}

function selfTestEmail() {
  return [
    "From: Wakefield Self Test <self-test@example.com>",
    "To: wakefield@example.com",
    "Subject: Wakefield self-test email",
    "Message-ID: <wakefield-self-test@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This email should queue, appear in the menu snapshot, and remain pending after dry-run dispatch."
  ].join("\r\n");
}

function imapSelfTestEmail() {
  return [
    "From: Wakefield IMAP Self Test <imap-self-test@example.com>",
    "To: wakefield@example.com",
    "Subject: Wakefield IMAP self-test email",
    "Message-ID: <wakefield-imap-self-test@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This email should queue through the IMAP poller without touching a real mailbox."
  ].join("\r\n");
}

function imapEnvFileSelfTestEmail() {
  return [
    "From: Wakefield Env File Self Test <env-file-self-test@example.com>",
    "To: wakefield@example.com",
    "Subject: Wakefield service env file self-test email",
    "Message-ID: <wakefield-env-file-imap-self-test@example.com>",
    "Content-Type: text/plain; charset=utf-8",
    "",
    "This email should queue through a service tick that loaded secrets from an env file."
  ].join("\r\n");
}

function selfTestDiscordMessage() {
  return {
    type: 0,
    id: "wakefield-discord-self-test",
    channel_id: "self-test-channel",
    guild_id: "self-test-guild",
    content: "Discord gateway self-test message.",
    author: {
      id: "self-test-user",
      username: "self-test-user",
      global_name: "Self Test User",
      bot: false
    },
    attachments: []
  };
}

function selfTestImessageRow() {
  return {
    id: 42,
    guid: "wakefield-imessage-self-test",
    text: "iMessage chat.db self-test message.",
    date: 1_000_000_000_000_000_000,
    is_from_me: 0,
    sender: "+15551234567",
    service: "iMessage",
    chat_id: 7,
    chat_guid: "iMessage;-;+15551234567",
    chat_identifier: "+15551234567",
    chat_name: "Self Test",
    is_group: 0
  };
}

function fakeMailbox(messages) {
  const byId = new Map(messages.map((message) => [message.id, message.raw]));
  return {
    async listMessages({ maxResults = 10 } = {}) {
      return messages.slice(0, maxResults).map((message) => ({
        id: message.id,
        raw: message.raw
      }));
    },
    async getMessage(id) {
      return byId.get(id);
    },
    async markProcessed() {}
  };
}
