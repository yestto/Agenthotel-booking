import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";
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
const intakeLabelExpression = html.match(/\$\{(\["gemini", "groq"\]\.includes\(intake\.goal\.intakeSource\) \? "AI interpreted" : "Validated")\}/)?.[1];
assert.ok(intakeLabelExpression, "The UI must recognize both configured model providers without displaying their names");
for (const intakeSource of ["gemini", "groq", "deterministic"]) {
  assert.equal(runInNewContext(intakeLabelExpression, { intake: { goal: { intakeSource } } }), intakeSource === "deterministic" ? "Validated" : "AI interpreted");
}
const hostedHtml = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
assert.ok(hostedHtml.includes(intakeLabelExpression), "The hosted frontend must recognize the same AI intake sources");

function createUiFixture(content) {
  let now = Date.parse("2026-10-13T15:00:00Z");
  let timerId = 0;
  const timers = new Map();
  const timeouts = new Map();
  const requests = [];
  let fetchImpl = async () => ({ ok: true });
  const elements = new Map();
  function element() {
    const classes = new Set();
    return {
      textContent: "", hidden: true, disabled: false, children: [], value: "",
      classList: { add: value => classes.add(value), remove: value => classes.delete(value), toggle: (value, enabled) => enabled ? classes.add(value) : classes.delete(value) },
      append(...children) { this.children.push(...children); },
      replaceChildren(...children) { this.children = children; },
      querySelector: selector => selector === "span" ? { textContent: "" } : null,
      addEventListener() {},
    };
  }
  class FixtureDate extends Date { static now() { return now; } }
  class FixtureEventSource {
    constructor(url) { this.url = url; }
    close() { this.closed = true; }
  }
  const script = content.match(/<script>([\s\S]*?)<\/script>/)[1].replace(/\s+connectRuntime\(\);\s*$/, "");
  const context = {
    document: {
      getElementById(id) { if (!elements.has(id)) elements.set(id, element()); return elements.get(id); },
      querySelectorAll: () => [], querySelector: () => null, createElement: element,
    },
    CSS: { escape: value => value }, Date: FixtureDate, Intl, URL, URLSearchParams, AbortController,
    location: { protocol: "http:", search: "", pathname: "/" }, history: { replaceState() {} },
    EventSource: FixtureEventSource,
    setInterval(callback) { timers.set(++timerId, callback); return timerId; },
    clearInterval(id) { timers.delete(id); },
    setTimeout(callback, ms) { timeouts.set(++timerId, { callback, at: now + ms }); return timerId; },
    clearTimeout(id) { timeouts.delete(id); },
    fetch: async (url, options) => { requests.push({ url, options }); return fetchImpl(url, options); },
  };
  runInNewContext(`${script}\nglobalThis.fixture = { attachRun, addEvent, finish, startRun, stopRun, resetAgentCards, probeRuntime };`, context);
  return { ui: context.fixture, elements, timers, timeouts, requests, setFetch(callback) { fetchImpl = callback; },
    advance(ms) { now += ms; for (const [id, timeout] of [...timeouts]) if (timeout.at <= now) { timeouts.delete(id); timeout.callback(); } for (const callback of [...timers.values()]) callback(); }, now: () => now };
}

