import assert from "node:assert/strict";
import { requestStructuredModel, resolveModelConfig } from "../scripts/model-provider.mjs";

const envNames = ["LLM_PROVIDER", "GEMINI_API_KEY", "GEMINI_MODEL", "GROQ_API_KEY", "GROQ_MODEL"];
const savedEnvironment = Object.fromEntries(envNames.map((name) => [name, process.env[name]]));
try {
  Object.assign(process.env, {
    LLM_PROVIDER: "groq", GROQ_API_KEY: "gsk_FixtureConfig", GROQ_MODEL: "groq-fixture-model",
    GEMINI_API_KEY: "gemini-fixture-key", GEMINI_MODEL: "gemini-fixture-model",
  });
  const groqConfig = resolveModelConfig();
  assert.deepEqual({ provider: groqConfig.provider, apiKey: groqConfig.apiKey, model: groqConfig.model, keyField: groqConfig.keyField }, {
    provider: "groq", apiKey: "gsk_FixtureConfig", model: "groq-fixture-model", keyField: "GROQ_API_KEY",
  });
  const geminiConfig = resolveModelConfig({ provider: "gemini" });
  assert.deepEqual({ provider: geminiConfig.provider, apiKey: geminiConfig.apiKey, model: geminiConfig.model, keyField: geminiConfig.keyField }, {
    provider: "gemini", apiKey: "gemini-fixture-key", model: "gemini-fixture-model", keyField: "GEMINI_API_KEY",
  });
  assert.equal(resolveModelConfig({ apiKey: "" }).apiKey, "", "An explicit empty key must not enable an environment credential");
  assert.equal(resolveModelConfig({ apiKey: "override-key", model: "override-model" }).model, "override-model");
  assert.equal(resolveModelConfig({ apiKey: "override-key" }).apiKey, "override-key");
  assert.throws(() => resolveModelConfig({ provider: "grok" }), /provider|supported/i);
  process.env.LLM_PROVIDER = "grok";
  assert.throws(() => resolveModelConfig(), /provider|supported/i, "An unknown provider must not silently receive a credential");
  delete process.env.LLM_PROVIDER;
  delete process.env.GROQ_API_KEY;
  assert.equal(resolveModelConfig().provider, "gemini", "Existing deployments must retain their Gemini default");
  delete process.env.GROQ_MODEL;
  assert.equal(resolveModelConfig({ provider: "groq" }).model, "openai/gpt-oss-120b");
  delete process.env.GROQ_API_KEY;
  const wrongLegacyKey = resolveModelConfig({ provider: "groq" });
  assert.ok(!wrongLegacyKey.apiKey, "The Gemini credential must not be used as a Groq fallback");
  assert.match(wrongLegacyKey.configurationIssue, /key|gemini|groq/i);
  process.env.GEMINI_API_KEY = "gsk_LegacyFixture";
  const legacyGroqKey = resolveModelConfig({ provider: "groq" });
  assert.equal(legacyGroqKey.apiKey, "gsk_LegacyFixture", "Explicit Groq selection supports the user's recognized key in the old field");
  assert.equal(legacyGroqKey.keyField, "GEMINI_API_KEY");
  process.env.GROQ_API_KEY = "gsk_PreferredFixture";
  assert.equal(resolveModelConfig({ provider: "groq" }).apiKey, "gsk_PreferredFixture", "The dedicated Groq field takes precedence over legacy migration support");
  for (const wrongKey of ["gemini-fixture-key", "xai-fixture-key", "gsk_bad-format", "gsk_"]) {
    process.env.GROQ_API_KEY = wrongKey;
    const invalidConfig = resolveModelConfig({ provider: "groq" });
    assert.equal(invalidConfig.apiKey, "", "An invalid dedicated key must not mark the service ready or fall back to the legacy field");
    assert.match(invalidConfig.configurationIssue, /groq|key|provider/i);
    assert.doesNotMatch(invalidConfig.configurationIssue, new RegExp(wrongKey));
  }
  delete process.env.GROQ_API_KEY;
  for (const wrongKey of ["gsk_", "gsk_bad-format"]) {
    process.env.GEMINI_API_KEY = wrongKey;
    const invalidLegacy = resolveModelConfig({ provider: "groq" });
    assert.equal(invalidLegacy.apiKey, "", "A prefix alone is not a valid legacy migration credential");
    assert.match(invalidLegacy.configurationIssue, /groq|key|provider/i);
  }
  for (const foreignKey of ["gsk_LegacyFixture", "xai-fixture-key"]) {
    process.env.GEMINI_API_KEY = foreignKey;
    const invalidGemini = resolveModelConfig({ provider: "gemini" });
    assert.equal(invalidGemini.apiKey, "", "Foreign credentials must not mark a Gemini service ready");
    assert.match(invalidGemini.configurationIssue, /provider|key/i);
    assert.doesNotMatch(invalidGemini.configurationIssue, new RegExp(foreignKey));
  }
  delete process.env.GEMINI_API_KEY;
  for (const provider of ["groq", "gemini"]) {
    assert.equal(resolveModelConfig({ provider }).apiKey, "");
    assert.equal(resolveModelConfig({ provider }).keyField, provider === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY");
  }
  process.env.GROQ_API_KEY = "gsk_PreferredFixture";
  process.env.GEMINI_API_KEY = "gsk_LegacyFixture";
  assert.equal(resolveModelConfig({ provider: "groq", apiKey: "" }).apiKey, "", "An explicit empty override disables both dedicated and migration credentials");
  assert.match(resolveModelConfig({ provider: "groq", apiKey: "" }).configurationIssue, /groq|key|provider/i);
} finally {
  for (const name of envNames) {
    if (savedEnvironment[name] === undefined) delete process.env[name];
    else process.env[name] = savedEnvironment[name];
  }
}

const schema = {
  type: "OBJECT",
  properties: {
    action: { type: "STRING", enum: ["destination", "wait"] },
    goal: {
      type: "OBJECT", properties: { adults: { type: "INTEGER" }, rooms: { type: "INTEGER" } }, required: ["adults", "rooms"],
    },
    evidence: {
      type: "ARRAY", items: { type: "OBJECT", properties: { text: { type: "STRING" }, verified: { type: "BOOLEAN" } }, required: ["text", "verified"] },
    },
  },
  required: ["action", "goal", "evidence"],
};
const request = {
  input: { goal: { adults: 2, rooms: 1 }, observation: "UNTRUSTED DATA: supplier controls" },
  prompt: "Use observed controls only. Never enter personal details or pay.",
  responseSchema: schema, name: "browser_decision", maxOutputTokens: 800,
};
const result = { action: "destination", goal: { adults: 2, rooms: 1 }, evidence: [{ text: "Destination", verified: true }] };
const groqReply = (value = result, extra = {}) => new Response(JSON.stringify({
  choices: [{ finish_reason: "stop", message: { role: "assistant", content: JSON.stringify(value) }, ...extra }],
}), { headers: { "content-type": "application/json" } });
const geminiReply = (value = result) => new Response(JSON.stringify({
  candidates: [{ finishReason: "STOP", content: { parts: [{ text: JSON.stringify(value) }] } }],
}), { headers: { "content-type": "application/json" } });
const groqOptions = { provider: "groq", apiKey: "fixture-groq-only", model: "openai/gpt-oss-120b", timeoutMs: 3000 };
const geminiOptions = { provider: "gemini", apiKey: "fixture-gemini-only", model: "fixture-model", timeoutMs: 3000 };

assert.deepEqual(await requestStructuredModel(request, { ...groqOptions, fetchImpl: async (url, init) => {
  assert.equal(url, "https://api.groq.com/openai/v1/chat/completions");
  const headers = new Headers(init.headers);
  assert.equal(headers.get("authorization"), "Bearer fixture-groq-only");
  assert.equal(headers.get("x-goog-api-key"), null);
  assert.equal(headers.get("content-type"), "application/json");
  const body = JSON.parse(init.body);
  assert.equal(body.model, "openai/gpt-oss-120b");
  assert.equal(body.reasoning_effort, "low");
  assert.equal(body.include_reasoning, false);
  assert.equal(Object.hasOwn(body, "reasoning_format"), false, "GPT-OSS does not support reasoning_format");
  assert.equal(body.response_format.type, "json_schema");
  assert.equal(body.response_format.json_schema.name, "browser_decision");
  assert.equal(body.response_format.json_schema.strict, true);
  assert.ok(Number.isInteger(body.max_completion_tokens));
  assert.equal(body.max_completion_tokens, request.maxOutputTokens);
  assert.deepEqual(body.messages.map(({ role }) => role), ["system", "user"]);
  assert.equal(body.messages[0].content, request.prompt);
  assert.deepEqual(JSON.parse(body.messages[1].content), request.input, "Request compaction must not silently erase goal or safety information");
  const converted = body.response_format.json_schema.schema;
  assert.equal(converted.type, "object");
  assert.equal(converted.additionalProperties, false);
  assert.equal(converted.properties.action.type, "string");
  assert.deepEqual(converted.properties.action.enum, ["destination", "wait"]);
  assert.equal(converted.properties.goal.additionalProperties, false);
  assert.equal(converted.properties.goal.properties.adults.type, "integer");
  assert.equal(converted.properties.evidence.type, "array");
  assert.equal(converted.properties.evidence.items.additionalProperties, false);
  assert.equal(converted.properties.evidence.items.properties.verified.type, "boolean");
  assert.deepEqual(converted.required, schema.required);
  assert.equal(schema.type, "OBJECT", "Schema translation must not mutate the shared Gemini schema");
  return groqReply();
} }), result);

for (const model of ["openai/gpt-oss-20b", "qwen/qwen3.8-27b"]) {
  assert.deepEqual(await requestStructuredModel(request, { ...groqOptions, model, fetchImpl: async (_url, init) => {
    const body = JSON.parse(init.body);
    if (model === "openai/gpt-oss-20b") {
      assert.equal(body.include_reasoning, false);
      assert.equal(Object.hasOwn(body, "reasoning_format"), false);
    } else {
      assert.equal(body.reasoning_format, "hidden");
      assert.equal(Object.hasOwn(body, "include_reasoning"), false, "Reasoning options are mutually exclusive");
    }
    return groqReply();
  } }), result);
}

assert.deepEqual(await requestStructuredModel(request, { ...geminiOptions, fetchImpl: async (url, init) => {
  assert.match(url, /^https:\/\/generativelanguage\.googleapis\.com\/v1beta\/models\/fixture-model:generateContent$/);
  const headers = new Headers(init.headers);
  assert.equal(headers.get("x-goog-api-key"), "fixture-gemini-only");
  assert.equal(headers.get("authorization"), null);
  const body = JSON.parse(init.body);
  assert.equal(body.systemInstruction.parts[0].text, request.prompt);
  assert.deepEqual(JSON.parse(body.contents[0].parts[0].text), request.input);
  assert.equal(body.generationConfig.responseMimeType, "application/json");
  assert.deepEqual(body.generationConfig.responseSchema, schema);
  assert.equal(body.generationConfig.maxOutputTokens, 800);
  return geminiReply();
} }), result);

for (const providerOptions of [groqOptions, geminiOptions]) {
  await assert.rejects(requestStructuredModel(request, { ...providerOptions, apiKey: "", fetchImpl: () => assert.fail("A missing key must stop before network access") }), /key|configured|required/i);
  await assert.rejects(requestStructuredModel(request, { ...providerOptions, fetchImpl: async () => new Response("{}") }), /invalid|missing|response|content|incomplete|json/i);
  await assert.rejects(requestStructuredModel(request, { ...providerOptions, fetchImpl: async () => new Response("not json") }), /json|invalid|response/i);
}
await assert.rejects(requestStructuredModel(request, { ...groqOptions, provider: "grok", fetchImpl: () => assert.fail("Unknown providers must stop before a credential is transmitted") }), /provider|supported/i);
await assert.rejects(requestStructuredModel(request, { ...groqOptions, fetchImpl: async () => groqReply(result, { message: { content: null, refusal: "Cannot comply" } }) }), /refus|invalid|response|content/i);
await assert.rejects(requestStructuredModel(request, { ...groqOptions, fetchImpl: async () => groqReply(result, { finish_reason: "length" }) }), /incomplete|truncat|length|finish/i);
await assert.rejects(requestStructuredModel(request, { ...groqOptions, fetchImpl: async () => groqReply(result, { message: { content: JSON.stringify(result), tool_calls: [{ id: "unrequested-tool" }] } }) }), /incomplete|refus|decision/i);
await assert.rejects(requestStructuredModel(request, { ...groqOptions, fetchImpl: async () => groqReply(result, { message: { content: "{bad json" } }) }), /json|invalid/i);
await assert.rejects(requestStructuredModel(request, { ...geminiOptions, fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ finishReason: "MAX_TOKENS", content: { parts: [{ text: JSON.stringify(result) }] } }] })) }), /incomplete|truncat|tokens|finish/i);
assert.deepEqual(await requestStructuredModel(request, { ...geminiOptions, fetchImpl: async () => new Response(JSON.stringify({ candidates: [{ content: { parts: [{ thought: true, text: "private reasoning is not the decision" }, { text: JSON.stringify(result) }] } }] })) }), result);

