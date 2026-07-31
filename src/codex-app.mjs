import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import { promisify } from "node:util";
import { expandHome } from "./paths.mjs";
import { CodexDesktopController } from "../packages/connector-shared/src/codex-desktop-controller.mjs";

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
  permissions = null,
  controller = null
} = {}) {
  if (!cwd) throw new Error("Creating a new Codex Desktop task needs a workspace folder.");
  const workspace = expandHome(cwd);
  const ownsController = controller == null;
  const desktop = controller || new CodexDesktopController();
  try {
    const task = await desktop.createTask({ cwd: workspace, permissions });
    const threadId = task.thread.id;
    const turn = prompt
      ? await desktop.startTurn({ threadId, cwd: workspace, text: prompt, permissions })
      : null;
    return {
      ok: true,
      action: "create-desktop-task",
      threadId,
      cwd: task.thread.cwd,
      task,
      turn
    };
  } finally {
    if (ownsController) desktop.disconnect();
  }
}

export async function resolveCodexCli(explicit = null, {
  env = process.env,
  access = fs.access
} = {}) {
  const candidates = [
    explicit,
    env.CODEX_CLI_PATH,
    "/Applications/ChatGPT.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/Resources/codex",
    "/Applications/Codex.app/Contents/MacOS/codex",
    "codex"
  ].filter(Boolean);

  for (const candidate of candidates) {
    if (candidate === "codex") return candidate;
    try {
      await access(expandHome(candidate));
      return expandHome(candidate);
    } catch {
      // Try the next candidate.
    }
  }
  return "codex";
}
