import http from "node:http";
import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { AgentOrchestrator, AGENTS, ORCHESTRATION, checkBrowserStorage } from "./agent-orchestrator.mjs";
import { parseTravelRequestHybrid } from "./llm-intake.mjs";
import { decideBrowserAction } from "./browser-agent.mjs";

const pagePath = resolve("src", "agent-console.html");
const terminalStatuses = new Set(["completed", "cancelled", "failed", "needs_human"]);
const hostedOrigins = new Set(["https://staypilot-hotel-demo.quietcow1.chatgpt.site"]);

export function findActiveRun(runs) {
  return [...runs.values()].find((run) => !terminalStatuses.has(run.orchestrator.status));
}

export function allowHostedBridge(request, response) {
  const origin = request.headers.origin;
  if (!hostedOrigins.has(origin)) return false;
  response.setHeader("access-control-allow-origin", origin);
  response.setHeader("vary", "Origin");
  response.setHeader("access-control-allow-methods", "GET, POST, OPTIONS");
  response.setHeader("access-control-allow-headers", "Content-Type, Last-Event-ID");
  response.setHeader("access-control-allow-private-network", "true");
  return true;
}

function sendJson(response, body, status = 200) {
  response.writeHead(status, {
    "content-type": "application/json; charset=utf-8",
    "cache-control": "no-store",
    "x-content-type-options": "nosniff",
  });
  response.end(JSON.stringify(body));
}

async function readJson(request) {
  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    length += chunk.length;
    if (length > 10_000) throw new Error("Request is too large.");
    chunks.push(chunk);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new Error("Expected a JSON request.");
  }
}

function publicRun(run) {
  return {
    runId: run.id,
    status: run.orchestrator.status,
    currentAgent: run.currentAgent,
    createdAt: run.createdAt,
    events: run.events,
    result: run.result,
    error: run.error,
  };
}

