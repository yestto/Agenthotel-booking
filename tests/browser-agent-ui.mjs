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
} finally { await browser.close(); }
