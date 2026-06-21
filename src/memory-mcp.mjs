import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ensureDir, pathExists } from "./json-store.mjs";
import { nodeExecutable } from "./node-runtime.mjs";
import { appHome, expandHome } from "./paths.mjs";

export const MEMORY_MCP_SERVER_NAME = "wakefield-memory";
export const MEMORY_MCP_TOOLS = [
  "wakefield_memory_status",
  "wakefield_memory_recall",
  "wakefield_memory_list_notes",
  "wakefield_memory_get_note",
  "wakefield_memory_upsert_note",
  "wakefield_memory_list_matters",
  "wakefield_memory_get_matter",
  "wakefield_memory_upsert_matter",
  "wakefield_memory_archive_matter",
  "wakefield_memory_forget",
  "wakefield_scheduler_status",
  "wakefield_scheduler_configure_duty",
  "wakefield_scheduler_configure_wakeup",
  "wakefield_scheduler_delete_duty",
  "wakefield_scheduler_delete_wakeup"
];

const MODULE_DIR = path.dirname(fileURLToPath(import.meta.url));

export function memoryMcpCommand({
  home = appHome(),
  agentId = null
} = {}) {
  const args = [
    path.join(MODULE_DIR, "mcp-memory-server.mjs"),
    "--home",
    home
  ];
  if (agentId) args.push("--agent-id", agentId);
  return [nodeExecutable(), ...args];
}

export async function memoryMcpStatus({
  home = appHome(),
  agent = null,
  codexConfigPath = null,
  agentId = null
} = {}) {
  const resolvedCodexConfigPath = await resolveMemoryMcpCodexConfigPath({
    codexConfigPath,
    agent
  });
  const command = memoryMcpCommand({ home, agentId: agentId || agent?.id || null });
  const checks = [
    check("Wakefield home", await pathExists(home), home),
    check("MCP script", await pathExists(command[1]), command[1]),
    check("Codex config path", Boolean(resolvedCodexConfigPath), resolvedCodexConfigPath || "missing")
  ];

  let text = "";
  if (resolvedCodexConfigPath) {
    text = await readText(resolvedCodexConfigPath, "");
    checks.push(check("Codex config exists", await pathExists(resolvedCodexConfigPath), resolvedCodexConfigPath));
    checks.push(check("MCP server entry", text.includes(`[mcp_servers.${MEMORY_MCP_SERVER_NAME}]`), MEMORY_MCP_SERVER_NAME));
    checks.push(check("MCP home argument", text.includes(home), home));
    for (const tool of MEMORY_MCP_TOOLS) {
      checks.push(check(`tool ${tool}`, text.includes(`[mcp_servers.${MEMORY_MCP_SERVER_NAME}.tools.${tool}]`) || text.includes(tool), tool, { optional: true }));
    }
  }

  return {
    ok: checks.filter((item) => !item.optional).every((item) => item.ok),
    serverName: MEMORY_MCP_SERVER_NAME,
    command,
    codexConfigPath: resolvedCodexConfigPath,
    tools: MEMORY_MCP_TOOLS,
    checks
  };
}

export async function printMemoryMcp({
  home = appHome(),
  agentId = null
} = {}) {
  return memoryMcpBlock({ home, agentId });
}

export async function installMemoryMcp({
  home = appHome(),
  agent = null,
  agentId = null,
  codexConfigPath = null,
  dryRun = false
} = {}) {
  const resolvedCodexConfigPath = await resolveMemoryMcpCodexConfigPath({
    codexConfigPath,
    agent
  });
  if (!resolvedCodexConfigPath) {
    throw new Error("Wakefield memory MCP install needs --codex-config or an agent cwd.");
  }

  const block = memoryMcpBlock({
    home,
    agentId: agentId || agent?.id || null
  });
  const before = await readText(resolvedCodexConfigPath, "");
  const after = upsertTomlSections(before, memoryMcpSectionNames(), block);
  const changed = before !== after;

  if (!dryRun && changed) {
    await ensureDir(path.dirname(resolvedCodexConfigPath));
    await fs.writeFile(resolvedCodexConfigPath, after);
  }

  return {
    ok: true,
    changed: dryRun ? false : changed,
    dryRun,
    serverName: MEMORY_MCP_SERVER_NAME,
    command: memoryMcpCommand({ home, agentId: agentId || agent?.id || null }),
    codexConfigPath: resolvedCodexConfigPath,
    tools: MEMORY_MCP_TOOLS,
    block
  };
}