for (const providerOptions of [groqOptions, geminiOptions]) {
  const successfulResponse = providerOptions.provider === "groq" ? groqReply : geminiReply;
  let calls = 0;
  assert.deepEqual(await requestStructuredModel(request, { ...providerOptions, fetchImpl: async () => ++calls === 1
    ? new Response("{}", { status: 503 }) : successfulResponse(),
  }), result);
  assert.equal(calls, 2, "A transient provider failure gets one retry only");
  calls = 0;
  await assert.rejects(requestStructuredModel(request, { ...providerOptions, fetchImpl: async () => { calls++; return new Response("{}", { status: 503 }); } }), (error) => error.status === 503);
  assert.equal(calls, 2, "Repeated transient failures must stay bounded");
  calls = 0;
  await assert.rejects(requestStructuredModel(request, { ...providerOptions, fetchImpl: async () => { calls++; return new Response("{}", { status: 429 }); } }), (error) => error.status === 429);
  assert.equal(calls, 1, "Quota failures must not retry or switch providers");
  calls = 0;
  await assert.rejects(requestStructuredModel(request, { ...providerOptions, fetchImpl: async () => { calls++; return new Response("{}", { status: 401 }); } }), (error) => error.status === 401);
  assert.equal(calls, 1, "Authentication failures must not retry");
}
await assert.rejects(requestStructuredModel(request, { ...groqOptions, fetchImpl: async () => new Response("private provider details fixture-groq-only", { status: 400 }) }), (error) => {
  assert.equal(error.status, 400);
  assert.equal(error.providerCode, undefined);
  assert.doesNotMatch(error.message, /fixture-groq-only|private provider details/);
  return true;
});
for (const code of ["json_validate_failed", "fixture-groq-only", "unknown_error", null, { secret: "fixture-groq-only" }]) {
  let calls = 0;
  await assert.rejects(requestStructuredModel(request, { ...groqOptions, fetchImpl: async () => {
    calls++;
    return new Response(JSON.stringify({ error: { code, message: "private provider details fixture-groq-only",
      failed_generation: "private invalid model output fixture-groq-only" } }), { status: 400 });
  } }), (error) => {
    assert.equal(error.status, 400);
    assert.equal(error.providerCode, code === "json_validate_failed" ? code : undefined);
    assert.deepEqual(Object.keys(error).sort(), code === "json_validate_failed" ? ["providerCode", "status"] : ["status"]);
    assert.doesNotMatch(error.message + JSON.stringify(error), /fixture-groq-only|private|failed_generation/,
      "Only the exact allowlisted error code may escape provider-body parsing");
    return true;
  });
  assert.equal(calls, 1, "Even a recognized structured-output error remains non-retryable until a targeted policy is enabled");
}
await assert.rejects(requestStructuredModel(request, { ...geminiOptions, fetchImpl: async () => ({
  ok: false, status: 400, headers: new Headers(), body: { cancel: async () => {} },
  json: () => assert.fail("Other providers must not expose response-body error codes"),
}) }), (error) => error.status === 400 && error.providerCode === undefined);
const errorBodyCancellation = new AbortController();
const pendingErrorBody = requestStructuredModel(request, { ...groqOptions, signal: errorBodyCancellation.signal,
  fetchImpl: async () => ({ ok: false, status: 400, headers: new Headers(), json: () => new Promise(() => {}) }),
});
setTimeout(() => errorBodyCancellation.abort(), 5);
await assert.rejects(pendingErrorBody, { name: "AbortError" }, "Diagnostic body reads must remain immediately cancellable");
await assert.rejects(requestStructuredModel(request, { ...groqOptions, timeoutMs: 5,
  fetchImpl: async () => ({ ok: false, status: 400, headers: new Headers(), json: () => new Promise(() => {}) }),
}), (error) => error.modelTimedOut === true, "Diagnostic parsing must not extend the request deadline");

