import fs from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { codexHome } from "./hook-manager.mjs";
import { ensureDir, pathExists } from "./json-store.mjs";

const BUNDLED_SKILLS_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..", "skills");

export async function installWakefieldSkills({
  codexHomePath = codexHome()
} = {}) {
  const skills = await bundledWakefieldSkillNames();
  const skillsRoot = path.join(codexHomePath, "skills");
  await ensureDir(skillsRoot);

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
