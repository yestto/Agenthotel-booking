import assert from "node:assert/strict";
import { AgentOrchestrator } from "../scripts/agent-orchestrator.mjs";

// Exercise the real graph with deterministic tool evidence; live supplier tests are separate.
const goal = { destination: "Pune", supplier: "booking.com", supplierMode: "verified-adapter", checkIn: "2026-12-22", checkOut: "2026-12-23", adults: 1, rooms: 1, budgetInr: 10000, breakfast: false, freeCancellation: false };
const candidate = (title, rating, totalInr) => ({ index: 0, title, rating, totalInr, scopeText: `${title} in Pune`, destinationConfirmed: true });
const room = (totalInr = 5000, extra = {}) => ({ index: 0, totalInr, occupancyConfirmed: true, breakfastIncluded: false, freeCancellation: false, rowText: "1 adult", ...extra });
const reports = [];

async function check(name, { trip = {}, candidates = [], rooms = {}, changedRoom, failure, expectedHotel, searchError, cancelOnRoom = false, expectedStatus = "completed", supervisorDecider, roomDecider, roomError, checkoutRoomChange }) {
  const events = [];
  const calls = [];
  const decisions = [];
  const fixtureSupervisor = async (observation) => {
    const choice = ["checkout", "inspect", "search", "stop"].map((action) => observation.allowedActions.find((item) => item.action === action)).find(Boolean);
    decisions.push(choice.action);
    return { ...choice, summary: "Fixture choice from current evidence" };
  };
  const fixtureRoom = async (observation) => ({ ...(observation.allowedActions.find((item) => item.action === "select") || { action: "stop", roomId: "" }), summary: "Fixture rate choice" });
  const orchestrator = new AgentOrchestrator({ intakeParser: async () => ({ ...goal, ...trip }), supervisorDecider: supervisorDecider || fixtureSupervisor, roomDecider: roomDecider || fixtureRoom });
  orchestrator.trace.save = async () => {};
  orchestrator.trace.emit = (agent, type, message, evidence = {}) => {
    const event = { seq: events.length + 1, agent, type, message, evidence };
    events.push(event);
    return event;
  };
  let selected;
  let roomObservations = 0;
  let searchCalls = 0;
  orchestrator.tools = {
    bindPolicy: (trip, policy) => { assert.equal(policy.maximumTotalInr, trip.budgetInr); calls.push("policy"); },
    startSession: async () => calls.push("session"),
    search: async () => { searchCalls++; const error = typeof searchError === "function" ? searchError(searchCalls) : searchError; if (error) throw new Error(error); return "https://www.booking.com/searchresults.html"; },
    applyCheckbox: async () => false,
    observeCandidates: async () => candidates,
    openCandidate: async (item) => { selected = item; calls.push(item.title); return {}; },
    observeRooms: async () => {
      roomObservations++;
      if (cancelOnRoom) { await orchestrator.cancel(); throw new Error("Target page, context or browser has been closed"); }
      if (roomError) { const error = roomError(roomObservations); if (error) throw new Error(error); }
      if (checkoutRoomChange && roomObservations > 1) return [checkoutRoomChange];
      return rooms[selected.title] || [];
    },
    selectRoom: async (item, trip) => { calls.push(`select:${trip.rooms}`); return changedRoom || item; },
    verifySelectedRoom: async (item, trip) => (await orchestrator.tools.observeRooms(trip)).find((rate) => rate.index === item.index),
    returnToSearch: async () => calls.push("return"),
    continueToGuestDetails: async () => { calls.push("guest-details"); return "https://secure.booking.com/book.html?stage=guest-details"; },
    verifyBoundary: async () => ({ boundary: "protected-checkout", visibleProtectedFields: 3 }),
    close: async () => calls.push("close"),
  };
  if (failure) await assert.rejects(orchestrator.run("A complete hotel request for the graph scenario test"), failure);
  else {
    const result = await orchestrator.run("A complete hotel request for the graph scenario test");
    if (expectedHotel) assert.equal(result.receipt.hotel, expectedHotel);
    if (expectedStatus === "completed") {
      assert.equal(result.receipt.rooms, trip.rooms || 1);
      assert.equal(events.filter((event) => event.type === "boundary.reached").length, 1);
    }
  }
  assert.equal(orchestrator.status, expectedStatus);
  assert.ok(calls.includes("close"));
  if (expectedStatus !== "completed") assert.ok(!calls.includes("guest-details"), "Rejected evidence must never reach checkout");
  reports.push({ scenario: name, passed: true });
  return { events, calls, decisions };
}

