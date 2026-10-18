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

  async function fixture({ suggestions, clearFirstSelection = false, geographicTerm = "", selectionSuffix = "" }) {
    await page.setContent(`<label>Destination <input name="ss"></label><ul role="listbox"></ul>`);
    await page.evaluate(({ suggestions, clearFirstSelection, geographicTerm, selectionSuffix }) => {
      const input = document.querySelector("input");
      const list = document.querySelector("ul");
      let timer;
      let committed = false;
      window.selectionAttempts = 0;
      window.completedQueries = [];
      input.addEventListener("keydown", (event) => {
        if (event.key === "Escape" && !committed) input.value = "";
      });
      input.addEventListener("input", () => {
        committed = false;
        clearTimeout(timer);
        list.replaceChildren();
        timer = setTimeout(() => {
          window.completedQueries.push(input.value);
          const available = geographicTerm && input.value !== geographicTerm ? ["Trending destination: Delhi\nDelhi, India"] : suggestions;
          for (const text of available) {
            const item = document.createElement("li");
            item.dataset.testid = "autocomplete-result";
            item.innerText = text;
            item.addEventListener("click", () => {
              window.selectionAttempts += 1;
              input.value = clearFirstSelection && window.selectionAttempts === 1 ? "" : text.split("\n")[0] + selectionSuffix;
              committed = Boolean(input.value);
              list.replaceChildren();
            });
            list.append(item);
          }
        }, 1_400);
      });
    }, { suggestions, clearFirstSelection, geographicTerm, selectionSuffix });
  }

  const namedGoal = { destination: "Pune, Maharashtra", hotelName: "Hyatt Place Pune Hinjawadi" };
  await fixture({ suggestions: ["Hyatt Pune\nPune, Maharashtra, India", "Hyatt Place Pune Hinjawadi\nPune, Maharashtra, India"], clearFirstSelection: true });
  await tools.configureBookingDestination(namedGoal);
  assert.equal(await page.locator("input").inputValue(), namedGoal.hotelName);
  assert.equal(await page.evaluate(() => window.selectionAttempts), 2, "A cleared selection must be recovered through another visible suggestion click");
  assert.match(tools.bookingDestinationSelection.text, /Maharashtra/);

  await fixture({ suggestions: ["Tulip Inn Bengaluru Hoodi\nBangalore (Bengaluru), Karnataka, India"], selectionSuffix: ", Bangalore (Bengaluru), Karnataka, India" });
  await tools.configureBookingDestination({ hotelName: "Tulip Inn Bengaluru Hoodi", destination: "Bengaluru, Karnataka" });
  assert.equal(await page.evaluate(() => window.selectionAttempts), 1, "The exact hotel must not be discarded merely because the retained UI value includes a canonical city alias");
  assert.equal(tools.bookingDestinationSelection.mode, undefined, "An exact named suggestion must not fall back to city search");

  await fixture({ suggestions: ["New Town\nEdinburgh, United Kingdom", "New Town\nKolkata, West Bengal, India"] });
  await tools.configureBookingDestination({ destination: "New Town, Kolkata, West Bengal" });
  assert.match(tools.bookingDestinationSelection.text, /Kolkata/);
  assert.equal(await page.evaluate(() => window.selectionAttempts), 1);

  const namedFallbackGoal = Object.freeze({ ...namedGoal, supplier: "booking.com", checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 1, rooms: 1, budgetInr: 9000 });
  await fixture({ suggestions: ["Pune\nMaharashtra, India"], geographicTerm: "Pune, Maharashtra" });
  await tools.configureBookingDestination(namedFallbackGoal);
  assert.equal(await page.locator("input").inputValue(), "Pune", "When hotel suggestions are unavailable, the requested city must be selected visibly");
  assert.equal(tools.bookingDestinationSelection.mode, "city");
  assert.equal(await page.evaluate(() => window.selectionAttempts), 1, "Trending or wrong-place suggestions must never be clicked");
  assert.equal(namedFallbackGoal.hotelName, namedGoal.hotelName, "Geographic fallback must leave the original named-hotel goal unchanged");
  assert.ok((await page.evaluate(() => window.completedQueries)).some((term) => term.includes(namedGoal.hotelName)), "Named-hotel suggestions must be tried before the geographic fallback");
  await page.setContent(`<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Wed, Nov 11 — Thu, Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div>
    <article data-testid="property-card"><h2 data-testid="title">Hyatt Place Pune Hinjawadi</h2><span data-testid="price-and-discounted-price">₹8,000</span><a data-testid="title-link" href="https://www.booking.com/hotel/in/hyatt-place-pune-hinjawadi.html">Open hotel</a></article>
    <article data-testid="property-card"><h2 data-testid="title">Hyatt Pune</h2><span data-testid="price-and-discounted-price">₹6,000</span><a data-testid="title-link" href="https://www.booking.com/hotel/in/hyatt-pune.html">Open hotel</a></article>`);
  const cityCandidates = await tools.observeCandidates(namedFallbackGoal, {});
  assert.equal(cityCandidates.length, 2);
  assert.equal(cityCandidates[0].destinationConfirmed, true, "Matching city search evidence can establish geography only for the exact requested hotel card");
  assert.equal(cityCandidates[1].destinationConfirmed, false, "Geographic fallback cannot substitute another property from the same city");
  await page.locator('input[name="ss"]').fill("Mumbai");
  assert.equal((await tools.observeCandidates(namedFallbackGoal, {}))[0].destinationConfirmed, false, "A stale city selection cannot prove the geography of a changed search");

  await fixture({ suggestions: ["Conrad Bengaluru, Karnataka\nBengaluru, Karnataka, India", "Bengaluru, Karnataka\nKarnataka, India"] });
  await tools.configureBookingDestination({ destination: "Bengaluru, Karnataka" });
  assert.equal(await page.locator("input").inputValue(), "Bengaluru, Karnataka", "A generic city request must accept a combined city/state label without selecting a hotel");
  assert.equal(await page.evaluate(() => window.selectionAttempts), 1);

  await fixture({ suggestions: ["Bengaluru\nKarnataka, India"], geographicTerm: "Bangalore" });
  await tools.configureBookingDestination({ destination: "Bengaluru, Karnataka" });
  assert.deepEqual(await page.evaluate(() => window.completedQueries), ["Bengaluru", "Bangalore"], "Primary city and known city alias must be tried before a combined city/state phrase");
  assert.equal(await page.locator("input").inputValue(), "Bengaluru");

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
  await page.route('https://www.booking.com/spa-search', route => route.fulfill({ contentType: 'text/html', body: `<input name="ss" value="Pune">
    <div data-testid="searchbox-dates-container">Wed, Nov 11 — Thu, Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div>
    <button onclick="document.querySelector('article').hidden=false">Search</button><article data-testid="property-card" hidden>SPA fixture result</article>` }));
  await page.goto('https://www.booking.com/spa-search');
  tools.bookingDestinationSelection = { value: 'Pune', text: 'Pune' };
  const spaStarted = Date.now();
  await tools.submitBookingSearch(fullGoal, 1);
  assert.ok(Date.now() - spaStarted < 5000, 'A visible SPA result must be verified without waiting for nonexistent document navigation');
  await page.unroute('https://www.booking.com/spa-search');

  let retryClicks = 0;
  let submittedSearches = 0;
  const searchFields = (destination = "Pune", dates = "Wed, Nov 11 — Thu, Nov 12", occupancy = "1 adult · 0 children · 1 room") => `<input name="ss" value="${destination}">
    <div data-testid="searchbox-dates-container">${dates}</div><div data-testid="occupancy-config">${occupancy}</div>`;
  const temporaryPage = (mode) => `<h1>Oops!</h1><p>Something went wrong on our end. Error code: 502</p><button onclick="location.href='/retry-fixture/retry?mode=${mode}'">Try again</button>`;
  await page.route("https://www.booking.com/retry-fixture/**", (route) => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get("mode");
    if (url.pathname.endsWith("/start")) return route.fulfill({ contentType: "text/html", body: `${searchFields()}<button onclick="location.href='/retry-fixture/error?mode=${mode}'">Search</button>` });
    if (url.pathname.endsWith("/error")) {
      submittedSearches++;
      return route.fulfill({ contentType: "text/html", body: temporaryPage(mode) });
    }
    retryClicks++;
    const body = mode === "persistent" ? temporaryPage(mode)
      : mode === "wrong-dates" ? `${searchFields("Pune", "Thu, Nov 12 — Fri, Nov 13")}<article data-testid="property-card">Wrong trip result</article>`
      : mode === "wrong-occupancy" ? `${searchFields("Pune", undefined, "2 adults · 0 children · 1 room")}<article data-testid="property-card">Wrong trip result</article>`
      : `${searchFields()}<article data-testid="property-card">Recovered fixture result</article>`;
    return route.fulfill({ contentType: "text/html", body });
  });
  for (const mode of ["matching", "persistent", "wrong-dates", "wrong-occupancy"]) {
    retryClicks = 0;
    submittedSearches = 0;
    tools.bookingRecoveryUsed = false;
    tools.bookingDestinationSelection = { value: "Pune", text: "Pune" };
    await page.goto(`https://www.booking.com/retry-fixture/start?mode=${mode}`);
    const originalGoto = page.goto;
    page.goto = async () => assert.fail("502 recovery must use the visible supplier retry control, not a direct URL");
    try {
      if (mode === "matching") {
        const recoveredStart = Date.now();
        await tools.submitBookingSearch(fullGoal, 1);
        assert.ok(Date.now() - recoveredStart < 10_000, "A 502 page must not consume the entire result verification timeout before recovery");
        assert.equal((await tools.readBookingSearchState(fullGoal)).verified, true);
        assert.ok(events.some((event) => event[1] === "supplier.recovered"), "Successful recovery must be independently verified and reported");
      } else if (mode === "persistent") {
        await assert.rejects(tools.submitBookingSearch(fullGoal, 1), /temporarily unavailable \(502\) after one visible retry/);
      } else {
        await assert.rejects(tools.submitBookingSearch(fullGoal, 1), /recovered from its temporary 502 page.*did not retain matching search fields/);
        assert.equal((await tools.readBookingSearchState(fullGoal)).verified, false, "Recovered inventory with wrong dates or occupancy must not be accepted");
      }
    } finally { page.goto = originalGoto; }
    assert.equal(retryClicks, 1, "Supplier recovery must click Try again only once");
    assert.equal(submittedSearches, 1, "Recovery must not silently submit a different trip");
  }
  tools.bookingRecoveryUsed = false;
  await page.goto("https://www.booking.com/retry-fixture/start?mode=matching");
  submittedSearches = 0;
  await page.locator('[data-testid="searchbox-dates-container"]').evaluate((element) => { element.textContent = "Select dates"; });
  await assert.rejects(tools.submitBookingSearch(fullGoal, 1), /changed or cleared a requested field before Search/);
  assert.equal(submittedSearches, 0, "A stale completed checkpoint cannot submit cleared visible fields");
  await page.unroute("https://www.booking.com/retry-fixture/**");

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

  let propertyRequests = 0;
  let propertyMode = "matching";
  await page.route("https://www.booking.com/trip-property-list", route => route.fulfill({ contentType: "text/html", body: `<article data-testid="property-card"><span data-testid="title">Observed Hotel</span><a data-testid="title-link" href="/hotel/in/trip-property.html">Observed Hotel</a></article>` }));
  await page.route("https://www.booking.com/hotel/in/trip-property.html", route => {
    propertyRequests++;
    if (propertyRequests === 1) return route.fulfill({ contentType: "text/html", body: `<h1>Oops!</h1><p>Error code: 502. Something went wrong on our end.</p><button onclick="location.reload()">Try again</button>` });
    return route.fulfill({ contentType: "text/html", body: `<title>Property details</title><h2>Observed Hotel</h2><p class="hp_address_subtitle">Road, 411001 Pune, Maharashtra, India</p>
      ${searchFields("Pune", propertyMode === "wrong-dates" ? "Thu, Nov 12 — Fri, Nov 13" : "Wed, Nov 11 — Thu, Nov 12", propertyMode === "wrong-guests" ? "2 adults · 0 children · 1 room" : "1 adult · 0 children · 1 room")}
      <select id="hprt_nos_select_trip"><option selected value="0">0</option><option value="1">1</option></select>` });
  });
  for (const mode of ["matching", "wrong-dates", "wrong-guests"]) {
    propertyMode = mode;
    propertyRequests = 0;
    tools.bookingRecoveryUsed = false;
    await page.goto("https://www.booking.com/trip-property-list");
    const opened = tools.openCandidate({ index: 0, title: "Observed Hotel", href: "https://www.booking.com/hotel/in/trip-property.html" }, fullGoal);
    if (mode === "matching") assert.equal((await opened).locationEvidence.status, "confirmed");
    else await assert.rejects(opened, /did not retain the requested dates and guests/);
    assert.equal(propertyRequests, 2, "Property recovery must use exactly one visible retry, not repeated navigation");
    assert.equal(await page.locator("#hprt_nos_select_trip").inputValue(), "0", "A property retry must not select a room before fresh trip verification");
  }

  await page.route("https://www.booking.com/hotel/in/conflicting-address.html", (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<title>Best Resort in Bangalore - Booking.com</title><h1>Best Resort in Bangalore</h1>
    <p class="hp_address_subtitle">Best Resort in Bangalore, Bidadi, 562159 Rāmanagaram, India</p>
    <select id="hprt_nos_select_test"><option value="0" selected>0</option><option value="1">1</option></select>` }));
  await page.route("https://www.booking.com/address-list", (route) => route.fulfill({ contentType: "text/html", body: `<article data-testid="property-card"><span data-testid="title">Best Resort in Bangalore</span><a data-testid="title-link" href="/hotel/in/conflicting-address.html">Best Resort in Bangalore</a></article>` }));
  await page.goto("https://www.booking.com/address-list");
  await assert.rejects(tools.openCandidate({ index: 0, title: "Best Resort in Bangalore", href: "https://www.booking.com/hotel/in/conflicting-address.html" }, { destination: "Bengaluru, Karnataka" }), /visible address is in Rāmanagaram, not the requested Bengaluru/);
  assert.equal(await page.locator("#hprt_nos_select_test").inputValue(), "0", "A matching marketing title with a conflicting physical city must be rejected before selecting rooms");
  assert.ok(events.some((event) => event[1] === "property.location" && event[3].status === "conflict" && event[3].hotel === "Best Resort in Bangalore"), "Physical location evidence must identify the checked hotel");

  for (const fixture of [
    { id: "unconfirmed-address", title: "Observed Hotel", address: "Location available after booking", destination: "Bengaluru, Karnataka", error: /does not confirm the requested physical location/ },
    { id: "conflicting-state", title: "Observed Hotel", address: "Road, 799120 Udaipur, Tripura, India", destination: "Udaipur, Rajasthan", error: /Udaipur, Tripura, not the requested Udaipur, Rajasthan/ },
    { id: "unconfirmed-locality", title: "Observed Hotel", address: "New Town Resort, Park Street, Kolkata, West Bengal, India", destination: "New Town, Kolkata", error: /does not confirm the requested locality/ },
    { id: "known-place-alias", title: "Observed Hotel", address: "Bidadi, Rāmanagaram 562159, Karnataka, India", destination: "Ramanagara, Karnataka", expectedCity: "Rāmanagaram" },
    { id: "lookalike-property", title: "Taj Krishna", heading: "Taj Krishnan", address: "Road, Hyderabad, Telangana, India", destination: "Hyderabad, Telangana", error: /opened property did not match/ },
    { id: "semantic-address-wrapper", title: "Observed Hotel", address: "New No 297, KEB Colony, 560048 Bangalore, India", destination: "Bengaluru, Karnataka", semanticMarkup: true, expectedCity: "Bangalore" },
    { id: "contents-address-wrapper", title: "Observed Hotel", address: "New No 297, KEB Colony, 560048 Bangalore, India", destination: "Bengaluru, Karnataka", contentsMarkup: true, expectedCity: "Bangalore" },
    { id: "h2-only-property-heading", title: "Observed Hotel", address: "New No 297, KEB Colony, 560048 Bangalore, India", destination: "Bengaluru, Karnataka", h2Only: true, expectedCity: "Bangalore" },
    { id: "semantic-wrapper-state-conflict", title: "Observed Hotel", address: "Road, 799120 Udaipur, Tripura, India", destination: "Udaipur, Rajasthan", semanticMarkup: true, error: /Udaipur, Tripura, not the requested Udaipur, Rajasthan/ },
    { id: "changed-address-markup", title: "Observed Hotel", address: "New No 297, KEB Colony, 560048 Bangalore, India", destination: "Bengaluru, Karnataka", changedMarkup: true, expectedCity: "Bangalore" },
    { id: "button-address-markup", title: "Observed Hotel", address: "New No 297, KEB Colony, 560048 Bangalore, India", destination: "Bengaluru, Karnataka", changedMarkup: true, buttonMarkup: true, expectedCity: "Bangalore" },
    { id: "changed-markup-wrong-city", title: "Observed Hotel", address: "Road, 799120 Udaipur, Tripura, India", destination: "Bengaluru, Karnataka", changedMarkup: true, error: /Udaipur, Tripura, not the requested Bengaluru/ },
    { id: "invented-address-quote", title: "Observed Hotel", address: "Road, 799120 Udaipur, Tripura, India", destination: "Bengaluru, Karnataka", changedMarkup: true, quotedAddress: "New No 297, KEB Colony, 560048 Bangalore, India", error: /ungrounded property address quotation/ },
    { id: "hidden-address-mirror", title: "Observed Hotel", address: "No street address is shown here", destination: "Bengaluru, Karnataka", changedMarkup: true, hiddenAddress: "New No 297, KEB Colony, 560048 Bangalore, India", quotedAddress: "", error: /does not confirm the requested physical location/ },
  ]) {
    const href = `https://www.booking.com/hotel/in/${fixture.id}.html`;
    await page.route(href, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<title>${fixture.h2Only ? 'Property details' : fixture.title + ', ' + fixture.destination + ' (updated 2026 prices)'}</title><${fixture.h2Only ? 'h2' : 'h1'}>${fixture.heading || fixture.title}</${fixture.h2Only ? 'h2' : 'h1'}>
      ${fixture.semanticMarkup ? `<div data-testid="PropertyAddressDesktop-wrapper"><span>${fixture.address}</span><a href="#">Show on map</a></div>` : fixture.buttonMarkup ? `<button>${fixture.address}</button>` : `<p class="${fixture.changedMarkup ? "new-property-location" : "hp_address_subtitle"}" ${fixture.contentsMarkup ? 'style="display:contents"' : ''}>${fixture.address}</p>`}
      ${fixture.hiddenAddress ? `<p class="hp_address_subtitle" style="opacity:0">${fixture.hiddenAddress}</p><div class="hp_address_subtitle"><span style="opacity:0">${fixture.hiddenAddress}</span></div><div><span style="opacity:0">${fixture.hiddenAddress}</span></div><div class="guest-review">${fixture.hiddenAddress}</div><footer>${fixture.hiddenAddress}</footer>` : ""}
      <select id="hprt_nos_select_guard"><option value="0" selected>0</option><option value="1">1</option></select>` }));
    const listHref = `https://www.booking.com/${fixture.id}-list`;
    await page.route(listHref, (route) => route.fulfill({ contentType: "text/html; charset=utf-8", body: `<article data-testid="property-card"><span data-testid="title">${fixture.title}</span><a data-testid="title-link" href="${href}">${fixture.title}</a></article>` }));
    await page.goto(listHref);
    const originalAddressReader = tools.propertyAddressReader;
    let addressReads = 0;
    tools.propertyAddressReader = async ({ visibleHeader }, options) => {
      addressReads += 1;
      assert.ok(fixture.changedMarkup, "Existing visible address markup must not incur an extra model request");
      assert.ok(visibleHeader.length <= 5_000, "Address input must remain below the free-plan text budget");
      assert.equal(options.signal, tools.signal);
      assert.equal(typeof options.onQuotaWait, "function");
      if (fixture.hiddenAddress) assert.ok(!visibleHeader.includes(fixture.hiddenAddress), "Hidden mirrors, reviews and footer addresses cannot become physical-location evidence");
      return fixture.quotedAddress ?? fixture.address;
    };
    try {
      const opened = tools.openCandidate({ index: 0, title: fixture.title, href }, { destination: fixture.destination });
      if (fixture.error) await assert.rejects(opened, fixture.error);
      else assert.deepEqual((await opened).locationEvidence, { status: "confirmed", city: fixture.expectedCity, address: fixture.address, hotel: fixture.title });
      assert.equal(addressReads, fixture.changedMarkup ? 1 : 0, "Each changed property header gets at most one grounded address read");
    } finally { tools.propertyAddressReader = originalAddressReader; }
    assert.equal(await page.locator("#hprt_nos_select_guard").inputValue(), "0", "Opening a property must not select a room before identity and physical location verification");
  }

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

  console.log("Browser regressions passed: autocomplete recovery, exact hotel/location, named-hotel city fallback, primary-city aliases, physical-address conflict rejection, delayed results, visible 502 retry verification, persistent/mismatched retry rejection, fresh pre-submit fields, covered controls, multi-room availability/taxes, changed prices, fast missing-label extraction, double-click prevention, SSE deduplication.");
} finally {
  await browser.close();
}
