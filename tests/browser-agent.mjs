import assert from "node:assert/strict";
import { BrowserDecision, compactBrowserModelInput, decideBrowserAction, runBrowserActionLoop, validateBrowserAction } from "../scripts/browser-agent.mjs";
import { assertAllowedUrl } from "../scripts/computer-agent.mjs";

const goal = { supplier: 'booking.com', destination: 'Pune', checkIn: '2026-12-22', checkOut: '2026-12-23', adults: 1, rooms: 1 };
const action = (name, extra = {}) => ({ action: name, target: '', field: 'none', key: 'none', summary: 'Take the next observed step', ...extra });
assert.throws(() => validateBrowserAction(action('submit'), { availableSkills: ['destination', 'dates', 'occupancy'] }, goal), /unavailable in the current state/);
assert.equal(validateBrowserAction(action('dates'), { availableSkills: ['dates'] }, goal), null);
const control = (extra = {}) => ({ id: 'c0', name: 'Destination', metadata: 'ss', tag: 'input', type: 'text', role: '', href: '', options: [], ...extra });
const observation = (extra = {}) => ({ url: 'https://www.booking.com/', controls: [control()], searchVerified: false, ...extra });
assert.throws(() => assertAllowedUrl('http://booking.com/'), /non-HTTPS/);
assert.throws(() => assertAllowedUrl('https://secret@booking.com/'), /credential-bearing/);
assert.equal(validateBrowserAction(action('fill', { target: 'c0', field: 'destination' }), observation(), goal).value, 'Pune');
assert.throws(() => BrowserDecision.parse({ ...action('fill'), value: 'secret' }));
assert.throws(() => validateBrowserAction(action('click', { target: 'invented' }), observation(), goal), /unknown/);
for (const name of ['Pay now', 'Confirm', 'Book now', 'Login', 'Continue', 'Download application']) {
  assert.throws(() => validateBrowserAction(action('click', { target: 'c0' }), observation({ controls: [control({ name, metadata: '', tag: 'button' })] }), goal), /blocked/, name);
}
assert.throws(() => validateBrowserAction(action('fill', { target: 'c0', field: 'adults' }), observation(), goal), /unrelated/);
assert.throws(() => validateBrowserAction(action('fill', { target: 'c0', field: 'destination' }), observation({ controls: [control({ name: 'Email', type: 'email' })] }), goal), /personal/);
assert.throws(() => validateBrowserAction(action('click', { target: 'c0' }), observation({ controls: [control({ date: '2026-12-24' })] }), goal), /date outside/);
assert.throws(() => validateBrowserAction(action('select', { target: 'c0', field: 'rooms' }), observation({ controls: [control({ name: 'Rooms', metadata: 'no_rooms', tag: 'select' })] }), goal), /not an available/);
assert.throws(() => validateBrowserAction(action('press', { target: 'c0', key: 'Enter' }), observation(), goal), /implicit form/);
assert.throws(() => validateBrowserAction(action('click', { target: 'c0' }), observation({ controls: [control({ href: 'https://evil.example/' })] }), goal), /navigation/);
const rawSearch = control({ id: 'c1', tag: 'button', name: 'Search', formSubmission: true });
const readySearchState = { destination: 'Pune', dateSummary: '22 December 2026 — 23 December 2026', occupancy: '1 adult · 1 room', searchOutcomeVisible: false };
assert.throws(() => validateBrowserAction(action('click', { target: 'c1' }), observation({ controls: [rawSearch], rawControls: [rawSearch], availableSkills: ['restart'] }), goal), /submission is unavailable/,
  'A raw Search click cannot bypass blocked Submit even when full raw evidence contains the control');

