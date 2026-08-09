import fs from "node:fs/promises";
import path from "node:path";
import { appConfigPath, appHome } from "./paths.mjs";
import { probeCodexRuntime } from "./codex-runtime-probe.mjs";
import { hooksStatus, wakefieldHookCommand } from "./hook-manager.mjs";
import { listAgents, loadAgent } from "./profile.mjs";
import { pathExists } from "./json-store.mjs";
import { wakefieldSkillsStatus } from "./skills.mjs";
import { probeCodexDesktopController } from "../packages/connector-shared/src/codex-desktop-controller.mjs";

export async function doctor({
  home = appHome(),
  codexHomePath = null,
  runtimeProbe = probeCodexRuntime,
  desktopControllerProbe = probeCodexDesktopController
} = {}) {
  const agents = await listAgents(home);
  const current = await loadAgent(null, home);
  const hooks = await hooksStatus({
    command: wakefieldHookCommand({ home }),
    codexHomePath: codexHomePath || undefined
  });
  const skills = await wakefieldSkillsStatus({ codexHomePath: codexHomePath || undefined });
  const codexRuntime = await runtimeProbe({
    ...(codexHomePath ? { sessionsPath: path.join(codexHomePath, "sessions") } : {})
  });
  const desktopController = await desktopControllerProbe();
  const checks = [];

  checks.push(check("Wakefield home", true, home));
  checks.push(check("App config", await pathExists(appConfigPath(home)), appConfigPath(home)));
  checks.push(check("Agents", agents.length > 0, `${agents.length} configured`));
  checks.push(check("Codex hook config", hooks.configured, hooks.hooksPath));
  if (hooks.configured) {
    checks.push(check("Codex hook command", hooks.commandExists, hooks.commands?.[0] || "not found"));
  }
  checks.push(check("Codex Wakefield skills", skills.configured, skills.installed.map((skill) => `${skill.name}:${skill.installed ? "installed" : "missing"}`).join(", ")));
  checks.push(check(
    "ChatGPT/Codex IPC",
    codexRuntime.status === "compatible",
    formatRuntimeDetail(codexRuntime),
    { optional: codexRuntime.status === "unavailable" }
  ));
  checks.push(check(
    "Codex session rollouts",
    codexRuntime.sessionsReadable,
    codexRuntime.sessionsPath,
    { optional: true }
  ));
  const desktopOptional = !desktopController.socket.ok;
  checks.push(check(
    "Codex daemon socket",
    desktopController.socket.ok,
    desktopController.socket.path,
    { optional: desktopOptional }
  ));
  checks.push(check(
    "Codex daemon ownership",
    desktopController.daemon.ok,
    desktopController.daemon.detail,
    { optional: desktopOptional }
  ));
  checks.push(check(
    "ChatGPT Desktop protocol",
    desktopController.protocol.ok,
    desktopController.protocol.detail,
    { optional: desktopOptional }
  ));
  checks.push(check(
    "Codex remote-device control (optional)",
    desktopController.remote.ok,
    desktopController.remote.detail,
    { optional: true }
  ));
  checks.push(check(
    "ChatGPT Desktop MCP runtime",
    desktopController.mcp.ok,
    desktopController.mcp.detail,
    { optional: desktopOptional }
  ));

  if (current) {
    checks.push(check("Current agent", true, `${current.name} (${current.id})`));
    checks.push(check("Soul file", await pathExists(current.soulPath), current.soulPath));
    checks.push(check("Inbox memory", await pathExists(current.memory.inboxPath), current.memory.inboxPath));
    checks.push(check("Journal memory", await pathExists(current.memory.journalPath), current.memory.journalPath));
    checks.push(check("Dream memory", await pathExists(current.memory.dreamsPath), current.memory.dreamsPath));
    if (current.memory.externalMessagesPath) {
      checks.push(check("External inbox", await pathExists(current.memory.externalMessagesPath), current.memory.externalMessagesPath));
    }
    checks.push(check("State memory", await pathExists(current.memory.statePath), current.memory.statePath));
    const memoryPermissions = await inspectMemoryPermissions(current.memory);
    checks.push(check("Memory permissions", memoryPermissions.ok, memoryPermissions.detail, {
      optional: memoryPermissions.optional
    }));
    checks.push(check("Codex thread", Boolean(current.threadId), current.threadId || "not selected yet"));
    checks.push(check("Codex cwd", Boolean(current.cwd), current.cwd || "not set"));
  }

  return {
    ok: checks.every((item) => item.ok || item.optional),
    home,
    hooks,
    skills,
    codexRuntime,
    desktopController,
    checks
  };
}

export function formatDoctor(result) {
  const lines = ["Wakefield doctor", `home: ${result.home}`, ""];
  for (const item of result.checks) {
    lines.push(`${item.ok ? "ok" : item.optional ? "warn" : "fail"}: ${item.label} - ${item.detail}`);
  }
  lines.push("", result.ok ? "doctor ok" : "doctor found setup gaps");
  return lines.join("\n");
}

function check(label, ok, detail, { optional = false } = {}) {
  return { label, ok: Boolean(ok), detail, optional };
}

function formatRuntimeDetail(runtime) {
  if (runtime.status === "compatible") {
    return `${runtime.socketPath}; initialize succeeded; follower protocol not tested`;
  }
  if (runtime.status === "unavailable") {
    return `${runtime.reason}; ChatGPT desktop may be closed`;
  }
  return `${runtime.reason}; IPC initialize or access check failed`;
}

async function inspectMemoryPermissions(memory) {
  if (process.platform === "win32") {
    return {
      ok: true,
      optional: true,
      detail: "Unix permission bits are not enforced on Windows"
    };
  }
  const files = Object.entries(memory || {})
    .filter(([key, value]) => key.endsWith("Path") && typeof value === "string")
    .map(([, value]) => value);
  const issues = [];
  for (const dir of new Set(files.map((file) => path.dirname(file)))) {
    const stat = await fs.stat(dir).catch(() => null);
    if (stat && (stat.mode & 0o077) !== 0) issues.push(`${dir} is ${octalMode(stat.mode)}`);
  }
  for (const file of files) {
    const stat = await fs.stat(file).catch(() => null);
    if (stat && (stat.mode & 0o077) !== 0) issues.push(`${file} is ${octalMode(stat.mode)}`);
  }
  return {
    ok: issues.length === 0,
    optional: false,
    detail: issues.length === 0 ? "directories 0700; files 0600" : issues.join("; ")
  };
}

function octalMode(mode) {
  return (mode & 0o777).toString(8).padStart(4, "0");
}