await check("Highest rating within budget, excluding a higher-rated expensive hotel", {
  candidates: [candidate("Expensive", 9.9, 12000), candidate("Cheap", 7.8, 3000), candidate("Best eligible", 9.2, 8000)],
  rooms: { "Best eligible": [room(8000)] }, expectedHotel: "Best eligible",
});
await check("Budget range lower and upper limits", {
  trip: { budgetMinInr: 4000, budgetInr: 6000 }, candidates: [candidate("Too cheap", 9.9, 3999), candidate("Eligible", 8.4, 6000)],
  rooms: { Eligible: [room(6000)] }, expectedHotel: "Eligible",
});
await check("Exact named hotel wins even with a lower rating", {
  trip: { hotelName: "Requested Hotel" }, candidates: [candidate("Popular Hotel", 9.9, 4000), candidate("Requested Hotel", 6.3, 5000)],
  rooms: { "Requested Hotel": [room()] }, expectedHotel: "Requested Hotel",
});
await check("Named hotel over budget does not switch hotels", {
  trip: { hotelName: "Requested Hotel", budgetInr: 2000 }, candidates: [candidate("Requested Hotel", 8.2, 5000), candidate("Cheap", 9.9, 1000)],
  failure: /no displayed stay.*budget/, expectedStatus: "failed",
});
await check("Wrong named hotel branch is rejected", {
  trip: { hotelName: "Holiday Inn Express Pune Hinjawadi" }, candidates: [candidate("Holiday Inn Express Pune Wakad", 9, 5000)],
  failure: /was not found/, expectedStatus: "failed",
});
await check("Named hotel unavailable does not substitute a different hotel", {
  trip: { hotelName: "Requested Hotel" }, candidates: [candidate("Requested Hotel", 8, 5000), candidate("Different Hotel", 9, 5000)],
  failure: /no verified available room/, expectedStatus: "failed",
});
await check("Sold-out highest-rated candidate falls back to next eligible hotel", {
  candidates: [candidate("Sold out", 9.5, 5000), candidate("Available", 9.2, 6000)], rooms: { Available: [room(6000)] }, expectedHotel: "Available",
});
await check("Policies omitted from card are verified in the live room evidence", {
  trip: { breakfast: true, freeCancellation: true }, candidates: [candidate("Eligible", 8, 5000)],
  rooms: { Eligible: [room(5000, { breakfastIncluded: true, freeCancellation: true })] }, expectedHotel: "Eligible",
});
await check("Non-refundable rooms cannot satisfy free cancellation", {
  trip: { freeCancellation: true }, candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] },
  failure: /No room could be verified/, expectedStatus: "failed",
});
await check("Unproven room occupancy is rejected", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room(5000, { occupancyConfirmed: false })] },
  failure: /No room could be verified/, expectedStatus: "failed",
});
await check("Two-room quantities propagate to checkout receipt", {
  trip: { adults: 3, rooms: 2 }, candidates: [candidate("Eligible", 8, 8000)], rooms: { Eligible: [room(8000, { quantity: 2 })] }, expectedHotel: "Eligible",
});
await check("A dormitory bed is not a private room", {
  candidates: [candidate("Hostel", 9.1, 3000), candidate("Private Hotel", 8.9, 5000)],
  rooms: { Hostel: [room(3000, { sharedAccommodation: true })], "Private Hotel": [room()] }, expectedHotel: "Private Hotel",
});
await check("Changed room price over budget stops before checkout", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] }, changedRoom: room(10001),
  failure: /price or policies changed/, expectedStatus: "failed",
});
await check("Changed cancellation terms stop before checkout", {
  trip: { freeCancellation: true }, candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room(5000, { freeCancellation: true })] }, changedRoom: room(),
  failure: /price or policies changed/, expectedStatus: "failed",
});
const bounded = await check("Unavailable-room retries are bounded to three properties", {
  candidates: [1, 2, 3, 4, 5].map((index) => candidate(`Hotel ${index}`, 10 - index, 5000)),
  failure: /No room could be verified/, expectedStatus: "failed",
});
assert.equal(bounded.events.filter((event) => event.type === "candidate.rejected").length, 3);
await check("An unrated hotel cannot satisfy generic highest-rating selection", {
  candidates: [candidate("Unknown rating", null, 5000)], rooms: { "Unknown rating": [room()] },
  failure: /visible guest rating/, expectedStatus: "failed",
});
await check("A specific named hotel does not require a guest rating", {
  trip: { hotelName: "Requested Hotel" }, candidates: [candidate("Requested Hotel", null, 5000)],
  rooms: { "Requested Hotel": [room()] }, expectedHotel: "Requested Hotel",
});
await check("No supplier results never produce fabricated inventory", { failure: /No observed hotel/, expectedStatus: "failed" });
await check("Human verification is reported as needing human attention", { searchError: "The supplier requested human verification", failure: /human verification/, expectedStatus: "needs_human" });
const cancelled = await check("Cancellation during room observation does not retry or checkout", { candidates: [candidate("Eligible", 8, 5000)], cancelOnRoom: true, expectedStatus: "cancelled" });
assert.ok(!cancelled.calls.includes("return"));

