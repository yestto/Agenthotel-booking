import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { chromium } from 'playwright-core';
import { BrowserToolGateway } from '../scripts/agent-orchestrator.mjs';
import { assertObservedControl, observeBrowserControls, validateBrowserAction } from '../scripts/browser-agent.mjs';

// Audit probes: keep failed checks visible instead of weakening assertions to make a green report.
const results = [];
async function check(name, run) {
  try { await run(); results.push({ scenario: name, passed: true }); console.log('PASS: ' + name); }
  catch (error) { results.push({ scenario: name, passed: false, error: error.message }); console.error('FAIL: ' + name + ': ' + error.message); process.exitCode = 1; }
}
const goal = { supplier: 'booking.com', destination: 'Pune', checkIn: '2026-11-11', checkOut: '2026-11-12', adults: 1, rooms: 1, budgetInr: 9000 };
const decision = (action, extra = {}) => ({ action, target: '', field: 'none', key: 'none', summary: 'Audit the observed action', ...extra });
await check('Telephone input remains blocked even with a misleading Rooms label', () => {
  assert.throws(() => validateBrowserAction(decision('fill', { target: 'c0', field: 'rooms' }), {
    controls: [{ id: 'c0', tag: 'input', type: 'tel', name: 'Rooms', metadata: 'field', role: '', href: '', options: [], disabled: false }],
  }, goal), /blocked|personal/);
});

