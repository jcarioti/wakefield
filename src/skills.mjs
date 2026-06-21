import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome } from "./hook-manager.mjs";
import { ensureDir, pathExists } from "./json-store.mjs";

const BUNDLED_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");
const RENAMED_BUNDLED_SKILLS = [
  ["wakefield-codex-tool-refresh", "codex-mcp-tool-refresh"],
  ["wakefield-discord", "discord-connector"],
  ["wakefield-external-source-replies", "external-source-replies"],
  ["wakefield-imessage", "imessage-connector"],
  ["wakefield-memory", "scoped-memory"],
  ["wakefield-scheduled-wakeup", "scheduled-wakeup"],
  ["wakefield-scheduler-management", "scheduler-management"],
  ["wakefield-shared-room-etiquette", "shared-room-etiquette"],
  ["wakefield-subagent-continuity", "subagent-continuity"]
];

export async function installWakefieldSkills({
  codexHomePath = codexHome()
} = {}) {
  const skills = await bundledWakefieldSkillNames();
  const skillsRoot = path.join(codexHomePath, "skills");
  await ensureDir(skillsRoot);
  const removedLegacy = await removeRenamedBundledSkills(skillsRoot, skills);

  const installed = [];
  for (const name of skills) {
    const source = path.join(BUNDLED_SKILLS_DIR, name);
    const destination = path.join(skillsRoot, name);
    const sourceText = await fs.readFile(path.join(source, "SKILL.md"), "utf8");
    const beforeText = await readOptionalText(path.join(destination, "SKILL.md"));
    const changed = beforeText !== sourceText;
    if (changed) {
      await fs.rm(destination, { recursive: true, force: true });
      await fs.cp(source, destination, { recursive: true });
    }
    installed.push({ name, path: destination, changed });
  }

  return {
    skillsRoot,
    installed,
    removedLegacy,
    configured: installed.every((skill) => skill.path)
  };
}

export async function wakefieldSkillsStatus({
  codexHomePath = codexHome()
} = {}) {
  const skills = await bundledWakefieldSkillNames();
  const installed = [];
  for (const name of skills) {
    const skillPath = path.join(codexHomePath, "skills", name, "SKILL.md");
    installed.push({
      name,
      path: skillPath,
      installed: await pathExists(skillPath)
    });
  }
  return {
    skillsRoot: path.join(codexHomePath, "skills"),
    installed,
    configured: installed.every((skill) => skill.installed)
  };
}

export async function bundledWakefieldSkillNames() {
  const entries = await fs.readdir(BUNDLED_SKILLS_DIR, { withFileTypes: true });
  const names = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const skillPath = path.join(BUNDLED_SKILLS_DIR, entry.name, "SKILL.md");
    if (!await pathExists(skillPath)) {
      throw new Error(`Bundled Wakefield skill is missing SKILL.md: ${entry.name}`);
    }
    names.push(entry.name);
  }
  return names.sort();
}

async function readOptionalText(file) {
  try {
    return await fs.readFile(file, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function removeRenamedBundledSkills(skillsRoot, bundledNames) {
  const removed = [];
  for (const [legacyName, replacementName] of RENAMED_BUNDLED_SKILLS) {
    if (!bundledNames.includes(replacementName)) continue;
    const legacyPath = path.join(skillsRoot, legacyName);
    const legacyText = await readOptionalText(path.join(legacyPath, "SKILL.md"));
    if (!legacyText) continue;
    if (!new RegExp(`^name:\\s*${escapeRegExp(legacyName)}\\s*$`, "m").test(legacyText)) continue;
    await fs.rm(legacyPath, { recursive: true, force: true });
    removed.push({ name: legacyName, path: legacyPath, replacedBy: replacementName });
  }
  return removed;
}

function escapeRegExp(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
