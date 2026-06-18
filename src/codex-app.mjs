import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { expandHome } from "./paths.mjs";

const execFileAsync = promisify(execFile);

export async function openCodexWorkspace({
  cwd,
  codexPath = null,
  execFileImpl = execFileAsync
} = {}) {
  if (!cwd) throw new Error("Opening Codex needs a workspace folder.");
  const command = await resolveCodexCli(codexPath);
  const workspace = expandHome(cwd);
  const result = await execFileImpl(command, ["app", workspace], {
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  return {
    ok: true,
    command: [command, "app", workspace],
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

export async function openCodexNewThread({
  cwd,
  prompt = "",
  openCommand = null,
  execFileImpl = execFileAsync
} = {}) {
  if (!cwd) throw new Error("Opening a new Codex thread needs a workspace folder.");
  const workspace = expandHome(cwd);
  const url = codexNewThreadUrl({ cwd: workspace, prompt });
  const command = openCommand || defaultOpenCommand();
  if (!command) throw new Error("Codex deep links are only supported on macOS right now.");
  const result = await execFileImpl(command, [url], {
    timeout: 30000,
    maxBuffer: 1024 * 1024
  });
  return {
    ok: true,
    url,
    command: [command, url],
    stdout: result.stdout || "",
    stderr: result.stderr || ""
  };
}

export function codexNewThreadUrl({ cwd, prompt = "" }) {
  const params = new URLSearchParams();
  params.set("path", cwd);
  if (prompt) params.set("prompt", prompt);
  return `codex://threads/new?${params.toString()}`;
}

export async function resolveCodexCli(explicit = null) {
  const candidates = [
    explicit,
    process.env.CODEX_CLI_PATH,
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/MacOS/codex",
    "codex"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "codex") return candidate;
    try {
      await fs.access(expandHome(candidate));
      return expandHome(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return "codex";
}

function defaultOpenCommand() {
  return process.platform === "darwin" ? "/usr/bin/open" : null;
}
