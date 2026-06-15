import path from "node:path";
import { doctor } from "./doctor.mjs";
import { installHooks } from "./hook-manager.mjs";
import { appHome, expandHome } from "./paths.mjs";
import { initAgent, loadAgent, saveAgent, selectThread } from "./profile.mjs";
import { installWakefieldSkills } from "./skills.mjs";

export async function installWakefield({
  name = "Wakefield",
  soul = "",
  threadId = null,
  cwd = null,
  overwriteAgent = false,
  skipHooks = false,
  skipSkills = false,
  home = appHome(),
  codexHomePath = null
} = {}) {
  let profile = await loadAgent(null, home);
  let createdAgent = false;

  if (!profile || overwriteAgent) {
    profile = await initAgent({
      name,
      soul,
      threadId,
      cwd,
      home,
      overwrite: overwriteAgent
    });
    createdAgent = true;
  } else if (threadId || (cwd && profile.threadId)) {
    profile = await selectThread({
      threadId: threadId || profile.threadId,
      cwd,
      home
    });
  } else if (cwd) {
    profile = await saveAgent({
      ...profile,
      cwd: path.resolve(expandHome(cwd))
    }, home);
  }

  const hookResult = skipHooks
    ? null
    : await installHooks({ codexHomePath: codexHomePath || undefined });
  const skillResult = skipSkills
    ? null
    : await installWakefieldSkills({ codexHomePath: codexHomePath || undefined });

  return {
    profile,
    createdAgent,
    hookResult,
    skillResult,
    doctor: await doctor({ home, codexHomePath: codexHomePath || undefined })
  };
}