const alreadyCancelled = new AbortController();
alreadyCancelled.abort();
await assert.rejects(requestStructuredModel(request, { ...groqOptions, signal: alreadyCancelled.signal, fetchImpl: () => assert.fail("An aborted run must not spend a model call") }), { name: "AbortError" });
const externalCancellation = new AbortController();
await assert.rejects(requestStructuredModel(request, { ...groqOptions, signal: externalCancellation.signal, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("Cancelled", "AbortError")), { once: true });
  queueMicrotask(() => externalCancellation.abort());
}) }), { name: "AbortError" });
const retryCancellation = new AbortController();
let retryCalls = 0;
await assert.rejects(requestStructuredModel(request, { ...groqOptions, signal: retryCancellation.signal, fetchImpl: async () => {
  retryCalls++;
  queueMicrotask(() => retryCancellation.abort());
  return new Response("{}", { status: 503 });
} }), { name: "AbortError" });
assert.equal(retryCalls, 1, "Cancellation interrupts retry waiting");
const bodyCancellation = new AbortController();
await assert.rejects(requestStructuredModel(request, { ...groqOptions, signal: bodyCancellation.signal, fetchImpl: async () => ({
  ok: true, status: 200, json: async () => {
    bodyCancellation.abort();
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] };
  },
}) }), { name: "AbortError" }, "Cancellation during response-body parsing must not return a successful decision");
await assert.rejects(requestStructuredModel(request, { ...groqOptions, timeoutMs: 5, fetchImpl: async () => ({
  ok: true, status: 200, json: async () => {
    await new Promise((resolve) => setTimeout(resolve, 20));
    return { choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }] };
  },
}) }), (error) => error.modelTimedOut === true, "An expired deadline during response-body parsing must not return a successful decision");
const stalledBodyCancellation = new AbortController();
const stalledBody = requestStructuredModel(request, { ...groqOptions, signal: stalledBodyCancellation.signal, fetchImpl: async () => ({
  ok: true, status: 200, json: () => new Promise(() => {}),
}) });
setTimeout(() => stalledBodyCancellation.abort(), 5);
await assert.rejects(stalledBody, { name: "AbortError" }, "Cancellation must not wait indefinitely for a stalled response body");
await assert.rejects(requestStructuredModel(request, { ...groqOptions, timeoutMs: 5, fetchImpl: () => new Promise(() => {}) }),
  (error) => error.modelTimedOut === true, "An unresponsive transport must still obey its deadline");
