import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { hookConfig } from "./hooks.mjs";
import { ensureDir, pathExists, readJson, writeJson } from "./json-store.mjs";
import { nodeExecutable } from "./node-runtime.mjs";
import { appHome } from "./paths.mjs";

const WAKEFIELD_STATUS = "Wakefield memory";

export function codexHome(env = process.env) {
  return expandHome(env.CODEX_HOME || path.join(os.homedir(), ".codex"));
}

export function hooksPath(home = codexHome()) {
  return path.join(home, "hooks.json");
}

export function wakefieldHookCommand({ home = appHome() } = {}) {
  const commandPath = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "cli.mjs");
  return `env WAKEFIELD_HOME=${shellQuote(home)} ${shellQuote(nodeExecutable())} ${shellQuote(commandPath)} hook`;
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
  const configured = command
    ? await hasMatchingWakefieldCommand(commands, command)
    : commands.length > 0;
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

async function hasMatchingWakefieldCommand(commands, command) {
  if (commands.includes(command)) return true;
  const expected = hookCommandTarget(command);
  if (!expected) return false;
  for (const existing of commands) {
    const actual = hookCommandTarget(existing);
    if (actual && await sameHookCommandTarget(actual, expected)) {
      return true;
    }
  }
  return false;
}

function hookCommandTarget(command) {
  const words = splitCommandWords(String(command));
  if (words.length === 0) return null;

  let commandStart = 0;
  let home = null;
  if (words[0] === "env") {
    commandStart = 1;
    while (commandStart < words.length && envAssignmentName(words[commandStart])) {
      if (envAssignmentName(words[commandStart]) === "WAKEFIELD_HOME") {
        home = envAssignmentValue(words[commandStart]);
      }
      commandStart += 1;
    }
  }

  const cliIndex = words.findIndex((word, index) => (
    index >= commandStart && word.endsWith("cli.mjs") && words[index + 1] === "hook"
  ));
  if (cliIndex < 0) return null;

  return {
    home,
    nodePath: cliIndex > commandStart ? words[cliIndex - 1] : null,
    cliPath: words[cliIndex]
  };
}

async function sameHookCommandTarget(left, right) {
  if (left.home !== right.home) return false;
  if (!await samePath(left.cliPath, right.cliPath)) return false;
  if (!left.nodePath || !right.nodePath) return left.nodePath === right.nodePath;
  return samePath(left.nodePath, right.nodePath);
}

async function samePath(left, right) {
  if (left === right) return true;
  if (!path.isAbsolute(left) || !path.isAbsolute(right)) return false;
  try {
    return await fs.realpath(left) === await fs.realpath(right);
  } catch {
    return false;
  }
}

function splitCommandWords(value) {
  const words = [];
  let current = "";
  let quote = null;
  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (quote === "'") {
      if (char === "'") {
        quote = null;
      } else {
        current += char;
      }
      continue;
    }
    if (quote === "\"") {
      if (char === "\"") {
        quote = null;
      } else if (char === "\\" && index + 1 < value.length) {
        index += 1;
        current += value[index];
      } else {
        current += char;
      }
      continue;
    }
    if (/\s/.test(char)) {
      if (current) {
        words.push(current);
        current = "";
      }
      continue;
    }
    if (char === "'" || char === "\"") {
      quote = char;
      continue;
    }
    if (char === "\\" && index + 1 < value.length) {
      index += 1;
      current += value[index];
      continue;
    }
    current += char;
  }
  if (current) words.push(current);
  return words;
}

function envAssignmentName(word) {
  const separator = word.indexOf("=");
  if (separator <= 0) return null;
  const name = word.slice(0, separator);
  return /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null;
}

function envAssignmentValue(word) {
  return word.slice(word.indexOf("=") + 1);
}

function isWakefieldHook(hook) {
  return String(hook?.statusMessage || "").startsWith(WAKEFIELD_STATUS);
}

async function hookCommandExists(command) {
  const match = String(command).match(/(?:"([^"]+cli\.mjs)"|'([^']+cli\.mjs)'|(\S+cli\.mjs))\s+hook\b/);
  if (!match) return true;
  const commandPath = match[1] || match[2] || match[3];
  try {
    await fs.access(commandPath);
    return true;
  } catch {
    return false;
  }
}

function shellQuote(value) {
  return `'${String(value).replaceAll("'", "'\\''")}'`;
}

function expandHome(value) {
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}
