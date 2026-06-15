import fs from "node:fs/promises";
import { expandHome } from "./paths.mjs";

export async function loadEnvFile(file, {
  env = process.env,
  override = false
} = {}) {
  const status = await envFileStatus(file);
  if (!status.configured || !status.exists) {
    return {
      ...status,
      loaded: false,
      keys: [],
      loadedKeys: []
    };
  }

  const parsed = parseEnv(await fs.readFile(status.path, "utf8"));
  const loadedKeys = [];
  for (const [key, value] of Object.entries(parsed)) {
    if (!override && env[key] != null) continue;
    env[key] = value;
    loadedKeys.push(key);
  }

  return {
    ...status,
    loaded: true,
    keys: Object.keys(parsed),
    loadedKeys
  };
}

export async function envFileStatus(file) {
  if (!file) {
    return {
      configured: false,
      path: null,
      exists: false,
      secure: null,
      warnings: []
    };
  }

  const resolved = expandHome(String(file));
  try {
    const stat = await fs.stat(resolved);
    const insecureMode = process.platform !== "win32" && Boolean(stat.mode & 0o077);
    return {
      configured: true,
      path: resolved,
      exists: stat.isFile(),
      secure: process.platform === "win32" ? null : !insecureMode,
      warnings: insecureMode ? ["Env file is readable by group or other users."] : []
    };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    return {
      configured: true,
      path: resolved,
      exists: false,
      secure: null,
      warnings: ["Env file does not exist."]
    };
  }
}

function parseEnv(text) {
  const values = {};
  for (const rawLine of String(text || "").split(/\r?\n/)) {
    const parsed = parseEnvLine(rawLine);
    if (parsed) values[parsed.key] = parsed.value;
  }
  return values;
}

function parseEnvLine(line) {
  let text = String(line || "").trim();
  if (!text || text.startsWith("#")) return null;
  if (text.startsWith("export ")) text = text.slice("export ".length).trim();
  const index = text.indexOf("=");
  if (index <= 0) return null;
  const key = text.slice(0, index).trim();
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) return null;
  return {
    key,
    value: unquoteEnvValue(text.slice(index + 1).trim())
  };
}

function unquoteEnvValue(value) {
  if (value.length >= 2 && value.startsWith('"') && value.endsWith('"')) {
    return value.slice(1, -1)
      .replaceAll("\\n", "\n")
      .replaceAll('\\"', '"')
      .replaceAll("\\\\", "\\");
  }
  if (value.length >= 2 && value.startsWith("'") && value.endsWith("'")) {
    return value.slice(1, -1);
  }
  const hash = value.indexOf(" #");
  return hash >= 0 ? value.slice(0, hash).trimEnd() : value;
}
