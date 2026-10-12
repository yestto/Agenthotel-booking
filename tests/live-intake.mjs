import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";

const base = process.env.AGENT_BASE_URL || "http://127.0.0.1:4180";
const cases = [
  { name: "User's noisy Vizag request", query: "find a hotel in vizag andrapardesh under 9000 budget for 1 adult 1 room from 11 of november to 16 of november with high rating", expected: { destination: /Visakhapatnam/i, checkIn: "2026-11-11", checkOut: "2026-11-16", adults: 1, rooms: 1, budgetInr: 9000, hotelName: undefined } },
  { name: "Hotel and place share Vaishali", query: "I need to book The Vaishali residency hotel in the bihar vaishali for 2 adult from 13 to 15 november 2 room under 9000 budget no lunch", expected: { destination: /Vaishali.*Bihar|Bihar.*Vaishali/i, hotelName: /Vaishali Residency/i, adults: 2, rooms: 2, budgetInr: 9000 } },
  { name: "Hotel named after location", query: "book Hyatt Place Pune Hinjawadi on 22 December 2026 for 1 adult 1 room under INR 10,000", expected: { destination: /Pune/i, hotelName: /Hyatt Place Pune Hinjawadi/i, checkOut: "2026-12-23" } },
  { name: "Budget range with misspelled occupancy", query: "find high rating hotel in Kolkata New Town 8-10 january 2027 for 2 adlts 1 rom budget 7000-18000 free cancellation", expected: { destination: /Kolkata/i, budgetMinInr: 7000, budgetInr: 18000, adults: 2, rooms: 1, freeCancellation: true } },
  { name: "Free-form people and room counts", query: "pune pls three of us need a pair of rooms november 11 2026 total max 9000", expected: { adults: 3, rooms: 2, budgetInr: 9000, checkOut: "2026-11-12" } },
  { name: "Repeated hotel word and spelling errors", query: "look I need to book Akshaya hotel hotel in vizag andra pradesh for 1 adult and 1 room dates between 19 to 20 november my budget under 2000", expected: { destination: /Visakhapatnam/i, hotelName: /Akshaya/i, checkIn: "2026-11-19", checkOut: "2026-11-20" } },
  { name: "Missing adults and rooms", query: "Hotel in Pune on 11 November 2026 under 5000", clarification: /adults.*rooms|rooms.*adults/i },
  { name: "Missing rooms only", query: "Hotel in Pune on 11 November 2026 for 1 adult under 5000", clarification: /rooms/i },
  { name: "Ambiguous two bed room", query: "Hotel in Pune on 11 November 2026 for 2 adults 2 bed room under 5000", clarification: /room|bed/i },
  { name: "Impossible calendar date", query: "Hotel in Pune on 31 November 2026 for 1 adult 1 room under 5000", clarification: /valid calendar/i },
  { name: "Per-night versus total budget", query: "Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000 per night", clarification: /total budget/i },
  { name: "Children must not silently disappear", query: "Hotel in Pune on 11 November 2026 for 2 adults 1 child 1 room under 5000", clarification: /Child occupancy/i },
];
const reports = [];
for (const item of cases) {
  const started = Date.now();
  try {
    const response = await fetch(`${base}/api/intake`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ query: item.query }), signal: AbortSignal.timeout(20000) });
    const result = await response.json();
    if (item.clarification) {
      assert.equal(response.status, 422);
      assert.match(result.message, item.clarification);
    } else {
      assert.equal(response.status, 200, result.message);
      assert.equal(result.goal.intakeSource, "gemini");
      for (const [key, value] of Object.entries(item.expected)) {
        if (value instanceof RegExp) assert.match(result.goal[key], value, key);
        else assert.equal(result.goal[key], value, key);
      }
    }
    reports.push({ scenario: item.name, passed: true, durationMs: Date.now() - started, result });
    console.log(`PASS: ${item.name} (${Date.now() - started}ms)`);
  } catch (error) {
    reports.push({ scenario: item.name, passed: false, error: error.message });
    console.error(`FAIL: ${item.name}: ${error.message}`);
    process.exitCode = 1;
  }
}
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/live-intake-report.json", JSON.stringify(reports, null, 2));
console.log(`${reports.filter((item) => item.passed).length}/${reports.length} live intake scenarios passed.`);