for (const content of [html, hostedHtml]) {
  assert.match(content, /id="allowanceWait" role="status" hidden/);
  assert.match(content, /id="allowanceCountdown" aria-live="off"/);
  const fixture = createUiFixture(content);
  const { ui, elements, timers, requests } = fixture;
  let seq = 0;
  const event = (type, evidence = {}, at = new Date(fixture.now()).toISOString()) => ({ seq: ++seq, type, agent: "SearchAgent", message: "Fixture activity", evidence, at });
  ui.attachRun("quota-run");
  const wait = event("model.quota_wait", { waitMs: 60_000 }, new Date(fixture.now() - 10_000).toISOString());
  ui.addEvent(wait);
  assert.equal(elements.get("allowanceWait").hidden, false);
  assert.equal(elements.get("status").textContent, "Waiting for allowance");
  assert.equal(elements.get("allowanceCountdown").textContent, "Next decision in about 50s.");
  assert.equal(elements.get("stop").disabled, false, "Cancel must remain usable during quota waiting");
  assert.equal(timers.size, 1);
  fixture.advance(10_000);
  ui.addEvent(wait);
  assert.equal(elements.get("allowanceCountdown").textContent, "Next decision in about 40s.");
  assert.equal(timers.size, 1, "A replayed event must not add or restart a countdown");
  await ui.stopRun();
  assert.equal(requests.at(-1).url, "/api/runs/quota-run/cancel");
  assert.equal(requests.at(-1).options.method, "POST");
  ui.addEvent(event("model.quota_resumed", { waitedMs: 60_000 }));
  assert.equal(elements.get("allowanceWait").hidden, true);
  assert.equal(elements.get("status").textContent, "Running");
  assert.equal(timers.size, 0);
  ui.addEvent(event("model.quota_wait", { waitMs: 1_000_000 }, new Date(fixture.now() + 1_000_000).toISOString()));
  assert.equal(elements.get("allowanceCountdown").textContent, "Next decision in about 90s.", "Untrusted or skewed timing evidence must stay bounded");
  fixture.advance(91_000);
  assert.equal(elements.get("allowanceCountdown").textContent, "Allowance check is due; waiting for the service to respond.");
  assert.equal(timers.size, 0, "An expired countdown must not keep ticking indefinitely");
  ui.addEvent(event("model.quota_resumed"));
  ui.addEvent(event("model.quota_wait", { waitMs: "not-a-duration" }));
  assert.equal(elements.get("allowanceWait").hidden, true);
  ui.addEvent(event("model.quota_wait", { waitMs: 60_000 }));
  ui.addEvent(event("boundary.reached"));
  assert.equal(elements.get("allowanceWait").hidden, true);
  assert.equal(timers.size, 0);
  ui.addEvent(event("model.quota_wait", { waitMs: 60_000 }));
  ui.addEvent(event("model.quota_resumed"));
  assert.equal(elements.get("status").textContent, "Safe boundary", "Late model callbacks must not replace the protected boundary status");
  assert.equal(elements.get("allowanceWait").hidden, true);
  for (const type of ["run.failed", "run.cancelled", "run.completed"]) {
    ui.attachRun(`fixture-${type}`);
    seq = 0;
    ui.addEvent(event("model.quota_wait", { waitMs: 60_000 }));
    ui.finish(type, "Fixture timeout: no hotel was booked.");
    assert.equal(elements.get("allowanceWait").hidden, true);
    assert.equal(timers.size, 0, `${type} must clear quota waiting`);
    const finishedStatus = elements.get("status").textContent;
    ui.addEvent(event("model.quota_wait", { waitMs: 60_000 }));
    ui.addEvent(event("model.quota_resumed"));
    assert.equal(elements.get("status").textContent, finishedStatus, "Late model callbacks must not revive a finished run");
    assert.equal(timers.size, 0);
  }
  ui.attachRun("next-run");
  seq = 0;
  ui.addEvent(event("model.quota_wait", { waitMs: 60_000 }));
  ui.attachRun("another-run");
  assert.equal(elements.get("allowanceWait").hidden, true);
  assert.equal(timers.size, 0, "Attaching a different run must clear the old countdown");
  seq = 0;
  ui.addEvent(event("model.quota_wait", { waitMs: 60_000 }));
  ui.resetAgentCards();
  assert.equal(elements.get("allowanceWait").hidden, true);
  assert.equal(timers.size, 0, "Starting a new run must clear quota waiting");
}

const fixtureIntake = { ready: true, goal: { destination: "Pune", checkIn: "2026-12-15", checkOut: "2026-12-17", adults: 2, rooms: 1,
  budgetInr: 5000, supplier: "booking.com", supplierMode: "verified-adapter", intakeSource: "groq" } };
