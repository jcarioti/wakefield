import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookConfig } from "./hooks.mjs";
import { ensureDir, pathExists, readJson, writeJson } from "./json-store.mjs";

const WAKEFIELD_STATUS = "Wakefield memory";

export function codexHome(env = process.env) {
  return expandHome(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function hooksPath(home = codexHome()) {
  return path.join(home, "hooks.json");
}

export function wakefieldHookCommand() {
  const commandPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  return `node ${JSON.stringify(commandPath)} hook`;
}

export async function installHooks({
  command = wakefieldHookCommand(),
  codexHomePath = codexHome()
}) {
  if (!command) throw new Error("installHooks needs a hook command.");
  const file = hooksPath(codexHomePath);
  const before = await readJson(file, {});
  const next = mergeWakefieldHooks(before, command);
  await writeJson(file, next);
  return {
    hooksPath: file,
    changed: JSON.stringify(before) !== JSON.stringify(next),
    configured: true
  };
}

export async function hooksStatus({
  command = wakefieldHookCommand(),
  codexHomePath = codexHome()
} = {}) {
  const file = hooksPath(codexHomePath);
  if (!await pathExists(file)) {
    return { hooksPath: file, exists: false, configured: false, commandExists: false };
  }
  const config = await readJson(file, {});
  const commands = wakefieldCommands(config);
  const configured = command ? commands.includes(command) : commands.length > 0;
  const commandExists = commands.length > 0
    ? await hookCommandExists(commands[0])
    : false;
  return {
    hooksPath: file,
    exists: true,
    configured,
    commands,
    commandExists
  };
}

export function mergeWakefieldHooks(existing, command) {
  const merged = {
    ...existing,
    hooks: { ...(existing?.hooks || {}) }
  };
  stripWakefieldHooks(merged.hooks);

  const wakefieldConfig = hookConfig({
    command,
    statusMessage: WAKEFIELD_STATUS
  });

  for (const [eventName, groups] of Object.entries(wakefieldConfig.hooks)) {
    merged.hooks[eventName] = [
      ...(merged.hooks[eventName] || []),
      ...groups
    ];
  }

  return merged;
}

function stripWakefieldHooks(hooks) {
  for (const [eventName, groups] of Object.entries(hooks)) {
    const nextGroups = [];
    for (const group of groups || []) {
      const nextHooks = (group.hooks || []).filter((hook) => !isWakefieldHook(hook));
      if (nextHooks.length > 0) {
        nextGroups.push({ ...group, hooks: nextHooks });
      }
    }
    if (nextGroups.length > 0) {
      hooks[eventName] = nextGroups;
    } else {
      delete hooks[eventName];
    }
  }
}

function wakefieldCommands(config) {
  const commands = [];
  for (const groups of Object.values(config?.hooks || {})) {
    for (const group of groups || []) {
      for (const hook of group.hooks || []) {
        if (isWakefieldHook(hook) && hook.command) commands.push(hook.command);
      }
    }
  }
  return [...new Set(commands)];
}

function isWakefieldHook(hook) {
  return String(hook?.statusMessage || "").startsWith(WAKEFIELD_STATUS);
}

async function hookCommandExists(command) {
  const match = String(command).match(/^node\s+"([^"]+)"\s+hook$/);
  if (!match) return true;
  try {
    await fs.access(match[1]);
    return true;
  } catch {
    return false;
  }
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
