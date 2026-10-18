import assert from "node:assert/strict";
import { WORKFLOW_LIMITS, SupervisorDecision, RoomDecision, decideSupervisorAction, decideRoomAction, readPropertyAddress, recoverableWorkflowFailure, supervisorObservation, validateSupervisorDecision, validateRoomDecision } from "../scripts/workflow-agent.mjs";
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
assert.deepEqual(bounded.allowedActions.map((choice) => choice.action), ["stop"]);
const exhaustedSearch = supervisorObservation({ ...state, rankedCandidates: [], searchAttempts: WORKFLOW_LIMITS.searches,
  lastFailure: { phase: 'search', recoverable: true, message: 'Supplier UI unavailable: temporary 502 after a visible retry' } });
assert.deepEqual(exhaustedSearch.allowedActions.map(({ action }) => action), ['stop'], 'Supplier failure is not missing user information');
assert.throws(() => validateSupervisorDecision(decision('needs_human'), exhaustedSearch), /unapproved/);
assert.ok(supervisorObservation({ ...state, lastFailure: { phase: 'search', recoverable: false, message: 'Human verification required' } })
  .allowedActions.some(({ action }) => action === 'needs_human'));
assert.ok(recoverableWorkflowFailure("Supplier UI unavailable: visible room table timeout"));
assert.ok(recoverableWorkflowFailure("AI browser actions made no progress after repeated observations. Please retry or use another supplier."), "The supervisor may use its remaining bounded re-search after browser progress stalls");
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
assert.deepEqual(captured.generationConfig.responseSchema.properties.action.enum, [...new Set(observed.allowedActions.map(({ action }) => action))]);
assert.ok(!captured.generationConfig.responseSchema.properties.action.enum.includes("retry_room"), 'Unavailable delegations are excluded from the model schema');
await decideSupervisorAction(exhaustedSearch, { apiKey: 'fixture', fetchImpl: async (_url, request) => {
  assert.deepEqual(JSON.parse(request.body).generationConfig.responseSchema.properties.action.enum, ['stop']);
  return response(decision('stop'));
} });
const roomChoice = { action: "select", roomId: "room_0", summary: "Verified rate" };
assert.deepEqual(await decideRoomAction({ allowedActions: [{ action: "select", roomId: "room_0" }] }, { apiKey: "fixture", fetchImpl: async () => response(roomChoice) }), roomChoice);
for (const [decide, input, choice] of [
  [decideSupervisorAction, observed, decision("inspect", "hotel_0")],
  [decideRoomAction, { allowedActions: [{ action: "select", roomId: "room_0" }] }, roomChoice],
]) {
  assert.deepEqual(await decide(input, { provider: "groq", apiKey: "fixture", fetchImpl: async (url, request) => {
    assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
    const body = JSON.parse(request.body);
    assert.equal(body.response_format.json_schema.strict, true);
    assert.deepEqual(JSON.parse(body.messages[1].content), JSON.parse(JSON.stringify(input)));
    return Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify(choice) } }] });
  } }), choice);
}
await assert.rejects(decideSupervisorAction({}, { apiKey: "", fetchImpl: () => assert.fail("Missing key must not call the model") }), /requires a configured API key/);
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
const propertyHeader = { hotel: "Tulip Inn Bengaluru Hoodi", visibleHeader: "Tulip Inn Bengaluru Hoodi\nNew No 297, KEB Colony, 560048 Bangalore, India\nShow on map" };
const checkoutChoice = await decideSupervisorAction({ allowedActions: [{ action: 'checkout', candidateId: '' }, { action: 'stop', candidateId: '' }] }, { provider: 'groq', apiKey: 'fixture', fetchImpl: async (_url, request) => {
  const body = JSON.parse(request.body);
  assert.match(body.messages[0].content, /checkout ONLY opens the guest-details page/);
  assert.match(body.messages[0].content, /does NOT prohibit opening it/);
  const schema = body.response_format.json_schema.schema;
  assert.equal(schema.properties.summary.maxLength, 240, 'Provider constraints must match runtime validation so a verbose operational summary cannot abort a valid action');
  assert.equal(schema.properties.summary.minLength, 1);
  assert.equal(schema.properties.candidateId.maxLength, 40);
  assert.deepEqual(schema.properties.candidateId.enum, ['']);
  assert.deepEqual(schema.properties.action.enum, ['checkout', 'stop']);
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(decision('checkout')) } }] });
} });
assert.equal(checkoutChoice.action, 'checkout');
await assert.rejects(decideSupervisorAction({}, { provider: 'groq', apiKey: 'fixture', fetchImpl: async () => Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...decision('stop'), summary: 'x'.repeat(241) }) } }] }) }), /Invalid decision schema \(summary\)/, 'Runtime validation must still reject an oversized response if a provider violates its contract');
await decideRoomAction({ allowedActions: [{ action: 'select', roomId: 'room_0' }, { action: 'stop', roomId: '' }] }, { provider: 'groq', apiKey: 'fixture', fetchImpl: async (_url, request) => {
  const schema = JSON.parse(request.body).response_format.json_schema.schema;
  assert.deepEqual(schema.properties.action.enum, ['select', 'stop']);
  assert.deepEqual(schema.properties.roomId.enum, ['room_0', '']);
  assert.equal(schema.properties.summary.maxLength, 240);
  return Response.json({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(roomChoice) } }] });
} });
const quotedAddress = "New No 297, KEB Colony, 560048 Bangalore, India";
for (const provider of ["gemini", "groq"]) {
  assert.equal(await readPropertyAddress(propertyHeader, { provider, apiKey: "fixture", fetchImpl: async (_url, request) => {
    const body = JSON.parse(request.body);
    const prompt = provider === "groq" ? body.messages[0].content : body.systemInstruction.parts[0].text;
    assert.match(prompt, /exact contiguous quotation/);
    assert.match(prompt, /reviews.*footer/);
    return provider === "groq" ? Response.json({ choices: [{ finish_reason: "stop", message: { content: JSON.stringify({ status: "found", address: quotedAddress }) } }] })
      : response({ status: "found", address: quotedAddress });
  } }), quotedAddress);
}
assert.equal(await readPropertyAddress(propertyHeader, { apiKey: "fixture", fetchImpl: async () => response({ status: "unconfirmed", address: "" }) }), "");
await assert.rejects(readPropertyAddress(propertyHeader, { apiKey: "fixture", fetchImpl: async () => response({ status: "found", address: "560001 Bengaluru, Karnataka, India" }) }), /ungrounded property address quotation/);
await assert.rejects(readPropertyAddress(propertyHeader, { apiKey: "fixture", fetchImpl: async () => response({ status: "unconfirmed", address: quotedAddress }) }), /contradictory property address evidence/);
await assert.rejects(readPropertyAddress(propertyHeader, { apiKey: "fixture", fetchImpl: async () => response({ status: "found", address: "" }) }), /ungrounded property address quotation/);
await assert.rejects(readPropertyAddress(propertyHeader, { apiKey: "fixture", signal: controller.signal, fetchImpl: () => assert.fail("Aborted extraction") }), /abort/i);
console.log("Supervisor and room-agent checks passed: constrained delegation, ranking order, retry budgets, room eligibility, immutable policy, distinct model contracts, cancellation and failures.");
