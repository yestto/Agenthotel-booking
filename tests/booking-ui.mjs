import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { chromium } from "playwright-core";
import { BrowserToolGateway } from "../scripts/agent-orchestrator.mjs";

const executablePath = [process.env.CHROME_PATH, "C:/Program Files/Google/Chrome/Application/chrome.exe", "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe"].find((path) => path && existsSync(path));
assert.ok(executablePath, "Set CHROME_PATH to run browser regression tests.");
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  const events = [];
  const tools = new BrowserToolGateway({ trace: { emit: (...event) => events.push(event) }, signal: new AbortController().signal });
  tools.page = page;

  async function fixture({ suggestions, clearFirstSelection = false }) {
    await page.setContent(`<label>Destination <input name="ss"></label><ul role="listbox"></ul>`);
    await page.evaluate(({ suggestions, clearFirstSelection }) => {
      const input = document.querySelector("input");
      const list = document.querySelector("ul");
      let timer;
      let committed = false;
      window.selectionAttempts = 0;
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !committed) input.value = "";
      });
      input.addEventListener("input", () => {
        committed = false;
        clearTimeout(timer);
        list.replaceChildren();
        timer = setTimeout(() => {
          for (const text of suggestions) {
            const item = document.createElement("li");
            item.dataset.testid = "autocomplete-result";
            item.innerText = text;
            item.addEventListener("click", () => {
              window.selectionAttempts += 1;
              input.value = clearFirstSelection && window.selectionAttempts === 1 ? "" : text.split("\n")[0];
              committed = Boolean(input.value);
              list.replaceChildren();
            });
            list.append(item);
          }
        }, 1_400);
      });
    }, { suggestions, clearFirstSelection });
  }

  const namedGoal = { destination: "Pune, Maharashtra", hotelName: "Hyatt Place Pune Hinjawadi" };
  await fixture({ suggestions: ["Hyatt Pune\nPune, Maharashtra, India", "Hyatt Place Pune Hinjawadi\nPune, Maharashtra, India"], clearFirstSelection: true });
  await tools.configureBookingDestination(namedGoal);
  assert.equal(await page.locator("input").inputValue(), namedGoal.hotelName);
  assert.equal(await page.evaluate(() => window.selectionAttempts), 2, "A cleared selection must be recovered through another visible suggestion click");
  assert.match(tools.bookingDestinationSelection.text, /Maharashtra/);

  await fixture({ suggestions: ["New Town\nEdinburgh, United Kingdom", "New Town\nKolkata, West Bengal, India"] });
  await tools.configureBookingDestination({ destination: "New Town, Kolkata, West Bengal" });
  assert.match(tools.bookingDestinationSelection.text, /Kolkata/);
  assert.equal(await page.evaluate(() => window.selectionAttempts), 1);

  await page.route("https://www.booking.com/**", (route) => route.fulfill({
    contentType: "text/html",
    body: `<input name="ss" value="New Town, Kolkata, West Bengal, India">
      <div data-testid="searchbox-dates-container"></div>
      <div data-testid="occupancy-config"></div>
      <article data-testid="property-card" hidden>Live fixture result</article>
      <script>setTimeout(() => {
        document.querySelector('[data-testid="searchbox-dates-container"]').textContent = 'Fri, Jan 8 — Sun, Jan 10';
        document.querySelector('[data-testid="occupancy-config"]').textContent = '2 adults · 0 children · 1 room';
        document.querySelector('article').hidden = false;
      }, 1400);</script>`,
  }));
  await page.goto("https://www.booking.com/district/in/calcutta/newtown.html");
  const verification = await tools.verifyBookingSearch({ destination: "New Town, Kolkata", checkIn: "2027-01-08", checkOut: "2027-01-10", adults: 2, rooms: 1 });
  assert.equal(verification.verified, true, "Clean supplier URLs must be accepted only when the hydrated visible form and results match");
  assert.equal(verification.observed.searchOutcomeVisible, true);

  await page.unroute("https://www.booking.com/**");
  const fullGoal = { supplier: "booking.com", destination: "Pune", checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 1, rooms: 1 };
  let redirectToLanding = false;
  await page.route("https://www.booking.com/**", (route) => {
    const url = new URL(route.request().url());
    if (url.pathname === "/" || url.pathname.startsWith("/city/")) return route.fulfill({ contentType: "text/html", body: `<input name="ss"><ul role="listbox"></ul>
      <button data-testid="searchbox-dates-container">Select dates</button><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div>
      <button id="search">Search</button><div id="calendar" hidden style="position:fixed;inset:0;background:white;z-index:10">
      <button data-date="2026-11-11">November 11</button><button data-date="2026-11-12">November 12</button></div>
      <script>
      const input = document.querySelector('input');
      input.addEventListener('input', () => { document.querySelector('ul').innerHTML = '<li data-testid="autocomplete-result">Pune</li>'; document.querySelector('li').onclick = () => { input.value = 'Pune'; document.querySelector('ul').replaceChildren(); }; });
      document.querySelector('[data-testid="searchbox-dates-container"]').onclick = () => document.querySelector('#calendar').hidden = false;
      for (const button of document.querySelectorAll('[data-date]')) button.onclick = () => document.querySelector('[data-testid="searchbox-dates-container"]').textContent = 'Wed, Nov 11 — Thu, Nov 12';
      document.addEventListener('keydown', event => { if (event.key === 'Escape') document.querySelector('#calendar').hidden = true; });
      document.querySelector('#search').onclick = () => { window.location.href = '/searchresults.html?ss=Pune&checkin=2026-11-11&checkout=2026-11-12&group_adults=1&no_rooms=1'; };
      </script>` });
    if (url.pathname === "/searchresults.html" && redirectToLanding) {
      redirectToLanding = false;
      return route.fulfill({ contentType: "text/html", body: '<script>location.replace("https://www.booking.com/city/in/pune.html")</script>' });
    }
    if (url.pathname === "/searchresults.html") return route.fulfill({ contentType: "text/html", body: `<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Wed, Nov 11 — Thu, Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Fixture hotel</article>` });
    if (url.pathname === "/hotel/in/fixture.html") return route.fulfill({ contentType: "text/html", body: `<p>You won't be charged yet</p><button onclick="location.href='/guest-details'">I'll reserve</button>` });
    return route.fulfill({ contentType: "text/html", body: '<h1>Enter your details</h1><input type="email"><input name="firstname">' });
  });
  await page.goto("https://www.booking.com/");
  await tools.configureBookingSearch(fullGoal);
  assert.equal(new URL(page.url()).pathname, "/searchresults.html", "A calendar left open after selection must be closed before visibly submitting Search");
  await page.goto("https://www.booking.com/");
  await tools.configureBookingDestination(fullGoal);
  await tools.configureBookingDates(fullGoal);
  await tools.configureBookingOccupancy(fullGoal);
  tools.bookingDestinationSelection.value = "Pune, Maharashtra, India";
  const originalDestinationSkill = tools.configureBookingDestination;
  tools.configureBookingDestination = async () => assert.fail("A committed destination with a supplier-shortened label must not be re-entered during submit");
  try { await tools.submitBookingSearch(fullGoal); }
  finally { tools.configureBookingDestination = originalDestinationSkill; }
  assert.equal(new URL(page.url()).pathname, "/searchresults.html");
  redirectToLanding = true;
  tools.artifactDir = resolve("artifacts", "browser-fixture-recovery");
  await page.goto("https://www.booking.com/");
  await tools.configureBookingSearch(fullGoal);
  assert.equal(new URL(page.url()).pathname, "/searchresults.html", "A static destination landing-page redirect must recover through a fresh homepage form, never a constructed results URL");
  await page.goto("https://www.booking.com/hotel/in/fixture.html");
  const checkoutUrl = await tools.continueToGuestDetails();
  assert.equal(new URL(checkoutUrl).pathname, "/guest-details");
  assert.equal(tools.readOnly, true, "A successful checkout navigation must not click the old reservation button again");
  tools.readOnly = false;

  await page.route("https://www.booking.com/hotel/in/observed.html", (route) => route.fulfill({ contentType: "text/html", body: "<title>Observed Hotel - Booking.com</title><h1>Observed Hotel</h1>" }));
  await page.route("https://www.booking.com/observed-list", (route) => route.fulfill({ contentType: "text/html", body: `
    <article data-testid="property-card"><span data-testid="title">Different Hotel</span><a data-testid="title-link" href="/hotel/in/different.html">Different Hotel</a></article>
    <article data-testid="property-card"><span data-testid="title">Observed Hotel</span><a data-testid="title-link" href="/hotel/in/observed.html">Observed Hotel</a></article>` }));
  const observedCandidate = { index: 0, title: "Observed Hotel", href: "https://www.booking.com/hotel/in/observed.html" };
  tools.context = page.context();
  tools.searchPage = page;
  for (const mode of ["verified-adapter", "universal-computer-use"]) {
    tools.supplierMode = mode;
    await page.goto("https://www.booking.com/observed-list");
    const originalGoto = page.goto;
    page.goto = async () => assert.fail("Property selection must click an observed link, not navigate directly");
    const started = Date.now();
    try {
      const opened = await tools.openCandidate(observedCandidate);
      assert.match(opened.title, /Observed Hotel/);
      assert.equal(page.url(), observedCandidate.href);
      assert.ok(Date.now() - started < 5000, "Same-tab links must not wait for a nonexistent popup");
    } finally { page.goto = originalGoto; }
  }
  tools.supplierMode = "verified-adapter";
  await page.goto("https://www.booking.com/observed-list");
  await assert.rejects(tools.openCandidate({ ...observedCandidate, title: "An unrelated property" }), /title changed/);
  assert.equal(page.url(), "https://www.booking.com/observed-list", "A changed hotel card must not be clicked");

  await page.setContent(`<label><input type="checkbox" aria-label="Free cancellation">Free cancellation</label><div aria-hidden="true" style="position:fixed;inset:0;z-index:10"></div>`);
  assert.equal(await tools.applyCheckbox(/free cancellation/i), true);
  assert.equal(await page.getByRole("checkbox").isChecked(), true, "An overlay must not turn an optional filter into a failed hotel search");

  const roomGoal = { adults: 3, rooms: 2 };
  await page.setContent(`<table><tr>
    <td class="hprt-table-cell-occupancy"><span title="Max. people: 2"></span></td>
    <td><span class="bui-price-display__value">₹1,999.50</span><span class="prd-taxes-and-fees-under-price">+ ₹100.75 taxes</span> Breakfast included Free cancellation</td>
    <td><select id="hprt_nos_select_available"><option value="0">0</option><option value="1" selected>1</option><option value="2">2</option></select></td>
    </tr><tr><td>2 adults <span class="bui-price-display__value">₹900</span></td>
    <td><select id="hprt_nos_select_insufficient"><option value="0">0</option><option value="1">1</option><option value="2" disabled>2</option></select></td>
    </tr></table>`);
  const rooms = await tools.observeRooms(roomGoal);
  assert.equal(rooms.length, 1, "Unavailable quantities must be excluded");
  assert.equal(rooms[0].totalInr, 4200.5, "Both rooms and their taxes must be priced");
  assert.equal(rooms[0].occupancyConfirmed, true, "Two rooms sleeping two adults each can accommodate three adults");
  const selected = await tools.selectRoom(rooms[0], roomGoal);
  assert.equal(selected.quantity, 2);
  assert.equal(await page.locator("#hprt_nos_select_available").inputValue(), "2");
  assert.equal(await page.locator("#hprt_nos_select_insufficient").inputValue(), "0");
  assert.equal((await tools.verifySelectedRoom(selected, roomGoal)).quantity, 2);
  await page.locator("#hprt_nos_select_available").selectOption("1");
  await assert.rejects(tools.verifySelectedRoom(selected, roomGoal), /quantity changed before checkout/);
  await page.locator("#hprt_nos_select_available").selectOption("2");
  await page.locator("#hprt_nos_select_available").evaluate((element) => element.addEventListener("change", () => { document.querySelector(".bui-price-display__value").textContent = "₹3,000"; }));
  assert.equal((await tools.selectRoom(selected, roomGoal)).totalInr, 6201.5, "A price change must be re-read after selection");

  await page.setContent("<h1>No rooms available for your dates — sold out</h1>");
  const unavailableStart = Date.now();
  assert.deepEqual(await tools.observeRooms(roomGoal), []);
  assert.ok(Date.now() - unavailableStart < 1500, "Known unavailability should not wait for a 45-second selector timeout");

  await page.setContent(`<article data-testid="property-card"><h2 data-testid="title">Fixture Hotel</h2><span data-testid="price-and-discounted-price">₹4,000</span><a data-testid="title-link" href="https://www.booking.com/hotel/in/fixture.html">Open hotel</a></article>`);
  const observationStart = Date.now();
  const cards = await tools.observeCandidates({ destination: "Pune" }, {});
  assert.equal(cards.length, 1);
  assert.equal(cards[0].rating, null);
  assert.ok(Date.now() - observationStart < 1500, "Missing optional tax/rating labels must not cause per-card timeouts");
  await page.setContent('<input type="email" hidden><input name="firstname" hidden>');
  assert.equal(await tools.protectedCheckoutVisible(), false, "Hidden account fields are not proof of a visible checkout page");
  await page.setContent('<input type="email"><input name="firstname">');
  assert.equal(await tools.protectedCheckoutVisible(), true);

  const html = await readFile(new URL("../src/agent-console.html", import.meta.url), "utf8");
  let intakeCalls = 0;
  await page.route("http://staypilot.test/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/") return route.fulfill({ contentType: "text/html", body: html });
    if (path === "/api/health") return route.fulfill({ json: { ready: true, agents: ["IntakeAgent"], intakeMode: "llm-assisted" } });
    if (path === "/api/intake") {
      intakeCalls += 1;
      await new Promise((resolve) => setTimeout(resolve, 500));
      return route.fulfill({ status: 422, json: { ready: false, message: "How many adults and rooms?" } });
    }
    return route.fulfill({ status: 404, json: {} });
  });
  await page.goto("http://staypilot.test/");
  await page.waitForFunction(() => document.querySelector("#runtime").classList.contains("online"));
  await page.locator("#query").fill("Find a hotel in Pune on 11 November 2026 under 5000");
  await page.locator("#start").evaluate((button) => { button.click(); button.click(); });
  await page.getByText("Before I search: How many adults and rooms?").waitFor();
  assert.equal(intakeCalls, 1, "Double clicking must not duplicate AI calls");
  assert.equal(await page.locator("#start").isEnabled(), true);
  await page.evaluate(() => {
    const event = { seq: 1, agent: "IntakeAgent", type: "agent.started", at: new Date().toISOString(), message: "Parsing request" };
    addEvent(event); addEvent(event);
  });
  assert.equal(await page.locator(".event").count(), 1, "Replayed events must not duplicate the timeline");

  console.log("Browser regressions passed: autocomplete recovery, exact hotel/location, delayed results, covered controls, multi-room availability/taxes, changed prices, fast missing-label extraction, double-click prevention, SSE deduplication.");
} finally {
  await browser.close();
}