export async function createAgentServer({ orchestratorFactory, html, intakeParser = parseTravelRequestHybrid } = {}) {
  const page = html || await readFile(pagePath, "utf8");
  const runs = new Map();
  const intakeCache = new Map();
  const parseIntent = async (query) => {
    const cacheKey = `${new Date().toDateString()}:${query}`;
    if (!intakeCache.has(cacheKey)) {
      if (intakeCache.size >= 32) intakeCache.delete(intakeCache.keys().next().value);
      intakeCache.set(cacheKey, Promise.resolve().then(() => intakeParser(query)).catch((error) => { intakeCache.delete(cacheKey); throw error; }));
    }
    return intakeCache.get(cacheKey);
  };
  const makeOrchestrator = orchestratorFactory || ((options) => new AgentOrchestrator({ ...options, intakeParser: parseIntent, browserDecider: decideBrowserAction }));

  const server = http.createServer(async (request, response) => {
    const localHost = request.headers.host || "";
    if (!/^(?:127\.0\.0\.1|localhost)(?::\d+)?$/i.test(localHost)) return sendJson(response, { error: "Untrusted local service host." }, 403);
    const origin = request.headers.origin;
    if (origin && !hostedOrigins.has(origin) && origin !== `http://${localHost}`) return sendJson(response, { error: "Untrusted request origin." }, 403);
    allowHostedBridge(request, response);
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "cache-control": "no-store" });
      return response.end();
    }
    const url = new URL(request.url, `http://${request.headers.host || "127.0.0.1"}`);
    try {
      if (request.method === "GET" && url.pathname === "/") {
        response.writeHead(200, {
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store",
          "content-security-policy": "default-src 'self'; img-src 'self' data:; style-src 'self' 'unsafe-inline'; script-src 'self' 'unsafe-inline'; connect-src 'self'",
          "x-content-type-options": "nosniff",
          "referrer-policy": "no-referrer",
        });
        return response.end(page);
      }

      if (request.method === "GET" && url.pathname === "/api/health") {
        const active = findActiveRun(runs);
        const browserIssue = await checkBrowserStorage();
        return sendJson(response, {
          ready: true,
          browserReady: !browserIssue,
          browserIssue,
          mode: "local-computer-use",
          agents: AGENTS,
          orchestration: ORCHESTRATION,
          intakeMode: process.env.GEMINI_API_KEY ? "llm-assisted" : "deterministic-fallback",
          browserActionMode: process.env.GEMINI_API_KEY ? "agentic" : "unavailable",
          workflowActionMode: process.env.GEMINI_API_KEY ? "supervised-agentic" : "unavailable",
          activeRunId: active?.id || null,
          activeRunStatus: active?.orchestrator.status || null,
        });
      }

      if (request.method === "POST" && url.pathname === "/api/intake") {
        const input = await readJson(request);
        const query = typeof input?.query === "string" ? input.query.trim() : "";
        if (query.length < 10 || query.length > 2_000) return sendJson(response, { ready: false, message: "Tell me the destination, dates, and total budget." }, 422);
        try {
          const goal = await parseIntent(query);
          return sendJson(response, {
            ready: true,
            goal: {
              destination: goal.destination,
              supplier: goal.supplier,
              supplierMode: goal.supplierMode,
              ...(goal.hotelName ? { hotelName: goal.hotelName } : {}),
              checkIn: goal.checkIn,
              checkOut: goal.checkOut,
              adults: goal.adults,
              rooms: goal.rooms,
              budgetInr: goal.budgetInr,
              ...(goal.budgetMinInr ? { budgetMinInr: goal.budgetMinInr } : {}),
              breakfast: goal.breakfast,
              freeCancellation: goal.freeCancellation,
              intakeSource: goal.intakeSource,
              corrections: goal.corrections,
              ...(goal.interpretedRequest ? { interpretedRequest: goal.interpretedRequest } : {}),
              ...(goal.bedPreference ? { bedPreference: goal.bedPreference } : {}),
            },
          });
        } catch (error) {
          return sendJson(response, {
            ready: false,
            message: error.message,
            missingFields: error.missingFields || [],
            partial: error.partial || null,
          }, 422);
        }
      }

      if (request.method === "POST" && url.pathname === "/api/runs") {
        const input = await readJson(request);
        const query = typeof input?.query === "string" ? input.query.trim() : "";
        if (query.length < 20 || query.length > 2_000) return sendJson(response, { error: "Enter a complete hotel request between 20 and 2,000 characters." }, 400);
        // Check after reading the body: concurrent requests must not launch two browsers.
        const active = findActiveRun(runs);
        if (active) return sendJson(response, { error: "Another browser run is active.", runId: active.id }, 409);
        while (runs.size >= 32) {
          const oldest = [...runs.values()].find((run) => terminalStatuses.has(run.orchestrator.status));
          if (!oldest) break;
          for (const subscriber of oldest.subscribers) subscriber.end();
          runs.delete(oldest.id);
        }

        const id = `run_${crypto.randomUUID()}`;
        const run = { id, createdAt: new Date().toISOString(), currentAgent: null, events: [], subscribers: new Set(), result: null, error: null };
        const publish = (event) => {
          run.events.push(event);
          run.currentAgent = event.agent;
          const payload = `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`;
          for (const subscriber of run.subscribers) subscriber.write(payload);
        };
        run.orchestrator = makeOrchestrator({ runId: id, onEvent: publish, holdAtBoundary: true });
        runs.set(id, run);
        run.orchestrator.run(query).then((result) => {
          run.result = result;
        }).catch((error) => {
          run.error = error.message;
        });
        return sendJson(response, { runId: id, status: "queued" }, 202);
      }

      const runMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)$/);
      if (request.method === "GET" && runMatch) {
        const run = runs.get(runMatch[1]);
        return run ? sendJson(response, publicRun(run)) : sendJson(response, { error: "Run not found." }, 404);
      }

      const eventMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/events$/);
      if (request.method === "GET" && eventMatch) {
        const run = runs.get(eventMatch[1]);
        if (!run) return sendJson(response, { error: "Run not found." }, 404);
        response.writeHead(200, {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-cache, no-transform",
          connection: "keep-alive",
          "x-accel-buffering": "no",
        });
        response.write("retry: 1000\n\n");
        const afterSequence = Number(request.headers["last-event-id"] || 0);
        for (const event of run.events) {
          if (event.seq > (Number.isFinite(afterSequence) ? afterSequence : 0)) response.write(`id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`);
        }
        run.subscribers.add(response);
        request.on("close", () => run.subscribers.delete(response));
        return;
      }

      const actionMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/(cancel|close)$/);
      if (request.method === "POST" && actionMatch) {
        const run = runs.get(actionMatch[1]);
        if (!run) return sendJson(response, { error: "Run not found." }, 404);
        if (actionMatch[2] === "close" && run.orchestrator.status === "awaiting_human") {
          run.orchestrator.closeAtBoundary();
        } else {
          await run.orchestrator.cancel();
        }
        return sendJson(response, { runId: run.id, status: run.orchestrator.status }, 202);
      }

      const artifactMatch = url.pathname.match(/^\/api\/runs\/([a-zA-Z0-9_-]+)\/artifacts\/(01-selected-hotel|02-booking-boundary)\.png$/);
      if (request.method === "GET" && artifactMatch) {
        const run = runs.get(artifactMatch[1]);
        if (!run) return sendJson(response, { error: "Run not found." }, 404);
        try {
          const image = await readFile(resolve(run.orchestrator.artifactDir, `${artifactMatch[2]}.png`));
          response.writeHead(200, { "content-type": "image/png", "cache-control": "no-store", "x-content-type-options": "nosniff" });
          return response.end(image);
        } catch {
          return sendJson(response, { error: "Artifact is not available yet." }, 404);
        }
      }

      return sendJson(response, { error: "Not found." }, 404);
    } catch (error) {
      const status = /Expected a JSON request|Request is too large/.test(error.message) ? 400 : 500;
      return sendJson(response, { error: error.message || "Local agent server error." }, status);
    }
  });

  return { server, runs };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile?.(".env"); } catch (error) { if (error?.code !== "ENOENT") throw error; }
  const port = Number(process.env.AGENT_PORT || 4180);
  const { server, runs } = await createAgentServer();
  server.listen(port, "127.0.0.1", () => {
    console.log(`StayPilot multi-agent console: http://127.0.0.1:${port}`);
  });
  const shutdown = async () => {
    await Promise.all([...runs.values()].map((run) => run.orchestrator.cancel()));
    server.close();
  };
  process.once("SIGINT", shutdown);
  process.once("SIGTERM", shutdown);
}