export function formatMemoryMcpStatus(status) {
  const lines = [
    "Wakefield memory MCP",
    `server: ${status.serverName}`,
    `codex config: ${status.codexConfigPath || "missing"}`,
    `command: ${status.command.join(" ")}`,
    ""
  ];
  for (const item of status.checks) {
    lines.push(`${item.ok ? "ok" : item.optional ? "info" : "missing"}: ${item.label} - ${item.detail}`);
  }
  return lines.join("\n");
}

export function formatMemoryMcpInstall(result) {
  if (result.dryRun) return `Wakefield memory MCP dry run: ${result.codexConfigPath}`;
  return result.changed
    ? `Installed Wakefield memory MCP server ${result.serverName}: ${result.codexConfigPath}`
    : `Wakefield memory MCP server ${result.serverName} already configured: ${result.codexConfigPath}`;
}

function memoryMcpBlock({ home, agentId = null }) {
  const [program, ...args] = memoryMcpCommand({ home, agentId });
  return [
    `[mcp_servers.${MEMORY_MCP_SERVER_NAME}]`,
    `command = ${tomlString(program)}`,
    `args = [${args.map(tomlString).join(", ")}]`,
    "startup_timeout_sec = 30.0",
    "tool_timeout_sec = 30.0",
    "",
    ...MEMORY_MCP_TOOLS.flatMap((tool) => [
      `[mcp_servers.${MEMORY_MCP_SERVER_NAME}.tools.${tool}]`,
      "approval_mode = \"approve\"",
      ""
    ])
  ].join("\n");
}

function memoryMcpSectionNames() {
  return new Set([
    `mcp_servers.${MEMORY_MCP_SERVER_NAME}`,
    ...MEMORY_MCP_TOOLS.map((tool) => `mcp_servers.${MEMORY_MCP_SERVER_NAME}.tools.${tool}`)
  ]);
}

async function resolveMemoryMcpCodexConfigPath({ codexConfigPath, agent }) {
  if (codexConfigPath) return path.resolve(expandHome(codexConfigPath));
  const found = await findNearestCodexConfig(agent?.cwd || process.cwd());
  if (found) return found;
  if (agent?.cwd) return path.join(agent.cwd, ".codex", "config.toml");
  return null;
}

async function findNearestCodexConfig(startDir) {
  let current = path.resolve(expandHome(startDir || process.cwd()));
  for (;;) {
    const candidate = path.join(current, ".codex", "config.toml");
    if (await pathExists(candidate)) return candidate;
    const parent = path.dirname(current);
    if (parent === current) return null;
    current = parent;
  }
}

function upsertTomlSections(text, sectionNames, block) {
  const lines = text.split("\n");
  const kept = [];
  let dropping = false;
  for (const line of lines) {
    const section = tomlSectionName(line);
    if (section) dropping = sectionNames.has(section);
    if (!dropping) kept.push(line);
  }
  const trimmed = kept.join("\n").trimEnd();
  return `${trimmed ? `${trimmed}\n\n` : ""}${block.trimEnd()}\n`;
}

function tomlSectionName(line) {
  const match = String(line).trim().match(/^\[([^\]]+)]$/);
  return match ? match[1] : null;
}

function tomlString(value) {
  return JSON.stringify(String(value));
}

async function readText(file, fallback = null) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return fallback;
    throw error;
  }
}

function check(label, ok, detail, { optional = false } = {}) {
  return { label, ok: Boolean(ok), detail, optional };
}
