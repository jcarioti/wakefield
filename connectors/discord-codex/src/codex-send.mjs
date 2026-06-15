#!/usr/bin/env node
import { getTarget, loadConnectorConfig, parseCliArgs } from "./config.mjs";
import { sendTextToCodexTarget } from "./codex-router.mjs";

const args = parseCliArgs();
if (args.help || !args.text) {
  console.log("Usage: discord-codex-send --config connectors/discord-codex/config.local.json --target rick --mode auto --text \"hello\"");
  process.exit(args.help ? 0 : 1);
}

const config = await loadConnectorConfig({ configPath: args.configPath });
const target = getTarget(config, args.targetId);
const result = await sendTextToCodexTarget({
  target,
  text: args.text,
  mode: args.mode || "auto",
  codex: config.codex
});
console.log(JSON.stringify(result, null, 2));
