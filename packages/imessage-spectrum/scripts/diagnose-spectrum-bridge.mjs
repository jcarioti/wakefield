#!/usr/bin/env node
import { fileURLToPath } from "node:url";
import { runSpectrumBridgeDiagnostic } from "../src/spectrum-bridge-diagnostics.mjs";

const args = withCliDefaults(parseArgs(process.argv.slice(2)));

if (args.help) {
  console.log(`Usage: diagnose-spectrum-bridge [options]

Options:
  --config <path>          Connector config path.
  --chat-id <id>           Local Messages chat row id for read-only imsg history.
  --space-id <id>          Rick-side Spectrum DM space id.
  --state-path <path>      Diagnostic state file path.
  --artifact-dir <path>    Incident artifact directory.
  --baseline-current       Mark the latest local outbound row as already accounted for.
  --active-imsg-probe      Send one synthetic local imsg message to Rick, then verify live capture.
  --skip-local-history     Skip local imsg history reads; useful for cloud-only Photon checks.
  --probe-text <text>      Override the synthetic probe text.
  --probe-wait-ms <ms>     Time to wait for the active probe to be captured.
  --probe-poll-ms <ms>     Poll interval while waiting for the active probe.
  --restart-on-stale       Restart the Spectrum launch agent when stale evidence is found.
  --deep                   Run Photon cloud/API probes when stale evidence is found.
  --help                   Show this help.
`);
  process.exit(0);
}

try {
  const result = await runSpectrumBridgeDiagnostic(args);
  console.log(JSON.stringify(result, null, 2));
  if (result.status === "stale") {
    process.exitCode = 2;
  } else if (result.status === "suspect") {
    process.exitCode = 1;
  }
} catch (error) {
  console.error(JSON.stringify({
    status: "error",
    error: {
      message: error.message,
      stack: error.stack
    }
  }, null, 2));
  process.exitCode = 1;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") {
      parsed.help = true;
    } else if (arg === "--config") {
      parsed.configPath = argv[++i];
    } else if (arg.startsWith("--config=")) {
      parsed.configPath = arg.slice("--config=".length);
    } else if (arg === "--chat-id") {
      parsed.chatId = argv[++i];
    } else if (arg.startsWith("--chat-id=")) {
      parsed.chatId = arg.slice("--chat-id=".length);
    } else if (arg === "--space-id") {
      parsed.spaceId = argv[++i];
    } else if (arg.startsWith("--space-id=")) {
      parsed.spaceId = arg.slice("--space-id=".length);
    } else if (arg === "--state-path") {
      parsed.statePath = argv[++i];
    } else if (arg.startsWith("--state-path=")) {
      parsed.statePath = arg.slice("--state-path=".length);
    } else if (arg === "--artifact-dir") {
      parsed.artifactDir = argv[++i];
    } else if (arg.startsWith("--artifact-dir=")) {
      parsed.artifactDir = arg.slice("--artifact-dir=".length);
    } else if (arg === "--baseline-current") {
      parsed.baselineCurrent = true;
    } else if (arg === "--active-imsg-probe") {
      parsed.activeProbe = true;
    } else if (arg === "--skip-local-history") {
      parsed.skipLocalHistory = true;
    } else if (arg === "--probe-text") {
      parsed.probeText = argv[++i];
    } else if (arg.startsWith("--probe-text=")) {
      parsed.probeText = arg.slice("--probe-text=".length);
    } else if (arg === "--probe-wait-ms") {
      parsed.probeWaitMs = argv[++i];
    } else if (arg.startsWith("--probe-wait-ms=")) {
      parsed.probeWaitMs = arg.slice("--probe-wait-ms=".length);
    } else if (arg === "--probe-poll-ms") {
      parsed.probePollMs = argv[++i];
    } else if (arg.startsWith("--probe-poll-ms=")) {
      parsed.probePollMs = arg.slice("--probe-poll-ms=".length);
    } else if (arg === "--restart-on-stale") {
      parsed.restartOnStale = true;
    } else if (arg === "--deep") {
      parsed.deep = true;
    } else {
      throw new Error(`Unsupported argument: ${arg}`);
    }
  }
  return parsed;
}

function withCliDefaults(args) {
  const here = new URL(".", import.meta.url);
  return {
    configPath: fileURLToPath(new URL("../config.local.json", here)),
    artifactDir: fileURLToPath(new URL("../../../outputs/imessage-bridge-diagnostics", here)),
    ...args
  };
}