const executablePath = [process.env.CHROME_PATH, 'C:/Program Files/Google/Chrome/Application/chrome.exe', 'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe'].find((path) => path && existsSync(path));
const browser = await chromium.launch({ executablePath, headless: true });
try {
  const page = await browser.newPage();
  await page.route('**/*', (route) => route.fulfill({ contentType: 'text/html', body: '<body>Local audit fixture, not live inventory</body>' }));
  await page.goto('https://www.booking.com/searchresults.html?ss=Pune&checkin=2026-11-11&checkout=2026-11-12&group_adults=1&no_rooms=1');
  const tools = new BrowserToolGateway({ trace: { emit: () => {} }, signal: new AbortController().signal, browserDecider: null });
  tools.page = page;
  await check('Matching URL cannot override visibly conflicting dates and occupancy', async () => {
    await page.setContent('<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Dec 22 — Dec 23</div><div data-testid="occupancy-config">2 adults · 0 children · 2 rooms</div><article data-testid="property-card">A visible result</article>');
    assert.equal((await tools.readBookingSearchState(goal)).verified, false, 'Visible contradictory trip fields must invalidate search evidence');
  });
  await check('A changed associated label invalidates an old control observation', async () => {
    await page.setContent('<label for="destination">Destination</label><input id="destination" name="ss">');
    const observed = await observeBrowserControls(page, ['booking.com']);
    try {
      const control = observed.rawControls.find((item) => item.metadata.includes('ss'));
      await page.locator('label').evaluate((label) => { label.textContent = 'Card number'; });
      await assert.rejects(assertObservedControl(observed.targets.get(control.id), control), /control changed/);
    } finally { await observed.dispose(); }
  });
  await check('Hidden destination mirrors cannot replace the visible search field', async () => {
    for (const [hidden, visible, verified] of [['Mumbai', 'Pune', true], ['Pune', 'Mumbai', false]]) {
      await page.setContent(`<input type="hidden" name="ss" value="${hidden}"><input name="ss" value="${visible}"><div data-testid="searchbox-dates-container">Nov 11 — Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">A visible result</article>`);
      assert.equal((await tools.readBookingSearchState(goal)).verified, verified);
    }
  });
  await check('Visible fields cannot override contradictory trip parameters', async () => {
    await page.goto('https://www.booking.com/searchresults.html?ss=Pune&checkin=2027-11-11&checkout=2027-11-12&group_adults=2&no_rooms=1');
    await page.setContent('<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Nov 11 — Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">A visible result</article>');
    assert.equal((await tools.readBookingSearchState(goal)).verified, false);
  });
  await check('Verified manual date recovery can submit after the calendar skill fails', async () => {
    await page.goto('https://www.booking.com/');
    await page.setContent(`<input name="ss" value="Pune"><button data-testid="searchbox-dates-container">Select dates</button>
      <button data-date="2026-11-11">November 11</button><button data-date="2026-11-12">November 12</button>
      <button data-testid="occupancy-config">1 adult · 0 children · 1 room</button><button>Search</button>
      <script>for (const button of document.querySelectorAll('[data-date]')) button.onclick = () => document.querySelector('[data-testid="searchbox-dates-container"]').textContent = 'Wed, Nov 11 — Thu, Nov 12';</script>`);
    let step = 0;
    const recovered = new BrowserToolGateway({ trace: { emit: () => {} }, signal: new AbortController().signal, browserDecider: async ({ observation }) => {
      step++;
      if (step === 1) return decision('destination');
      if (step === 2) return decision('dates');
      if (step === 3 || step === 4) return decision(step === 3 ? 'click' : 'press', { key: step === 3 ? 'none' : 'Enter', target: observation.controls.find((item) => item.date === (step === 3 ? goal.checkIn : goal.checkOut)).id });
      if (step === 5) return decision('occupancy');
      if (step === 6) return decision('submit');
      return decision(observation.searchVerified ? 'finish' : 'stop');
    } });
    recovered.page = page;
    recovered.configureBookingDestination = async () => { recovered.bookingDestinationSelection = { value: 'Pune', text: 'Pune' }; };
    recovered.configureBookingDates = async () => { throw new Error('The adapter calendar control changed; recover using observed controls'); };
    recovered.submitBookingSearch = async () => { await page.setContent('<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Wed, Nov 11 — Thu, Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Verified fixture result</article>'); };
    await recovered.searchWithAI(goal);
    assert.equal((await recovered.readBookingSearchState(goal)).verified, true);
  });
  await check('Visible fields cannot override results for another destination URL', async () => {
    await page.goto('https://www.booking.com/searchresults.html?ss=Mumbai');
    await page.setContent('<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Nov 11 — Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Stale result</article>');
    assert.equal((await tools.readBookingSearchState(goal)).verified, false);
  });
  await check('Field entry cannot claim pre-existing results without actually submitting', async () => {
    await page.goto('https://www.booking.com/');
    await page.setContent('<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Nov 11 — Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Old result</article>');
    let submissions = 0;
    const verifiedEntry = new BrowserToolGateway({ trace: { emit: () => {} }, signal: new AbortController().signal,
      browserDecider: async ({ observation }) => decision(observation.availableSkills[0]) });
    verifiedEntry.page = page;
    verifiedEntry.configureBookingDestination = async () => { verifiedEntry.bookingDestinationSelection = { value: 'Pune', text: 'Pune' }; };
    verifiedEntry.configureBookingDates = async () => {};
    verifiedEntry.configureBookingOccupancy = async () => {};
    verifiedEntry.submitBookingSearch = async () => { submissions++; };
    await verifiedEntry.searchWithAI(goal);
    assert.equal(submissions, 1, 'Changing the form is not evidence that its old inventory was searched for this trip');
  });
  await check('Preloaded matching results cannot bypass visible field-entry proof', async () => {
    await page.goto('https://www.booking.com/');
    await page.setContent('<input name="ss" value="Pune"><div data-testid="searchbox-dates-container">Nov 11 — Nov 12</div><div data-testid="occupancy-config">1 adult · 0 children · 1 room</div><article data-testid="property-card">Preloaded result</article>');
    const premature = new BrowserToolGateway({ trace: { emit: () => {} }, signal: new AbortController().signal, browserDecider: async () => decision('finish') });
    premature.page = page;
    premature.bookingDestinationSelection = { value: 'Pune', text: 'Pune' };
    await assert.rejects(premature.searchWithAI(goal), /no progress/);
  });
} finally { await browser.close(); }
await mkdir('artifacts', { recursive: true });
await writeFile('artifacts/agentic-adversarial-report.json', JSON.stringify({ testedAt: new Date().toISOString(), scope: 'Isolated browser fixtures and policy probes; not live supplier inventory', results }, null, 2));
console.log(results.filter((item) => item.passed).length + '/' + results.length + ' deeper audit checks passed');
