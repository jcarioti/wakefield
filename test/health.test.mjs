import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { runHealthCheck } from "../src/health.mjs";

async function makeHome() {
  return fs.mkdtemp(path.join(os.tmpdir(), "wakefield-health-"));
}

async function writeService(home, now) {
  await fs.writeFile(path.join(home, "service.json"), JSON.stringify({
    enabled: true,
    intervalMinutes: 15,
    lastRunAt: now.toISOString(),
    health: { enabled: true }
  }));
}

test("health alerts once per local day and suppresses repeats", async () => {
  const home = await makeHome();
  const first = new Date("2026-07-09T16:00:00-07:00");
  await writeService(home, first);
  const alerts = [];
  const notify = async ({ payload }) => {
    alerts.push(payload);
    return { status: "sent" };
  };

  const firstResult = await runHealthCheck({ home, now: first, notify });
  const secondResult = await runHealthCheck({
    home,
    now: new Date(first.getTime() + 15 * 60 * 1000),
    notify
  });
  const nextDayResult = await runHealthCheck({
    home,
    now: new Date("2026-07-10T08:00:00-07:00"),
    notify
  });

  assert.equal(firstResult.status, "degraded");
  assert.equal(secondResult.notification.status, "suppressed-daily-limit");
  assert.equal(nextDayResult.notification.status, "sent");
  assert.equal(alerts.length, 2);
  assert.equal(alerts[0].dailyAlertLimit, 1);
});

test("health records a failed scheduled Codex dispatch", async () => {
  const home = await makeHome();
  const now = new Date("2026-07-09T16:00:00-07:00");
  await writeService(home, now);
  const result = await runHealthCheck({
    home,
    now,
    serviceRun: true,
    dutyResults: {
      results: [{
        status: "failed",
        duty: { id: "morning-ops" },
        error: { message: "Codex follower did not register" }
      }]
    },
    notify: async () => ({ status: "sent" })
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.findings[0].code, "codex-dispatch-failed");
  assert.equal(result.state.incident.code, "codex-dispatch-failed");
});

test("health alerts when an external message stays queued after Codex dispatch fails", async () => {
  const home = await makeHome();
  const now = new Date("2026-07-09T16:00:00-07:00");
  await writeService(home, now);
  const alerts = [];
  const result = await runHealthCheck({
    home,
    now,
    serviceRun: true,
    externalDispatch: {
      failed: 1,
      pending: 1,
      results: [{
        ok: false,
        message: { connector: "imessage" },
        error: { message: "No responsive Codex IPC socket found." }
      }]
    },
    notify: async ({ payload }) => {
      alerts.push(payload);
      return { status: "sent" };
    }
  });

  assert.equal(result.status, "degraded");
  assert.equal(result.findings[0].code, "external-dispatch-failed");
  assert.equal(result.state.incident.code, "external-dispatch-failed");
  assert.equal(alerts[0].pendingExternalMessages, 1);
});
