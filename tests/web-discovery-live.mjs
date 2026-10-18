import assert from "node:assert/strict";
import { mkdir, writeFile } from "node:fs/promises";
import { discoverHotel } from "../scripts/web-discovery.mjs";

process.loadEnvFile(".env");
const cases = [
  { name: "Exact named hotel and location", identity: { hotelName: "Taj Lake Palace", destination: "Udaipur, Rajasthan", supplier: "booking.com" }, expected: ["consistent"] },
  { name: "Spelling mistake in hotel identity", identity: { hotelName: "Taj Lake Palce", destination: "Udaipur, Rajasthan", supplier: "booking.com" }, expected: ["consistent"] },
  { name: "Named hotel conflicts with the requested city", identity: { hotelName: "Taj Lake Palace", destination: "Jaipur, Rajasthan", supplier: "booking.com" }, expected: ["ambiguous", "unconfirmed"] },
  { name: "Alternative booking supplier identity", identity: { destination: "Udaipur, Rajasthan", supplier: "agoda.com" }, expected: ["consistent"] },
  { name: "Invented hotel must not be positively confirmed", identity: { hotelName: "ZXQ Discovery Probe Hotel 9F47", destination: "Udaipur, Rajasthan", supplier: "booking.com" }, expected: ["unconfirmed"] },
  { name: "Generic default search avoids unnecessary web requests", identity: { destination: "Udaipur, Rajasthan", supplier: "booking.com" }, expected: ["skipped"] },
];
const results = [];
let blockedBy = /^AIza[A-Za-z0-9_-]+$/.test(process.env.GEMINI_API_KEY || "")
  ? undefined : "Google discovery is unavailable without a separate Google credential; no provider requests were sent.";
let requests = 0;
for (const { name, identity, expected } of cases) {
  if (blockedBy && expected[0] !== "skipped") {
    results.push({ scenario: name, identity, status: "blocked", reason: blockedBy, attempted: false });
    console.log(`BLOCKED ${name}: further live requests stopped after the provider error`);
    continue;
  }
  const started = Date.now();
  let providerDiagnostic;
  try {
    const result = await discoverHotel(identity, { fetchImpl: async (...args) => {
      requests++;
      const response = await fetch(...args);
      if (!response.ok) {
        const error = await response.clone().json().then(body => body.error).catch(() => null);
        // Record quota metadata only, never response bodies, keys or project identifiers.
        providerDiagnostic = { httpStatus: response.status, status: error?.status,
          quotas: (error?.details || []).flatMap(detail => (detail.violations || []).map(violation => ({
            metric: violation.quotaMetric, id: violation.quotaId, limit: violation.quotaValue,
          }))), retryDelay: (error?.details || []).find(detail => detail.retryDelay)?.retryDelay };
      }
      return response;
    } });
    assert.ok(expected.includes(result.status), `Expected ${expected.join(" or ")}, received ${result.status}`);
    if (result.status !== "skipped") assert.ok(result.queries?.length, "Provider must report actual search queries");
    if (["consistent", "ambiguous"].includes(result.status)) assert.ok(result.sources.length && result.claims.length, "Positive/ambiguous identity requires cited evidence");
    results.push({ scenario: name, identity, passed: true, elapsedMs: Date.now() - started, ...result });
    console.log(`PASS ${name}: ${result.status}, ${result.sources.length} cited sources`);
  } catch (error) {
    const unavailable = /Provider HTTP (?:401|403|429)|Search timed out/.test(error.message) || [401, 403, 429].includes(providerDiagnostic?.httpStatus);
    results.push({ scenario: name, identity, passed: false, status: unavailable ? "blocked" : "failed", attempted: true,
      elapsedMs: Date.now() - started, error: error.message, providerDiagnostic });
    console.error(`${unavailable ? "BLOCKED" : "FAIL"} ${name}: ${error.message}`);
    if (unavailable) blockedBy = error.message;
    process.exitCode = 1;
  }
}
await mkdir("artifacts", { recursive: true });
await writeFile("artifacts/live-discovery-scenarios-report.json", JSON.stringify({ testedAt: new Date().toISOString(), requests,
  scope: "Actual Google-grounded discovery through Gemini; not room availability or browser checkout. Skipped generic lookup is not a live-search pass.", results }, null, 2));
console.log(`${results.filter(result => result.passed && result.status !== "skipped").length} live lookup passes; ${results.filter(result => result.status === "blocked").length} blocked; ${results.filter(result => result.status === "skipped").length} deliberate skips; ${requests} provider requests.`);