let executions = [];
let observations = 0;
let disposed = 0;
const events = [];
const result = await runBrowserActionLoop({ goal, maxSteps: 5, signal: new AbortController().signal,
  observe: async () => observation({ attempt: ++observations, searchVerified: executions.includes('submit'), dispose: () => disposed++ }),
  decide: async ({ previousResults, observation: current }) => {
    if (current.searchVerified) return action('finish');
    if (!previousResults.length) return action('destination');
    assert.match(previousResults.at(-1).result, /supplier changed/);
    return action('submit');
  },
  execute: async ({ action: tool }) => { executions.push(tool); if (tool === 'destination') throw new Error('supplier changed'); },
  trace: { emit: (agent, type) => events.push(type) },
});
assert.equal(result, 'https://www.booking.com/');
assert.deepEqual(executions, ['destination', 'submit']);
assert.equal(disposed, 3);
assert.ok(events.includes('agent.replanned'));
assert.ok(events.includes('agent.decision'));
let unchangedStep = 0;
const unchangedActions = [];
const unchangedSnapshots = [];
await runBrowserActionLoop({ goal, maxSteps: 3,
  observe: async () => {
    const current = observation({ url: unchangedStep ? 'https://www.booking.com/city/in/pune.html' : 'https://www.booking.com/',
      controls: [control({ context: 'Changing promotion ' + unchangedStep }), rawSearch], rawControls: [control(), rawSearch],
      pageText: 'Dynamic countdown ' + unchangedStep, searchState: { ...readySearchState }, completedSkills: ['destination', 'dates', 'occupancy'],
      availableSkills: ['submit', 'restart'], searchVerified: unchangedStep === 2 });
    unchangedSnapshots.push(current);
    return current;
  },
  decide: (input, options) => decideBrowserAction(input, { ...options, provider: 'gemini', apiKey: 'test-key', fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    const schema = body.generationConfig.responseSchema.properties;
    const submitted = JSON.parse(body.contents[0].parts[0].text);
    if (unchangedStep === 0) {
      assert.ok(schema.action.enum.includes('submit'), 'The initial verified form can Submit');
      assert.ok(schema.target.enum.includes('c1'));
    } else {
      assert.ok(!schema.action.enum.includes('submit'), 'A failed Submit is removed despite changed URL, animated text and control context');
      assert.ok(schema.action.enum.includes('restart'), 'The model can choose bounded supplier recovery');
      assert.ok(!schema.target.enum.includes('c1'), 'Raw Search cannot bypass the failed typed skill in the model schema');
      assert.ok(!submitted.observation.controls.some(({ id }) => id === 'c1'));
      assert.deepEqual(submitted.observation.searchState, readySearchState, 'Verified field evidence is retained');
    }
    return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action(unchangedStep ? 'restart' : 'submit')) }] } }] }));
  } }),
  execute: async ({ action: tool }) => {
    unchangedActions.push(tool); unchangedStep++;
    if (tool === 'submit') throw new Error('Supplier retained fields without verified trip results.');
  },
});
assert.deepEqual(unchangedActions, ['submit', 'restart'], 'An unchanged failed form cannot spend another decision on the same Submit');
assert.ok(unchangedSnapshots[1].availableSkills.includes('submit'), 'Eligibility does not mutate the supplier observation');
assert.ok(unchangedSnapshots[1].rawControls.includes(rawSearch), 'Policy retains complete raw control evidence');
for (const secondAction of [action('submit'), action('click', { target: 'c1' }), action('press', { target: 'c1', key: 'Enter' })]) {
  let repeatedSubmit = 0;
  await assert.rejects(runBrowserActionLoop({ goal, maxSteps: 2,
    observe: async () => observation({ controls: [rawSearch], rawControls: [rawSearch], pageText: 'Changing content ' + repeatedSubmit,
      searchState: readySearchState, completedSkills: ['destination', 'dates', 'occupancy'], availableSkills: ['submit', 'restart'] }),
    decide: async ({ observation: current }) => {
      if (repeatedSubmit) assert.ok(!current.availableSkills.includes('submit'));
      return repeatedSubmit ? secondAction : action('submit');
    }, execute: async () => { repeatedSubmit++; throw new Error('No verified trip results.'); },
  }), /unavailable.*bounded time\/action limit/);
  assert.equal(repeatedSubmit, 1, 'An injected decision cannot execute a blocked typed or raw Submit');
}
let changedStage = 0;
const changedActions = [];
await runBrowserActionLoop({ goal, maxSteps: 4,
  observe: async () => observation({ searchState: { ...readySearchState, dateSummary: changedStage === 1 ? 'Supplier reset dates' : readySearchState.dateSummary },
    completedSkills: changedStage === 1 ? ['destination', 'occupancy'] : ['destination', 'dates', 'occupancy'],
    availableSkills: changedStage === 1 ? ['dates', 'restart'] : ['submit', 'restart'], searchVerified: changedStage === 3 }),
  decide: async ({ observation: current }) => {
    if (changedStage === 1) assert.ok(!current.availableSkills.includes('submit'));
    if (changedStage === 2) assert.ok(current.availableSkills.includes('submit'), 'A real repaired field restores Submit eligibility');
    return action(changedStage === 1 ? 'dates' : 'submit');
  }, execute: async ({ action: tool }) => {
    changedActions.push(tool); changedStage++;
    if (changedStage === 1) throw new Error('Supplier reset dates after submission.');
  },
});
assert.deepEqual(changedActions, ['submit', 'dates', 'submit']);
let failedRawStage = 0;
await runBrowserActionLoop({ goal, maxSteps: 3,
  observe: async () => observation({ controls: [rawSearch], searchState: readySearchState, availableSkills: ['submit', 'restart'], searchVerified: failedRawStage === 2 }),
  decide: async ({ observation: current }) => {
    if (failedRawStage) assert.ok(!current.availableSkills.includes('submit'), 'A failed raw Search shares the typed Submit eligibility');
    return failedRawStage ? action('restart') : action('click', { target: 'c1' });
  }, execute: async ({ action: tool }) => { failedRawStage++; if (tool === 'click') throw new Error('Raw Search did not establish trip results.'); },
});
let calls = 0;
await assert.rejects(runBrowserActionLoop({ goal, maxSteps: 2, observe: async () => observation(), decide: async () => action('finish'), execute: async () => calls++ }), /limit reached/);
assert.equal(calls, 0, 'Model finish cannot bypass independent evidence');
let lateActions = 0;
let lateDisposals = 0;
await assert.rejects(runBrowserActionLoop({ goal, elapsedMs: 20,
  observe: async () => observation({ dispose: () => lateDisposals++ }),
  decide: async (input, options) => {
    assert.ok(options.timeoutMs > 0 && options.timeoutMs <= 20, 'Model request deadline must fit the remaining loop budget');
    await new Promise((resolve) => setTimeout(resolve, 30));
    return action('wait');
  }, execute: async () => lateActions++,
}), /limit reached/);
assert.equal(lateActions, 0, 'A slow model or quota wait cannot execute actions after the loop deadline');
assert.equal(lateDisposals, 1, 'Deadline expiry must still dispose the observation');
await assert.rejects(runBrowserActionLoop({ goal, elapsedMs: 20,
  observe: async () => { await new Promise((resolve) => setTimeout(resolve, 30)); return observation({ searchVerified: true, dispose: () => lateDisposals++ }); },
  decide: async () => assert.fail('Expired observation must not reach the model'), execute: async () => assert.fail('Expired observation must not act'),
}), /limit reached/);
assert.equal(lateDisposals, 2, 'A verified but late observation is disposed and cannot return success');
const realNow = Date.now;
let simulatedNow = realNow();
try {
  Date.now = () => simulatedNow;
  await assert.rejects(runBrowserActionLoop({ goal, elapsedMs: 1000,
    observe: async () => { simulatedNow += 900; return observation(); },
    decide: async () => assert.fail('Do not start a model request with an unusably small remaining active allowance'),
    execute: async () => assert.fail('No action is permitted after budget exhaustion'),
  }), /limit reached/);
} finally { Date.now = realNow; }
let pacedExecutions = 0;
const pacedEvents = [];
await runBrowserActionLoop({ goal, elapsedMs: 40, quotaWaitBudgetMs: 90,
  observe: async () => observation({ searchVerified: pacedExecutions > 0 }),
  decide: async (_input, options) => {
    assert.ok(options.quotaWaitBudgetMs > 0, 'Local pacing receives a separate bounded allowance');
    options.onQuotaWait({ phase: 'waiting', waitMs: 55 });
    await new Promise((resolve) => setTimeout(resolve, 55));
    options.onQuotaWait({ phase: 'resumed', waitedMs: 55 });
    return action('submit');
  }, execute: async () => pacedExecutions++,
  trace: { emit: (_agent, type) => pacedEvents.push(type) },
});
assert.equal(pacedExecutions, 1, 'Local quota waiting does not consume active browser work time');
assert.deepEqual(pacedEvents.filter((type) => type.startsWith('model.')), ['model.quota_wait', 'model.quota_resumed']);
await assert.rejects(runBrowserActionLoop({ goal, elapsedMs: 15, quotaWaitBudgetMs: 15,
  observe: async () => observation(),
  decide: async (_input, options) => {
    options.onQuotaWait({ phase: 'waiting', waitMs: 40 });
    await new Promise((resolve) => setTimeout(resolve, 40));
    options.onQuotaWait({ phase: 'resumed', waitedMs: 40 });
    return action('submit');
  }, execute: async () => assert.fail('Quota accounting cannot permit an action past the wall-clock bound'),
}), /limit reached/);
await assert.rejects(runBrowserActionLoop({ goal, maxSteps: 1,
  observe: async () => observation(), decide: async () => action('submit'),
  execute: async () => { throw new Error('Supplier UI unavailable: Booking.com returned a temporary 502.'); },
}), /Supplier UI unavailable: Booking.com returned a temporary 502.*bounded time\/action limit/,
'Exhausted recovery must preserve the actual supplier cause, not replace it with an unexplained action limit');
let recoveryStep = 0;
await assert.rejects(runBrowserActionLoop({ goal, maxSteps: 2,
  observe: async () => observation({ attempt: recoveryStep }), decide: async () => action(recoveryStep++ ? 'wait' : 'submit'),
  execute: async ({ action: tool }) => { if (tool === 'submit') throw new Error('Supplier UI unavailable: temporary 502.'); },
}), /Supplier UI unavailable: temporary 502.*bounded time\/action limit/,
'A successful wait is not proof the supplier failure recovered');
let stoppingStep = 0;
await assert.rejects(runBrowserActionLoop({ goal,
  observe: async () => observation({ attempt: stoppingStep }), decide: async () => action(stoppingStep++ ? 'stop' : 'submit'),
  execute: async () => { throw new Error('Supplier UI unavailable: temporary 502.'); },
}), /Supplier UI unavailable: temporary 502/, 'A model stop must preserve the observed supplier failure');
const pacedCancellation = new AbortController();
await assert.rejects(runBrowserActionLoop({ goal, elapsedMs: 40, quotaWaitBudgetMs: 90, signal: pacedCancellation.signal,
  observe: async () => observation(), decide: async (_input, options) => {
    options.onQuotaWait({ phase: 'waiting', waitMs: 10 });
    pacedCancellation.abort();
    options.onQuotaWait({ phase: 'resumed', waitedMs: 0 });
    return action('submit');
  }, execute: async () => assert.fail('Cancellation must prevent the queued action'),
}), { name: 'AbortError' });
await assert.rejects(runBrowserActionLoop({ goal, observe: async () => observation(), decide: async () => action('wait'), execute: async () => {} }), /no progress/);
for (const flag of ['humanVerification', 'protectedBoundary']) {
  await assert.rejects(runBrowserActionLoop({ goal, observe: async () => observation({ [flag]: true }), decide: async () => assert.fail('Must stop before the model'), execute: async () => assert.fail('Must not act') }), /verification|boundary/);
}
const controller = new AbortController(); controller.abort();
await assert.rejects(runBrowserActionLoop({ goal, signal: controller.signal, observe: async () => assert.fail('Cancelled'), execute: async () => {} }), { name: 'AbortError' });
await assert.rejects(decideBrowserAction({}, { provider: 'gemini', apiKey: '' }), /require a configured API key/);
const modelResult = await decideBrowserAction({ goal, observation: observation() }, { provider: 'gemini', apiKey: 'test-key', fetchImpl: async (url, init) => {
  assert.equal(init.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(init.body);
  assert.match(body.systemInstruction.parts[0].text, /UNTRUSTED DATA/);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('destination')) }] } }] }));
} });
assert.equal(modelResult.action, 'destination');
const pendingOccupancy = { goal, observation: observation({ controls: [control(), control({ id: 'c1', tag: 'button', name: 'Search', formSubmission: true })],
  completedSkills: ['destination', 'dates'], availableSkills: ['occupancy'] }) };
