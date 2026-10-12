import assert from "node:assert/strict";
import { createAgentServer } from "../scripts/agent-server.mjs";

let intakeCalls = 0;
let browsersStarted = 0;
const { server, runs } = await createAgentServer({
  html: "<h1>Test console</h1>",
  intakeParser: async () => { intakeCalls += 1; await new Promise((resolve) => setTimeout(resolve, 20)); return { destination: "Pune", adults: 1, rooms: 1 }; },
  orchestratorFactory: ({ onEvent }) => ({
    status: "queued",
    async run() {
      browsersStarted += 1;
      this.status = "planning";
      for (let seq = 1; seq <= 3; seq += 1) onEvent({ seq, agent: "IntakeAgent", message: `Event ${seq}` });
      return new Promise((resolve) => { this.finish = resolve; });
    },
    async cancel() { this.status = "cancelled"; this.finish?.({ status: "cancelled" }); },
  }),
});
await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
const base = `http://127.0.0.1:${server.address().port}`;
const query = "Hotel in Pune on 22 December 2026 for 1 adult and 1 room under 5000";
const post = (path, body = JSON.stringify({ query }), headers = {}) => fetch(`${base}${path}`, { method: "POST", body, headers: { "content-type": "application/json", ...headers } });
try {
  assert.equal((await fetch(`${base}/api/health`)).status, 200);
  const intents = await Promise.all([post("/api/intake"), post("/api/intake")]);
  assert.ok(intents.every((response) => response.status === 200));
  assert.equal(intakeCalls, 1, "Concurrent identical requests must share one AI call");
  assert.equal((await post("/api/intake", "{bad json")).status, 400);
  assert.equal((await post("/api/runs", JSON.stringify({ query: "too short" }))).status, 400);
  assert.equal((await post("/api/runs", JSON.stringify({ query }), { origin: "https://untrusted.example" })).status, 403, "Foreign websites must not trigger the local browser");
  assert.equal(browsersStarted, 0);
  const started = await Promise.all([post("/api/runs"), post("/api/runs")]);
  assert.deepEqual(started.map((response) => response.status).sort(), [202, 409]);
  assert.equal(browsersStarted, 1, "Only one browser may start from simultaneous requests");
  const runId = (await started.find((response) => response.status === 202).json()).runId;
  const abort = new AbortController();
  const stream = await fetch(`${base}/api/runs/${runId}/events`, { headers: { "last-event-id": "2" }, signal: abort.signal });
  const reader = stream.body.getReader();
  let replay = "";
  while (!replay.includes("Event 3")) replay += new TextDecoder().decode((await reader.read()).value);
  assert.ok(!replay.includes("Event 1") && !replay.includes("Event 2"), "Reconnect must replay only events after Last-Event-ID");
  abort.abort();
  await post(`/api/runs/${runId}/cancel`, "{}");
  assert.equal((await fetch(`${base}/api/health`).then((response) => response.json())).activeRunId, null);
  for (let index = 0; index < 40; index += 1) runs.set(`old_${index}`, { id: `old_${index}`, orchestrator: { status: "completed", cancel: async () => {} }, subscribers: new Set() });
  assert.equal((await post("/api/runs")).status, 202);
  assert.ok(runs.size <= 32, "Terminal run/checkpoint history must not grow without a bound");
  console.log("Server HTTP checks passed: AI-cache coalescing, malformed input, untrusted origins, concurrent-run lock, incremental event replay, cancellation and bounded retention.");
} finally {
  await Promise.all([...runs.values()].map((run) => run.orchestrator.cancel()));
  server.closeAllConnections();
  await new Promise((resolve) => server.close(resolve));
}
