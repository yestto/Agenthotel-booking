import assert from "node:assert/strict";
import { parseTravelRequestHybrid } from "../scripts/llm-intake.mjs";

const now = new Date("2026-10-10T00:00:00+05:30");
const noisy = "find htel in hydrebad chandanagr on 11 nobember 2026 fr two adlts one rom undr 2000 with breakfst";

await assert.rejects(
  parseTravelRequestHybrid(noisy, { apiKey: "", now }),
  /total budget in INR/,
);

const corrected = await parseTravelRequestHybrid(noisy, {
  apiKey: "test-key",
  model: "test-model",
  now,
  fetchImpl: async (url, options) => {
    assert.match(url, /models\/test-model:generateContent$/);
    assert.equal(options.headers["x-goog-api-key"], "test-key");
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      destination: "Hyderabad, Chandanagar", hotelName: "", supplier: "booking.com",
      checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 2, rooms: 1, budgetMinInr: 0, budgetInr: 2000,
      adultsEvidence: "two adlts", roomsEvidence: "one rom", clarification: "",
      breakfast: true, freeCancellation: false, bedPreference: "none", corrections: ["hydrebad → Hyderabad", "nobember → November"],
    }) }] } }] }), { headers: { "content-type": "application/json" } });
  },
});
assert.equal(corrected.intakeSource, "gemini");
assert.equal(corrected.destination, "Hyderabad, Chandanagar");
assert.equal(corrected.checkOut, "2026-11-12");
assert.equal(corrected.adults, 2);
assert.equal(corrected.rooms, 1);
assert.equal(corrected.breakfast, true);
assert.deepEqual(corrected.corrections, ["hydrebad → Hyderabad", "nobember → November"]);
assert.equal(corrected.originalRequest, noisy);

const overlapping = await parseTravelRequestHybrid("Book The Vaishali Residency hotel in Bihar Vaishali on 13 November 2026 for 2 adults and 1 room under INR 9000", {
  apiKey: "test-key",
  now,
  fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    destination: "Vaishali, Bihar", hotelName: "The Vaishali Residency", supplier: "booking.com",
    checkIn: "2026-11-13", checkOut: "2026-11-14", adults: 2, rooms: 1, budgetMinInr: 0, budgetInr: 9000,
    adultsEvidence: "2 adults", roomsEvidence: "1 room", clarification: "",
    breakfast: false, freeCancellation: false, bedPreference: "none", corrections: [],
  }) }] } }] }), { headers: { "content-type": "application/json" } }),
});
assert.equal(overlapping.destination, "Vaishali, Bihar");
assert.equal(overlapping.hotelName, "The Vaishali Residency");

const akshayaRequest = "look I need to book Akshaya hotel hotel in vizag andra pradesh for 1 adult and 1 room dates between 19 to 20 november my budget under 2000";
const akshaya = await parseTravelRequestHybrid(akshayaRequest, {
  apiKey: "test-key",
  now,
  fetchImpl: async (_url, options) => {
    const prompt = JSON.parse(options.body).systemInstruction.parts[0].text;
    assert.match(prompt, /Classify hotelName and destination as separate semantic fields/);
    assert.match(prompt, /Akshaya Hotel/);
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      destination: "Visakhapatnam, Andhra Pradesh", hotelName: "Akshaya Hotel", supplier: "booking.com",
      checkIn: "2026-11-19", checkOut: "2026-11-20", adults: 1, rooms: 1, budgetMinInr: 0, budgetInr: 2000,
      adultsEvidence: "1 adult", roomsEvidence: "1 room", clarification: "",
      breakfast: false, freeCancellation: false, bedPreference: "none", corrections: ["vizag → Visakhapatnam", "andra → Andhra"],
    }) }] } }] }), { headers: { "content-type": "application/json" } });
  },
});
assert.equal(akshaya.intakeSource, "gemini");
assert.equal(akshaya.destination, "Visakhapatnam, Andhra Pradesh");
assert.equal(akshaya.hotelName, "Akshaya Hotel");

const ranged = await parseTravelRequestHybrid("Hotel in Vizag on 11 November 2026 for 1 adult and 1 room budget 2000-6000", {
  apiKey: "test-key",
  now,
  fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
    destination: "Visakhapatnam, Andhra Pradesh", hotelName: "", supplier: "booking.com",
    checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 1, rooms: 1, budgetMinInr: 2000, budgetInr: 6000,
    adultsEvidence: "1 adult", roomsEvidence: "1 room", clarification: "",
    breakfast: false, freeCancellation: false, bedPreference: "none", corrections: ["Vizag → Visakhapatnam"],
  }) }] } }] }), { headers: { "content-type": "application/json" } }),
});
assert.equal(ranged.budgetMinInr, 2000);
assert.equal(ranged.budgetInr, 6000);
assert.match(ranged.interpretedRequest, /between INR 2000 and 6000/);

await assert.rejects(
  parseTravelRequestHybrid("find htel in pune on 11 novembr 2026 under 4000", {
    apiKey: "test-key",
    now,
    fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify({
      destination: "Pune", hotelName: "", supplier: "booking.com",
      checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 1, rooms: 1, budgetMinInr: 0, budgetInr: 4000,
      breakfast: false, freeCancellation: false, bedPreference: "none", corrections: [],
    }) }] } }] }), { headers: { "content-type": "application/json" } }),
  }),
  /How many adults and rooms/,
);

