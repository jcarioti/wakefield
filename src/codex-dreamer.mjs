import { execFile } from "node:child_process";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expandHome } from "./paths.mjs";

const execFileAsync = promisify(execFile);
const DEFAULT_TIMEOUT_MS = 120000;
const DEFAULT_DREAM_MODEL = "gpt-5.4-mini";

export function codexDreamerConfig(env = process.env) {
  const provider = String(env.WAKEFIELD_MEMORY_PROVIDER || "codex").trim().toLowerCase();
  return {
    provider,
    enabled: provider === "codex",
    codexPath: env.WAKEFIELD_DREAM_CODEX_PATH || env.WAKEFIELD_CODEX_PATH || "codex",
    codexHome: env.WAKEFIELD_DREAM_CODEX_HOME || null,
    model: env.WAKEFIELD_DREAM_MODEL || env.WAKEFIELD_MEMORY_MODEL || DEFAULT_DREAM_MODEL,
    reasoningEffort: env.WAKEFIELD_DREAM_REASONING_EFFORT || "low",
    ephemeral: env.WAKEFIELD_DREAM_CODEX_EPHEMERAL !== "false",
    ignoreUserConfig: env.WAKEFIELD_DREAM_CODEX_IGNORE_USER_CONFIG !== "false",
    timeoutMs: positiveInteger(env.WAKEFIELD_DREAM_CODEX_TIMEOUT_MS, DEFAULT_TIMEOUT_MS)
  };
}

export async function createCodexStructuredMemoryResponse({
  prompt,
  schema,
  config = codexDreamerConfig(),
  execFileImpl = execFileAsync
}) {
  if (!config.enabled) {
    throw new Error(`Unsupported Wakefield memory provider: ${config.provider}`);
  }

  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "wakefield-codex-dream-"));
  const schemaPath = path.join(tempDir, "memory-capture.schema.json");
  await fs.writeFile(schemaPath, `${JSON.stringify(schema, null, 2)}\n`);

  const args = codexExecArgs({
    prompt,
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
  prompt,
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
  args.push(prompt);
  return args;
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
