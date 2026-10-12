import assert from "node:assert/strict";
import { mkdir, readFile, writeFile } from "node:fs/promises";

const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:4180";
const scenarios = [
  { name: "Pune named hotel, one night", query: "book Hyatt Place Pune Hinjawadi on 22 December 2026 for 1 adult 1 room under INR 10,000", hotel: "Hyatt Place Pune Hinjawadi", max: 10000 },
  { name: "Pune repeated with spelling mistakes", query: "need Hyatt Place Pune Hinjawadi pune for 1 adlt 1 rom on 22 december 2026 buget under 10000", hotel: "Hyatt Place Pune Hinjawadi", max: 10000 },
  { name: "Pune exact hotel over budget", query: "book Hyatt Place Pune Hinjawadi on 22 December 2026 for 1 adult 1 room under INR 1,000", overBudget: true },
  { name: "Kolkata generic hotel, budget range and cancellation", query: "find high rating hotel in Kolkata New Town 8-10 january 2027 for 2 adlts 1 room budget 7000-18000 free cancellation", min: 7000, max: 18000, freeCancellation: true, rated: true },
  { name: "Pune three adults and two rooms", query: "book Hyatt Place Pune Hinjawadi in Pune for 3 adults 2 rooms on 22 December 2026 total budget under 30000", hotel: "Hyatt Place Pune Hinjawadi", max: 30000, rooms: 2, adults: 3 },
  { name: "Vizag original noisy request, five nights", query: "find a hotel in vizag andrapardesh under 9000 budget for 1 adult 1 room from 11 of november to 16 of november with high rating", max: 9000, rooms: 1, adults: 1, rated: true },
  { name: "Bengaluru breakfast and generous budget", query: "Find a hotel in Bengaluru, 15-17 December 2026, for 2 adults and 1 room, under INR 50000 total, with breakfast", max: 50000, breakfast: true, adults: 2, rooms: 1, rated: true },
];
const report = [];
for (const scenario of scenarios.filter((scenario) => process.argv.length < 3 || process.argv.slice(2).some((term) => scenario.name.includes(term)))) {
  let runId;
  const startedAt = Date.now();
  try {
    const response = await fetch(`${base}/api/runs`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: scenario.query }) });
    const started = await response.json();
    assert.equal(response.status, 202, JSON.stringify(started));
    runId = started.runId;
    let state;
    let sequence = 0;
    const deadline = Date.now() + 240000;
    do {
      state = await fetch(`${base}/api/runs/${runId}`).then((result) => result.json());
      for (const event of state.events.filter((event) => event.seq > sequence)) console.log(`${scenario.name}: ${event.message}`);
      sequence = state.events.at(-1)?.seq || sequence;
      if (["awaiting_human", "failed", "needs_human", "cancelled"].includes(state.status)) break;
      await new Promise((resolve) => setTimeout(resolve, 2000));
    } while (Date.now() < deadline);
    const boundary = state.events.find((event) => event.type === "boundary.reached")?.evidence;
    const aiDecisions = state.events.filter((event) => event.type === "agent.decision").length;
    report.push({ scenario: scenario.name, query: scenario.query, runId, status: state.status, error: state.error, boundary, aiDecisions, testedAt: new Date().toISOString(), durationMs: Date.now() - startedAt });
    assert.ok(aiDecisions >= 3, 'The live run must use real model-selected browser actions');
    if (scenario.overBudget) {
      assert.equal(state.status, "failed");
      assert.match(state.error, /found, but no displayed stay.*budget/i);
    } else {
      assert.equal(state.status, "awaiting_human", state.error || "Did not reach guest details");
      if (scenario.hotel) assert.equal(boundary.hotel.toLowerCase(), scenario.hotel.toLowerCase());
      assert.equal(boundary.availability, "available");
      assert.ok(boundary.totalInr <= scenario.max);
      if (scenario.min) assert.ok(boundary.totalInr >= scenario.min);
      if (scenario.freeCancellation) assert.equal(boundary.roomPolicy.freeCancellation, true);
      if (scenario.breakfast) assert.equal(boundary.roomPolicy.breakfastIncluded, true);
      if (scenario.rooms) assert.equal(boundary.rooms, scenario.rooms);
      if (scenario.adults) assert.equal(boundary.adults, scenario.adults);
      if (scenario.rated) assert.ok(Number.isFinite(boundary.rating), 'Highest-rating selection must have a verified guest rating');
    }
    report.at(-1).passed = true;
  } catch (error) {
    console.error(`${scenario.name}: ${error.message}`);
    if (!report.some((item) => item.scenario === scenario.name)) report.push({ scenario: scenario.name, runId, error: error.message });
    report.at(-1).passed = false;
    process.exitCode = 1;
  } finally {
    if (runId) {
      const state = await fetch(`${base}/api/runs/${runId}`).then((result) => result.json());
      await fetch(`${base}/api/runs/${runId}/${state.status === "awaiting_human" ? "close" : "cancel"}`, { method: "POST" });
      for (let attempt = 0; attempt < 15; attempt += 1) {
        const health = await fetch(`${base}/api/health`).then((result) => result.json());
        if (!health.activeRunId) break;
        await new Promise((resolve) => setTimeout(resolve, 500));
      }
    }
  }
}
await mkdir("artifacts", { recursive: true });
const previous = process.argv[2] ? await readFile("artifacts/live-booking-report.json", "utf8").then(JSON.parse).catch(() => []) : [];
await writeFile("artifacts/live-booking-report.json", JSON.stringify([...previous.filter((entry) => !report.some((item) => item.scenario === entry.scenario)), ...report], null, 2));
console.log(JSON.stringify(report, null, 2));
