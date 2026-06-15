import assert from "node:assert/strict";
import test from "node:test";
import { CodexAppServerClient } from "../src/codex-app-server-client.mjs";

test("app-server turn start carries full-access target permissions", async () => {
  const calls = [];
  const client = new CodexAppServerClient();
  client.connect = async () => {};
  client.request = async (method, params) => {
    calls.push({ method, params });
    if (method === "thread/resume") {
      return { thread: { status: { type: "idle" } } };
    }
    if (method === "turn/start") {
      return { turn: { id: "turn-1" } };
    }
    throw new Error(`Unexpected method ${method}`);
  };

  const result = await client.routeTextToThread({
    threadId: "thread-1",
    cwd: "/tmp/project",
    text: "hello",
    permissions: { mode: "full-access" }
  });

  assert.equal(result.turnId, "turn-1");
  assert.deepEqual(calls.at(-1), {
    method: "turn/start",
    params: {
      threadId: "thread-1",
      cwd: "/tmp/project",
      input: [{ type: "text", text: "hello", text_elements: [] }],
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" }
    }
  });
});
