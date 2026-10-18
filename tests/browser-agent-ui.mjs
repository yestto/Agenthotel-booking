import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { chromium } from 'playwright-core';
import { BrowserToolGateway } from '../scripts/agent-orchestrator.mjs';
import { assertObservedControl, decideBrowserAction, observeBrowserControls, validateBrowserAction } from '../scripts/browser-agent.mjs';

const live = process.argv.includes('--live');
if (live) { try { process.loadEnvFile?.('.env'); } catch {} }
const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((path) => path && existsSync(path));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === '/results') return route.fulfill({ contentType: 'text/html', body: '<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Wed, Nov 11 — Thu, Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Fixture Hotel (not live inventory)</article>' });
    return route.fulfill({ contentType: 'text/html', body: `<label>Destination <input name="ss"></label><ul role="listbox"></ul>
      <button data-testid="searchbox-dates-container">Select dates</button><button data-testid="occupancy-config">1 adult · 0 children · 1 room</button>
      <button id="search">Search</button><div id="calendar" hidden>
      <button data-date="2026-11-11">November 11</button><button data-date="2026-11-12">November 12</button></div>
      <input type="email" value="private@example.invalid" hidden><button hidden>Pay now</button>
      <script>
        const input = document.querySelector('[name="ss"]');
        input.oninput = () => { document.querySelector('ul').innerHTML = '<li role="option" data-testid="autocomplete-result">Pune</li>'; document.querySelector('li').onclick = () => { input.value = 'Pune'; document.querySelector('ul').replaceChildren(); }; };
        document.querySelector('[data-testid="searchbox-dates-container"]').onclick = () => document.querySelector('#calendar').hidden = false;
        for (const button of document.querySelectorAll('[data-date]')) button.onclick = () => document.querySelector('[data-testid="searchbox-dates-container"]').textContent = 'Wed, Nov 11 — Thu, Nov 12';
        document.onkeydown = event => { if (event.key === 'Escape') document.querySelector('#calendar').hidden = true; };
        document.querySelector('#search').onclick = () => { if (input.value !== 'Pune') throw Error('Missing destination'); location.href = '/results'; };
      </script>` });
  });
  await page.goto('https://www.booking.com/');
  const goal = { supplier: 'booking.com', destination: 'Pune', checkIn: '2026-11-11', checkOut: '2026-11-12', adults: 1, rooms: 1, budgetInr: 9000 };
  const observed = await observeBrowserControls(page, ['booking.com']);
  assert.ok(!JSON.stringify(observed.controls).includes('private@example.invalid'));
  assert.ok(!observed.controls.some((control) => /Pay now/.test(control.name)));
  const destination = observed.controls.find((control) => control.metadata.includes('ss'));
  assert.equal(validateBrowserAction({ action: 'fill', target: destination.id, field: 'destination', key: 'none', summary: 'Enter requested location' }, observed, goal).value, 'Pune');
  const rawDestination = observed.rawControls.find((control) => control.id === destination.id);
  await assertObservedControl(observed.targets.get(destination.id), rawDestination);
  await page.locator('[name="ss"]').evaluate((input) => input.setAttribute('aria-label', 'Card number'));
  await assert.rejects(assertObservedControl(observed.targets.get(destination.id), rawDestination), /control changed/);
  await page.locator('[name="ss"]').evaluate((input) => input.removeAttribute('aria-label'));
  await observed.dispose();
  const events = [];
  let modelCalls = 0;
  const tools = new BrowserToolGateway({ trace: { emit: (agent, type, message, evidence) => { events.push({ type, evidence }); console.log(message); } }, signal: new AbortController().signal,
    browserDecider: async (input, options) => {
      modelCalls++;
      if (live) return decideBrowserAction(input, options);
      const next = input.observation.searchVerified ? 'finish' : ['destination', 'dates', 'occupancy', 'submit'].find((skill) => !input.observation.completedSkills.includes(skill));
      return { action: next, target: '', field: 'none', key: 'none', summary: 'Choose the next observed skill' };
    },
  });
  tools.page = page;
  await tools.searchWithAI(goal);
  assert.equal(new URL(page.url()).pathname, '/results');
  assert.ok(modelCalls >= 4, 'Each next action must be selected by the decider');
  for (const skill of ['destination', 'dates', 'submit']) assert.ok(events.some((event) => event.type === 'agent.action' && event.evidence.tool === skill));
  assert.equal((await tools.readBookingSearchState(goal)).verified, true);
  console.log((live ? 'Live AI decisions' : 'Controlled model decisions') + ': visible browser skills and independent result verification passed (local supplier fixture, not live inventory).');

  const temporaryPage = (mode) => `<h1>Oops!</h1><p>Something went wrong on our end. Error code: 502</p>
    <button onclick="location.href='/retry-agent/retry?mode=${mode}'">Try again</button>`;
  let retryClicks = 0;
  await page.route('https://www.booking.com/retry-agent/**', async (route) => {
    const url = new URL(route.request().url());
    const mode = url.searchParams.get('mode');
    if (url.pathname.endsWith('/error')) return route.fulfill({ contentType: 'text/html', body: temporaryPage(mode) });
    retryClicks++;
    if (mode === 'delayed') {
      await new Promise((resolve) => setTimeout(resolve, 2200));
      return route.fulfill({ contentType: 'text/html', body: '<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Wed, Nov 11 — Thu, Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Recovered fixture</article>' });
    }
    return route.fulfill({ contentType: 'text/html', body: temporaryPage(mode) });
  });
  await page.goto('https://www.booking.com/');
  tools.bookingRecoveryUsed = false;
  const configureDestination = tools.configureBookingDestination.bind(tools);
  tools.configureBookingDestination = async (trip) => {
    await configureDestination(trip);
    await page.goto('https://www.booking.com/retry-agent/error?mode=persistent');
  };
  let recoveryDecisions = 0;
  tools.browserDecider = async ({ observation }) => {
    recoveryDecisions++;
    if (recoveryDecisions === 1) return { action: 'destination', target: '', field: 'none', key: 'none', summary: 'Choose destination' };
    assert.deepEqual(observation.availableSkills, [], 'A supplier error page must not offer absent form skills');
    const retry = observation.controls.find((control) => control.name === 'Try again');
    assert.ok(retry, 'The agent must choose the visible supplier retry control');
    return { action: 'click', target: retry.id, field: 'none', key: 'none', summary: 'Retry the temporary supplier failure' };
  };
  await assert.rejects(tools.searchWithAI(goal), /temporarily unavailable \(502\) after one visible retry/);
  assert.equal(retryClicks, 1, 'Raw model-selected Try again must share the one-retry budget');
  assert.equal(recoveryDecisions, 2, 'An exhausted persistent 502 must stop before another model decision');
  tools.configureBookingDestination = configureDestination;

  retryClicks = 0;
  tools.bookingRecoveryUsed = false;
  tools.bookingDestinationSelection = { value: 'Pune', text: 'Pune' };
  await page.goto('https://www.booking.com/retry-agent/error?mode=delayed');
  const delayedStart = Date.now();
  assert.equal(await tools.recoverBookingTemporaryFailure(), true);
  assert.equal(retryClicks, 1, 'Slow navigation must not cause another retry click');
  assert.ok(Date.now() - delayedStart < 10_000, 'Delayed retry should finish within the existing bounded recovery allowance');
  assert.equal((await tools.readBookingSearchState(goal)).verified, true, 'A retry slower than the old document load must still verify its actual result');

  retryClicks = 0;
  await page.goto('https://www.booking.com/retry-agent/error?mode=persistent');
  const retryCancellation = new AbortController();
  const cancellationTools = new BrowserToolGateway({ trace: { emit() {} }, signal: retryCancellation.signal });
  cancellationTools.page = page;
  const cancellationStarted = Date.now();
  const cancelTimer = setTimeout(() => retryCancellation.abort(), 2500);
  try {
    await assert.rejects(cancellationTools.recoverBookingTemporaryFailure(), { name: 'AbortError' });
    assert.ok(Date.now() - cancellationStarted < 5000, 'Cancellation must interrupt recovery observation before its 15-second allowance expires');
    assert.equal(retryClicks, 1, 'Cancellation must not dispatch an additional retry');
  } finally { clearTimeout(cancelTimer); }

  tools.bookingRecoveryUsed = false;
  await page.setContent('<p>Room 502 has a Try again option, not a supplier error.</p><button onclick="this.dataset.clicked=\'yes\'">Try again</button>');
  let ordinaryDecisions = 0;
  tools.browserDecider = async ({ observation }) => ({ action: ordinaryDecisions++ ? 'stop' : 'click',
    target: ordinaryDecisions === 1 ? observation.controls.find((control) => control.name === 'Try again').id : '',
    field: 'none', key: 'none', summary: 'Inspect ordinary control' });
  await assert.rejects(tools.searchWithAI(goal), /could not establish a safe next action/);
  assert.equal(tools.bookingRecoveryUsed, false, 'Harmless room numbers or Try again labels must not consume supplier recovery');
  assert.equal(await page.getByRole('button', { name: 'Try again' }).getAttribute('data-clicked'), 'yes');
  console.log('Agent-selected 502 retry shares the bounded budget, delayed retry is observed, and harmless page text is not misclassified.');
} finally { await browser.close(); }