assert.equal((await decideBrowserAction(pendingOccupancy, { provider: 'gemini', apiKey: 'test-key', fetchImpl: async (_url, init) => {
  const body = JSON.parse(init.body);
  const allowed = body.generationConfig.responseSchema.properties.action.enum;
  assert.ok(allowed.includes('occupancy'));
  for (const unavailable of ['submit', 'destination', 'dates', 'restart', 'finish']) assert.ok(!allowed.includes(unavailable), 'Schema cannot offer ' + unavailable + ' while occupancy is pending');
  assert.ok(!body.generationConfig.responseSchema.properties.target.enum.includes('c1'), 'A raw Search click cannot bypass skill eligibility');
  assert.ok(!JSON.parse(body.contents[0].parts[0].text).observation.controls.some(({ id }) => id === 'c1'));
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('occupancy')) }] } }] }));
} })).action, 'occupancy');
await assert.rejects(decideBrowserAction(pendingOccupancy, { provider: 'gemini', apiKey: 'test-key', fetchImpl: async () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('submit')) }] } }] })) }), /invalid or unavailable action/,
'A provider ignoring the constrained schema cannot return a premature submit');
await assert.rejects(decideBrowserAction(pendingOccupancy, { provider: 'gemini', apiKey: 'test-key', fetchImpl: async () =>
  new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('click', { target: 'c1' })) }] } }] })) }), /invalid or unavailable action/,
