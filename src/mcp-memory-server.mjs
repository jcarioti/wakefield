#!/usr/bin/env node
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { pathToFileURL } from "node:url";
import { z } from "zod";
import {
  archiveMatter,
  forgetMemoryItem,
  loadMatters,
  loadNotes,
  normalizeScope,
  recallContext,
  upsertMatter,
  upsertNote
} from "./context-memory.mjs";
import {
  configureDuty,
  configureWakeup,
  deleteDuty,
  deleteWakeup,
  dutyStatuses
} from "./duties.mjs";
import { MEMORY_MCP_TOOLS } from "./memory-mcp.mjs";
import { appHome, expandHome } from "./paths.mjs";
import { ensureAgentMemory, loadAgent } from "./profile.mjs";

if (isMain()) {
  await runWakefieldMemoryMcpServer();
}

export async function runWakefieldMemoryMcpServer(argv = process.argv.slice(2)) {
  const args = parseArgs(argv);

  if (args.help) {
    console.log("Usage: wakefield-memory-mcp [--home PATH] [--agent-id ID]");
    return;
  }

  const home = args.home ? expandHome(args.home) : appHome();
  const loadedAgent = await loadAgent(args.agentId || null, home);
  if (!loadedAgent) {
    throw new Error("No Wakefield agent is initialized yet. Run wakefield init first.");
  }
  const agent = await ensureAgentMemory(loadedAgent, home);

  const server = new McpServer({
    name: "wakefield-memory",
    version: "0.1.0"
  });

  registerWakefieldMemoryTools(server, { agent, home });

  await server.connect(new StdioServerTransport());
}

