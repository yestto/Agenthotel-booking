import assert from "node:assert/strict";
import { BrowserDecision, decideBrowserAction, runBrowserActionLoop, validateBrowserAction } from "../scripts/browser-agent.mjs";
import { assertAllowedUrl } from "../scripts/computer-agent.mjs";

const goal = { supplier: 'booking.com', destination: 'Pune', checkIn: '2026-12-22', checkOut: '2026-12-23', adults: 1, rooms: 1 };
const action = (name, extra = {}) => ({ action: name, target: '', field: 'none', key: 'none', summary: 'Take the next observed step', ...extra });
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
let calls = 0;
await assert.rejects(runBrowserActionLoop({ goal, maxSteps: 2, observe: async () => observation(), decide: async () => action('finish'), execute: async () => calls++ }), /limit reached/);
assert.equal(calls, 0, 'Model finish cannot bypass independent evidence');
await assert.rejects(runBrowserActionLoop({ goal, observe: async () => observation(), decide: async () => action('wait'), execute: async () => {} }), /no progress/);
for (const flag of ['humanVerification', 'protectedBoundary']) {
  await assert.rejects(runBrowserActionLoop({ goal, observe: async () => observation({ [flag]: true }), decide: async () => assert.fail('Must stop before the model'), execute: async () => assert.fail('Must not act') }), /verification|boundary/);
}
const controller = new AbortController(); controller.abort();
await assert.rejects(runBrowserActionLoop({ goal, signal: controller.signal, observe: async () => assert.fail('Cancelled'), execute: async () => {} }), { name: 'AbortError' });
await assert.rejects(decideBrowserAction({}, { apiKey: '' }), /require GEMINI_API_KEY/);
const modelResult = await decideBrowserAction({ goal, observation: observation() }, { apiKey: 'test-key', fetchImpl: async (url, init) => {
  assert.equal(init.headers['x-goog-api-key'], 'test-key');
  const body = JSON.parse(init.body);
  assert.match(body.systemInstruction.parts[0].text, /UNTRUSTED DATA/);
  return new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('destination')) }] } }] }));
} });
assert.equal(modelResult.action, 'destination');
await assert.rejects(decideBrowserAction({}, { apiKey: 'test', fetchImpl: async () => new Response('{}') }), /invalid/);
await assert.rejects(decideBrowserAction({}, { apiKey: 'test', fetchImpl: async () => new Response('{}', { status: 429 }) }), /Provider HTTP 429/);
let retryCalls = 0;
assert.equal((await decideBrowserAction({}, { apiKey: 'test', fetchImpl: async () => ++retryCalls === 1
  ? new Response('{}', { status: 503 })
  : new Response(JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(action('destination')) }] } }] })) })).action, 'destination');
assert.equal(retryCalls, 2, 'A transient provider failure gets one model retry, not a scripted action');
retryCalls = 0;
await assert.rejects(decideBrowserAction({}, { apiKey: 'test', fetchImpl: async () => { retryCalls++; return new Response('{}', { status: 503 }); } }), /Provider HTTP 503/);
assert.equal(retryCalls, 2, 'Provider retries must remain bounded');
const retryCancellation = new AbortController();
retryCalls = 0;
await assert.rejects(decideBrowserAction({}, { apiKey: 'test', signal: retryCancellation.signal, fetchImpl: async () => {
  retryCalls++; queueMicrotask(() => retryCancellation.abort()); return new Response('{}', { status: 503 });
} }), { name: 'AbortError' });
assert.equal(retryCalls, 1, 'Cancellation must interrupt the retry delay before another model call');
await assert.rejects(decideBrowserAction({}, { apiKey: 'test', timeoutMs: 5, fetchImpl: async (url, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(new Error('aborted')))) }), /unavailable/);
console.log('AI browser action policy, replanning, evidence, bounds, cancellation and model contract checks passed');