const jsonResponse = (data, ok = true) => ({ ok, json: async () => data });
async function connectedFixture(content) {
  const fixture = createUiFixture(content);
  fixture.setFetch(async () => jsonResponse({ ready: true, browserReady: true, agents: [], intakeMode: "llm-assisted", browserActionMode: "agentic" }));
  assert.equal(await fixture.ui.probeRuntime(""), true);
  fixture.elements.get("query").value = "Find a hotel in Pune on 15 December 2026 for 2 adults 1 room under 5000";
  fixture.requests.length = 0;
  return fixture;
}
for (const content of [html, hostedHtml]) {
  const fixture = await connectedFixture(content);
  const { ui, elements, requests, timeouts } = fixture;
  let resolveOldIntake;
  fixture.setFetch(() => new Promise(resolve => { resolveOldIntake = resolve; }));
  const cancelledStart = ui.startRun();
  const oldSignal = requests[0].options.signal;
  assert.equal(requests[0].url, "/api/intake");
  assert.equal(elements.get("stop").disabled, false, "Cancel must be enabled while intake awaits a model response");
  assert.equal(elements.get("stop").textContent, "Cancel interpretation");
  assert.match(elements.get("clarification").textContent, /AI interpretation may wait for its allowance/);
  assert.equal(timeouts.size, 1);
  assert.equal([...timeouts.values()][0].at - fixture.now(), 95_000);
  await ui.stopRun();
  assert.equal(oldSignal.aborted, true);
  assert.equal(elements.get("status").textContent, "Cancelled");
  assert.equal(elements.get("start").disabled, false);
  assert.equal(elements.get("stop").disabled, true);
  assert.equal(timeouts.size, 0, "Local cancellation must clear its intake deadline");
  assert.equal(requests.length, 1, "Cancelling interpretation must not call any run or server cancellation endpoint");

  let resolveNewIntake;
  fixture.setFetch(url => url === "/api/intake" ? new Promise(resolve => { resolveNewIntake = resolve; }) : jsonResponse({ runId: "new-run" }));
  const newStart = ui.startRun();
  resolveOldIntake(jsonResponse(fixtureIntake));
  await cancelledStart;
  assert.equal(requests.filter(request => request.url === "/api/runs").length, 0, "A delayed cancelled intake reply must not start a browser run");
  assert.equal(elements.get("status").textContent, "Understanding request", "An old cancelled request must not replace a new attempt's status");
  assert.equal(elements.get("start").disabled, true);
  assert.equal(elements.get("stop").disabled, false);
  assert.equal(timeouts.size, 1, "Old cleanup must not remove a newer attempt's deadline");
  resolveNewIntake(jsonResponse(fixtureIntake));
  await newStart;
  assert.equal(requests.filter(request => request.url === "/api/runs").length, 1);
  assert.equal(elements.get("status").textContent, "Running");
  assert.equal(elements.get("stop").textContent, "Cancel run");
  assert.equal(timeouts.size, 0, "Successful interpretation must clear its deadline");

  const timeoutFixture = await connectedFixture(content);
  timeoutFixture.setFetch((_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(signal.reason))));
  const timedStart = timeoutFixture.ui.startRun();
  timeoutFixture.advance(95_000);
  await timedStart;
  assert.equal(timeoutFixture.elements.get("status").textContent, "Interpretation timed out");
  assert.match(timeoutFixture.elements.get("clarification").textContent, /no browser run was started/);
  assert.equal(timeoutFixture.elements.get("start").disabled, false);
  assert.equal(timeoutFixture.elements.get("stop").disabled, true);
  assert.equal(timeoutFixture.timeouts.size, 0);
  assert.equal(timeoutFixture.requests.filter(request => request.url === "/api/runs").length, 0);

  const restoredFixture = await connectedFixture(content);
  let resolveRestoredIntake;
  restoredFixture.setFetch(() => new Promise(resolve => { resolveRestoredIntake = resolve; }));
  const restoredStart = restoredFixture.ui.startRun();
  restoredFixture.ui.attachRun("already-active");
  assert.equal(restoredFixture.requests[0].options.signal.aborted, true);
  resolveRestoredIntake(jsonResponse(fixtureIntake));
  await restoredStart;
  assert.equal(restoredFixture.elements.get("status").textContent, "Restoring run");
  assert.equal(restoredFixture.elements.get("start").disabled, true);
  assert.equal(restoredFixture.elements.get("stop").disabled, false);
  assert.equal(restoredFixture.timeouts.size, 0);
  assert.equal(restoredFixture.requests.filter(request => request.url === "/api/runs").length, 0, "Restoring an existing run must invalidate pending intake");

  const bodyFixture = await connectedFixture(content);
  let resolveIntakeBody;
  let bodyParsingStarted;
  const bodyReady = new Promise(resolve => { bodyParsingStarted = resolve; });
  bodyFixture.setFetch(() => ({ ok: true, json: () => new Promise(resolve => { resolveIntakeBody = resolve; bodyParsingStarted(); }) }));
  const bodyStart = bodyFixture.ui.startRun();
  await bodyReady;
  assert.equal(typeof resolveIntakeBody, "function");
  await bodyFixture.ui.stopRun();
  resolveIntakeBody(fixtureIntake);
  await bodyStart;
  assert.equal(bodyFixture.elements.get("status").textContent, "Cancelled");
  assert.equal(bodyFixture.timeouts.size, 0);
  assert.equal(bodyFixture.requests.filter(request => request.url === "/api/runs").length, 0, "Cancellation during response parsing must also prevent a run");

  const clarificationFixture = await connectedFixture(content);
  clarificationFixture.setFetch(() => jsonResponse({ ready: false, message: "How many rooms?" }, false));
  await clarificationFixture.ui.startRun();
  assert.equal(clarificationFixture.elements.get("status").textContent, "Need one detail");
  assert.equal(clarificationFixture.elements.get("start").disabled, false);
  assert.equal(clarificationFixture.elements.get("stop").disabled, true);
  assert.equal(clarificationFixture.timeouts.size, 0, "A validation response must clear pending controls and timers");
  assert.equal(clarificationFixture.requests.filter(request => request.url === "/api/runs").length, 0);
}

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