export function registerWakefieldMemoryTools(server, { agent, home }) {
  server.registerTool(
    "wakefield_memory_status",
    {
      title: "Wakefield Memory Status",
      description: "Show the active Wakefield agent and scoped memory store paths.",
      inputSchema: {}
    },
    async () => {
      const [notes, matters] = await Promise.all([
        loadNotes(agent),
        loadMatters(agent)
      ]);
      return jsonContent({
        home,
        agent: {
          id: agent.id,
          name: agent.name,
          threadId: agent.threadId,
          cwd: agent.cwd
        },
        counts: {
          notes: notes.notes.length,
          matters: matters.matters.length,
          activeMatters: matters.matters.filter((matter) => ["active", "waiting"].includes(matter.status)).length
        },
        paths: {
          notes: agent.memory?.notesPath || null,
          matters: agent.memory?.mattersPath || null
        },
        tools: MEMORY_MCP_TOOLS
      });
    }
  );

  server.registerTool(
    "wakefield_memory_recall",
    {
      title: "Recall Wakefield Memory",
      description: "Recall scoped Wakefield notes and active matters that match a person, room, task, case, topic, connector, sender, conversation, or query.",
      inputSchema: {
        query: z.string().optional(),
        ...scopeSchema(),
        limitNotes: z.number().int().min(0).max(10).optional(),
        limitMatters: z.number().int().min(0).max(10).optional(),
        includeArchived: z.boolean().optional()
      }
    },
    async (input = {}) => {
      const recalled = await recallContext(agent, {
        query: input.query || "",
        scope: scopeFromInput(input),
        limitNotes: input.limitNotes ?? 3,
        limitMatters: input.limitMatters ?? 3,
        includeArchived: Boolean(input.includeArchived)
      });
      return jsonContent(recalled);
    }
  );

  server.registerTool(
    "wakefield_memory_list_notes",
    {
      title: "List Wakefield Notes",
      description: "List stable Wakefield notes. Use recall first when you only need relevant memory.",
      inputSchema: {
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ limit = 50 } = {}) => {
      const document = await loadNotes(agent);
      return jsonContent({
        ...document,
        notes: document.notes.slice(0, limit)
      });
    }
  );

  server.registerTool(
    "wakefield_memory_get_note",
    {
      title: "Get Wakefield Note",
      description: "Get one stable Wakefield note by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const note = (await loadNotes(agent)).notes.find((item) => item.id === id);
      if (!note) throw new Error(`Note not found: ${id}`);
      return jsonContent(note);
    }
  );

  server.registerTool(
    "wakefield_memory_upsert_note",
    {
      title: "Upsert Wakefield Note",
      description: "Create or update a stable Wakefield note. Use this for durable facts, preferences, and operating guidance, not temporary cases.",
      inputSchema: {
        id: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        text: z.string().min(1),
        tags: stringListSchema().optional(),
        sources: stringListSchema().optional(),
        ...scopeSchema()
      }
    },
    async (input) => {
      const document = await upsertNote(agent, {
        id: input.id,
        title: input.title,
        text: input.text,
        tags: stringList(input.tags),
        sources: stringList(input.sources),
        scope: scopeFromInput(input)
      });
      const id = input.id || document.notes.find((item) => item.text === input.text)?.id;
      return jsonContent({
        ok: true,
        note: id ? document.notes.find((item) => item.id === id) : document.notes.at(-1)
      });
    }
  );

  server.registerTool(
    "wakefield_memory_list_matters",
    {
      title: "List Wakefield Matters",
      description: "List temporary active-context matters. By default archived matters are hidden.",
      inputSchema: {
        status: z.enum(["active", "waiting", "resolved", "archived"]).optional(),
        includeArchived: z.boolean().optional(),
        limit: z.number().int().min(1).max(100).optional()
      }
    },
    async ({ status, includeArchived = false, limit = 50 } = {}) => {
      const document = await loadMatters(agent);
      const matters = document.matters
        .filter((matter) => includeArchived || matter.status !== "archived")
        .filter((matter) => !status || matter.status === status)
        .slice(0, limit);
      return jsonContent({ ...document, matters });
    }
  );

  server.registerTool(
    "wakefield_memory_get_matter",
    {
      title: "Get Wakefield Matter",
      description: "Get one Wakefield active-context matter by id.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      const matter = (await loadMatters(agent)).matters.find((item) => item.id === id);
      if (!matter) throw new Error(`Matter not found: ${id}`);
      return jsonContent(matter);
    }
  );

  server.registerTool(
    "wakefield_memory_upsert_matter",
    {
      title: "Upsert Wakefield Matter",
      description: "Create or update a temporary Wakefield active-context matter for a person, task, case, room, or topic.",
      inputSchema: {
        id: z.string().min(1).optional(),
        kind: z.string().min(1).optional(),
        title: z.string().min(1).optional(),
        summary: z.string().min(1),
        status: z.enum(["active", "waiting", "resolved", "archived"]).optional(),
        statusReason: z.string().min(1).optional(),
        nextAction: z.string().min(1).optional(),
        notifyWhen: z.string().min(1).optional(),
        tags: stringListSchema().optional(),
        sources: stringListSchema().optional(),
        ...scopeSchema()
      }
    },
    async (input) => {
      const document = await upsertMatter(agent, {
        id: input.id,
        kind: input.kind,
        title: input.title,
        summary: input.summary,
        status: input.status || "active",
        statusReason: input.statusReason || null,
        nextAction: input.nextAction || null,
        notifyWhen: input.notifyWhen || null,
        tags: stringList(input.tags),
        sources: stringList(input.sources),
        scope: scopeFromInput(input)
      });
      const id = input.id || document.matters.find((item) => item.summary === input.summary)?.id;
      return jsonContent({
        ok: true,
        matter: id ? document.matters.find((item) => item.id === id) : document.matters.at(-1)
      });
    }
  );

  server.registerTool(
    "wakefield_memory_archive_matter",
    {
      title: "Archive Wakefield Matter",
      description: "Archive a matter that is resolved or no longer relevant. Prefer this over forgetting normal completed context.",
      inputSchema: {
        id: z.string().min(1),
        reason: z.string().min(1).optional()
      }
    },
    async ({ id, reason }) => {
      const document = await archiveMatter(agent, id, { reason });
      return jsonContent({
        ok: true,
        matter: document.matters.find((item) => item.id === id)
      });
    }
  );

  server.registerTool(
    "wakefield_memory_forget",
    {
      title: "Forget Wakefield Memory Item",
      description: "Permanently remove a note or matter by id. Use archive for normal completed matters; forget is for mistakes or sensitive data.",
      inputSchema: {
        type: z.enum(["note", "matter"]),
        id: z.string().min(1)
      }
    },
    async ({ type, id }) => {
      await forgetMemoryItem(agent, type, id);
      return jsonContent({ ok: true, type, id });
    }
  );

  server.registerTool(
    "wakefield_scheduler_status",
    {
      title: "Wakefield Scheduler Status",
      description: "List configured Wakefield duties and wakeups, including due status and missing duty references.",
      inputSchema: {
        includeCompatibilityWakeups: z.boolean().optional(),
        now: z.string().min(1).optional()
      }
    },
    async ({ includeCompatibilityWakeups = false, now } = {}) => {
      return jsonContent(await dutyStatuses({
        home,
        now: dateFromInput(now),
        includeCompatibilityWakeups: Boolean(includeCompatibilityWakeups)
      }));
    }
  );

  server.registerTool(
    "wakefield_scheduler_configure_duty",
    {
      title: "Configure Wakefield Duty",
      description: "Create or update a reusable Wakefield duty definition. Create duties before attaching them to wakeups.",
      inputSchema: {
        id: z.string().min(1),
        label: z.string().min(1).optional(),
        prompt: z.string().min(1).optional(),
        promptFile: z.string().min(1).optional(),
        skills: stringListSchema().optional(),
        wakeTimes: stringListSchema().optional(),
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(1).optional(),
        clearInterval: z.boolean().optional(),
        clearWakeTimes: z.boolean().optional(),
        dispatchMode: dispatchModeSchema().optional(),
        requiredTools: stringListSchema().optional(),
        resetSchedule: z.boolean().optional()
      }
    },
    async (input) => {
      await configureDuty(input.id, {
        home,
        label: input.label ?? null,
        prompt: input.prompt ?? null,
        promptFile: input.promptFile ?? null,
        skills: input.skills == null ? null : stringList(input.skills),
        wakeTimes: input.wakeTimes == null ? null : stringList(input.wakeTimes),
        enabled: Object.hasOwn(input, "enabled") ? Boolean(input.enabled) : null,
        intervalMinutes: input.intervalMinutes ?? null,
        clearInterval: Boolean(input.clearInterval),
        clearWakeTimes: Boolean(input.clearWakeTimes),
        dispatchMode: input.dispatchMode ?? null,
        requiredTools: input.requiredTools == null ? null : stringList(input.requiredTools),
        resetSchedule: Boolean(input.resetSchedule)
      });
      return jsonContent({
        ok: true,
        ...await dutyStatuses({ home, includeCompatibilityWakeups: false })
      });
    }
  );

  server.registerTool(
    "wakefield_scheduler_configure_wakeup",
    {
      title: "Configure Wakefield Wakeup",
      description: "Create or update a scheduled Wakefield wakeup that runs one or more duties.",
      inputSchema: {
        id: z.string().min(1),
        label: z.string().min(1).optional(),
        duties: stringListSchema().optional(),
        skills: stringListSchema().optional(),
        wakeTimes: stringListSchema().optional(),
        enabled: z.boolean().optional(),
        intervalMinutes: z.number().int().min(1).optional(),
        clearInterval: z.boolean().optional(),
        clearWakeTimes: z.boolean().optional(),
        dispatchMode: dispatchModeSchema().optional(),
        requiredTools: stringListSchema().optional(),
        resetSchedule: z.boolean().optional()
      }
    },
    async (input) => {
      await configureWakeup(input.id, {
        home,
        label: input.label ?? null,
        duties: input.duties == null ? null : stringList(input.duties),
        skills: input.skills == null ? null : stringList(input.skills),
        wakeTimes: input.wakeTimes == null ? null : stringList(input.wakeTimes),
        enabled: Object.hasOwn(input, "enabled") ? Boolean(input.enabled) : null,
        intervalMinutes: input.intervalMinutes ?? null,
        clearInterval: Boolean(input.clearInterval),
        clearWakeTimes: Boolean(input.clearWakeTimes),
        dispatchMode: input.dispatchMode ?? null,
        requiredTools: input.requiredTools == null ? null : stringList(input.requiredTools),
        resetSchedule: Boolean(input.resetSchedule)
      });
      return jsonContent({
        ok: true,
        ...await dutyStatuses({ home, includeCompatibilityWakeups: false })
      });
    }
  );

  server.registerTool(
    "wakefield_scheduler_delete_duty",
    {
      title: "Delete Wakefield Duty",
      description: "Delete a Wakefield duty. Set removeReferences to also detach it from wakeups.",
      inputSchema: {
        id: z.string().min(1),
        removeReferences: z.boolean().optional()
      }
    },
    async ({ id, removeReferences = false }) => {
      await deleteDuty(id, {
        home,
        removeReferences: Boolean(removeReferences)
      });
      return jsonContent({
        ok: true,
        ...await dutyStatuses({ home, includeCompatibilityWakeups: false })
      });
    }
  );

  server.registerTool(
    "wakefield_scheduler_delete_wakeup",
    {
      title: "Delete Wakefield Wakeup",
      description: "Delete a scheduled Wakefield wakeup without deleting its reusable duties.",
      inputSchema: {
        id: z.string().min(1)
      }
    },
    async ({ id }) => {
      await deleteWakeup(id, { home });
      return jsonContent({
        ok: true,
        ...await dutyStatuses({ home, includeCompatibilityWakeups: false })
      });
    }
  );
}

