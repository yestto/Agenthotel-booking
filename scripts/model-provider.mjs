import { setTimeout as delay } from "node:timers/promises";

const DEFAULT_MODELS = { gemini: "gemini-3.5-flash-lite", groq: "openai/gpt-oss-120b" };
const groqWindows = new Map();

export function resolveModelConfig(options = {}) {
  const provider = options.provider ?? process.env.LLM_PROVIDER ?? (process.env.GROQ_API_KEY ? "groq" : "gemini");
  if (!Object.hasOwn(DEFAULT_MODELS, provider)) throw new Error("Unsupported AI provider configuration.");
  let keyField = provider === "groq" ? "GROQ_API_KEY" : "GEMINI_API_KEY";
  let apiKey = options.apiKey ?? process.env[keyField] ?? "";
  if (provider === "groq" && options.apiKey === undefined && !apiKey && /^gsk_/.test(process.env.GEMINI_API_KEY || "")) {
    // Accept the user's existing field only after Groq was explicitly selected; never send a Google key to Groq.
    apiKey = process.env.GEMINI_API_KEY;
    keyField = "GEMINI_API_KEY";
  }
  const model = options.model ?? process.env[provider === "groq" ? "GROQ_MODEL" : "GEMINI_MODEL"] ?? DEFAULT_MODELS[provider];
  if (provider === "groq" && options.apiKey === undefined && !/^gsk_[A-Za-z0-9]+$/.test(apiKey)) apiKey = "";
  const wrongGeminiKey = provider === "gemini" && options.apiKey === undefined && /^(?:gsk_|xai-)/.test(apiKey);
  if (wrongGeminiKey) apiKey = "";
  const configurationIssue = wrongGeminiKey
    ? "The key in GEMINI_API_KEY belongs to another provider. Select the correct AI provider before starting a run."
    : provider === "groq" && !apiKey
    ? "Groq is selected but its key is missing or invalid. Set GROQ_API_KEY locally using a key from console.groq.com."
    : "";
  return { provider, apiKey, model, keyField, configurationIssue };
}

function strictJsonSchema(schema) {
  if (Array.isArray(schema)) return schema.map(strictJsonSchema);
  if (!schema || typeof schema !== "object") return schema;
  const result = Object.fromEntries(Object.entries(schema).map(([key, value]) => [key, strictJsonSchema(value)]));
  if (typeof result.type === "string") result.type = result.type.toLowerCase();
  if (result.type === "object") {
    result.additionalProperties = false;
    result.required = Object.keys(result.properties || {});
  }
  return result;
}

async function reserveGroqBudget(key, estimatedTokens, signal, wait) {
  if (estimatedTokens > 7_000) throw new Error("AI observation is too large for the free model allowance. No request was sent.");
  while (true) {
    signal.throwIfAborted();
    const now = Date.now();
    const recent = (groqWindows.get(key) || []).filter(item => now - item.time < 60_000);
    groqWindows.set(key, recent);
    if (recent.reduce((sum, item) => sum + item.tokens, 0) + estimatedTokens <= 7_000 && recent.length < 28) {
      const reservation = { time: now, tokens: estimatedTokens };
      recent.push(reservation);
      return reservation;
    }
    await wait(Math.max(1, recent[0].time + 60_050 - now));
  }
}

function abortable(promise, signal) {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { signal.removeEventListener("abort", abort); reject(signal.reason); };
    signal.addEventListener("abort", abort, { once: true });
    Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener("abort", abort));
  });
}

