import assert from "node:assert/strict";
import { setTimeout as delay } from "node:timers/promises";

process.loadEnvFile(".env.share");
const base = process.env.SHARE_PUBLIC_ORIGIN;
assert.equal(new URL(base).protocol, "https:");
const authorization = "Basic " + Buffer.from(`${process.env.SHARE_USERNAME}:${process.env.SHARE_PASSWORD}`).toString("base64");
const call = (path, options = {}, authenticated = true) => fetch(base + path, { ...options, headers: { ...(authenticated ? { authorization } : {}), ...options.headers }, signal: AbortSignal.timeout(15_000), redirect: "error" });
const checks = [];
assert.equal((await call("/api/health", {}, false)).status, 401);
assert.equal((await call("/api/health", { headers: { authorization: "Basic wrong" } })).status, 401);
checks.push("Unauthenticated and incorrect passwords are rejected");
const health = await call("/api/health");
assert.equal(health.status, 200);
const initial = await health.json();
assert.equal(initial.ready, true);
assert.equal(initial.browserActionMode, "agentic");
assert.equal(initial.activeRunId, null, "Do not run this probe during another person's test");
checks.push("Authenticated HTTPS reaches the real agent service");
const page = await call("/");
assert.equal(page.status, 200);
assert.match(await page.text(), /StayPilot control tower/);
assert.equal(page.headers.get("x-frame-options"), "DENY");
checks.push("The real frontend is served with framing protection");
assert.equal((await call("/api/runs", { method: "POST", headers: { origin: "https://untrusted.example", "content-type": "application/json" }, body: JSON.stringify({ query: "This request must never reach the browser agent" }) })).status, 403);
assert.equal((await call("/api/runs", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: "{bad json" })).status, 400);
checks.push("Foreign origins are rejected and valid-origin POSTs reach input validation");

// Exercise real orchestration and streaming without opening a supplier browser or spending model tokens.
const started = await call("/api/runs", { method: "POST", headers: { origin: base, "content-type": "application/json" }, body: JSON.stringify({ query: "Find a hotel in Jaipur on 31 April 2027 for 1 adult and 1 room under 5000 total" }) });
assert.equal(started.status, 202);
const { runId } = await started.json();
const abort = new AbortController();
const timeout = setTimeout(() => abort.abort(), 10_000);
try {
  const stream = await fetch(`${base}/api/runs/${runId}/events`, { headers: { authorization }, signal: abort.signal, redirect: "error" });
  assert.equal(stream.status, 200);
  assert.match(stream.headers.get("content-type"), /text\/event-stream/);
  let events = "";
  const reader = stream.body.getReader();
  while (!events.includes("data:")) events += new TextDecoder().decode((await reader.read()).value);
  checks.push("Actual orchestration events stream through the public tunnel without buffering");
} finally { clearTimeout(timeout); abort.abort(); }
let state;
for (let attempt = 0; attempt < 10; attempt++) {
  state = await call(`/api/runs/${runId}`).then(response => response.json());
  if (state.status === "failed") break;
  await delay(200);
}
assert.equal(state.status, "failed");
assert.match(state.error, /valid calendar/);
assert.ok(state.events.every(event => event.agent !== "SearchAgent"));
assert.equal((await call("/api/health").then(response => response.json())).activeRunId, null);
checks.push("Invalid dates stop before browser launch, reservation or payment");
console.log(JSON.stringify({ url: base, passed: checks.length, checks, hotelFlowRetested: false }, null, 2));