await assert.rejects(
  parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult and 1 room under INR 3000", {
    apiKey: "test-key",
    now,
    fetchImpl: async () => new Response("unavailable", { status: 503 }),
  }),
  /AI language classification is unavailable/,
);

const baseIntent = { destination: "Pune", hotelName: "", supplier: "booking.com", checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 1, rooms: 1, budgetMinInr: 0, budgetInr: 5000, breakfast: false, freeCancellation: false, bedPreference: "none", corrections: [], adultsEvidence: "1 adult", roomsEvidence: "1 room", clarification: "" };
const mockIntent = (intent) => async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(intent) }] } }] }));
let intakeRetryCalls = 0;
assert.equal((await parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000", {
  apiKey: "test-key", now, fetchImpl: async (...args) => ++intakeRetryCalls === 1 ? new Response('{}', { status: 503 }) : mockIntent(baseIntent)(...args),
})).adults, 1);
assert.equal(intakeRetryCalls, 2);
intakeRetryCalls = 0;
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000", {
  apiKey: "test-key", now, fetchImpl: async () => { intakeRetryCalls++; return new Response('{}', { status: 429 }); },
}), /Provider HTTP 429/);
assert.equal(intakeRetryCalls, 1, "Quota errors must not trigger model retries");
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 under 5000", {
  apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, adults: 0, rooms: 0, adultsEvidence: "", roomsEvidence: "", clarificationField: "budget", clarification: "Is this per night or total?" }),
}), /adults.*rooms|rooms.*adults/, "Essential missing occupancy must not be hidden by a speculative model clarification");
for (const clarificationField of ["adults", "rooms"]) {
  await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 under 5000", {
    apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, adults: 0, rooms: 0, adultsEvidence: "", roomsEvidence: "", clarificationField, clarification: "Could you specify the number of guests?" }),
  }), /adults.*rooms|rooms.*adults/, "A vague model question must still request both omitted counts");
}
const unusual = await parseTravelRequestHybrid("pune pls three of us need a pair of rooms november 11 2026 max 5000", {
  apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, adults: 3, rooms: 2, adultsEvidence: "three of us", roomsEvidence: "a pair of rooms" }),
});
assert.equal(unusual.adults, 3, "Valid free-form occupancy must reach the LLM rather than being blocked by the rule parser");
assert.equal(unusual.rooms, 2);
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 under 5000", { apiKey: "test-key", now, fetchImpl: mockIntent(baseIntent) }), /How many adults and rooms/);
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult under 5000", { apiKey: "test-key", now, fetchImpl: mockIntent(baseIntent) }), /number of rooms/);
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult 2 bed room under 5000", { apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, clarification: "Do you mean two rooms or one room with two beds?" }) }), /two rooms/);
const budgetGuard = await parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000", { apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, budgetInr: 50000 }) });
const explicitRooms = await parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 2 adults 2 rooms under 5000", {
  apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, adults: 2, rooms: 2, adultsEvidence: "2 adults", roomsEvidence: "2 rooms", clarificationField: "rooms", clarification: "Do you mean two separate rooms?" }),
});
assert.equal(explicitRooms.rooms, 2, "An already explicit, grounded room count must not generate a redundant clarification");
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 2 adults one room or two rooms under 5000", {
  apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, adults: 2, adultsEvidence: "2 adults", roomsEvidence: "one room", clarificationField: "rooms", clarification: "Do you need one room or two rooms?" }),
}), /one room or two rooms/, "Conflicting source counts must keep their clarification");
assert.equal(budgetGuard.budgetInr, 5000, "The model must not enlarge a clearly stated budget");
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000", { apiKey: "test-key", now, fetchImpl: mockIntent({ ...baseIntent, checkIn: "2026-11-12", checkOut: "2026-11-13" }) }), /changed the stated dates/);
for (const [query, expected] of [
  ["Hotel in Pune on 31 November 2026 for 1 adult 1 room under 5000", /not valid calendar/],
  ["Hotel in Pune on 11 November 2026 for 1 adult 1 room budget 6000-2000", /lower amount first/],
  ["Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000 per night", /total budget/],
  ["Hotel in Pune on 11/12/2026 for 1 adult 1 room under 5000", /unambiguous/],
  ["Hotel in Pune on 11 November 2026 for 2 adults 1 child 1 room under 5000", /Child occupancy/],
]) {
  await assert.rejects(parseTravelRequestHybrid(query, { apiKey: "test-key", now, fetchImpl: () => assert.fail("Invalid trip must be rejected before spending an LLM call") }), expected);
}
await assert.rejects(parseTravelRequestHybrid("Hotel in Pune on 11 November 2026 for 1 adult 1 room under 5000", { apiKey: "test-key", now, timeoutMs: 10, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }), /classification is unavailable/);

console.log("Hybrid LLM intake checks passed: noisy phrasing, place/hotel separation, grounded occupancy, explicit budget/date guards, ambiguous details, invalid trips and timeouts");
