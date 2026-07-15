import path from "node:path";
import { doctor } from "./doctor.mjs";
import { installHooks, wakefieldHookCommand } from "./hook-manager.mjs";
import { appHome, expandHome } from "./paths.mjs";
import { ensureAgentMemory, initAgent, loadAgent, saveAgent, selectThread } from "./profile.mjs";
import { normalizeCodexPermissions } from "./codex-permissions.mjs";
import { installWakefieldSkills } from "./skills.mjs";

export async function installWakefield({
  name = "Wakefield",
  soul = "",
  ownerName = null,
  threadId = null,
  cwd = null,
  agentHome = null,
  codexPermissions = undefined,
  newAgent = false,
  overwriteAgent = false,
  skipHooks = false,
  skipSkills = false,
  home = appHome(),
  codexHomePath = null
} = {}) {
  let profile = newAgent ? null : await loadAgent(null, home);
  let createdAgent = false;

  if (!profile || overwriteAgent) {
    profile = await initAgent({
      name,
      soul,
      ownerName,
      threadId,
      cwd,
      agentHome,
      codexPermissions,
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
  if (codexPermissions !== undefined) {
    profile = await saveAgent({
      ...profile,
      codexPermissions: normalizeCodexPermissions(codexPermissions)
    }, home);
  }
  profile = await ensureAgentMemory(profile, home);

  const hookResult = skipHooks
    ? null
    : await installHooks({
      command: wakefieldHookCommand({ home }),
      codexHomePath: codexHomePath || undefined
    });
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
