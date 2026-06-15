import { CONNECTOR_SETUP_SLOTS } from "./connectors.mjs";
import { wakefieldManifest } from "./manifest.mjs";
import { formatSelfTest, runSelfTest } from "./self-test.mjs";

const REQUIRED_FEATURES = [
  "agent-profile",
  "soul",
  "thread-selection",
  "agent-packs",
  "codex-hooks",
  "contacts",
  "local-memory",
  "local-dreamer",
  "external-message-ingest",
  "discord-gateway",
  "email-rfc822-ingest",
  "email-imap-poll",
  "imessage-chatdb-poll",
  "http-setup-api",
  "external-message-dispatch",
  "service-tick",
  "scheduled-duties",
  "service-env-file",
  "macos-launch-agent",
  "setup-actions",
  "menu-snapshot",
  "clone-self-test",
  "clone-verify",
  "one-command-setup",
  "connector-config",
  "connector-wizards",
  "managed-connector-packages",
  "managed-connector-wizards",
  "managed-connector-config-init",
  "managed-connector-mcp-install",
  "managed-connector-launch-agents"
];

const REQUIRED_JSON_COMMANDS = [
  "wakefield verify --json",
  "wakefield self-test --json",
  "wakefield setup actions --json",
  "wakefield setup run --json",
  "wakefield pack inspect --file $packFile --json",
  "wakefield menu snapshot --json",
  "wakefield contacts list --json",
  "wakefield duties list --json",
  "wakefield wakeups list --json",
  "wakefield connectors status --json",
  "wakefield connectors wizards --json",
  "wakefield connectors wizard discord --json",
  "wakefield managed-connectors status --json",
  "wakefield managed-connectors wizards --json",
  "wakefield managed-connectors init-config $connectorId --json",
  "wakefield managed-connectors mcp install $connectorId --json",
  "wakefield managed-connectors test $connectorId --kind status --json",
  "wakefield managed-connectors launch-agent status $connectorId --json",
  "wakefield service configure --env-file $envFile --json",
  "wakefield service launch-agent install --load --json"
];

export async function verifyWakefield({
  keep = false,
  now = new Date()
} = {}) {
  const manifest = await wakefieldManifest({ connectors: CONNECTOR_SETUP_SLOTS });
  const selfTest = await runSelfTest({ keep, now });
  const availableFeatures = new Set(
    manifest.core
      .filter((feature) => feature.status === "available")
      .map((feature) => feature.id)
  );
  const jsonCommands = new Set(manifest.setup.jsonCommands.map((command) => command.join(" ")));
  const checks = [
    check("package", manifest.app.packageName === "wakefield", `${manifest.app.packageName}@${manifest.app.version}`),
    check("binary", manifest.runtime.binary === "wakefield", manifest.runtime.binary),
    check("license", Boolean(manifest.app.license), manifest.app.license || "missing"),
    check(
      "required features",
      REQUIRED_FEATURES.every((feature) => availableFeatures.has(feature)),
      missingDetail(REQUIRED_FEATURES.filter((feature) => !availableFeatures.has(feature)))
    ),
    check(
      "setup json commands",
      REQUIRED_JSON_COMMANDS.every((command) => jsonCommands.has(command)),
      missingDetail(REQUIRED_JSON_COMMANDS.filter((command) => !jsonCommands.has(command)))
    ),
    check("connector slots", manifest.connectors.length === CONNECTOR_SETUP_SLOTS.length, `${manifest.connectors.length} connector(s)`),
    check("self-test", selfTest.ok, selfTest.ok ? `${selfTest.steps.length} step(s)` : failedSelfTestSteps(selfTest).join(", "))
  ];

  return {
    ok: checks.every((item) => item.ok),
    verifiedAt: now.toISOString(),
    checks,
    manifest: {
      app: manifest.app,
      runtime: manifest.runtime,
      availableFeatures: [...availableFeatures],
      setupJsonCommands: manifest.setup.jsonCommands,
      connectors: manifest.connectors.map((connector) => ({
        id: connector.id,
        status: connector.status,
        available: connector.available,
        transports: connector.transports
      }))
    },
    selfTest
  };
}

export function formatVerification(result) {
  const lines = [
    result.ok ? "Wakefield verification passed." : "Wakefield verification failed.",
    `verified at: ${result.verifiedAt}`,
    ""
  ];
  for (const item of result.checks) {
    lines.push(`${item.ok ? "ok" : "fail"}: ${item.label} - ${item.detail}`);
  }
  lines.push("", formatSelfTest(result.selfTest));
  return lines.join("\n");
}

function check(label, ok, detail) {
  return { label, ok: Boolean(ok), detail };
}

function missingDetail(missing) {
  return missing.length === 0 ? "complete" : `missing: ${missing.join(", ")}`;
}

function failedSelfTestSteps(result) {
  return result.steps
    .filter((step) => !step.ok)
    .map((step) => step.id);
}