function jsonContent(value) {
  return {
    content: [{
      type: "text",
      text: JSON.stringify(value, null, 2)
    }]
  };
}

function scopeSchema() {
  return {
    person: stringListSchema().optional(),
    people: stringListSchema().optional(),
    room: stringListSchema().optional(),
    rooms: stringListSchema().optional(),
    channel: stringListSchema().optional(),
    channels: stringListSchema().optional(),
    task: stringListSchema().optional(),
    tasks: stringListSchema().optional(),
    topic: stringListSchema().optional(),
    topics: stringListSchema().optional(),
    caseId: stringListSchema().optional(),
    case: stringListSchema().optional(),
    cases: stringListSchema().optional(),
    connector: stringListSchema().optional(),
    connectors: stringListSchema().optional(),
    sender: stringListSchema().optional(),
    senders: stringListSchema().optional(),
    conversation: stringListSchema().optional(),
    conversations: stringListSchema().optional()
  };
}

function stringListSchema() {
  return z.union([z.string(), z.array(z.string())]);
}

function dispatchModeSchema() {
  return z.enum(["dry-run", "manual", "ipc", "auto", "steer", "start"]);
}

function scopeFromInput(input = {}) {
  return normalizeScope({
    people: input.people ?? input.person,
    rooms: input.rooms ?? input.room,
    channels: input.channels ?? input.channel,
    tasks: input.tasks ?? input.task,
    topics: input.topics ?? input.topic,
    cases: input.cases ?? input.case ?? input.caseId,
    connectors: input.connectors ?? input.connector,
    senders: input.senders ?? input.sender,
    conversations: input.conversations ?? input.conversation
  });
}

function stringList(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.flatMap(stringList);
  return String(value).split(",").map((item) => item.trim()).filter(Boolean);
}

function dateFromInput(value) {
  if (!value) return new Date();
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new Error(`Invalid date: ${value}`);
  return date;
}

function parseArgs(argv) {
  const parsed = {};
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--help" || arg === "-h") parsed.help = true;
    else if (arg === "--home") parsed.home = argv[++i];
    else if (arg === "--agent-id") parsed.agentId = argv[++i];
  }
  return parsed;
}

function isMain() {
  return Boolean(process.argv[1]) && import.meta.url === pathToFileURL(process.argv[1]).href;
}
