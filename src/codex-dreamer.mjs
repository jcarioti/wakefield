import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { expandHome } from "./paths.mjs";

const DEFAULT_TIMEOUT_MS = 300000;
const DEFAULT_DREAM_MODEL = "gpt-5.4-mini";
const DEFAULT_CODEX_PATHS = [
  "/Applications/Codex.app/Contents/Resources/codex",
  "/opt/homebrew/bin/codex",
  "/usr/local/bin/codex"
];

export function codexDreamerConfig(env = process.env) {
  const provider = String(env.WAKEFIELD_MEMORY_PROVIDER || "codex").trim().toLowerCase();
  return {
    provider,
    enabled: provider === "codex",
    codexPath: env.WAKEFIELD_DREAM_CODEX_PATH || env.WAKEFIELD_CODEX_PATH || defaultCodexPath(),
    codexHome: env.WAKEFIELD_DREAM_CODEX_HOME || null,
    model: env.WAKEFIELD_DREAM_MODEL || env.WAKEFIELD_MEMORY_MODEL || DEFAULT_DREAM_MODEL,
    reasoningEffort: env.WAKEFIELD_DREAM_REASONING_EFFORT || "low",
    ephemeral: env.WAKEFIELD_DREAM_CODEX_EPHEMERAL !== "false",
    ignoreUserConfig: env.WAKEFIELD_DREAM_CODEX_IGNORE_USER_CONFIG !== "false",
    timeoutMs: positiveInteger(env.WAKEFIELD_DREAM_CODEX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

function defaultCodexPath() {
  return DEFAULT_CODEX_PATHS.find((candidate) => existsSync(candidate)) || "codex";
}

export async function createCodexStructuredMemoryResponse({
  prompt,
  schema,
  config = codexDreamerConfig(),
  execFileImpl = execFileWithInput
}) {
  if (!config.enabled) {
    throw new Error(`Unsupported Wakefield memory provider: ${config.provider}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-codex-dream-"));
  const schemaPath = path.join(tempDir, "memory-capture.schema.json");
  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  const args = codexExecArgs({
    schemaPath,
    cwd: tempDir,
    model: config.model,
    reasoningEffort: config.reasoningEffort,
    ephemeral: config.ephemeral,
    ignoreUserConfig: config.ignoreUserConfig
  });
  const env = {
    ...process.env,
    WAKEFIELD_CODEX_DREAMER: "1"
  };
  if (config.codexHome) env.CODEX_HOME = expandHome(config.codexHome);

  try {
    const { stdout } = await execFileImpl(config.codexPath, args, {
      cwd: tempDir,
      env,
      input: prompt,
      timeout: config.timeoutMs,
      maxBuffer: 1024 * 1024 * 4
    });
    return parseCodexStructuredOutput(stdout);
  } catch (error) {
    const stderr = String(error?.stderr || "").trim();
    const detail = stderr ? ` ${stderr.split(/\r?\n/g).slice(-6).join(" ")}` : "";
    throw new Error(`Codex dreamer failed: ${error?.message || String(error)}${detail}`);
  } finally {
    await fs.rm(tempDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function codexExecArgs({
  schemaPath,
  cwd,
  model = null,
  reasoningEffort = "low",
  ephemeral = true,
  ignoreUserConfig = false
}) {
  const args = [
    "-s",
    "read-only",
    "-a",
    "never",
    "--disable",
    "hooks",
    "-c",
    `model_reasoning_effort="${reasoningEffort || "low"}"`,
    "exec",
    "--skip-git-repo-check",
    "--ignore-rules",
    "--cd",
    cwd,
    "--output-schema",
    schemaPath
  ];
  if (ephemeral) args.push("--ephemeral");
  if (ignoreUserConfig) args.push("--ignore-user-config");
  if (model) args.push("--model", model);
  args.push("-");
  return args;
}

async function execFileWithInput(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(file, args, {
      cwd: options.cwd,
      env: options.env,
      stdio: ["pipe", "pipe", "pipe"]
    });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const maxBuffer = positiveInteger(options.maxBuffer, 1024 * 1024 * 4);

    const finish = (error, value = null) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      if (error) {
        error.stdout = stdout;
        error.stderr = stderr;
        reject(error);
      } else {
        resolve(value);
      }
    };

    const appendOutput = (name, chunk) => {
      if (settled) return;
      if (name === "stdout") stdout += chunk;
      else stderr += chunk;
      if (Buffer.byteLength(stdout) + Buffer.byteLength(stderr) > maxBuffer) {
        child.kill("SIGTERM");
        finish(new Error(`Command exceeded maxBuffer ${maxBuffer}`));
      }
    };

    const timer = options.timeout
      ? setTimeout(() => {
          child.kill("SIGTERM");
          finish(new Error(`Command timed out after ${options.timeout}ms`));
        }, options.timeout)
      : null;

    child.stdout.on("data", (chunk) => appendOutput("stdout", chunk));
    child.stderr.on("data", (chunk) => appendOutput("stderr", chunk));
    child.on("error", finish);
    child.on("close", (code, signal) => {
      if (code === 0) {
        finish(null, { stdout, stderr });
        return;
      }
      const reason = signal ? `signal ${signal}` : `exit code ${code}`;
      finish(new Error(`Command failed: ${file} ${args.join(" ")} (${reason})`));
    });

    child.stdin.end(options.input || "");
  });
}

export function parseCodexStructuredOutput(stdout) {
  const text = String(stdout || "").trim();
  if (!text) throw new Error("Codex dreamer did not produce output.");
  try {
    return JSON.parse(text);
  } catch {
    for (const line of text.split(/\r?\n/g).reverse()) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      try {
        return JSON.parse(trimmed);
      } catch {
        // Keep looking for the final JSON line.
      }
    }
    throw new Error("Codex dreamer output was not valid JSON.");
  }
}

function positiveInteger(value, fallback) {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : fallback;
}
