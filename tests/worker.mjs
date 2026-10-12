import assert from "node:assert/strict";

const worker = (await import(new URL("../dist/server/index.js", import.meta.url))).default;

const hostedHealth = await worker.fetch(new Request("https://demo.test/api/health"), {});
assert.equal(hostedHealth.status, 200);
const hostedHealthBody = await hostedHealth.json();
assert.equal(hostedHealthBody.ready, false);
assert.equal(hostedHealthBody.mode, "hosted-presentation");
assert.equal(hostedHealthBody.agents.length, 8);
assert.equal(hostedHealthBody.orchestration.framework, "LangGraph.js");
assert.equal(hostedHealthBody.orchestration.humanInterrupt, "humanApproval");

const missingKey = await worker.fetch(new Request("https://demo.test/api/plan", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ request: "Hotel in Bengaluru" }),
}), {});
assert.equal(missingKey.status, 503);

const missingInventoryKey = await worker.fetch(new Request("https://demo.test/api/hotels/search", {
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify({ area: "Bengaluru", checkIn: "2026-12-15", checkOut: "2026-12-17", adults: 2 }),
}), {});
assert.equal(missingInventoryKey.status, 503);

const originalFetch = globalThis.fetch;
globalThis.fetch = async (url, options) => {
  if (String(url).includes("api.liteapi.travel")) {
    assert.equal(options.headers["X-API-Key"], "sandbox-test-key");
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.currency, "INR");
    assert.equal(requestBody.occupancies[0].adults, 2);
    return new Response(JSON.stringify({
      sandbox: true,
      hotels: [{ id: "lp1", name: "Live Test Hotel", address: "MG Road", rating: 8.9, main_photo: "https://example.test/hotel.jpg" }],
      data: [{
        hotelId: "lp1",
        roomTypes: [{
          offerId: "offer-1",
          rates: [{
            name: "Deluxe King",
            boardName: "Breakfast Included",
            retailRate: { total: [{ amount: 7800, currency: "INR" }] },
            cancellationPolicies: { refundableTag: "RFN" },
          }],
        }],
      }],
    }), { headers: { "content-type": "application/json" } });
  }
  if (String(url).includes("book.liteapi.travel")) {
    assert.equal(options.headers["X-API-Key"], "sandbox-test-key");
    const requestBody = JSON.parse(options.body);
    assert.equal(requestBody.offerId, "offer-1");
    assert.equal(requestBody.usePaymentSdk, false);
    return new Response(JSON.stringify({
      data: {
        prebookId: "prebook-1",
        hotelId: "lp1",
        checkin: "2026-12-15",
        checkout: "2026-12-17",
        currency: "INR",
        price: 7900,
        sellingPriceToUser: 7900,
        boardChanged: false,
        cancellationChanged: false,
        paymentTypes: ["NUITEE_PAY"],
        roomTypes: [{ rates: [{
          name: "Deluxe King",
          boardName: "Breakfast Included",
          retailRate: { total: [{ amount: 7900, currency: "INR" }] },
          cancellationPolicies: {
            refundableTag: "RFN",
            cancelPolicyInfos: [{ cancelTime: "2026-12-13 10:00:00", amount: 7900 }],
          },
        }] }],
      },
    }), { headers: { "content-type": "application/json" } });
  }
  assert.match(String(url), /models\/test-model:generateContent$/);
  assert.equal(options.headers["x-goog-api-key"], "test-key");
  return new Response(JSON.stringify({
    candidates: [{ content: { parts: [{ text: JSON.stringify({
      area: "Koramangala, Bengaluru",
      hotelName: "Taj MG Road",
      checkIn: "15 December",
      checkOut: "17 December",
      adults: 2,
      budgetInr: 10000,
      requirements: ["breakfast", "free cancellation"],
    }) }] } }],
  }), { headers: { "content-type": "application/json" } });
};

try {
  const response = await worker.fetch(new Request("https://demo.test/api/plan", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ request: "Hotel in Koramangala under 10000" }),
  }), { GEMINI_API_KEY: "test-key", GEMINI_MODEL: "test-model" });
  assert.equal(response.status, 200);
  const body = await response.json();
  assert.equal(body.plan.area, "Koramangala, Bengaluru");
  assert.equal(body.plan.hotelName, "Taj MG Road");
  assert.equal(body.plan.budgetInr, 10000);

  const hotelResponse = await worker.fetch(new Request("https://demo.test/api/hotels/search", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      area: "Bengaluru",
      checkIn: "2026-12-15",
      checkOut: "2026-12-17",
      adults: 2,
      budgetInr: 10000,
      requirements: ["breakfast"],
    }),
  }), { LITEAPI_KEY: "sandbox-test-key" });
  assert.equal(hotelResponse.status, 200);
  const hotelBody = await hotelResponse.json();
  assert.equal(hotelBody.sandbox, true);
  assert.equal(hotelBody.options[0].name, "Live Test Hotel");
  assert.equal(hotelBody.options[0].room, "Deluxe King");
  assert.equal(hotelBody.options[0].price, 7800);
  assert.equal(hotelBody.options[0].refundable, true);

  const prebookResponse = await worker.fetch(new Request("https://demo.test/api/hotels/prebook", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ offerId: "offer-1", quotedPrice: 7800 }),
  }), { LITEAPI_KEY: "sandbox-test-key" });
  assert.equal(prebookResponse.status, 200);
  const prebookBody = await prebookResponse.json();
  assert.equal(prebookBody.prebookId, "prebook-1");
  assert.equal(prebookBody.price, 7900);
  assert.equal(prebookBody.priceChanged, true);
  assert.equal(prebookBody.board, "Breakfast Included");
} finally {
  globalThis.fetch = originalFetch;
}

console.log("StayPilot Worker check passed");