'A provider ignoring the target schema cannot click the excluded Search control');
assert.ok(pendingOccupancy.observation.controls.some(({ id }) => id === 'c1'), 'Execution keeps the full original observed controls');
await assert.rejects(decideBrowserAction({}, { provider: 'gemini', apiKey: 'test', fetchImpl: async () => new Response('{}') }), /invalid/);
await assert.rejects(decideBrowserAction({}, { provider: 'gemini', apiKey: 'test', fetchImpl: async () => new Response('{}', { status: 429 }) }), /Provider HTTP 429/);
let retryCalls = 0;
assert.equal((await decideBrowserAction({}, { provider: 'gemini', apiKey: 'test', fetchImpl: async () => ++retryCalls === 1
  ? new Response('{}', { status: 503 })
  : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('destination')) }] } }] })) })).action, 'destination');
assert.equal(retryCalls, 2, 'A transient provider failure gets one model retry, not a scripted action');
retryCalls = 0;
await assert.rejects(decideBrowserAction({}, { provider: 'gemini', apiKey: 'test', fetchImpl: async () => { retryCalls++; return new Response('{}', { status: 503 }); } }), /Provider HTTP 503/);
assert.equal(retryCalls, 2, 'Provider retries must remain bounded');
const retryCancellation = new AbortController();
retryCalls = 0;
await assert.rejects(decideBrowserAction({}, { provider: 'gemini', apiKey: 'test', signal: retryCancellation.signal, fetchImpl: async () => {
  retryCalls++; queueMicrotask(() => retryCancellation.abort()); return new Response('{}', { status: 503 });
} }), { name: 'AbortError' });
assert.equal(retryCalls, 1, 'Cancellation must interrupt the retry delay before another model call');
await assert.rejects(decideBrowserAction({}, { provider: 'gemini', apiKey: 'test', timeoutMs: 5, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /unavailable/);

const noisyControls = Array.from({ length: 160 }, (_, index) => control({ id: 'c' + index, name: 'Unrelated hotel ' + index, context: 'Unrelated inventory '.repeat(16), tag: 'button', metadata: 'inventory', href: 'https://www.booking.com/hotel/in/unrelated.html' }));
const actionable = [
  control({ id: 'c160', name: 'Destination', metadata: 'ss' }),
  control({ id: 'c161', name: 'Pune Maharashtra India', role: 'option', tag: 'li', metadata: 'autocomplete-result' }),
  control({ id: 'c162', name: '22 December 2026', date: goal.checkIn, tag: 'button', metadata: 'calendar-cell' }),
  control({ id: 'c163', name: '23 December 2026', date: goal.checkOut, tag: 'button', metadata: 'calendar-cell' }),
  control({ id: 'c164', name: 'Next month', tag: 'button', metadata: 'calendar-next' }),
  control({ id: 'c165', name: 'Adults', context: 'Adults 1', tag: 'select', metadata: 'group_adults', options: [{ value: '1', text: '1 adult', disabled: false }] }),
  control({ id: 'c166', name: 'Rooms', context: 'Rooms 1', tag: 'select', metadata: 'no_rooms', options: [{ value: '1', text: '1 room', disabled: false }] }),
  control({ id: 'c167', name: 'Search', tag: 'button', type: 'submit', metadata: '', formSubmission: true }),
];
const largeInput = { goal: { ...goal, hotelName: 'Hyatt Place Pune Hinjawadi', budgetMinInr: 2000, budgetInr: 10000 },
  observation: observation({ controls: [...noisyControls, ...actionable], pageText: 'Large untrusted page text '.repeat(1000),
    searchState: { destination: 'Pune', datesMatch: false, occupancyMatch: false }, completedSkills: ['destination'], availableSkills: ['dates', 'occupancy'],
    humanVerification: false, protectedBoundary: false }), previousResults: [{ action: 'destination', result: 'committed geographical suggestion' }], remainingSteps: 20 };
const originalInput = JSON.stringify(largeInput);
const compacted = compactBrowserModelInput(largeInput);
assert.ok(JSON.stringify(compacted).length <= 5000, 'The Groq model input must have a conservative character budget');
assert.equal(JSON.stringify(largeInput), originalInput, 'Compaction must not change the evidence used by validation or execution');
assert.deepEqual(compacted.goal, largeInput.goal);
assert.ok(!compacted.observation.controls.some((item) => item.href), 'Forbidden search-stage navigation links must not consume the model allowance or appear as permitted targets');
assert.ok(!compactBrowserModelInput({ ...largeInput, observation: { ...largeInput.observation, controls: [...actionable, control({ id: 'c168', date: '2026-12-24' })] } }).observation.controls.some(({ id }) => id === 'c168'), 'A date outside the requested stay is never an actionable recovery target');
const auditedInput = { ...largeInput, goal: { ...largeInput.goal, originalRequest: 'Original noisy request '.repeat(600), interpretedRequest: 'Repeated trip explanation '.repeat(600), corrections: Array(80).fill('Typo correction'), intakeSource: 'groq' } };
const auditedSnapshot = JSON.stringify(auditedInput);
assert.deepEqual(compactBrowserModelInput(auditedInput), compacted, 'Repeated intake audit prose cannot crowd out the operational goal and current supplier controls');
assert.equal(JSON.stringify(auditedInput), auditedSnapshot, 'Original intake evidence remains intact for execution and audit');
for (const field of ['url', 'searchState', 'searchVerified', 'completedSkills', 'availableSkills', 'humanVerification', 'protectedBoundary']) {
  assert.deepEqual(compacted.observation[field], largeInput.observation[field], 'Compaction retains ' + field);
}
for (const item of actionable) assert.deepEqual(compacted.observation.controls.find((candidate) => candidate.id === item.id), item, 'Actionable control is preserved exactly: ' + item.id);
assert.equal(compacted.observation.omitted.controls, largeInput.observation.controls.length - compacted.observation.controls.length);
assert.equal(compacted.observation.omitted.pageTextCharacters, largeInput.observation.pageText.length - compacted.observation.pageText.length);
assert.equal(compacted.observation.omitted.previousResults, 0);
for (const item of compacted.observation.controls) assert.ok(largeInput.observation.controls.some((original) => original.id === item.id), 'No control IDs can be invented during compaction');
assert.throws(() => compactBrowserModelInput({ ...largeInput, goal: { destination: 'x'.repeat(11000) } }), /input budget/, 'The goal must not be silently truncated');
const crowdedOptions = Array.from({ length: 12 }, (_, index) => control({ id: 'c' + index, tag: 'li', role: 'option', name: 'Pune autocomplete property '.repeat(11), context: 'Supplier area and property '.repeat(13), metadata: 'autocomplete-result' }));
const crowdedEssential = [
  control({ id: 'c12', tag: 'button', name: '22 December 2026', context: 'Calendar labels '.repeat(21), metadata: 'calendar-cell', date: goal.checkIn }),
  control({ id: 'c13', tag: 'button', name: '23 December 2026', context: 'Calendar labels '.repeat(21), metadata: 'calendar-cell', date: goal.checkOut }),
  control({ id: 'c14', tag: 'button', name: 'Next month', context: 'Calendar labels '.repeat(21), metadata: 'calendar-next' }),
  control({ id: 'c15', name: 'Destination', context: 'Calendar labels '.repeat(21), metadata: 'ss' }),
  control({ id: 'c16', tag: 'button', name: 'Search', context: 'Calendar labels '.repeat(21), metadata: '', formSubmission: true }),
];
const crowdedInput = { ...largeInput, observation: { ...largeInput.observation, controls: [...crowdedOptions, ...crowdedEssential], pageText: '' },
  previousResults: Array.from({ length: 8 }, (_, index) => ({ action: 'dates', target: '', result: index + ': ' + 'Supplier calendar not ready '.repeat(8) })) };
const crowdedSnapshot = JSON.stringify(crowdedInput);
const crowdedCompacted = compactBrowserModelInput(crowdedInput);
assert.ok(JSON.stringify(crowdedCompacted).length <= 5000);
for (const item of crowdedEssential) assert.deepEqual(crowdedCompacted.observation.controls.find((candidate) => candidate.id === item.id), item, 'History and options cannot displace a current form/date/navigation control: ' + item.id);
assert.deepEqual(crowdedCompacted.previousResults, crowdedInput.previousResults.slice(-3));
assert.equal(crowdedCompacted.observation.omitted.previousResults, 5);
assert.equal(JSON.stringify(crowdedInput), crowdedSnapshot, 'Full runtime history must remain unchanged for validation and no-progress detection');
assert.throws(() => compactBrowserModelInput({ ...largeInput, observation: { ...largeInput.observation, controls: [control({ metadata: 'ss ' + 'x'.repeat(6000) })] } }), /Required browser controls.*input budget/, 'An essential observed control must not be silently truncated or omitted');
await assert.rejects(decideBrowserAction({ ...largeInput, goal: { ...goal, destination: 'x'.repeat(11000) } }, { provider: 'groq', apiKey: 'test', fetchImpl: async () => assert.fail('Oversized required evidence must stop before an API call') }), /supplier controls exceed the model observation allowance.*without a scripted fallback/);
await assert.rejects(decideBrowserAction({}, { provider: 'groq', apiKey: '' }), /require a configured API key/);
const groqResult = await decideBrowserAction(largeInput, { provider: 'groq', apiKey: 'test-groq-key', model: 'openai/gpt-oss-120b', fetchImpl: async (url, init) => {
  assert.equal(url, 'https://api.groq.com/openai/v1/chat/completions');
  assert.equal(init.headers.authorization || init.headers.Authorization, 'Bearer test-groq-key');
  assert.equal(init.headers['x-goog-api-key'], undefined, 'A Groq key must never be sent to Gemini');
  const body = JSON.parse(init.body);
  assert.equal(body.model, 'openai/gpt-oss-120b');
  assert.equal(body.response_format.type, 'json_schema');
  assert.equal(body.response_format.json_schema.strict, true);
  assert.equal(body.response_format.json_schema.schema.type, 'object');
  assert.equal(body.response_format.json_schema.schema.additionalProperties, false);
  assert.equal(body.response_format.json_schema.schema.properties.summary.maxLength, 200);
  assert.equal(body.response_format.json_schema.schema.properties.summary.minLength, 1);
  assert.equal(body.response_format.json_schema.schema.properties.target.maxLength, 20);
  assert.match(body.messages.find((message) => message.role === 'system').content, /UNTRUSTED DATA/);
  const submitted = JSON.parse(body.messages.find((message) => message.role === 'user').content);
  assert.deepEqual(submitted, compactBrowserModelInput({ ...largeInput, observation: { ...largeInput.observation,
    controls: largeInput.observation.controls.filter((control) => !control.formSubmission && !/^search$/i.test(control.name.trim())),
  } }));
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action('click', { target: 'c162' })) } }] }));
} });
assert.equal(groqResult.target, 'c162');
assert.equal((await decideBrowserAction(pendingOccupancy, { provider: 'groq', apiKey: 'test-groq-key', fetchImpl: async (_url, init) => {
  const body = JSON.parse(init.body);
  assert.ok(!body.response_format.json_schema.schema.properties.action.enum.includes('submit'), 'Groq uses the same current-state eligibility schema');
  return new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify(action('occupancy')) } }] }));
} })).action, 'occupancy');
assert.equal(validateBrowserAction(groqResult, largeInput.observation, goal).control.date, goal.checkIn, 'The model action is checked against full original evidence');
let groqCalls = 0;
await assert.rejects(decideBrowserAction({}, { provider: 'groq', apiKey: 'test', fetchImpl: async () => { groqCalls++; return new Response('{}', { status: 429 }); } }), /Provider HTTP 429.*quota or rate limit reached.*without a scripted fallback/);
assert.equal(groqCalls, 1, 'Groq quota failure must remain explicit, not rotate providers or replay actions');
await assert.rejects(decideBrowserAction({}, { provider: 'groq', apiKey: 'test', fetchImpl: async () => new Response(JSON.stringify({ choices: [{ finish_reason: 'stop', message: { content: JSON.stringify({ ...action('destination'), value: 'invented' }) } }] })) }), /invalid action schema.*without a scripted fallback/);
const groqCancellation = new AbortController();
await assert.rejects(decideBrowserAction({}, { provider: 'groq', apiKey: 'test', signal: groqCancellation.signal, fetchImpl: async (url, { signal }) => {
  queueMicrotask(() => groqCancellation.abort());
  return new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted'))));
} }), { name: 'AbortError' });
console.log('AI browser action policy, replanning, evidence, bounds, cancellation and model contract checks passed');