export async function requestStructuredModel({ input, prompt, responseSchema, name = "agent_decision", maxOutputTokens = 800 }, options = {}) {
  const config = resolveModelConfig(options);
  const { provider, apiKey, model } = config;
  if (!apiKey) throw new Error(config.configurationIssue || `AI service requires ${config.keyField}.`);
  const fetchImpl = options.fetchImpl ?? fetch;
  const realRequest = fetchImpl === globalThis.fetch;
  if (realRequest && provider === "groq" && !/^gsk_[A-Za-z0-9]+$/.test(apiKey)) {
    throw new Error("Invalid Groq key format. Replace GROQ_API_KEY locally with the full key from console.groq.com. No request was sent.");
  }
  if (provider === "gemini" && /^(?:gsk_|xai-)/.test(apiKey)) {
    throw new Error("The configured key belongs to another AI provider. No request was sent to Google.");
  }
  options.signal?.throwIfAborted();
  const controller = new AbortController();
  const abort = () => controller.abort();
  options.signal?.addEventListener("abort", abort, { once: true });
  const timeoutMs = options.timeoutMs ?? (provider === "groq" ? 90_000 : 15_000);
  const quotaWaitBudgetMs = Number.isFinite(options.quotaWaitBudgetMs) && options.quotaWaitBudgetMs > 0
    ? options.quotaWaitBudgetMs : 0;
  let activeRemainingMs = timeoutMs;
  let activeStartedAt = performance.now();
  let quotaWaitedMs = 0;
  let quotaWaitTimedOut = false;
  let quotaTimer;
  let timer = setTimeout(abort, activeRemainingMs);
  const hardTimer = quotaWaitBudgetMs ? setTimeout(abort, timeoutMs + quotaWaitBudgetMs) : undefined;
  const notifyQuotaWait = (event) => {
    try { options.onQuotaWait?.(event); } catch { /* Progress reporting must not change model execution. */ }
  };
  const waitForQuota = async (waitMs) => {
    controller.signal.throwIfAborted();
    if (quotaWaitBudgetMs) {
      activeRemainingMs -= performance.now() - activeStartedAt;
      clearTimeout(timer);
      if (activeRemainingMs <= 0) {
        abort();
        controller.signal.throwIfAborted();
      }
      quotaTimer = setTimeout(() => { quotaWaitTimedOut = true; abort(); }, Math.max(0, quotaWaitBudgetMs - quotaWaitedMs));
    }
    notifyQuotaWait({ phase: "waiting", waitMs });
    const startedAt = performance.now();
    try {
      await delay(waitMs, undefined, { signal: controller.signal });
    } finally {
      const waitedMs = performance.now() - startedAt;
      quotaWaitedMs += waitedMs;
      clearTimeout(quotaTimer);
      if (quotaWaitBudgetMs && !controller.signal.aborted) {
        activeStartedAt = performance.now();
        timer = setTimeout(abort, Math.max(0, activeRemainingMs));
      }
      notifyQuotaWait({ phase: "resumed", waitedMs });
    }
  };
  try {
    const body = provider === "groq" ? {
      model, messages: [{ role: "system", content: prompt }, { role: "user", content: typeof input === "string" ? input : JSON.stringify(input) }],
      temperature: 0, reasoning_effort: "low", max_completion_tokens: maxOutputTokens,
      ...(["openai/gpt-oss-20b", "openai/gpt-oss-120b"].includes(model) ? { include_reasoning: false } : { reasoning_format: "hidden" }),
      response_format: { type: "json_schema", json_schema: { name, strict: true, schema: strictJsonSchema(responseSchema) } },
    } : {
      systemInstruction: { parts: [{ text: prompt }] }, contents: [{ role: "user", parts: [{ text: typeof input === "string" ? input : JSON.stringify(input) }] }],
      generationConfig: { temperature: 0, maxOutputTokens, responseMimeType: "application/json", responseSchema },
    };
    const serialized = JSON.stringify(body);
    // This conservative estimate is not a tokenizer. Honor actual quota failures rather than rotating keys or providers.
    const estimatedTokens = Math.ceil(Buffer.byteLength(serialized, "utf8") / 3) + maxOutputTokens;
    if (provider === "groq" && estimatedTokens > 7_000) throw new Error("AI observation is too large for the free model allowance. No request was sent.");
    const url = provider === "groq" ? "https://api.groq.com/openai/v1/chat/completions"
      : `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`;
    const headers = provider === "groq" ? { "content-type": "application/json", Authorization: `Bearer ${apiKey}` }
      : { "content-type": "application/json", "x-goog-api-key": apiKey };
    let response;
    let reservation;
    for (let attempt = 0; attempt < 2; attempt++) {
      if (provider === "groq" && realRequest) reservation = await reserveGroqBudget(apiKey + ":" + model, estimatedTokens, controller.signal, waitForQuota);
      response = await abortable(fetchImpl(url, { method: "POST", headers, body: serialized, signal: controller.signal }), controller.signal);
      controller.signal.throwIfAborted();
      if (![502, 503, 504].includes(response.status) || attempt === 1) break;
      await abortable(response.body?.cancel(), controller.signal);
      await delay(1_000, undefined, { signal: controller.signal });
    }
    if (!response.ok) {
      const retrySeconds = Number(response.headers.get("retry-after"));
      let providerCode;
      if (provider === "groq" && response.status === 400) {
        try {
          const code = (await abortable(response.json(), controller.signal))?.error?.code;
          if (code === "json_validate_failed") providerCode = code;
        } catch {
          controller.signal.throwIfAborted();
        }
      } else await abortable(response.body?.cancel(), controller.signal);
      throw Object.assign(new Error("AI provider request failed."), { status: response.status,
        ...(providerCode ? { providerCode } : {}),
        ...(Number.isFinite(retrySeconds) && retrySeconds > 0 ? { retryAfterMs: retrySeconds * 1_000 } : {}) });
    }
    const result = await abortable(response.json(), controller.signal);
    options.signal?.throwIfAborted();
    controller.signal.throwIfAborted();
    // Provider-reported usage replaces the estimate, retaining a small local safety margin.
    if (reservation && Number.isSafeInteger(result.usage?.total_tokens) && result.usage.total_tokens > 0) {
      reservation.tokens = Math.ceil(result.usage.total_tokens * 1.1);
    }
    let raw;
    if (provider === "groq") {
      const choice = result.choices?.[0];
      if (choice?.message?.refusal || choice?.finish_reason !== "stop" || choice?.message?.tool_calls?.length) throw new SyntaxError("Incomplete or refused AI decision.");
      raw = choice.message.content;
    } else {
      const candidate = result.candidates?.[0];
      if (candidate?.finishReason && candidate.finishReason !== "STOP") throw new SyntaxError("Incomplete or refused AI decision.");
      raw = (candidate?.content?.parts || []).filter(part => !part.thought).map(part => part.text || "").join("");
    }
    return JSON.parse(raw);
  } catch (error) {
    options.signal?.throwIfAborted();
    if (quotaWaitTimedOut) throw Object.assign(new Error("AI quota wait allowance exceeded."), { quotaWaitTimedOut: true });
    if (controller.signal.aborted) throw Object.assign(new Error("Model request timed out."), { modelTimedOut: true });
    if (error.status || error instanceof SyntaxError || /too large|No request was sent/.test(error.message)) throw error;
    throw new Error("AI provider could not be reached.");
  } finally {
    clearTimeout(timer);
    clearTimeout(quotaTimer);
    clearTimeout(hardTimer);
    options.signal?.removeEventListener("abort", abort);
  }
}
