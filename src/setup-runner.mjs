import { listRecentThreads } from "./codex-sessions.mjs";
import { installWakefield } from "./install.mjs";
import { appHome, codexConfigPath } from "./paths.mjs";
import { installMemoryMcp } from "./memory-mcp.mjs";
import { loadAgent, selectThread } from "./profile.mjs";
import { configureService, installLaunchAgent } from "./service.mjs";
import { setupStatus } from "./setup.mjs";

export async function runSetup({
  home = appHome(),
  codexHomePath = null,
  name = "Wakefield",
  soul = "",
  ownerName = null,
  threadId = null,
  latestThread = false,
  cwd = null,
  agentHome = null,
  newAgent = false,
  skipHooks = false,
  enableService = false,
  intervalMinutes = null,
  enableDispatch = false,
  dispatchMode = null,
  dispatchLimit = null,
  envFile = null,
  installScheduler = false,
  loadScheduler = false,
  reloadScheduler = false,
  launchAgentsPath = null
} = {}) {
  const actions = [];
  const before = newAgent ? null : await loadAgent(null, home);
  const resolvedThreadId = threadId || await maybeLatestThreadId({ latestThread, codexHomePath, actions });

  let profile;
  if (!before) {
    const result = await installWakefield({
      name,
      soul,
      ownerName,
      threadId: resolvedThreadId,
      cwd,
      agentHome,
      newAgent,
      skipHooks,
      home,
      codexHomePath
    });
    profile = result.profile;
    actions.push({
      id: "create-agent",
      status: "applied",
      detail: `${profile.name} (${profile.id})`
    });
    actions.push(hookAction(result.hookResult, skipHooks));
    actions.push(skillAction(result.skillResult));
  } else {
    profile = before;
    const installResult = await installWakefield({ home, codexHomePath, skipHooks });
    actions.push({
      id: "create-agent",
      status: "unchanged",
      detail: `${profile.name} (${profile.id}) already exists`
    });
    actions.push(hookAction(installResult.hookResult, skipHooks));
    actions.push(skillAction(installResult.skillResult));

    if (resolvedThreadId || (cwd && profile.threadId)) {
      const previousThread = profile.threadId || null;
      profile = await selectThread({
        threadId: resolvedThreadId || profile.threadId,
        cwd,
        home
      });
      actions.push({
        id: "select-thread",
        status: previousThread === profile.threadId && !cwd ? "unchanged" : "applied",
        detail: profile.threadId
      });
    }
  }

  if (!profile.threadId && latestThread && !resolvedThreadId) {
    actions.push({
      id: "select-thread",
      status: "skipped",
      detail: "No local Codex thread transcripts found."
    });
  } else if (!profile.threadId && !resolvedThreadId) {
    actions.push({
      id: "select-thread",
      status: "skipped",
      detail: "No Codex thread was selected."
    });
  } else if (!actions.some((action) => action.id === "select-thread")) {
    actions.push({
      id: "select-thread",
      status: "unchanged",
      detail: profile.threadId
    });
  }

  if (enableService || enableDispatch || envFile || installScheduler) {
    const service = await configureService({
      home,
      enabled: enableService || enableDispatch || installScheduler ? true : null,
      intervalMinutes,
      dispatchEnabled: enableDispatch ? true : null,
      dispatchMode,
      dispatchLimit,
      envFile
    });
    if (enableService || enableDispatch || installScheduler) {
      actions.push({
        id: "enable-service",
        status: "applied",
        detail: `${service.intervalMinutes} minute interval`
      });
    }
    if (envFile) {
      actions.push({
        id: "configure-service-env-file",
        status: "applied",
        detail: service.environment?.path || envFile
      });
    }
    if (enableDispatch) {
      actions.push({
        id: "enable-external-dispatch",
        status: "applied",
        detail: `${service.externalDispatch.mode}, limit ${service.externalDispatch.limit}`
      });
    }
  }

  if (installScheduler) {
    const result = await installLaunchAgent({
      home,
      launchAgentsPath: launchAgentsPath || undefined,
      intervalMinutes,
      load: loadScheduler || reloadScheduler,
      reload: reloadScheduler
    });
    actions.push({
      id: "install-launch-agent",
      status: result.status.installed ? "applied" : "skipped",
      detail: result.loadResult
        ? `${result.plistPath} (${result.loadResult.action}${result.loadResult.skipped ? `: ${result.loadResult.skipped}` : ""})`
        : result.plistPath
    });
  }

  const memoryMcp = await installMemoryMcp({
    home,
    agent: profile,
    codexConfigPath: codexConfigPath(codexHomePath || undefined)
  });
  actions.push({
    id: "install-memory-mcp",
    status: memoryMcp.changed ? "applied" : "unchanged",
    detail: memoryMcp.codexConfigPath
  });

  const status = await setupStatus({ home, codexHomePath });
  return {
    ok: status.ok,
    phase: status.phase,
    actions,
    status
  };
}

export function formatSetupRun(result) {
  const lines = ["Wakefield setup run"];
  for (const action of result.actions) {
    lines.push(`${action.status}: ${action.id} - ${action.detail}`);
  }
  lines.push("", `state: ${result.phase}`);
  if (result.actions.some((action) => ["install-hooks", "install-base-skills"].includes(action.id) && action.status === "applied")) {
    lines.push("", "Open Codex and run /hooks if it asks you to review newly installed hooks.");
  }
  if (!result.ok && result.status.nextSteps.length > 0) {
    lines.push("", "Next steps:");
    for (const step of result.status.nextSteps) lines.push(`- ${step}`);
  }
  return lines.join("\n");
}

async function maybeLatestThreadId({ latestThread, codexHomePath, actions }) {
  if (!latestThread) return null;
  const [thread] = await listRecentThreads({
    codexHomePath: codexHomePath || undefined,
    limit: 1
  });
  if (!thread) return null;
  actions.push({
    id: "find-latest-thread",
    status: "applied",
    detail: thread.threadId
  });
  return thread.threadId;
}

function hookAction(hookResult, skipped) {
  if (skipped) {
    return {
      id: "install-hooks",
      status: "skipped",
      detail: "Skipped by request."
    };
  }
  return {
    id: "install-hooks",
    status: hookResult?.changed ? "applied" : "unchanged",
    detail: hookResult?.hooksPath || "Codex hooks unchanged."
  };
}

function skillAction(skillResult) {
  const installed = skillResult?.installed || [];
  const changedCount = installed.filter((skill) => skill.changed).length;
  return {
    id: "install-base-skills",
    status: changedCount > 0 ? "applied" : "unchanged",
    detail: `${installed.length} Wakefield skill(s) at ${skillResult?.skillsRoot || "Codex skills"}`
  };
}
