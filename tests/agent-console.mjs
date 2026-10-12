import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { allowHostedBridge, createAgentServer, findActiveRun } from "../scripts/agent-server.mjs";

const html = await readFile(new URL("../src/agent-console.html", import.meta.url), "utf8");
for (const value of ["Agentic hotel search and pre-booking", "Coordinated agents", "Agent execution controls", "SupervisorAgent", "supervisor.decision", "Supervisor decision:", "workflowActionMode", "Human attention needed", "AI language understanding", "AI interpreted", "budget or budget range", "budgetMinInr", "Requested hotel:", "Highest-rated available hotel within total budget", "Exact hotel; rating does not affect the choice", "Local language fallback", "Open local agent console", "http://127.0.0.1:4180", "forwardedRequest", "probeRuntime", "attachRun", "activeRunId", "Previous run active", "/api/intake", "Before I search", "preferred booking website", "Provider", "Universal computer use", "Guest rating", "Room availability", "No eligible stay", "Protected checkout boundary reached", "IntakeAgent", "PolicyAgent", "SearchAgent", "RankingAgent", "RoomAgent", "CheckoutAgent", "SafetyAgent", "/api/runs", "EventSource", "Close supplier browser"]) {
  assert.match(html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
}
assert.doesNotMatch(html, /buildDemoHotels|Computer route is a visual simulation|LangGraph|Playwright|Booking\.com|local Chrome|SSE observability|hotel availability API/i);
assert.match(html, /DiscoveryAgent/);
assert.match(html, /discovery.completed/);
assert.match(html, /Hotel identity lookup/);
assert.match(html, /data.agents.length/);
assert.doesNotMatch(html, /7 specialized agents/);

const { server, runs } = await createAgentServer({ html });
assert.equal(typeof server.listen, "function");
assert.equal(typeof server.close, "function");
assert.equal(runs.size, 0);

const origin = "https://staypilot-hotel-demo.quietcow1.chatgpt.site";
const corsHeaders = new Map();
assert.equal(allowHostedBridge({ headers: { origin } }, { setHeader: (name, value) => corsHeaders.set(name, value) }), true);
assert.equal(corsHeaders.get("access-control-allow-origin"), origin);
assert.equal(corsHeaders.get("access-control-allow-private-network"), "true");
assert.equal(allowHostedBridge({ headers: { origin: "https://untrusted.example" } }, { setHeader: () => assert.fail("Untrusted origins must not receive CORS headers") }), false);

const activeRuns = new Map([
  ["completed", { id: "completed", orchestrator: { status: "completed" } }],
  ["boundary", { id: "boundary", orchestrator: { status: "awaiting_human" } }],
]);
assert.equal(findActiveRun(activeRuns)?.id, "boundary", "A refreshed page must recover a run waiting at the safe boundary");

console.log("Agent console checks passed");
