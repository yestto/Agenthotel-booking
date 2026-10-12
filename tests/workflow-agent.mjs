import assert from "node:assert/strict";
import { WORKFLOW_LIMITS, SupervisorDecision, RoomDecision, decideSupervisorAction, decideRoomAction, recoverableWorkflowFailure, supervisorObservation, validateSupervisorDecision, validateRoomDecision } from "../scripts/workflow-agent.mjs";
import { BrowserToolGateway, roomMatchesGoal } from "../scripts/agent-orchestrator.mjs";

const goal = { supplier: "booking.com", adults: 2, rooms: 1, budgetInr: 6000, budgetMinInr: 2000, breakfast: true, freeCancellation: true };
const state = { goal, searchAttempts: 1, inspectionAttempts: 0, supervisorSteps: 1, rankedCandidates: [
  { title: "Best", rating: 9.5, totalInr: 5000 }, { title: "Next", rating: 9, totalInr: 4000 },
], rejectedCandidates: [], workflowHistory: [] };
const decision = (action, candidateId = "") => ({ action, candidateId, summary: "Evidence-based next step" });
const observed = supervisorObservation(state);
assert.equal(validateSupervisorDecision(decision("inspect", "hotel_0"), observed).action, "inspect");
for (const choice of [decision("inspect", "hotel_1"), decision("inspect", "invented"), decision("checkout"), decision("search")]) {
  assert.throws(() => validateSupervisorDecision(choice, observed), /premature, stale or unapproved/);
}
assert.throws(() => SupervisorDecision.parse({ ...decision("search"), url: "https://booking.com/searchresults" }));
assert.throws(() => RoomDecision.parse({ action: "select", roomId: "room_0", summary: "Chosen", quantity: 5 }));
const retry = supervisorObservation({ ...state, rejectedCandidates: [0], candidateIndex: 0,
  lastFailure: { phase: "room", recoverable: true, message: "Room table timeout" } });
assert.ok(retry.allowedActions.some((choice) => choice.action === "retry_room"));
assert.ok(retry.allowedActions.some((choice) => choice.action === "inspect" && choice.candidateId === "hotel_1"));
const bounded = supervisorObservation({ ...state, searchAttempts: WORKFLOW_LIMITS.searches, inspectionAttempts: WORKFLOW_LIMITS.inspections,
  lastFailure: { phase: "room", recoverable: true } });
assert.deepEqual(bounded.allowedActions.map((choice) => choice.action), ["needs_human", "stop"]);
assert.ok(recoverableWorkflowFailure("Supplier UI unavailable: visible room table timeout"));
for (const message of ["No verified available room", "Price or policies changed", "AI room worker decision is unavailable", "Captcha human verification", "Policy blocked payment"]) assert.equal(recoverableWorkflowFailure(message), false);
const validRoom = { totalInr: 5000, occupancyConfirmed: true, quantity: 1, breakfastIncluded: true, freeCancellation: true };
assert.ok(roomMatchesGoal(validRoom, goal));
for (const room of [{ ...validRoom, totalInr: 6001 }, { ...validRoom, totalInr: 1999 }, { ...validRoom, occupancyConfirmed: false },
  { ...validRoom, quantity: 2 }, { ...validRoom, sharedAccommodation: true }, { ...validRoom, freeCancellation: false }, { ...validRoom, breakfastIncluded: false }]) assert.equal(roomMatchesGoal(room, goal), false);
assert.throws(() => validateRoomDecision({ action: "select", roomId: "room_1", summary: "Changed rate" }, { allowedActions: [{ action: "select", roomId: "room_0" }] }), /ineligible or stale/);
const tools = new BrowserToolGateway({ signal: new AbortController().signal });
const policy = { allowedHosts: ["booking.com"], minimumTotalInr: 2000, maximumTotalInr: 6000, currency: "INR", stopAt: "guest-details", forbidden: ["login", "personal-data-entry", "final-booking", "payment"] };
tools.bindPolicy(goal, policy);
assert.ok(Object.isFrozen(tools.runPolicy));
assert.throws(() => tools.bindPolicy(goal, { ...policy, maximumTotalInr: 7000 }), /changed goal/);
assert.throws(() => tools.bindPolicy(goal, { ...policy, forbidden: [] }), /transaction permission/);

const response = (value, status = 200) => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(value) }] } }] }), { status });
let captured;
assert.equal((await decideSupervisorAction(observed, { apiKey: "fixture", fetchImpl: async (_, request) => {
  captured = JSON.parse(request.body); return response(decision("inspect", "hotel_0"));
} })).candidateId, "hotel_0");
assert.match(captured.systemInstruction.parts[0].text, /supervise.*delegate/i);
assert.ok(captured.generationConfig.responseSchema.properties.action.enum.includes("retry_room"));
const roomChoice = { action: "select", roomId: "room_0", summary: "Verified rate" };
assert.deepEqual(await decideRoomAction({ allowedActions: [{ action: "select", roomId: "room_0" }] }, { apiKey: "fixture", fetchImpl: async () => response(roomChoice) }), roomChoice);
await assert.rejects(decideSupervisorAction({}, { apiKey: "", fetchImpl: () => assert.fail("Missing key must not call the model") }), /requires GEMINI_API_KEY/);
await assert.rejects(decideRoomAction({}, { apiKey: "fixture", fetchImpl: async () => response({ ...roomChoice, value: "secret" }) }), /Invalid decision schema/);
let calls = 0;
await decideSupervisorAction({}, { apiKey: "fixture", fetchImpl: async () => ++calls === 1 ? response({}, 503) : response(decision("stop")) });
assert.equal(calls, 2);
calls = 0;
await assert.rejects(decideSupervisorAction({}, { apiKey: "fixture", fetchImpl: async () => { calls++; return response({}, 429); } }), /HTTP 429/);
assert.equal(calls, 1);
const controller = new AbortController(); controller.abort();
await assert.rejects(decideRoomAction({}, { apiKey: "fixture", signal: controller.signal, fetchImpl: () => assert.fail("Aborted request") }), /abort/i);
await assert.rejects(decideRoomAction({}, { apiKey: "fixture", timeoutMs: 5, fetchImpl: (_, { signal }) => new Promise((_, reject) => signal.addEventListener("abort", () => reject(new Error("aborted")))) }), /timed out/);
console.log("Supervisor and room-agent checks passed: constrained delegation, ranking order, retry budgets, room eligibility, immutable policy, distinct model contracts, cancellation and failures.");
