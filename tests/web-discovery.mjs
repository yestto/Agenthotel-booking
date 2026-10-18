import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import vm from "node:vm";
import { discoverHotel, groundedDiscoveryEvidence, needsWebDiscovery, safeDiscoveryUrl, validateDiscoveryMatch } from "../scripts/web-discovery.mjs";
import { AgentOrchestrator } from "../scripts/agent-orchestrator.mjs";

const goal = { destination: "Vaishali, Bihar", hotelName: "The Vaishali Residency", supplier: "booking.com", supplierMode: "verified-adapter",
  checkIn: "2027-01-12", checkOut: "2027-01-13", adults: 2, rooms: 2, budgetInr: 9000, originalRequest: "PRIVATE ORIGINAL REQUEST" };
const quote = "The Vaishali Residency is in Vaishali, Bihar.";
const grounded = () => ({ content: { parts: [{ text: quote }] }, groundingMetadata: {
  webSearchQueries: ["The Vaishali Residency Vaishali Bihar official"],
  groundingChunks: [{ web: { uri: "https://example-hotel.com/location", title: "Official location" } }],
  groundingSupports: [{ segment: { text: quote, startIndex: 0, endIndex: quote.length }, groundingChunkIndices: [0] }],
  searchEntryPoint: { renderedContent: "<div>Provider attribution</div>" },
} });
const evidence = groundedDiscoveryEvidence(grounded());
assert.equal(evidence.claims[0].text, quote);
assert.deepEqual(evidence.claims[0].sourceIds, ["source_0"]);
assert.equal(needsWebDiscovery({ supplier: "booking.com" }), false);
assert.equal(needsWebDiscovery(goal), true);
assert.equal(needsWebDiscovery({ supplier: "agoda.com" }), true);
for (const url of ["javascript:alert(1)", "http://example.com", "https://user:secret@example.com", "https://127.0.0.1/", "https://localhost/", "https://192.168.1.2/"]) {
  assert.equal(safeDiscoveryUrl(url), null, url);
}
assert.equal(safeDiscoveryUrl("https://example.com/location#secret"), "https://example.com/location");
assert.throws(() => validateDiscoveryMatch({ status: "consistent", summary: "Supported", claimIds: ["invented"] }, evidence), /supporting citations/);
assert.throws(() => validateDiscoveryMatch({ status: "ambiguous", summary: "Ambiguous", claimIds: [] }, evidence), /supporting citations/);
assert.throws(() => validateDiscoveryMatch({ status: "consistent", summary: "Supported", claimIds: ["claim_0"], supplier: "evil.example" }, evidence));
const unsafe = grounded(); unsafe.groundingMetadata.groundingChunks[0].web.uri = "javascript:alert(1)";
assert.equal(groundedDiscoveryEvidence(unsafe).claims.length, 0);
const invented = grounded(); invented.groundingMetadata.groundingSupports[0].segment.text = "A fact not present in the response";
assert.equal(groundedDiscoveryEvidence(invented).claims.length, 0);

let calls = 0;
const decision = { status: "consistent", summary: "Cited location agrees with the requested place.", claimIds: ["claim_0"] };
const fetchImpl = async (_url, options) => {
  calls++;
  const body = JSON.parse(options.body);
  if (calls === 1) {
    assert.deepEqual(body.tools, [{ googleSearch: {} }]);
    assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), { hotelName: goal.hotelName, destination: goal.destination, supplier: goal.supplier });
    assert.ok(!options.body.includes(goal.originalRequest));
    return Response.json({ candidates: [grounded()] });
  }
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  return Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(decision) }] } }] });
};
const before = JSON.stringify(goal);
const result = await discoverHotel(Object.freeze(goal), { apiKey: "fixture-key", fetchImpl });
assert.equal(result.status, "consistent");
assert.equal(result.sources.length, 1);
assert.equal(result.searchSuggestions, "<div>Provider attribution</div>");
assert.equal(calls, 2);
assert.equal(JSON.stringify(goal), before);
assert.ok(!("totalInr" in result) && !("availability" in result), "Discovery is not room evidence");
assert.equal((await discoverHotel({ supplier: "booking.com" }, { fetchImpl: () => assert.fail("Generic search should avoid extra requests") })).status, "skipped");
assert.equal((await discoverHotel(goal, { apiKey: "fixture-key", fetchImpl: async () => Response.json({ candidates: [{ content: { parts: [{ text: quote }] } }] }),
  matchDecider: () => assert.fail("Uncited text must not be assessed as web evidence") })).status, "unconfirmed");
