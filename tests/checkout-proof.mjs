import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { chromium } from "playwright-core";
import { bookingCheckoutSummaryEvidence, BrowserToolGateway } from "../scripts/agent-orchestrator.mjs";

const receipt = { hotel: "Fixture Grand Hotel", checkIn: "2026-12-15", checkOut: "2026-12-17", adults: 2, rooms: 1,
  totalInr: 11760, roomType: "Standard Double Room", roomPolicy: { breakfastIncluded: true, freeCancellation: true } };
const summary = `Your Selection
Your Details
Finish booking
Fixture Grand Hotel
MG Road, 560001 Bangalore, India
Your booking details
Check-in
Tue, Dec 15, 2026
Check-out
Thu, Dec 17, 2026
You selected
2 nights, 1 room for 2 adults
1 x Standard Double Room
Change your selection
Total price
₹ 11,760
Enter your details
Standard Double Room
Breakfast included in the price
Free cancellation before December 10, 2026`;
assert.equal(bookingCheckoutSummaryEvidence(summary, receipt).checkoutSummaryVerified, true);
for (const [changed, expected] of [
  [summary.replace("Fixture Grand Hotel", "Fixture Grand Premium Hotel"), /hotel identity/],
  [summary.replace("Dec 15, 2026", "Dec 16, 2026"), /stay dates/],
  [summary.replace("Dec 17, 2026", "Dec 17, 2027"), /stay dates/],
  [summary.replace("1 room for 2 adults", "2 rooms for 2 adults"), /room quantity/],
  [summary.replace("1 room for 2 adults", "1 room for 1 adult"), /adults/],
  [summary.replace("₹ 11,760", "₹ 12,000"), /total changed/],
  [summary.replace("Total price", "How much will it cost to cancel?"), /verifiable full stay total/],
  [summary.replace("₹ 11,760", "₹ 11,760\n+ ₹ 1,000 taxes and fees"), /additional or excluded charges/],
  [summary.replace("Breakfast included in the price", "No meals included"), /room policies/],
  [summary.replace("Free cancellation before December 10, 2026", "Non-refundable"), /room policies/],
  [summary.replace("Free cancellation before December 10, 2026", "No free cancellation"), /room policies/],
  [summary.replaceAll("Standard Double Room", "Single Room"), /room type/],
  ["Enter your details\nEmail address\nFirst name", /hotel identity/],
]) assert.throws(() => bookingCheckoutSummaryEvidence(changed, receipt), expected);
const priorCheckout = await readFile("artifacts/run_1ee9f7b3-0f80-486e-b0d0-0d5703295426-2026-10-13T15-55-37-516Z/checkout-observation.json", "utf8").then(JSON.parse).catch(() => null);
if (priorCheckout) assert.throws(() => bookingCheckoutSummaryEvidence(priorCheckout.pageText, { ...receipt,
  hotel: "Ambara Kovilakam Private Pool Villa By Travent Mug", roomType: "Three-Bedroom Villa" }), /verifiable full stay total/,
  "A cancellation fee from an actual earlier checkout must never be reused as the current reservation total");

const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
const browser = await chromium.launch({ executablePath, headless: true });
const artifactDir = await mkdtemp(join(tmpdir(), "staypilot-checkout-proof-"));
try {
  const page = await browser.newPage();
  let renderedSummary = summary.replace("Fixture Grand Hotel", "Wrong Hotel");
  await page.route("https://secure.booking.com/**", (route) => route.fulfill({ contentType: "text/html; charset=utf-8",
    body: `<h1>Enter your details</h1><div style="white-space:pre-line">${renderedSummary}</div><input name="firstname"><input name="lastname"><input type="email">` }));
  await page.goto("https://secure.booking.com/book.html");
  const events = [];
  const tools = new BrowserToolGateway({ artifactDir, trace: { emit: (...event) => events.push(event) }, signal: new AbortController().signal });
  tools.page = page;
  tools.supplier = "booking.com";
  tools.supplierMode = "verified-adapter";
  tools.allowedHosts = ["booking.com"];
  tools.readOnly = true;
  await assert.rejects(tools.verifyBoundary(receipt), /hotel identity/);
  assert.equal(events.filter((event) => event[1] === "boundary.reached").length, 0);
  renderedSummary = summary;
  await page.reload();
  const proof = await tools.verifyBoundary(receipt);
  assert.equal(proof.checkoutSummaryVerified, true);
  assert.equal(proof.totalInr, receipt.totalInr);
  assert.deepEqual(await page.locator("input").evaluateAll((fields) => fields.map((field) => field.value)), ["", "", ""]);
} finally {
  await browser.close();
  await rm(artifactDir, { recursive: true, force: true });
}
console.log("Checkout proof checks passed: current hotel, dated stay, quantity, total, room type and policies; guest fields remain untouched");