await assert.rejects(requestStructuredModel(request, { ...groqOptions, timeoutMs: 15, fetchImpl: (_url, { signal }) => new Promise((_resolve, reject) => {
  signal.addEventListener("abort", () => reject(new DOMException("Timed out", "AbortError")), { once: true });
}) }), (error) => error.modelTimedOut === true);
let deadlineCalls = 0;
await assert.rejects(requestStructuredModel(request, { ...groqOptions, timeoutMs: 15, fetchImpl: async () => {
  deadlineCalls++;
  return new Response("{}", { status: 503 });
} }), (error) => error.modelTimedOut === true);
assert.equal(deadlineCalls, 1, "The deadline includes retry waiting and prevents a second request after expiry");

const enormousRequest = { ...request, input: { ...request.input, observation: "x".repeat(200_000) } };
await assert.rejects(requestStructuredModel(enormousRequest, { ...groqOptions, fetchImpl: () => assert.fail("Oversized requests must be rejected rather than silently truncated or sent") }), /input|request|large|limit|budget/i);

const originalFetch = globalThis.fetch;
const originalNow = Date.now;
let pacedCalls = 0;
try {
  // A process-local stand-in reaches the native-call limiter without network access or a real credential.
  globalThis.fetch = async () => { pacedCalls++; return groqReply(); };
  const pacedOptions = { ...groqOptions, apiKey: "gsk_fixturePacing", model: "fixture-paced-model", timeoutMs: 50 };
  const largeButAllowed = { ...request, maxOutputTokens: 100, input: { observation: "p".repeat(10_000) } };
  assert.deepEqual(await requestStructuredModel(largeButAllowed, pacedOptions), result);
  assert.equal(pacedCalls, 1);
  await assert.rejects(requestStructuredModel(largeButAllowed, pacedOptions), (error) => error.modelTimedOut === true);
  assert.equal(pacedCalls, 1, "A second request that would exceed the sliding token allowance waits and stops at its deadline before fetch");
  const pacingCancellation = new AbortController();
  const pending = requestStructuredModel(largeButAllowed, { ...pacedOptions, timeoutMs: 500, signal: pacingCancellation.signal });
  queueMicrotask(() => pacingCancellation.abort());
  await assert.rejects(pending, { name: "AbortError" });
  assert.equal(pacedCalls, 1, "Cancellation interrupts allowance waiting without spending another call");
  await assert.rejects(requestStructuredModel(request, { ...groqOptions, apiKey: "wrong-provider-key" }), /invalid.*groq|key format/i);
  await assert.rejects(requestStructuredModel(request, { ...geminiOptions, apiKey: "gsk_fixturePacing" }), /another.*provider|no request.*google/i);
  assert.equal(pacedCalls, 1, "Runtime key/provider mismatches never reach fetch");

  const quotaProgress = [];
  await assert.rejects(requestStructuredModel(largeButAllowed, { ...pacedOptions, timeoutMs: 500, quotaWaitBudgetMs: 20,
    onQuotaWait: (event) => quotaProgress.push(event),
  }), (error) => error.quotaWaitTimedOut === true && !error.modelTimedOut, "Quota waiting has its own bounded allowance only when explicitly enabled");
  assert.deepEqual(quotaProgress.map(({ phase }) => phase), ["waiting", "resumed"]);
  assert.ok(quotaProgress[0].waitMs > 1000 && quotaProgress[1].waitedMs > 0 && quotaProgress[1].waitedMs < 500);
  assert.equal(pacedCalls, 1, "Quota expiry must not spend a model call");

  const separateWaitCancellation = new AbortController();
  const cancelledProgress = [];
  const separateWait = requestStructuredModel(largeButAllowed, { ...pacedOptions, timeoutMs: 500, quotaWaitBudgetMs: 500,
    signal: separateWaitCancellation.signal, onQuotaWait: (event) => {
      cancelledProgress.push(event);
      if (event.phase === "waiting") queueMicrotask(() => separateWaitCancellation.abort());
    },
  });
  await assert.rejects(separateWait, { name: "AbortError" });
  assert.deepEqual(cancelledProgress.map(({ phase }) => phase), ["waiting", "resumed"], "Cancellation reports the actual wait in the paired resumed event");
  assert.ok(cancelledProgress[1].waitedMs >= 0);
  assert.equal(pacedCalls, 1);

  const releasingOptions = { ...pacedOptions, model: "fixture-releasing-model", timeoutMs: 30 };
  assert.deepEqual(await requestStructuredModel(largeButAllowed, releasingOptions), result);
  const releaseProgress = [];
  // Move only the limiter clock close to expiry; real deadline timers and actual wait measurement remain untouched.
  Date.now = () => originalNow() + 59_990;
  globalThis.fetch = async () => {
    pacedCalls++;
    await new Promise((resolve) => setTimeout(resolve, 10));
    return groqReply();
  };
  assert.deepEqual(await requestStructuredModel(largeButAllowed, { ...releasingOptions, quotaWaitBudgetMs: 200,
    onQuotaWait: (event) => {
      releaseProgress.push(event);
      if (event.phase === "waiting") throw new Error("Fixture progress renderer failed");
    },
  }), result, "A completed quota wait must leave the full active request allowance for the provider call");
  assert.deepEqual(releaseProgress.map(({ phase }) => phase), ["waiting", "resumed"]);
  assert.ok(releaseProgress[1].waitedMs > releasingOptions.timeoutMs);
  Date.now = originalNow;

  let usageCalls = 0;
  globalThis.fetch = async () => {
    usageCalls++;
    return new Response(JSON.stringify({ usage: { total_tokens: 100 },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
    }));
  };
  const reconciledOptions = { ...pacedOptions, model: "fixture-reconciled-model" };
  assert.deepEqual(await requestStructuredModel(largeButAllowed, reconciledOptions), result);
  assert.deepEqual(await requestStructuredModel(largeButAllowed, reconciledOptions), result);
  assert.equal(usageCalls, 2, "Valid actual usage releases overestimated reserved tokens without disabling the limiter");
  globalThis.fetch = async () => new Response(JSON.stringify({ usage: { total_tokens: 6000 },
    choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
  }));
  const largerUsageOptions = { ...pacedOptions, model: "fixture-larger-usage", timeoutMs: 5 };
  assert.deepEqual(await requestStructuredModel(largeButAllowed, largerUsageOptions), result);
  await assert.rejects(requestStructuredModel(largeButAllowed, largerUsageOptions), (error) => error.modelTimedOut === true,
    "Actual usage above the estimate must raise the reservation, never undercount it");
  for (const invalidUsage of [undefined, -1, 0, 100.5, "100"]) {
    globalThis.fetch = async () => new Response(JSON.stringify({ usage: { total_tokens: invalidUsage },
      choices: [{ finish_reason: "stop", message: { content: JSON.stringify(result) } }],
    }));
    const invalidUsageOptions = { ...pacedOptions, model: `fixture-invalid-usage-${String(invalidUsage)}`, timeoutMs: 5 };
    assert.deepEqual(await requestStructuredModel(largeButAllowed, invalidUsageOptions), result);
    await assert.rejects(requestStructuredModel(largeButAllowed, invalidUsageOptions), (error) => error.modelTimedOut === true,
      "Untrusted or missing usage must retain the conservative reservation");
  }
} finally {
  globalThis.fetch = originalFetch;
  Date.now = originalNow;
}

console.log("Model provider checks passed: isolated credentials, strict schemas, response failures, bounded retries, quota errors, separate quota waits, usage reconciliation, cancellation and deadlines");