await assert.rejects(discoverHotel(goal, { apiKey: "fixture-key", fetchImpl: async () => new Response("quota", { status: 429 }) }), /Provider HTTP 429/);
await assert.rejects(discoverHotel(goal, { apiKey: "gsk_PrivateFixture" }), /separate search credential/, "The core provider key must never be sent to Google search");
await assert.rejects(discoverHotel(goal, { apiKey: "gsk_PrivateFixture", fetchImpl: () => assert.fail("Wrapped fetch must not dispatch a foreign provider key") }), /separate search credential/);
const controller = new AbortController(); controller.abort();
await assert.rejects(discoverHotel(goal, { signal: controller.signal, apiKey: "fixture-key", fetchImpl: () => assert.fail("Already cancelled") }), { name: "AbortError" });
await assert.rejects(discoverHotel(goal, { apiKey: "fixture-key", timeoutMs: 5, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
}) }), /Search timed out/);

for (const mode of ["ambiguous", "unavailable", "consistent"]) {
  let browserCalls = 0;
  let assessment;
  const events = [];
  const orchestrator = new AgentOrchestrator({ intakeParser: async () => ({ ...goal }),
    discoverySearch: async () => {
      if (mode === "unavailable") throw new Error("Search provider unavailable");
      return { ...result, status: mode, summary: "The hotel branch needs checking." };
    }, supervisorDecider: async input => {
      assessment = input;
      return { action: "stop", candidateId: "", summary: "Fixture stops before supplier browser" };
    },
  });
  orchestrator.trace.save = async () => {};
  orchestrator.trace.emit = (agent, type, message, evidence = {}) => events.push({ agent, type, message, evidence });
  orchestrator.tools = { bindPolicy: () => {}, startSession: () => browserCalls++, close: async () => {} };
  await assert.rejects(orchestrator.run("Complete request for a cited discovery graph fixture"));
  assert.equal(browserCalls, 0);
  assert.equal(events.find(event => event.type === "discovery.completed").evidence.status, mode);
  if (mode === "ambiguous") { assert.equal(orchestrator.status, "needs_human"); assert.equal(assessment, undefined); }
  else { assert.equal(assessment.discovery.status, mode); assert.equal(assessment.goal.supplier, goal.supplier); assert.equal(assessment.goal.budgetInr, goal.budgetInr); }
}

// Execute the actual UI renderer against tiny DOM stubs; source text is never interpreted as HTML.
const html = await readFile(new URL("../src/agent-console.html", import.meta.url), "utf8");
const renderer = html.slice(html.indexOf("    function showDiscovery("), html.indexOf("    function finish("));
const node = () => ({ children: [], textContent: "", hidden: true, append(child) { this.children.push(child); }, replaceChildren() { this.children = []; } });
const els = { discovery: node(), discoverySummary: node(), discoveryClaims: node(), searchSuggestions: node() };
vm.runInNewContext(renderer + "\nshowDiscovery(evidence);", { els, URL, document: { createElement: node }, evidence: {
  status: "consistent", summary: "<img onerror=evil()>", claims: [{ text: "<script>evil()</script>", sourceIds: ["good", "bad"] }],
  sources: [{ id: "good", title: "Official", url: "https://example.com" }, { id: "bad", title: "Bad", url: "javascript:evil()" }],
  searchSuggestions: "<script>evil()</script>",
} });
assert.match(els.discoverySummary.textContent, /<img/);
assert.equal(els.discoveryClaims.children[0].textContent, "<script>evil()</script>");
assert.equal(els.discoveryClaims.children[0].children.length, 1);
assert.equal(els.discoveryClaims.children[0].children[0].rel, "noopener noreferrer");
assert.match(html, /sandbox="allow-popups allow-popups-to-escape-sandbox"/);
assert.doesNotMatch(html, /sandbox="[^"]*(?:allow-scripts|allow-same-origin)/);
assert.doesNotMatch(renderer, /innerHTML/);
console.log("Web discovery checks passed: real search contract, citation grounding, immutable trip, ambiguity handoff, outage, unsafe links, cancellation, timeout and safe UI rendering.");