const delegated = await check("Supervisor delegates search and room inspection before verified checkout", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] }, expectedHotel: "Eligible",
});
assert.deepEqual(delegated.decisions, ["search", "inspect", "checkout"]);
assert.ok(delegated.calls.includes("policy"));
await check("Supervisor cannot invent a hotel ID", { supervisorDecider: async () => ({ action: "inspect", candidateId: "hotel_99", summary: "Invented target" }), failure: /unapproved supervisor/, expectedStatus: "failed" });
await check("Supervisor cannot bypass search and room verification", { supervisorDecider: async () => ({ action: "checkout", candidateId: "", summary: "Skip verification" }), failure: /premature/, expectedStatus: "failed" });
await check("Supervisor hands genuine uncertainty to a human", { supervisorDecider: async () => ({ action: "needs_human", candidateId: "", summary: "Confirm the locality before navigating" }), failure: /Human input needed/, expectedStatus: "needs_human" });
await check("Room worker cannot select an invented rate", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] },
  roomDecider: async () => ({ action: "select", roomId: "room_99", summary: "Invented rate" }), failure: /ineligible or stale/, expectedStatus: "failed",
});
await check("Room worker cannot select an over-budget rate", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room(12000)] },
  roomDecider: async () => ({ action: "select", roomId: "room_0", summary: "Ignore budget" }), failure: /ineligible or stale/, expectedStatus: "failed",
});
const retried = await check("Supervisor retries a transient property failure without another browser session", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] }, expectedHotel: "Eligible",
  roomError: (attempt) => attempt === 1 ? "Supplier UI unavailable: visible room table timeout" : null,
  supervisorDecider: async (observation) => ({ ...(observation.allowedActions.find((item) => item.action === "retry_room")
    || observation.allowedActions.find((item) => item.action === "checkout") || observation.allowedActions.find((item) => item.action === "inspect")
    || observation.allowedActions.find((item) => item.action === "search") || { action: "stop", candidateId: "" }), summary: "Recover based on the worker outcome" }),
});
assert.equal(retried.calls.filter((call) => call === "session").length, 1);
assert.equal(retried.calls.filter((call) => call === "Eligible").length, 2);
await check("Price changes during supervisor review stop before checkout", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] }, checkoutRoomChange: room(6000),
  failure: /changed before checkout/, expectedStatus: "failed",
});
await check("Model supervisor failure never falls back to scripted routing", { supervisorDecider: async () => { throw new Error("AI workflow supervisor decision is unavailable"); }, failure: /unavailable/, expectedStatus: "failed" });
await check("Repeated room observations are bounded", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] },
  roomDecider: async () => ({ action: "observe", roomId: "", summary: "Observe forever" }), failure: /ineligible or stale/, expectedStatus: "failed",
});
const searchedAgain = await check("Supervisor recovers search through the same isolated browser session", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] }, expectedHotel: "Eligible",
  searchError: (attempt) => attempt === 1 ? "Supplier UI unavailable: destination cleared and search timeout" : null,
});
assert.deepEqual(searchedAgain.decisions, ["search", "search", "inspect", "checkout"]);
assert.equal(searchedAgain.calls.filter((call) => call === "session").length, 1);
await check("Room worker model failure never falls back to cheapest-rate scripting", {
  candidates: [candidate("Eligible", 8, 5000)], rooms: { Eligible: [room()] },
  roomDecider: async () => { throw new Error("AI room worker decision is unavailable"); }, failure: /unavailable/, expectedStatus: "failed",
});

console.log(`${reports.length} workflow scenarios passed (real orchestration, controlled tool evidence; not live inventory).`);
