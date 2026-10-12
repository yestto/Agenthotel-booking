import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";

const html = await readFile(new URL("../src/index.html", import.meta.url), "utf8");
const script = html.match(/<script>([\s\S]*?)<\/script>/)?.[1];

assert(script, "Inline application script is missing");
for (const value of [
  "StayPilot control tower",
  "Agentic hotel search and pre-booking",
  "Coordinated workflow",
  "AI language understanding",
  "AI interpreted",
  "Local language fallback",
  "AI browser decisions",
  "IntakeAgent",
  "PolicyAgent",
  "SearchAgent",
  "RankingAgent",
  "RoomAgent",
  "CheckoutAgent",
  "SafetyAgent",
  "SupervisorAgent",
  "supervisor.decision",
  "Start agent run",
  "Protected checkout boundary reached",
  "preferred booking website",
  "Provider",
  "Universal computer use",
  "Guest rating",
  "Room availability",
  "Not available",
  "/api/runs",
  "EventSource",
  "Reconnect agent service",
  "attachRun",
  "activeRunId",
  "Previous run active",
]) assert.match(html, new RegExp(value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

assert.doesNotMatch(html, /buildDemoHotels|Computer route is a visual simulation|Simulated inventory|LangGraph|Playwright|Booking\.com|local Chrome|SSE observability|hotel availability API/i);
assert.doesNotThrow(() => new Function(script), "Frontend JavaScript must parse");

console.log("StayPilot multi-agent frontend smoke check passed");
