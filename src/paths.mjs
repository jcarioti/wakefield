import os from "node:os";
import path from "node:path";

const APP_NAME = "Wakefield";

export function appHome(env = process.env) {
  if (env.WAKEFIELD_HOME) return expandHome(env.WAKEFIELD_HOME);

  if (process.platform === "darwin") {
    return path.join(os.homedir(), "Library", "Application Support", APP_NAME);
  }

  if (process.platform === "win32") {
    return path.join(env.APPDATA || path.join(os.homedir(), "AppData", "Roaming"), APP_NAME);
  }

  return path.join(env.XDG_DATA_HOME || path.join(os.homedir(), ".local", "share"), "wakefield");
}

export function agentsDir(home = appHome()) {
  return path.join(home, "agents");
}

export function connectorsDir(home = appHome()) {
  return path.join(home, "connectors");
}

export function connectorConfigPath(connectorId, home = appHome()) {
  return path.join(connectorsDir(home), `${connectorId}.json`);
}

export function managedConnectorsConfigPath(home = appHome()) {
  return path.join(connectorsDir(home), "managed-connectors.json");
}

export function connectorStatePath(connectorId, home = appHome()) {
  return path.join(connectorsDir(home), `${connectorId}-state.json`);
}

export function appConfigPath(home = appHome()) {
  return path.join(home, "config.json");
}

export function serviceConfigPath(home = appHome()) {
  return path.join(home, "service.json");
}

export function contactsPath(home = appHome()) {
  return path.join(home, "contacts.json");
}

export function dutiesPath(home = appHome()) {
  return path.join(home, "duties.json");
}

export function logsDir(home = appHome()) {
  return path.join(home, "logs");
}

export function launchAgentsDir(env = process.env) {
  if (env.WAKEFIELD_LAUNCH_AGENTS_DIR) return expandHome(env.WAKEFIELD_LAUNCH_AGENTS_DIR);
  return path.join(os.homedir(), "Library", "LaunchAgents");
}

export function agentDir(agentId, home = appHome()) {
  return path.join(agentsDir(home), agentId);
}

export function profilePath(agentId, home = appHome()) {
  return path.join(agentDir(agentId, home), "profile.json");
}

export function soulPath(agentId, home = appHome()) {
  return path.join(agentDir(agentId, home), "AGENTS.md");
}

export function memoryDir(agentId, home = appHome()) {
  return path.join(agentDir(agentId, home), "memory");
}

export function memoryPath(agentId, name, home = appHome()) {
  return path.join(memoryDir(agentId, home), `${name}.jsonl`);
}

export function externalMessagesPath(agentId, home = appHome()) {
  return path.join(memoryDir(agentId, home), "external-messages.jsonl");
}

export function statePath(agentId, home = appHome()) {
  return path.join(memoryDir(agentId, home), "state.json");
}

export function expandHome(value) {
  if (typeof value !== "string") return value;
  if (value === "~") return os.homedir();
  if (value.startsWith("~/")) return path.join(os.homedir(), value.slice(2));
  return value;
}

export function isPathInside(child, parent) {
  const relative = path.relative(path.resolve(parent), path.resolve(child));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
