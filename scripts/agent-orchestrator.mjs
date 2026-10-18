import { mkdir, mkdtemp, readFile, rm, statfs, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import { freemem, tmpdir } from "node:os";
import { spawn } from "node:child_process";
import { chromium } from "playwright-core";
import { Command, END, MemorySaver, START, StateGraph, interrupt } from "@langchain/langgraph";
import { z } from "zod";
import { assertAllowedUrl, bookingSearchText, budgetContains, budgetLabel, normalizeSupplierHost, safeUrlForTrace } from "./computer-agent.mjs";
import { parseTravelRequestHybrid } from "./llm-intake.mjs";
import { assertObservedControl, decideBrowserAction, observeBrowserControls, runBrowserActionLoop, validateBrowserAction } from "./browser-agent.mjs";
import { WORKFLOW_LIMITS, decideRoomAction, decideSupervisorAction, readPropertyAddress, recoverableWorkflowFailure, supervisorObservation, validateRoomDecision, validateSupervisorDecision } from "./workflow-agent.mjs";
import { discoverHotel } from "./web-discovery.mjs";

const AGENTS = ["IntakeAgent", "PolicyAgent", "DiscoveryAgent", "SupervisorAgent", "SearchAgent", "RankingAgent", "RoomAgent", "CheckoutAgent", "SafetyAgent"];
const GRAPH_NODES = ["intake", "policy", "webDiscovery", "supervisor", "search", "room", "checkout", "safety", "humanApproval"];
const MAX_ROOM_CANDIDATES = WORKFLOW_LIMITS.inspections;
const NONESSENTIAL_RESOURCE_TYPES = new Set(["image", "media", "font"]);

export const ORCHESTRATION = Object.freeze({
  framework: "LangGraph.js",
  stateSchema: "Zod",
  checkpointer: "MemorySaver",
  browserRuntime: "Playwright",
  transport: "Server-Sent Events",
  nodes: GRAPH_NODES,
  maxRoomCandidates: MAX_ROOM_CANDIDATES,
  humanInterrupt: "humanApproval",
  browserDecisionLoop: "observe-decide-act-verify",
  workflowDecisionLoop: "model-supervisor-workers",
  discoveryTool: "google-search-grounding",
});

const HotelGraphState = z.object({
  task: z.string().min(20),
  goal: z.any().optional(),
  runPolicy: z.any().optional(),
  discovery: z.any().optional(),
  candidates: z.array(z.any()).default([]),
  rankedCandidates: z.array(z.any()).default([]),
  candidateIndex: z.number().int().nonnegative().default(0),
  candidate: z.any().optional(),
  selectedRoom: z.any().optional(),
  checkoutReceipt: z.any().optional(),
  receipt: z.any().optional(),
  humanDecision: z.any().optional(),
  lastRoomError: z.string().optional(),
  nextAction: z.string().optional(),
  supervisorSteps: z.number().int().nonnegative().default(0),
  searchAttempts: z.number().int().nonnegative().default(0),
  inspectionAttempts: z.number().int().nonnegative().default(0),
  rejectedCandidates: z.array(z.number().int()).default([]),
  roomRetryUsed: z.boolean().default(false),
  lastFailure: z.any().optional(),
  workflowHistory: z.array(z.any()).default([]),
});

export function displayedTotalInr(priceText = "", taxesText = "") {
  const amounts = (value) => [...value.matchAll(/₹\s*(\d[\d,]*(?:\.\d{1,2})?)/g)]
    .map((match) => Number(match[1].replaceAll(",", "")))
    .filter(Number.isFinite);
  const prices = amounts(priceText);
  if (!prices.length) return null;
  const base = prices.at(-1);
  return Math.round((base + amounts(taxesText).reduce((sum, value) => sum + value, 0)) * 100) / 100;
}

function normalizedHotelName(value = "") {
  return value
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/&/g, " and ")
    .replace(/[^a-z0-9]+/g, " ")
    .trim();
}

const LOCATION_ALIASES = { bangalore: "bengaluru", mysore: "mysuru", vizag: "visakhapatnam", calcutta: "kolkata", ramanagaram: "ramanagara" };
const INDIAN_REGIONS = new Set("Andhra Pradesh|Arunachal Pradesh|Assam|Bihar|Chhattisgarh|Goa|Gujarat|Haryana|Himachal Pradesh|Jharkhand|Karnataka|Kerala|Madhya Pradesh|Maharashtra|Manipur|Meghalaya|Mizoram|Nagaland|Odisha|Punjab|Rajasthan|Sikkim|Tamil Nadu|Telangana|Tripura|Uttar Pradesh|Uttarakhand|West Bengal|Andaman and Nicobar Islands|Chandigarh|Dadra and Nagar Haveli and Daman and Diu|Delhi|Jammu and Kashmir|Ladakh|Lakshadweep|Puducherry".split("|").map(normalizedHotelName));

function normalizedLocationName(value = "") {
  return normalizedHotelName(value).replace(/\b(?:bangalore|mysore|vizag|calcutta|ramanagaram)\b/g, (word) => LOCATION_ALIASES[word])
    .replace(/\b(bengaluru|mysuru|visakhapatnam|kolkata|ramanagara)(?:\s+\1)+\b/g, "$1");
}

export function bookingAddressLocationEvidence(address = "", destination = "") {
  const parts = address.split(/[,\n]/).map((part) => part.trim()).filter(Boolean);
  const withoutPostcode = (part) => part.replace(/^\d{4,6}\s+|\s+\d{4,6}$/g, "").trim();
  const countryIndex = normalizedLocationName(parts.at(-1)) === "india" ? parts.length - 1 : -1;
  const regionIndex = (countryIndex < 0 ? parts.length : countryIndex) - 1;
  const region = INDIAN_REGIONS.has(normalizedLocationName(withoutPostcode(parts[regionIndex] || ""))) ? withoutPostcode(parts[regionIndex]) : null;
  let cityIndex = parts.findLastIndex((part, index) => index + 1 < parts.length && /^\d{4,6}\s+[^\d]+$/.test(part));
  if (cityIndex < 0 && (region || countryIndex >= 0)) {
    cityIndex = (region ? regionIndex : countryIndex) - 1;
    if (/^\d{4,6}$/.test(parts[cityIndex] || "")) cityIndex -= 1;
  }
  const city = withoutPostcode(parts[cityIndex] || "");
  if (!city || /\d/.test(city) || cityIndex < 0) return { status: "unconfirmed", city: null };
  const requestedParts = destination.split(",").map((part) => part.trim()).filter(Boolean);
  const requestedRegion = requestedParts.find((part) => INDIAN_REGIONS.has(normalizedLocationName(part)));
  if (region && requestedRegion && normalizedLocationName(region) !== normalizedLocationName(requestedRegion)) return { status: "conflict", city, region };
  const requestedPlaces = requestedParts.filter((part) => !INDIAN_REGIONS.has(normalizedLocationName(part)) && normalizedLocationName(part) !== "india");
  if (!requestedPlaces.length && requestedRegion) return region || normalizedLocationName(city) === normalizedLocationName(requestedRegion)
    ? { status: "confirmed", city } : { status: "unconfirmed", city };
  const matchedPart = requestedPlaces.findIndex((part) => normalizedLocationName(part) === normalizedLocationName(city));
  if (matchedPart < 0) return { status: "conflict", city };
  const localityParts = parts.slice(0, cityIndex).map((part) => normalizedLocationName(withoutPostcode(part)));
  if (requestedPlaces.some((part, index) => index !== matchedPart && !localityParts.includes(normalizedLocationName(part)))) return { status: "locality-unconfirmed", city };
  return { status: "confirmed", city };
}

function tokenEditDistance(left, right) {
  const previous = Array.from({ length: right.length + 1 }, (_, index) => index);
  for (let leftIndex = 1; leftIndex <= left.length; leftIndex += 1) {
    const current = [leftIndex];
    for (let rightIndex = 1; rightIndex <= right.length; rightIndex += 1) {
      current[rightIndex] = Math.min(
        current[rightIndex - 1] + 1,
        previous[rightIndex] + 1,
        previous[rightIndex - 1] + (left[leftIndex - 1] === right[rightIndex - 1] ? 0 : 1),
      );
    }
    previous.splice(0, previous.length, ...current);
  }
  return previous[right.length];
}

function hotelTokenMatches(requested, observed) {
  if (requested === observed) return true;
  const longest = Math.max(requested.length, observed.length);
  const tolerance = longest >= 7 ? 2 : longest >= 4 ? 1 : 0;
  return tolerance > 0 && tokenEditDistance(requested, observed) <= tolerance;
}

export function hotelNameMatchScore(title = "", requested = "", destination = "") {
  const observed = normalizedHotelName(title);
  const target = normalizedHotelName(requested);
  if (!observed || !target) return 0;
  const weak = new Set(["hotel", "hotels", "the"]);
  const identity = (value) => {
    const tokens = normalizedHotelName(value).split(" ").filter(Boolean);
    while (weak.has(tokens[0])) tokens.shift();
    while (/^hotels?$/.test(tokens.at(-1))) tokens.pop();
    return tokens.join(" ");
  };
  const requestedIdentity = identity(requested);
  if (!requestedIdentity) return 0;
  const displayName = title.replace(/\s*[-–—|]\s*Booking\.com.*$/i, "").replace(/\s*\(updated[^)]*prices?[^)]*\)\s*$/i, "").trim();
  const undecoratedName = displayName.replace(/\s+[-–—]\s+(?:nr\.?|near)\s+.+$/i, "");
  if ([displayName, undecoratedName].some((name) => identity(name) === requestedIdentity)) return 1;
  const displayParts = undecoratedName.split(",").map((part) => part.trim()).filter(Boolean);
  const locationLabels = new Set([...destination.split(","), "India"].map(normalizedLocationName));
  if (destination && displayParts.length > 1 && identity(displayParts[0]) === requestedIdentity
    && displayParts.slice(1).every((part) => locationLabels.has(normalizedLocationName(part)))) return 1;
  const requestedTokens = target.split(" ").filter((token) => token && !weak.has(token));
  if (!requestedTokens.length) return 0;
  const observedTokens = observed.split(" ").filter(Boolean);
  // Similarity is useful for retrieval, but only literal identity can authorize a named hotel.
  return Math.min(0.99, requestedTokens.filter((token) => observedTokens.some((observedToken) => hotelTokenMatches(token, observedToken))).length / requestedTokens.length);
}

export function bookingLocationMatchScore(observed = "", requested = "", hotelName = "") {
  const weak = new Set(["the", "area", "city", "district", "state", "india"]);
  const hotelTokens = new Set(normalizedLocationName(hotelName).split(" ").filter(Boolean));
  const allRequested = normalizedLocationName(requested).split(" ").filter((token) => token && !weak.has(token));
  const locationOnly = allRequested.filter((token) => !hotelTokens.has(token));
  const requestedTokens = locationOnly.length ? locationOnly : allRequested;
  const observedTokens = normalizedLocationName(observed).split(" ").filter(Boolean);
  if (!requestedTokens.length || !observedTokens.length) return 0;
  const matches = requestedTokens.filter((token) => observedTokens.some((candidate) => hotelTokenMatches(token, candidate))).length;
  return matches / requestedTokens.length;
}

export function bookingDestinationMatches(observed = "", requested = "", hotelName = "") {
  const weak = new Set(["the", "area", "city", "district", "state", "india"]);
  const hotelTokens = new Set(normalizedLocationName(hotelName).split(" ").filter(Boolean));
  const tokens = normalizedLocationName(requested.split(",")[0]).split(" ").filter((token) => token && !weak.has(token) && !hotelTokens.has(token));
  const observedTokens = normalizedLocationName(observed).split(" ");
  return tokens.length > 0 && tokens.every((token) => observedTokens.some((candidate) => hotelTokenMatches(token, candidate)));
}

export function chooseBookingSuggestion(suggestions, goal) {
  const weak = new Set(["the", "area", "city", "district", "state", "india"]);
  const placeLabel = (value) => [...new Set(normalizedLocationName(value).split(" ").filter((word) => word && !weak.has(word)))].sort().join(" ");
  const placeParts = goal.destination.split(",").map((part) => part.trim()).filter(Boolean);
  const requestedLabels = new Set(placeParts.map((_, index) => placeLabel(placeParts.slice(0, index + 1).join(", "))));
  const matches = suggestions.map((suggestion, index) => {
    const lines = suggestion.split("\n").filter((line) => line.trim());
    // A remembered trip is not geographic autocomplete evidence for a new search.
    if (lines.slice(1).some((line) => /\d.*\b(?:adults?|people|rooms?)\b/i.test(line))) return null;
    if (!goal.hotelName && ![lines[0], lines[0]?.replace(/\([^)]*\)/g, "")]
      .some((label) => requestedLabels.has(placeLabel(label)))) return null;
    const locationText = goal.hotelName && lines.length > 1 ? lines.slice(1).join(" ") : suggestion;
    return {
      index,
      location: goal.destination.split(",").slice(0, 2).every((part) => bookingDestinationMatches(locationText, part)) ? bookingLocationMatchScore(locationText, goal.destination) : 0,
      hotel: goal.hotelName ? hotelNameMatchScore(lines[0], goal.hotelName, goal.destination) : 1,
    };
  }).filter((match) => match && match.location >= 0.5 && match.hotel === 1);
  matches.sort((a, b) => b.hotel - a.hotel || b.location - a.location);
  return matches[0]?.index ?? -1;
}

export function compareHotelCandidates(left, right, namedHotel = false) {
  if (namedHotel) {
    const matchDifference = (right.nameMatchScore || 0) - (left.nameMatchScore || 0);
    return matchDifference || left.totalInr - right.totalInr;
  }
  const ratingDifference = (right.rating ?? -1) - (left.rating ?? -1);
  return ratingDifference || left.totalInr - right.totalInr;
}

export function parseReviewRating(text = "") {
  const match = text.match(/\b(?:scored|guest\s+rating|review\s+score)\s*:?\s*(\d+(?:\.\d+)?)/i)
    || text.match(/\b(\d+(?:\.\d+)?)\s*(?:\/\s*10|out of 10)\b/i)
    || text.match(/^\s*(\d+(?:\.\d+)?)(?!\d)/)
    || text.match(/\b(\d+\.\d+)\b/);
  const rating = Number(match?.[1]);
  return Number.isFinite(rating) && rating >= 0 && rating <= 10 ? rating : null;
}

function genericInrTotal(text = "") {
  return displayedTotalInr(text.replace(/\b(?:INR|Rs\.?)\s*/gi, "₹"), "");
}

function genericRating(text = "") {
  const match = text.match(/(?:guest\s+rating|review\s+score|rated|scored)\s*[:\-]?\s*(\d+(?:\.\d+)?)/i)
    || text.match(/\b(\d+(?:\.\d+)?)\s*(?:\/\s*10|out of 10)\b/i);
  return parseReviewRating(match?.[1] || "");
}

export function universalCandidatesFromLinks(raw = [], allowedHost, limit = 12) {
  const seen = new Set();
  const candidates = [];
  for (const item of raw) {
    if (!item.href || !item.title || item.text.length < 20 || !/(?:₹|\bINR\b|\bRs\.?)\s*[\d,]+/i.test(item.text)) continue;
    if (!/(?:hotel|room|stay|resort|inn|suite|apartment|villa|hostel)/i.test(item.text)) continue;
    try { assertAllowedUrl(item.href, allowedHost); } catch { continue; }
    const totalInr = genericInrTotal(item.text);
    const dedupeKey = `${item.href.split("?")[0]}|${item.title.toLowerCase()}`;
    if (totalInr === null || seen.has(dedupeKey)) continue;
    seen.add(dedupeKey);
    candidates.push({
      index: candidates.length,
      title: item.title,
      totalInr,
      rating: genericRating(item.text),
      priceText: item.text,
      taxesText: "",
      breakfastIncluded: /breakfast included|includes breakfast/i.test(item.text),
      freeCancellation: /free cancellation|fully refundable/i.test(item.text),
      href: item.href,
      source: "universal-computer-use",
    });
    if (candidates.length >= limit) break;
  }
  return candidates;
}

export function shouldBlockBrowserResource(resourceType = "") {
  return NONESSENTIAL_RESOURCE_TYPES.has(resourceType);
}

export function browserStorageIssue(freeBytes) {
  return freeBytes < 500 * 1024 * 1024
    ? `Low disk space: only ${Math.floor(freeBytes / 1024 / 1024)} MB free on the browser temporary-files drive. Free at least 500 MB and refresh the console before starting a browser run.`
    : null;
}

export function browserMemoryIssue(availableBytes) {
  return availableBytes < 512 * 1024 * 1024
    ? `Low available memory: only ${Math.floor(availableBytes / 1024 / 1024)} MB free on this computer. Close unused apps or browser tabs and refresh before starting a supplier browser.`
    : null;
}

export async function checkBrowserStorage() {
  const disk = await statfs(tmpdir());
  return browserStorageIssue(disk.bavail * disk.bsize) || browserMemoryIssue(freemem());
}

export function classifySearchFailure(pageText = "") {
  if (/captcha|verify (?:that )?you are human|security check|access denied/i.test(pageText)) return "human-verification";
  if (/no (?:properties|results|availability)|couldn['’]t find|can['’]t find|did not match|not found|try (?:another|a different) search/i.test(pageText)) return "no-results";
  return "retry";
}

export function isBookingTemporaryFailure(pageText = "") {
  return /(?:oops!\s*)?something went wrong on our end|error code:\s*502|502\s+bad gateway/i.test(pageText);
}

export function isBookingLandingPage(value = "") {
  try {
    const url = new URL(value);
    return /(^|\.)booking\.com$/i.test(url.hostname)
      && (url.pathname === "/" || /^\/index(?:\.[^/]+)?\.html$/i.test(url.pathname));
  } catch {
    return false;
  }
}

export function parseBookingOccupancySummary(value = "") {
  return {
    adults: Number(value.match(/(\d+)\s+adults?/i)?.[1]) || null,
    rooms: Number(value.match(/(\d+)\s+rooms?/i)?.[1]) || null,
  };
}

export function bookingOccupancyControlId(label) {
  return label === "Adults" ? "group_adults" : label === "Rooms" ? "no_rooms" : null;
}

export function bookingDateLabel(value) {
  return new Date(`${value}T00:00:00Z`).toLocaleDateString("en-US", {
    weekday: "long", month: "long", day: "numeric", year: "numeric", timeZone: "UTC",
  });
}

export function bookingDateLabelPattern(value) {
  const date = new Date(`${value}T00:00:00Z`);
  const weekday = date.toLocaleDateString("en-US", { weekday: "long", timeZone: "UTC" });
  const month = date.toLocaleDateString("en-US", { month: "long", timeZone: "UTC" });
  const day = date.getUTCDate();
  const year = date.getUTCFullYear();
  return new RegExp(`${weekday},?\\s*(?:${month}\\s+${day}|${day}\\s+${month}),?\\s+${year}`, "i");
}

export function bookingDateSummaryMatches(summary, ...dates) {
  const years = summary.match(/\b20\d{2}\b/g) || [];
  if (years.some((year) => !dates.some((date) => date.startsWith(year)))) return false;
  return dates.every((value) => {
    const date = new Date(`${value}T00:00:00Z`);
    const month = date.toLocaleDateString("en-US", { month: "short", timeZone: "UTC" });
    const day = date.getUTCDate();
    return new RegExp(`\\b(?:${month}[a-z]*\\s+${day}\\b|${day}\\s+${month}[a-z]*\\b)`, "i").test(summary);
  });
}

export function bookingCheckoutSummaryEvidence(pageText, receipt) {
  const text = pageText.normalize("NFKC").replace(/[\u200b-\u200f\u202a-\u202e\u2066-\u2069]/g, "");
  const property = text.match(/\bFinish booking\s*\n([^\n]+)[\s\S]*?\bYour booking details\b/i)?.[1]?.trim();
  if (!property || hotelNameMatchScore(property, receipt.hotel) !== 1) {
    throw new Error("Checkout did not retain the verified hotel identity. No booking was submitted.");
  }
  const dateLine = (label) => text.match(new RegExp(`\\b${label}\\s*\\n([^\\n]+)`, "i"))?.[1]?.trim() || "";
  const checkIn = dateLine("Check-in");
  const checkOut = dateLine("Check-out");
  if (!bookingDateSummaryMatches(checkIn, receipt.checkIn) || !checkIn.includes(receipt.checkIn.slice(0, 4))
    || !bookingDateSummaryMatches(checkOut, receipt.checkOut) || !checkOut.includes(receipt.checkOut.slice(0, 4))) {
    throw new Error("Checkout did not retain the requested stay dates. No booking was submitted.");
  }
  const selection = text.match(/\bYou selected\s*\n([^\n]+)/i)?.[1] || "";
  const rooms = Number(selection.match(/\b(\d+)\s+(?:rooms?|villas?|apartments?|suites?|units?)\b/i)?.[1]);
  const adults = Number(selection.match(/\b(\d+)\s+adults?\b/i)?.[1]);
  if (rooms !== receipt.rooms || adults !== receipt.adults) {
    throw new Error("Checkout did not retain the requested adults and room quantity. No booking was submitted.");
  }
  // Cancellation fees and optional add-ons are not proof of the booking's full price.
  const price = text.match(/^(?:Total(?:\s+(?:price|cost))?|Your total)\s*:?\s*\n?\s*(?:₹|INR|Rs\.?)\s*(\d[\d,]*(?:\.\d{1,2})?)\s*(?:\n|$)/im);
  if (!price) throw new Error("Checkout does not show a verifiable full stay total. No booking was submitted.");
  const priceBlock = text.slice(price.index).split("\n").slice(0, 7).join(" ");
  if (/\+\s*(?:₹|INR|Rs\.?)\s*\d|(?:excludes?|excluding|not included)[^.!?]{0,60}(?:tax|fees?)|(?:tax|fees?)[^.!?]{0,60}(?:excluded|not included)/i.test(priceBlock)) {
    throw new Error("Checkout shows additional or excluded charges rather than a verified full stay total. No booking was submitted.");
  }
  const totalInr = Number(price[1].replaceAll(",", ""));
  if (totalInr !== receipt.totalInr) throw new Error("The full stay total changed at checkout. No booking was submitted.");
  const roomPolicy = {
    breakfastIncluded: /breakfast included in the price|breakfast included|includes breakfast/i.test(text)
      && !/\bno breakfast\b|breakfast (?:is )?not included/i.test(text),
    freeCancellation: /free cancellation|fully refundable/i.test(text)
      && !/\bnon[- ]refundable\b|\bno free cancellation\b|free cancellation (?:is )?not (?:available|included)/i.test(text),
  };
  if (receipt.roomPolicy.breakfastIncluded && !roomPolicy.breakfastIncluded
    || receipt.roomPolicy.freeCancellation && !roomPolicy.freeCancellation) {
    throw new Error("Checkout did not retain the verified room policies. No booking was submitted.");
  }
  if (!receipt.roomType || receipt.roomType === "Not shown"
    || !text.split("\n").some((line) => normalizedHotelName(line.replace(/^\s*\d+\s*[x×]\s*/i, "")) === normalizedHotelName(receipt.roomType))) {
    throw new Error("Checkout did not retain the verified room type. No booking was submitted.");
  }
  return { hotel: property, checkIn: receipt.checkIn, checkOut: receipt.checkOut, rooms, adults, totalInr, roomType: receipt.roomType, roomPolicy,
    checkoutSummaryVerified: true, summaryEvidence: { property, checkIn, checkOut, selection: selection.trim(), price: price[0].trim() } };
}

export function bookingSearchSubmissionMatches(value, goal) {
  try {
    const url = new URL(value);
    const searchText = url.searchParams.get("ss")?.trim() || "";
    const destinationCommitted = (Boolean(searchText) || /^\/hotel\//i.test(url.pathname))
      && (!goal.destination || bookingDestinationMatches(searchText, goal.destination, goal.hotelName));
    return /(^|\.)booking\.com$/i.test(url.hostname)
      && destinationCommitted
      && url.searchParams.get("checkin") === goal.checkIn
      && url.searchParams.get("checkout") === goal.checkOut
      && url.searchParams.get("group_adults") === String(goal.adults)
      && url.searchParams.get("no_rooms") === String(goal.rooms);
  } catch {
    return false;
  }
}

export function bookingVisibleSearchStateMatches(observed, goal) {
  const occupancy = parseBookingOccupancySummary(observed.occupancy || "");
  return Boolean(observed.searchOutcomeVisible)
    && bookingDestinationMatches(`${observed.destination || ""} ${observed.destinationContext || ""}`, goal.destination)
    && bookingDateSummaryMatches(observed.dateSummary || "", goal.checkIn, goal.checkOut)
    && occupancy.adults === goal.adults
    && occupancy.rooms === goal.rooms;
}

export function bookingFieldReadiness(observed, goal, selection) {
  const occupancy = parseBookingOccupancySummary(observed.occupancy || "");
  const citySelection = selection?.mode === "city";
  const matchingGoal = citySelection ? { ...goal, hotelName: undefined } : goal;
  return {
    destination: Boolean(selection && chooseBookingSuggestion([selection.text], matchingGoal) === 0
      && (goal.hotelName && !citySelection ? hotelNameMatchScore(observed.destination, goal.hotelName, goal.destination) === 1
        || (observed.searchOutcomeVisible && bookingDestinationMatches(observed.destination, goal.destination))
        : bookingDestinationMatches(observed.destination, goal.destination))),
    dates: bookingDateSummaryMatches(observed.dateSummary || "", goal.checkIn, goal.checkOut),
    occupancy: occupancy.adults === goal.adults && occupancy.rooms === goal.rooms,
  };
}

export function publicAgentErrorMessage(error) {
  const message = String(typeof error === "string" ? error : error?.message || "")
    .replace(/\u001b\[[0-?]*[ -/]*[@-~]/g, "")
    .trim();
  if (!message) return "The browser run stopped safely because the supplier did not respond.";
  if (/(?:locator|page)\.\w+:|getBy(?:Role|Text|TestId)\(|call log:|timeout \d+ms exceeded|strict mode violation|protocol error/i.test(message)) {
    return "The supplier page changed or did not respond in time. The browser run stopped safely; please try again.";
  }
  return message.replace(/^Supplier UI unavailable:\s*/i, "").replace(/\s*No direct-URL recovery was used\./i, "");
}

export function bookingEntryUrl(goal) {
  return `https://www.${normalizeSupplierHost(goal.supplier)}/`;
}

function supplierUiUnavailable(detail) {
  return new Error(`Supplier UI unavailable: ${detail}`);
}

function roomTotalInr(priceText = "", taxesText = "", rowText = "") {
  const structured = displayedTotalInr(priceText, taxesText);
  if (structured !== null) return structured;
  const values = [...rowText.matchAll(/₹\s*([\d,]+)/g)]
    .map((match) => Number(match[1].replaceAll(",", "")))
    .filter(Number.isFinite);
  if (values.length === 1) return values[0];
  if (values.length === 2 && /\+\s*₹/.test(rowText)) return values[0] + values[1];
  return null;
}

export function bookingRoomEvidence(row, goal) {
  const option = row.options.find((option) => option.value === String(goal.rooms) && !option.disabled);
  const unitTotalInr = roomTotalInr(row.priceText, row.taxesText, row.rowText);
  if (row.disabled || !option || unitTotalInr === null) return null;
  const capacityText = `${row.capacityText || ""} ${row.rowText}`;
  const capacities = [...capacityText.matchAll(/(?:max\.?\s*(?:people|persons?)|sleeps?|guests?)\s*:?\s*(\d+)|(\d+)\s+adults?\b/gi)]
    .map((match) => Number(match[1] || match[2]));
  const capacity = capacities.length ? Math.max(...capacities) : null;
  return {
    index: row.index, selectId: row.selectId, optionValue: option.value, quantity: goal.rooms,
    totalInr: Math.round(unitTotalInr * goal.rooms * 100) / 100,
    occupancyConfirmed: capacity !== null && capacity * goal.rooms >= goal.adults,
    breakfastIncluded: /\b(?:good\s+)?breakfast included\b/i.test(row.rowText)
      && !/\b(?:no|without)\s+(?:good\s+)?breakfast\b|breakfast (?:is )?not included/i.test(row.rowText),
    freeCancellation: /\bfree cancellation\b/i.test(row.rowText)
      && !/\b(?:no|without) free cancellation\b|free cancellation (?:is )?not (?:available|included)|\bnon[- ]refundable\b/i.test(row.rowText),
    sharedAccommodation: /bed in\b|\bdormitor(?:y|ies)\b|\bcapsule\b/i.test(`${row.roomType || ""} ${row.rowText}`),
    roomType: (row.roomType || "").split("\n")[0].trim(),
    rowText: row.rowText,
  };
}

function findBrowserExecutable() {
  const candidates = [
    process.env.CHROME_PATH,
    "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Google\\Chrome\\Application\\chrome.exe",
    "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe",
    "C:\\Program Files\\Microsoft\\Edge\\Application\\msedge.exe",
  ].filter(Boolean);
  const executable = candidates.find((candidate) => existsSync(candidate));
  if (!executable) throw new Error("Chrome or Edge was not found. Set CHROME_PATH to the browser executable.");
  return executable;
}

async function launchAttachedChrome() {
  const profilePrefix = join(tmpdir(), "staypilot-chrome-");
  const profileDir = await mkdtemp(profilePrefix);
  const chromeProcess = spawn(findBrowserExecutable(), [
    "--remote-debugging-port=0",
    `--user-data-dir=${profileDir}`,
    "--window-size=1365,768",
    "--no-first-run",
    "--disable-default-apps",
    "--disable-extensions",
    "about:blank",
  ], { stdio: "ignore" });
  const portFile = join(profileDir, "DevToolsActivePort");
  try {
    let port;
    for (let attempt = 0; attempt < 100; attempt += 1) {
      port = await readFile(portFile, "utf8").then((value) => value.split(/\r?\n/)[0]).catch(() => null);
      if (port) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 100));
    }
    if (!port) throw new Error("Chrome did not expose its computer-use connection.");
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`);
    const context = browser.contexts()[0];
    if (!context) throw new Error("Chrome did not create a browser context.");
    const page = context.pages()[0] || await context.newPage();
    return { browser, context, page, chromeProcess, profileDir, profilePrefix };
  } catch (error) {
    chromeProcess.kill();
    if (resolve(profileDir).startsWith(resolve(profilePrefix))) await rm(profileDir, { recursive: true, force: true }).catch(() => {});
    throw error;
  }
}

function safeGoal(goal) {
  return {
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
    intakeSource: goal.intakeSource || "deterministic",
    corrections: goal.corrections || [],
    ...(goal.interpretedRequest ? { interpretedRequest: goal.interpretedRequest } : {}),
    ...(goal.bedPreference ? { bedPreference: goal.bedPreference } : {}),
  };
}

function abortError() {
  return new DOMException("The run was cancelled.", "AbortError");
}

function quotaWaitProgress(context, agent) {
  return ({ phase, waitMs, waitedMs }) => context.trace.emit(agent,
    phase === "waiting" ? "model.quota_wait" : "model.quota_resumed",
    phase === "waiting" ? "Waiting for the free-plan allowance before the next AI decision" : "Free-plan wait ended; checking the next AI decision",
    phase === "waiting" ? { waitMs } : { waitedMs });
}

function ensureActive(signal) {
  if (signal.aborted) throw abortError();
}

class RunTrace {
  constructor(runId, artifactDir, onEvent) {
    this.runId = runId;
    this.artifactDir = artifactDir;
    this.onEvent = onEvent;
    this.events = [];
    this.goal = null;
  }

  emit(agent, type, message, evidence = {}) {
    const event = {
      runId: this.runId,
      seq: this.events.length + 1,
      at: new Date().toISOString(),
      agent,
      type,
      message,
      evidence,
    };
    this.events.push(event);
    this.onEvent?.(event);
    console.log(`[${agent}] ${message}${Object.keys(evidence).length ? ` ${JSON.stringify(evidence)}` : ""}`);
    return event;
  }

  async save(status, error) {
    await mkdir(this.artifactDir, { recursive: true });
    await writeFile(resolve(this.artifactDir, "agent-trace.json"), JSON.stringify({
      runId: this.runId,
      status,
      goal: this.goal,
      events: this.events,
      error: error?.message,
    }, null, 2));
  }
}

async function dismissOrdinaryPopup(page) {
  const buttons = [
    page.getByRole("button", { name: /dismiss sign-in info/i }),
    page.locator('button[aria-label*="Dismiss"]'),
    page.getByRole("button", { name: /not now|maybe later|close/i }),
  ];
  for (const controls of buttons) {
    for (let index = 0; index < Math.min(await controls.count(), 8); index += 1) {
      const button = controls.nth(index);
      if (await button.isVisible().catch(() => false)) {
        if (await button.click({ timeout: 2_000 }).then(() => true).catch(() => false)) return true;
      }
    }
  }
  return false;
}

async function overlay(page, title, detail, tone = "#0b6f5b") {
  await page.evaluate(({ title, detail, tone }) => {
    document.querySelector("#staypilot-agent-overlay")?.remove();
    const panel = document.createElement("aside");
    panel.id = "staypilot-agent-overlay";
    panel.setAttribute("aria-label", "StayPilot agent status");
    Object.assign(panel.style, {
      position: "fixed", top: "18px", right: "18px", zIndex: "2147483647", width: "370px",
      padding: "16px 18px", borderRadius: "14px", background: "#fff", color: "#102a2e",
      border: `3px solid ${tone}`, boxShadow: "0 16px 50px rgba(0,0,0,.28)",
      font: "14px/1.45 system-ui, sans-serif",
    });
    const heading = document.createElement("strong");
    Object.assign(heading.style, { display: "block", color: tone, fontSize: "16px", marginBottom: "6px" });
    heading.textContent = title;
    const body = document.createElement("span");
    body.textContent = detail;
    panel.append(heading, body);
    (document.body || document.documentElement)?.append(panel);
  }, { title, detail, tone });
}

function observeRenderedPropertyText({ headingText = "", addressOnly = false }) {
  const excluded = 'nav, footer, [role="navigation"], [aria-hidden="true"], #staypilot-agent-overlay, [itemprop="review"], [data-testid*="review" i], [class*="review" i]';
  const visibleText = (element) => {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
    const text = [];
    while (walker.nextNode()) {
      const parent = walker.currentNode.parentElement;
      if (!parent || parent.closest(excluded)) continue;
      let hidden = false;
      for (let ancestor = parent; ancestor; ancestor = ancestor.parentElement) {
        const style = getComputedStyle(ancestor);
        if (style.display === "none" || style.visibility === "hidden" || style.visibility === "collapse" || Number(style.opacity) === 0 || style.contentVisibility === "hidden") { hidden = true; break; }
      }
      if (hidden) continue;
      // display:contents parents have no box, even when their text is visibly rendered.
      const range = document.createRange();
      range.selectNodeContents(walker.currentNode);
      if ([...range.getClientRects()].some((rect) => rect.width > 0 && rect.height > 0)) text.push(walker.currentNode.textContent);
    }
    return text.join(" ").replace(/\s+/g, " ").trim();
  };
  const address = [...document.querySelectorAll('.hp_address_subtitle, [data-testid="address"], [data-testid*="PropertyAddress"], [itemprop="address"], address')].map(visibleText).find(Boolean) || "";
  if (addressOnly) return { address };
  const heading = [...document.querySelectorAll("h1, h2")].find((element) => visibleText(element) === headingText.trim());
  const top = heading?.getBoundingClientRect().top ?? 0;
  const seen = new Set();
  const nodes = [];
  const candidateDiagnostics = [];
  for (const element of document.querySelectorAll("address, p, span, a, div, button")) {
    const range = document.createRange();
    range.selectNodeContents(element);
    const rect = element.getClientRects().length ? element.getBoundingClientRect() : range.getBoundingClientRect();
    if (candidateDiagnostics.length < 6 && /\b\d{6}\b/.test(element.textContent) && element.textContent.length < 500) {
      candidateDiagnostics.push({ tag: element.tagName.toLowerCase(), text: element.textContent.trim().slice(0, 200), rendered: visibleText(element), top: rect.top, height: rect.height, anchorTop: top, excluded: Boolean(element.closest(excluded)) });
    }
    if (element.closest(excluded)) continue;
    if (rect.top < top - 60 || rect.top > top + 650 || rect.height > 180) continue;
    const text = visibleText(element);
    if (text.length < 15 || text.length > 700 || seen.has(text)) continue;
    if (/\b(?:guest review|review score|rated by guests|testimonial)\b/i.test(text)) continue;
    seen.add(text);
    nodes.push({ tag: element.tagName.toLowerCase(), id: element.id, className: element.className.toString().slice(0, 160), testId: element.getAttribute("data-testid"), text });
    if (nodes.reduce((sum, node) => sum + node.text.length + 2, 0) >= 5_000 || nodes.length >= 35) break;
  }
  const diagnostics = [];
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  while (walker.nextNode() && diagnostics.length < 10) {
    const text = walker.currentNode.textContent.trim();
    if (!/\bIndia\b/i.test(text) || text.length > 500) continue;
    const element = walker.currentNode.parentElement;
    if (!element) continue;
    const ancestors = [];
    for (let parent = element; parent && ancestors.length < 6; parent = parent.parentElement) {
      const style = getComputedStyle(parent);
      ancestors.push({ tag: parent.tagName.toLowerCase(), className: parent.className.toString().slice(0, 160), testId: parent.getAttribute("data-testid"), display: style.display, visibility: style.visibility, opacity: style.opacity });
    }
    diagnostics.push({ text, exclusion: element.closest(excluded)?.className || null, ancestors });
  }
  return { visibleHeader: nodes.map((node) => node.text).join("\n\n").slice(0, 5_000), nodes, diagnostics, candidateDiagnostics };
}

export class BrowserToolGateway {
  constructor({ trace, signal, artifactDir, browserDecider = decideBrowserAction, propertyAddressReader = readPropertyAddress }) {
    this.trace = trace;
    this.signal = signal;
    this.artifactDir = artifactDir;
    this.browser = null;
    this.context = null;
    this.page = null;
    this.searchPage = null;
    this.detailPage = null;
    this.chromeProcess = null;
    this.profileDir = null;
    this.profilePrefix = null;
    this.readOnly = false;
    this.allowedHosts = ["booking.com"];
    this.supplier = "booking.com";
    this.supplierMode = "verified-adapter";
    this.universalSearchConfigured = false;
    this.currentCandidate = null;
    this.bookingRecoveryUsed = false;
    this.bookingDestinationSelection = null;
    this.browserDecider = browserDecider;
    this.propertyAddressReader = propertyAddressReader;
    this.searchSkills = new Set();
    this.enteredSearchFields = new Set();
    this.manualSearchDates = new Set();
    this.searchRestarts = 0;
  }

  bindPolicy(goal, policy) {
    if (policy.allowedHosts.length !== 1 || policy.allowedHosts[0] !== goal.supplier
      || policy.maximumTotalInr !== goal.budgetInr || policy.minimumTotalInr !== (goal.budgetMinInr || 0)
      || policy.stopAt !== "guest-details" || policy.currency !== "INR"
      || ["login", "personal-data-entry", "final-booking", "payment"].some((action) => !policy.forbidden.includes(action))) {
      throw new Error("Policy rejected a changed goal or transaction permission.");
    }
    this.runPolicy = Object.freeze({ ...policy, allowedHosts: Object.freeze([...policy.allowedHosts]), forbidden: Object.freeze([...policy.forbidden]) });
  }

  async startSession(goal) {
    ensureActive(this.signal);
    if (this.runPolicy) this.bindPolicy(goal, this.runPolicy);
    const storageIssue = await checkBrowserStorage();
    if (storageIssue) throw new Error(storageIssue);
    this.supplier = normalizeSupplierHost(goal.supplier);
    this.supplierMode = goal.supplierMode;
    this.allowedHosts = [this.supplier];
    this.bookingDestinationSelection = null;
    this.bookingRecoveryUsed = false;
    this.searchRestarts = 0;
    this.searchSkills.clear();
    this.enteredSearchFields.clear();
    this.manualSearchDates.clear();
    const session = await launchAttachedChrome();
    ({ browser: this.browser, context: this.context, page: this.page, chromeProcess: this.chromeProcess, profileDir: this.profileDir, profilePrefix: this.profilePrefix } = session);
    this.searchPage = this.page;
    await this.context.route("**/*", async (route) => {
      const request = route.request();
      if (request.isNavigationRequest()) {
        try { assertAllowedUrl(request.url(), this.allowedHosts); } catch { return route.abort(); }
      }
      return route.fallback();
    });
    this.signal.addEventListener("abort", () => this.close(), { once: true });
    if (this.signal.aborted) { await this.close(); throw abortError(); }
    return this.page;
  }

  assertWritable() {
    ensureActive(this.signal);
    if (this.readOnly) throw new Error("Policy blocked browser interaction after the checkout boundary.");
  }

  async search(goal) {
    this.assertWritable();
    const url = bookingEntryUrl(goal);
    assertAllowedUrl(url, this.allowedHosts);
    await this.page.goto(url, { waitUntil: "domcontentloaded", timeout: 60_000 });
    await this.page.waitForTimeout(1_500);
    await this.recoverBookingTemporaryFailure();
    await dismissOrdinaryPopup(this.page);
    assertAllowedUrl(this.page.url(), this.allowedHosts);
    if (this.browserDecider) {
      await this.searchWithAI(goal);
    } else if (this.supplier === "booking.com" && isBookingLandingPage(this.page.url())) {
      await this.configureBookingSearch(goal);
    } else if (this.supplierMode === "universal-computer-use" && new URL(url).pathname === "/") {
      await this.configureUniversalSearch(goal);
    } else {
      this.universalSearchConfigured = this.supplierMode === "universal-computer-use";
    }
    await overlay(this.page, "SearchAgent", `Reading ${this.supplier}’s live page and visible inventory.`);
    return safeUrlForTrace(this.page.url());
  }

  async searchWithAI(goal) {
    this.searchSkills.clear();
    this.enteredSearchFields.clear();
    this.manualSearchDates.clear();
    return runBrowserActionLoop({
      goal, decide: this.browserDecider, trace: this.trace, signal: this.signal,
      observe: async () => {
        const observation = await observeBrowserControls(this.page, this.allowedHosts);
        try {
          const humanVerification = classifySearchFailure(observation.pageText) === "human-verification";
          const protectedBoundary = await this.protectedCheckoutVisible();
          const verified = this.supplier === "booking.com" && !humanVerification && !protectedBoundary
            ? await this.readBookingSearchState(goal) : { verified: false, observed: {} };
          if (verified.observed.temporaryFailure && this.bookingRecoveryUsed) {
            throw supplierUiUnavailable("Booking.com is temporarily unavailable (502) after one visible retry. Please try again shortly.");
          }
          if (this.supplier === "booking.com") {
            for (const [field, ready] of Object.entries(bookingFieldReadiness(verified.observed, goal, this.bookingDestinationSelection))) {
              if (ready && this.enteredSearchFields.has(field)) this.searchSkills.add(field); else this.searchSkills.delete(field);
            }
            if (!verified.verified) this.searchSkills.delete("submit");
          }
          const pendingSkills = ["destination", "dates", "occupancy"].filter((field) => !this.searchSkills.has(field));
          return { ...observation, humanVerification, protectedBoundary, searchVerified: verified.verified && ["destination", "dates", "occupancy", "submit"].every((field) => this.searchSkills.has(field)),
            searchState: verified.observed, completedSkills: [...this.searchSkills],
            availableSkills: this.supplier === "booking.com" && !verified.observed.temporaryFailure ? [...(pendingSkills.length ? pendingSkills : ["submit"]),
              ...(this.searchRestarts < 1 && /^\/(?:city|district)\//.test(new URL(this.page.url()).pathname) ? ["restart"] : [])] : [],
          };
        } catch (error) { await observation.dispose(); throw error; }
      },
      execute: async (decision, observation) => {
        this.assertWritable();
        if (await this.protectedCheckoutVisible()) { this.readOnly = true; throw new Error("Policy blocked search at guest details."); }
        if (decision.action === "restart") {
          if (this.searchRestarts >= 1) throw new Error("The bounded supplier homepage restart was already used.");
          this.searchRestarts++;
          await this.page.goto(bookingEntryUrl(goal), { waitUntil: "domcontentloaded", timeout: 60000 });
          this.bookingDestinationSelection = null;
          this.searchSkills.clear();
          this.enteredSearchFields.clear();
          this.manualSearchDates.clear();
          await dismissOrdinaryPopup(this.page);
          return;
        }
        if (["destination", "dates", "occupancy", "submit"].includes(decision.action)) {
          if (this.supplier !== "booking.com") throw new Error("This supplier has no verified form skill. Use observed controls or stop.");
          if (decision.action === "destination") await this.configureBookingDestination(goal);
          if (decision.action === "dates") await this.configureBookingDates(goal);
          if (decision.action === "occupancy") await this.configureBookingOccupancy(goal);
          if (decision.action === "submit") {
            const current = await this.readBookingSearchState(goal);
            if (!Object.entries(bookingFieldReadiness(current.observed, goal, this.bookingDestinationSelection)).every(([field, ready]) => ready && this.enteredSearchFields.has(field))) throw new Error("Enter and verify destination, dates and occupancy before submitting.");
            await this.submitBookingSearch(goal, 1);
          }
          this.searchSkills.add(decision.action);
          if (["destination", "dates", "occupancy"].includes(decision.action)) this.enteredSearchFields.add(decision.action);
          return;
        }
        if (decision.action === "wait") return this.page.waitForTimeout(750);
        const checked = validateBrowserAction(decision, observation, goal);
        const handle = observation.targets.get(decision.target);
        await assertObservedControl(handle, checked.control);
        if ((decision.action === "click" || (decision.action === "press" && decision.key === "Enter"))
          && /^try again$/i.test(checked.control.name.trim()) && await this.recoverBookingTemporaryFailure()) return;
        if (checked.control.formSubmission || /^search$/i.test(checked.control.name.trim())) {
          const current = await this.readBookingSearchState(goal);
          if (!Object.entries(bookingFieldReadiness(current.observed, goal, this.bookingDestinationSelection)).every(([field, ready]) => ready && this.enteredSearchFields.has(field))) throw new Error("Search is blocked until all requested fields have been visibly verified.");
          if (this.supplier === "booking.com") {
            await this.submitBookingSearch(goal, 1);
            this.searchSkills.add("submit");
            return;
          }
        }
        let suggestion;
        if ((decision.action === "click" || (decision.action === "press" && decision.key === "Enter")) && (checked.control.role === "option" || /autocomplete/.test(checked.control.metadata))) {
          suggestion = await handle.innerText();
          if (chooseBookingSuggestion([suggestion], goal) !== 0) throw new Error("The observed suggestion does not match the requested hotel and location.");
        }
        if (decision.action === "fill") await handle.fill(checked.value, { timeout: 4000 });
        if (decision.action === "select") await handle.selectOption(checked.value, { timeout: 4000 });
        if (decision.action === "click") await handle.click({ timeout: 4000, noWaitAfter: true });
        if (decision.action === "press") await handle.press(decision.key, { timeout: 4000 });
        await this.page.waitForTimeout(500);
        assertAllowedUrl(this.page.url(), this.allowedHosts);
        if (suggestion) {
          const current = await this.readBookingSearchState(goal);
          const matches = goal.hotelName ? hotelNameMatchScore(current.observed.destination, goal.hotelName, goal.destination) === 1 : bookingDestinationMatches(current.observed.destination, goal.destination);
          if (!matches) throw new Error("The supplier did not retain the selected destination.");
          this.bookingDestinationSelection = { value: current.observed.destination, text: suggestion };
          this.enteredSearchFields.add("destination");
        }
        if (decision.action === "click" || (decision.action === "press" && decision.key === "Enter")) {
          const selectedDate = checked.control.date || [goal.checkIn, goal.checkOut].find((date) => bookingDateLabelPattern(date).test(checked.control.name));
          if ([goal.checkIn, goal.checkOut].includes(selectedDate)) this.manualSearchDates.add(selectedDate);
          if (this.manualSearchDates.size === 2) this.enteredSearchFields.add("dates");
          if (/increase|decrease|^[+−-]$/i.test(checked.control.name) && /adults|rooms/i.test(checked.control.context)) this.enteredSearchFields.add("occupancy");
        }
        if (["fill", "select"].includes(decision.action) && ["adults", "rooms"].includes(decision.field)) this.enteredSearchFields.add("occupancy");
        if (["fill", "select"].includes(decision.action) && ["checkIn", "checkOut"].includes(decision.field)) {
          this.manualSearchDates.add(goal[decision.field]);
          if (this.manualSearchDates.size === 2) this.enteredSearchFields.add("dates");
        }
      },
    });
  }

  async recoverBookingTemporaryFailure(agent = "SearchAgent") {
    if (this.supplier !== "booking.com") return false;
    const pageText = await this.page.locator("body").innerText().catch(() => "");
    if (!isBookingTemporaryFailure(pageText)) return false;
    if (this.bookingRecoveryUsed) {
      throw supplierUiUnavailable("Booking.com is temporarily unavailable (502) after one visible retry. Please try again shortly.");
    }
    const retry = this.page.getByRole("button", { name: /^try again$/i }).first();
    if (!await retry.isVisible().catch(() => false)) {
      throw supplierUiUnavailable("Booking.com is temporarily unavailable (502) and did not expose a visible retry control.");
    }
    this.bookingRecoveryUsed = true;
    this.trace.emit(agent, "supplier.retry", "Booking.com returned a temporary 502 page; waiting and using its visible Try again control once", { url: safeUrlForTrace(this.page.url()) });
    await this.page.waitForTimeout(2_000);
    ensureActive(this.signal);
    await retry.click({ timeout: 8_000, noWaitAfter: true });
    // The old error document may already be loaded; wait for the actual retry outcome, including SPA recovery.
    const deadline = Date.now() + 15_000;
    let retriedText = "";
    do {
      ensureActive(this.signal);
      retriedText = await this.page.locator("body").innerText({ timeout: 1_000 }).catch(() => "");
      if (retriedText.trim() && !isBookingTemporaryFailure(retriedText)) break;
      await this.page.waitForTimeout(250);
    } while (Date.now() < deadline);
    ensureActive(this.signal);
    if (!retriedText.trim() || isBookingTemporaryFailure(retriedText)) {
      throw supplierUiUnavailable("Booking.com is temporarily unavailable (502) after one visible retry. Please try again shortly.");
    }
    assertAllowedUrl(this.page.url(), this.allowedHosts);
    return true;
  }

  async configureBookingDestination(goal) {
    this.searchSkills.delete("submit");
    this.bookingDestinationSelection = null;
    const destination = this.page.locator('input[name="ss"]:visible, input[placeholder*="Where are you going" i]:visible').first();
    const destinationVisible = await destination.waitFor({ state: "visible", timeout: 15_000 }).then(() => true).catch(() => false);
    if (!destinationVisible) {
      throw supplierUiUnavailable("Booking.com did not expose its destination field. No direct-URL recovery was used.");
    }
    await this.page.keyboard.press("Escape").catch(() => {});
    await dismissOrdinaryPopup(this.page);
    const suggestions = this.page.locator('[data-testid="autocomplete-result"]:visible, [role="listbox"] [role="option"]:visible, [data-testid*="autocomplete"] li:visible, [id*="autocomplete"] li:visible')
      .filter({ hasNot: this.page.locator('[data-testid="autocomplete-icon-search-history"]') });
    const searchGoals = goal.hotelName ? [goal, { ...goal, hotelName: undefined }] : [goal];
    for (const searchGoal of searchGoals) {
      const cityFallback = searchGoal !== goal;
      if (cityFallback) this.trace.emit("SearchAgent", "destination.city_search", "The supplier did not confirm the named hotel suggestion; searching the requested city and retaining the exact hotel requirement", { destination: goal.destination, requestedHotel: goal.hotelName });
      const primaryPlace = searchGoal.destination.split(",")[0].trim();
      const alias = Object.entries(LOCATION_ALIASES).find(([, canonical]) => canonical === normalizedLocationName(primaryPlace))?.[0];
      const terms = [...new Set(searchGoal.hotelName
        ? [bookingSearchText(searchGoal), searchGoal.hotelName]
        : [primaryPlace, alias && alias[0].toUpperCase() + alias.slice(1), searchGoal.destination].filter(Boolean))];
      for (let attempt = 0; attempt < 2; attempt += 1) {
        for (const term of terms) {
          ensureActive(this.signal);
          await destination.focus();
          await destination.fill("");
          await destination.pressSequentially(term, { delay: 35 });
          const deadline = Date.now() + 6_000;
          let texts = [];
          while (Date.now() < deadline) {
            ensureActive(this.signal);
            texts = await suggestions.allInnerTexts().catch(() => []);
            const index = chooseBookingSuggestion(texts, searchGoal);
            if (index !== -1) {
              if (this.artifactDir) {
                await mkdir(this.artifactDir, { recursive: true });
                await writeFile(resolve(this.artifactDir, "destination-observation.json"), JSON.stringify({
                  query: term, url: safeUrlForTrace(this.page.url()), text: texts[index],
                  markup: await suggestions.nth(index).evaluate((element) => element.outerHTML.slice(0, 8000)),
                }, null, 2));
              }
              await suggestions.nth(index).click({ timeout: 5_000 });
              await this.page.waitForTimeout(400);
              const value = await destination.inputValue().catch(() => "");
              const retained = searchGoal.hotelName ? hotelNameMatchScore(value, searchGoal.hotelName, searchGoal.destination) === 1 : bookingDestinationMatches(value, searchGoal.destination);
              if (retained) {
                this.bookingDestinationSelection = { value, text: texts[index], ...(cityFallback ? { mode: "city" } : {}) };
                this.trace.emit("SearchAgent", "destination.confirmed", "Selected and confirmed the requested destination on the supplier page", { destination: value, suggestion: texts[index], requestedHotel: goal.hotelName || null, searchMode: cityFallback ? "city" : goal.hotelName ? "hotel" : "city" });
                return;
              }
              this.trace.emit("SearchAgent", "destination.selection_rejected", "The supplier did not retain a matching destination after the suggestion click", { query: term, suggestion: texts[index], retainedValue: value });
              break;
            }
            await this.page.waitForTimeout(250);
          }
          this.trace.emit("SearchAgent", "destination.retry", "Checking another spelling in the supplier's destination suggestions", { query: term, suggestions: texts.slice(0, 8) });
        }
        if (attempt === 0) {
          this.trace.emit("SearchAgent", "supplier.retry", "The destination was not confirmed; retrying the visible destination field once");
          await dismissOrdinaryPopup(this.page);
        }
      }
    }
    throw supplierUiUnavailable(`The destination suggestion for ${goal.hotelName || goal.destination} could not be confirmed. Please try again shortly.`);
  }

  async configureBookingSearch(goal, attempt = 0) {
    await this.configureBookingDestination(goal);
    await this.configureBookingDates(goal);
    await this.configureBookingOccupancy(goal);
    await this.submitBookingSearch(goal, attempt);
  }

  async configureBookingDates(goal) {
    this.searchSkills.delete("submit");
    const dateTriggers = [
      this.page.locator('[data-testid="searchbox-dates-container"]').first(),
      this.page.locator('[data-testid="date-display-field-start"]').first(),
      this.page.locator('button[data-testid*="date-display"], button[aria-label*="check-in" i], button[aria-label*="select dates" i]').first(),
      this.page.getByRole("button", { name: /select dates|check-in date|check-out date/i }).first(),
    ];
    let dateTrigger = dateTriggers[0];
    const calendarVisible = async (date = goal.checkIn) => await this.page.locator('[data-date]:visible, [data-testid="searchbox-datepicker-calendar"]:visible').first().isVisible().catch(() => false)
      || await this.page.getByRole("checkbox", { name: bookingDateLabelPattern(date) }).first().isVisible().catch(() => false)
      || await this.page.getByRole("button", { name: bookingDateLabelPattern(date) }).first().isVisible().catch(() => false);
    const openCalendar = async () => {
      if (await calendarVisible()) return true;
      for (const trigger of dateTriggers) {
        if (!await trigger.isVisible().catch(() => false)) continue;
        dateTrigger = trigger;
        await this.page.keyboard.press("Escape").catch(() => {});
        await dismissOrdinaryPopup(this.page);
        await trigger.click({ timeout: 5_000 }).catch(() => {});
        await this.page.waitForTimeout(750);
        if (await calendarVisible()) return true;
        await trigger.focus().catch(() => {});
        await trigger.press("Enter").catch(() => {});
        await this.page.waitForTimeout(750);
        if (await calendarVisible()) return true;
      }
      return false;
    };
    if (!await openCalendar()) {
      throw supplierUiUnavailable("Booking.com did not open its visible date picker.");
    }
    for (const date of [goal.checkIn, goal.checkOut]) {
      if (!await calendarVisible(date) && !await openCalendar()) throw supplierUiUnavailable("Booking.com closed its visible date picker before both dates were selected.");
      let selected = false;
      for (let month = 0; month < 18; month += 1) {
        let day = this.page.locator(`[data-date="${date}"]:visible`).first();
        if (!await day.isVisible().catch(() => false)) day = this.page.getByRole("checkbox", { name: bookingDateLabelPattern(date) }).first();
        if (!await day.isVisible().catch(() => false)) day = this.page.getByRole("button", { name: bookingDateLabelPattern(date) }).first();
        if (await day.isVisible().catch(() => false)) {
          await day.click({ timeout: 5_000 });
          selected = true;
          break;
        }
        let nextMonth = this.page.locator('button[aria-label*="next month" i]:visible, button[data-testid*="calendar-next" i]:visible').first();
        if (!await nextMonth.isVisible().catch(() => false)) nextMonth = this.page.getByRole("button", { name: /next month/i }).first();
        if (!await nextMonth.isVisible().catch(() => false)) break;
        await nextMonth.click({ timeout: 5_000 }).catch(() => nextMonth.click({ timeout: 5_000, force: true }));
        await this.page.waitForTimeout(250);
      }
      if (!selected) throw supplierUiUnavailable(`Booking.com did not expose ${date} in its visible date picker.`);
    }
    const dateSummary = await this.page.locator('[data-testid="searchbox-dates-container"]:visible, [data-testid="date-display-field-start"]:visible, [data-testid="date-display-field-end"]:visible').allInnerTexts()
      .then((values) => values.join(" "))
      .catch(() => dateTrigger.innerText().catch(() => ""));
    if (!bookingDateSummaryMatches(dateSummary, goal.checkIn, goal.checkOut)) {
      throw supplierUiUnavailable("Booking.com did not retain the requested check-in and check-out dates.");
    }
    this.trace.emit("SearchAgent", "dates.confirmed", "Confirmed the requested check-in and check-out dates", { checkIn: goal.checkIn, checkOut: goal.checkOut });
  }

  async configureBookingOccupancy(goal) {
    this.searchSkills.delete("submit");
    const occupancy = this.page.locator('[data-testid="occupancy-config"]').first();
    if (!await occupancy.isVisible().catch(() => false)) {
      throw supplierUiUnavailable("Booking.com did not expose its adults and rooms control.");
    }
    const current = parseBookingOccupancySummary(await occupancy.innerText().catch(() => ""));
    if (current.adults !== goal.adults || current.rooms !== goal.rooms) {
      await occupancy.click({ timeout: 5_000 });
      await this.setBookingCounter("Adults", current.adults, goal.adults);
      await this.setBookingCounter("Rooms", current.rooms, goal.rooms);
      const updatedText = await occupancy.getAttribute("aria-label").catch(() => null) || await occupancy.innerText().catch(() => "");
      const updated = parseBookingOccupancySummary(updatedText);
      if (updated.adults !== goal.adults || updated.rooms !== goal.rooms) {
        throw supplierUiUnavailable("Booking.com did not retain the requested adults and rooms.");
      }
      const done = this.page.getByRole("button", { name: /^done$/i }).first();
      if (await done.isVisible().catch(() => false)) await done.click({ timeout: 5_000 });
    }
    this.trace.emit("SearchAgent", "occupancy.confirmed", "Confirmed the requested adults and rooms", { adults: goal.adults, rooms: goal.rooms });
  }

  async submitBookingSearch(goal, attempt = 0) {
    const { observed: fields } = await this.readBookingSearchState(goal);
    if (!bookingFieldReadiness(fields, goal, this.bookingDestinationSelection).destination) await this.configureBookingDestination(goal);

    const submit = this.page.getByRole("button", { name: /^search$/i }).first();
    if (!await submit.waitFor({ state: "visible", timeout: 10_000 }).then(() => true).catch(() => false)) {
      throw supplierUiUnavailable("Booking.com did not expose its Search button.");
    }
    await this.page.keyboard.press("Escape").catch(() => {});
    await dismissOrdinaryPopup(this.page);
    const { observed: currentFields } = await this.readBookingSearchState(goal);
    if (!Object.values(bookingFieldReadiness(currentFields, goal, this.bookingDestinationSelection)).every(Boolean)) {
      throw supplierUiUnavailable("Booking.com changed or cleared a requested field before Search. Re-enter and verify the trip fields before submitting.");
    }
    // Wait for an unobstructed control, not for the supplier's long-lived navigation requests.
    await submit.click({ timeout: 8_000, noWaitAfter: true });
    await this.page.waitForTimeout(350);
    let { verified: submissionVerified, observed } = await this.verifyBookingSearch(goal);
    let recovered = false;
    if (!submissionVerified && observed.temporaryFailure) {
      recovered = await this.recoverBookingTemporaryFailure();
      ({ verified: submissionVerified, observed } = await this.verifyBookingSearch(goal));
      if (submissionVerified) this.trace.emit("SearchAgent", "supplier.recovered", "Verified the requested trip fields and search results after the supplier's visible retry");
    }
    if (!submissionVerified) {
      if (this.artifactDir) {
        await mkdir(this.artifactDir, { recursive: true });
        await this.page.screenshot({ path: resolve(this.artifactDir, "search-failure.png"), fullPage: false }).catch(() => {});
        await writeFile(resolve(this.artifactDir, "search-observation.json"), JSON.stringify({
          url: safeUrlForTrace(this.page.url()), observed,
          pageText: await this.page.locator("body").innerText().catch(() => ""),
          buttons: await this.page.getByRole("button").allInnerTexts().catch(() => []),
          forms: await this.page.locator("form").evaluateAll((forms) => forms.map((form) => ({
            action: form.action, method: form.method,
            searchFields: [...form.querySelectorAll('input[name="ss"], input[name="checkin"], input[name="checkout"], input[name="dest_id"], input[name="dest_type"]')].map((input) => ({ name: input.name, value: input.value })),
          }))).catch(() => []),
        }, null, 2));
      }
      const fieldsReady = Object.values(bookingFieldReadiness(observed, goal, this.bookingDestinationSelection)).every(Boolean);
      const failure = fieldsReady && !observed.searchOutcomeVisible
        ? "Booking.com retained the trip fields but did not show verified search results."
        : "Booking.com did not retain matching search fields and results.";
      const reason = recovered ? `Booking.com recovered from its temporary 502 page, but ${failure.replace(/^Booking.com /, "")}` : failure;
      this.trace.emit("SearchAgent", "supplier.validation_failed", reason, {
        url: safeUrlForTrace(this.page.url()),
        expected: { destination: goal.destination, checkIn: goal.checkIn, checkOut: goal.checkOut, adults: goal.adults, rooms: goal.rooms },
        observed,
      });
      const pageText = await this.page.locator("body").innerText().catch(() => "");
      if (classifySearchFailure(pageText) === "human-verification") throw new Error("Booking.com requested human verification, so the search has paused.");
      const destinationVisible = await this.page.locator('input[name="ss"]:visible').first().isVisible().catch(() => false);
      if (attempt === 0 && destinationVisible) {
        this.trace.emit("SearchAgent", "supplier.retry", "The supplier reset part of the search; restoring the requested fields and searching once more");
        if (/^\/(?:city|district)\//.test(new URL(this.page.url()).pathname)) {
          // Static destination landing pages use a different form; restart through the homepage UI.
          await this.page.goto(bookingEntryUrl(goal), { waitUntil: "domcontentloaded", timeout: 60_000 });
          await dismissOrdinaryPopup(this.page);
        }
        return this.configureBookingSearch(goal, 1);
      }
      throw supplierUiUnavailable(reason + " No direct-URL recovery was used.");
    }
    await dismissOrdinaryPopup(this.page);
    assertAllowedUrl(this.page.url(), this.allowedHosts);
  }

  async verifyBookingSearch(goal) {
    const deadline = Date.now() + 20_000;
    let observed = {};
    do {
      ensureActive(this.signal);
      assertAllowedUrl(this.page.url(), this.allowedHosts);
      const current = await this.readBookingSearchState(goal);
      observed = current.observed;
      if (current.verified || observed.temporaryFailure) return current;
      await this.page.waitForTimeout(300);
    } while (Date.now() < deadline);
    return { verified: false, observed };
  }

  async readBookingSearchState(goal) {
    const occupancy = this.page.locator('[data-testid="occupancy-config"]:visible').first();
    const cardsVisible = await this.page.locator('[data-testid="property-card"]:visible').first().isVisible().catch(() => false);
    const pageText = cardsVisible ? "" : await this.page.locator("body").innerText().catch(() => "");
    if (classifySearchFailure(pageText) === "human-verification") throw new Error("Booking.com requested human verification, so the search has paused.");
    if (isBookingTemporaryFailure(pageText)) {
      return { verified: false, observed: { destination: "", dateSummary: "", occupancy: "", searchOutcomeVisible: false, temporaryFailure: "502" } };
    }
    const observed = {
      destination: await this.page.locator('input[name="ss"]:visible, input[placeholder*="Where are you going" i]:visible').first().inputValue({ timeout: 1000 }).catch(() => ""),
      dateSummary: await this.page.locator('[data-testid="searchbox-dates-container"]:visible, [data-testid="date-display-field-start"]:visible, [data-testid="date-display-field-end"]:visible').allInnerTexts().then((values) => values.join(" ")).catch(() => ""),
      occupancy: await occupancy.innerText({ timeout: 1000 }).catch(() => ""),
      searchOutcomeVisible: cardsVisible || classifySearchFailure(pageText) === "no-results",
    };
    if (bookingFieldReadiness(observed, goal, this.bookingDestinationSelection).destination) observed.destinationContext = this.bookingDestinationSelection.text;
    const parameters = new URL(this.page.url()).searchParams;
    const expected = { checkin: goal.checkIn, checkout: goal.checkOut, group_adults: String(goal.adults), no_rooms: String(goal.rooms) };
    const noUrlConflicts = Object.entries(expected).every(([key, value]) => !parameters.has(key) || parameters.get(key) === value);
    const searchText = parameters.get("ss");
    const noDestinationConflict = !searchText || bookingDestinationMatches(searchText, goal.destination)
      || (Boolean(goal.hotelName) && hotelNameMatchScore(searchText, goal.hotelName, goal.destination) === 1);
    return { observed, verified: noUrlConflicts && noDestinationConflict && bookingVisibleSearchStateMatches(observed, goal) };
  }

  async setBookingCounter(label, current, target) {
    if (!Number.isInteger(current)) throw new Error(`Booking.com did not expose the current ${label.toLowerCase()} count.`);
    const controlId = bookingOccupancyControlId(label);
    const range = controlId ? this.page.locator(`input#${controlId}`).first() : null;
    if (range && await range.count()) {
      current = Number(await range.getAttribute("aria-valuenow"));
      const buttons = range.locator("xpath=following-sibling::button");
      if (!Number.isInteger(current) || await buttons.count() < 2) throw new Error(`Booking.com did not expose the ${label.toLowerCase()} controls.`);
      for (let value = current; value > target; value -= 1) await buttons.first().click({ timeout: 5_000 });
      for (let value = current; value < target; value += 1) await buttons.last().click({ timeout: 5_000 });
      if (Number(await range.getAttribute("aria-valuenow")) !== target) throw new Error(`Booking.com did not retain the requested ${label.toLowerCase()} count.`);
      return;
    }
    let decrease = this.page.getByRole("button", { name: new RegExp(`Decrease number of ${label}`, "i") }).first();
    let increase = this.page.getByRole("button", { name: new RegExp(`Increase number of ${label}`, "i") }).first();
    if (!await decrease.count() || !await increase.count()) {
      const labelNode = this.page.getByText(new RegExp(`^${label}$`, "i")).first();
      const row = labelNode.locator("xpath=..").locator("xpath=..");
      const buttons = row.getByRole("button");
      decrease = buttons.first();
      increase = buttons.last();
    }
    for (let value = current; value > target; value -= 1) await decrease.click({ timeout: 5_000 });
    for (let value = current; value < target; value += 1) await increase.click({ timeout: 5_000 });
  }

  async configureUniversalSearch(goal) {
    const searchText = bookingSearchText(goal);
    const destinationInputs = [
      this.page.getByRole("textbox", { name: /destination|where|city|hotel|location|going to/i }),
      this.page.locator('input[placeholder*="destination" i], input[placeholder*="where" i], input[placeholder*="city" i], input[placeholder*="hotel" i], input[name*="destination" i], input[name*="location" i]'),
    ];
    let destinationSet = false;
    for (const inputs of destinationInputs) {
      const count = Math.min(await inputs.count(), 8);
      for (let index = 0; index < count; index += 1) {
        const input = inputs.nth(index);
        if (!await input.isVisible().catch(() => false)) continue;
        await input.fill(searchText).catch(() => {});
        destinationSet = true;
        break;
      }
      if (destinationSet) break;
    }
    if (!destinationSet) throw new Error(`${this.supplier} did not expose a recognizable destination search field for the universal route.`);

    const dateInputs = this.page.locator('input[type="date"], input[name*="checkin" i], input[name*="checkout" i], input[aria-label*="check-in" i], input[aria-label*="check-out" i]');
    const visibleDates = [];
    for (let index = 0; index < Math.min(await dateInputs.count(), 8); index += 1) {
      const input = dateInputs.nth(index);
      if (await input.isVisible().catch(() => false)) visibleDates.push(input);
    }
    if (visibleDates[0]) await visibleDates[0].fill(goal.checkIn).catch(() => {});
    if (visibleDates[1]) await visibleDates[1].fill(goal.checkOut).catch(() => {});

    const searchButton = this.page.getByRole("button", { name: /search|find (?:hotels?|stays?|rooms?)|show (?:hotels?|stays?|rooms?)/i }).first();
    if (await searchButton.isVisible().catch(() => false)) await searchButton.click({ timeout: 8_000 });
    else await destinationInputs[0].first().press("Enter").catch(() => this.page.keyboard.press("Enter"));
    await this.page.waitForTimeout(4_000);
    await dismissOrdinaryPopup(this.page);
    assertAllowedUrl(this.page.url(), this.allowedHosts);
    this.universalSearchConfigured = true;
  }

  async applyCheckbox(name) {
    this.assertWritable();
    if (this.supplierMode === "universal-computer-use") return false;
    const checkbox = this.page.getByRole("checkbox", { name }).first();
    if (!await checkbox.isVisible().catch(() => false)) return false;
    await this.page.keyboard.press("Escape").catch(() => {});
    await dismissOrdinaryPopup(this.page);
    try {
      await checkbox.check({ timeout: 2_500 });
    } catch {
      if (!await checkbox.isChecked().catch(() => false)) {
        await checkbox.focus({ timeout: 2_000 }).catch(() => {});
        await checkbox.press("Space", { timeout: 2_000 }).catch(() => {});
      }
    }
    if (!await checkbox.isChecked().catch(() => false)) {
      this.trace.emit("SearchAgent", "filter.unavailable", "The supplier filter could not be confirmed; checking the requested policy against room terms instead");
      return false;
    }
    await this.page.waitForTimeout(1_500);
    return true;
  }

  async observeCandidates(goal, filterEvidence) {
    ensureActive(this.signal);
    if (this.supplierMode === "universal-computer-use") return this.observeUniversalCandidates(goal);
    const cards = this.page.locator('[data-testid="property-card"]');
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        await cards.first().waitFor({ state: "visible", timeout: attempt === 0 ? 45_000 : 30_000 });
        break;
      } catch {
        const recovered = await this.recoverBookingTemporaryFailure();
        if (recovered) continue;
        const pageText = await this.page.locator("body").innerText().catch(() => "");
        const failure = classifySearchFailure(pageText);
        if (failure === "human-verification") {
        throw new Error("The supplier requested human verification, so availability could not be checked.");
        }
        if (failure === "no-results") return [];
        if (attempt === 1) throw new Error("The supplier did not return hotel results after one automatic retry. Please try again shortly.");
        const landingPage = this.supplier === "booking.com" && isBookingLandingPage(this.page.url());
        this.trace.emit("SearchAgent", "supplier.retry", landingPage
          ? "Booking.com returned its landing page; completing the visible search form"
          : "The supplier did not render hotel cards; retrying once with a fresh page load", { url: safeUrlForTrace(this.page.url()) });
        if (landingPage) await this.configureBookingSearch(goal);
        else await this.page.reload({ waitUntil: "domcontentloaded", timeout: 60_000 });
        await this.page.waitForTimeout(1_500);
        await dismissOrdinaryPopup(this.page);
      }
    }
    const citySelection = this.bookingDestinationSelection?.mode === "city";
    const citySearchVerified = goal.hotelName && citySelection ? (await this.readBookingSearchState(goal)).verified : false;
    const selectionGoal = citySelection ? { ...goal, hotelName: undefined } : goal;
    const observedCards = await cards.evaluateAll((elements) => elements.slice(0, 30).map((card, index) => ({
      index,
      text: card.innerText,
      title: card.querySelector('[data-testid="title"]')?.innerText || "",
      priceText: card.querySelector('[data-testid="price-and-discounted-price"]')?.innerText || "",
      taxesText: card.querySelector('[data-testid="taxes-and-charges"]')?.innerText || "",
      ratingText: card.querySelector('[data-testid="review-score"], [data-testid="review-score-link"]')?.innerText || card.querySelector('[aria-label*="guest rating" i], [aria-label*="scored" i]')?.getAttribute("aria-label") || "",
      href: card.querySelector('a[data-testid="title-link"]')?.href || "",
    })));
    const candidates = [];
    for (const { index, text, title, priceText, taxesText, ratingText, href } of observedCards) {
      ensureActive(this.signal);
      const totalInr = displayedTotalInr(priceText, taxesText);
      if (!title || totalInr === null || !href) continue;
      try { assertAllowedUrl(href, this.allowedHosts); } catch { continue; }
      candidates.push({
        index,
        title,
        scopeText: text,
        destinationConfirmed: Boolean(goal.hotelName && this.bookingDestinationSelection
          && hotelNameMatchScore(title, goal.hotelName, goal.destination) === 1
          && chooseBookingSuggestion([this.bookingDestinationSelection.text], selectionGoal) === 0
          && (!citySelection || citySearchVerified)),
        totalInr,
        rating: parseReviewRating(ratingText) ?? genericRating(text),
        priceText,
        taxesText,
        breakfastIncluded: filterEvidence.breakfast || /\bbreakfast included\b/i.test(text),
        freeCancellation: filterEvidence.freeCancellation || /\bfree cancellation\b/i.test(text),
        href,
      });
    }
    if (goal.hotelName) this.trace.emit("SearchAgent", "hotel.matches", "Checked live property names against the requested hotel", {
      requestedHotel: goal.hotelName,
      candidates: candidates.map(({ title, totalInr, destinationConfirmed }) => ({ title, totalInr, destinationConfirmed })),
    });
    return candidates;
  }

  async observeUniversalCandidates(goal) {
    await this.page.waitForTimeout(2_000);
    const pageText = await this.page.locator("body").evaluate((body) => body.innerText.slice(0, 100_000)).catch(() => "");
    if (/captcha|verify (?:that )?you are human|security check|access denied/i.test(pageText)) {
      throw new Error(`${this.supplier} requested human verification, so availability could not be checked.`);
    }
    if (/no (?:properties|results|availability)|couldn['’]t find|can['’]t find|did not match|not found/i.test(pageText)) return [];

    const raw = await this.page.evaluate(() => [...document.querySelectorAll("a[href]")].slice(0, 160).map((link) => {
      const container = link.closest("article, li, [data-testid*='property'], [class*='property'], [class*='hotel'], [class*='card']") || link.parentElement;
      const text = (container?.innerText || link.innerText || "").replace(/\s+/g, " ").trim().slice(0, 1_200);
      const heading = container?.querySelector("h1, h2, h3, h4, [role='heading']")?.textContent || link.innerText || "";
      return { href: link.href, text, title: heading.replace(/\s+/g, " ").trim().slice(0, 160) };
    }));
    const candidates = universalCandidatesFromLinks(raw, this.allowedHosts);
    if (!candidates.length) {
      throw new Error(`${this.supplier} loaded, but the universal route could not prove comparable live hotel prices. Use the default supplier or add a verified adapter for this website.`);
    }
    return candidates;
  }

  async openCandidate(candidate, goal) {
    this.assertWritable();
    await this.returnToSearch();
    this.currentCandidate = candidate;
    let link;
    if (this.supplierMode === "universal-computer-use") {
      assertAllowedUrl(candidate.href, this.allowedHosts);
      const links = this.searchPage.locator("a[href]");
      const index = await links.evaluateAll((elements, href) => elements.findIndex((element) => element.href === href && element.getClientRects().length), candidate.href);
      if (index < 0) throw new Error("The observed property link is no longer visible. No direct-URL recovery was used.");
      link = links.nth(index);
    } else {
      const cards = this.searchPage.locator('[data-testid="property-card"]');
      const index = await cards.evaluateAll((elements, href) => elements.findIndex((element) => element.querySelector('a[data-testid="title-link"]')?.href.split("?")[0] === href.split("?")[0]), candidate.href);
      if (index < 0) throw new Error("The observed property card changed. No direct-URL recovery was used.");
      const card = cards.nth(index);
      const currentTitle = await card.locator('[data-testid="title"]').innerText();
      if (normalizedHotelName(currentTitle) !== normalizedHotelName(candidate.title)) throw new Error("The observed property title changed before selection.");
      link = card.locator('a[data-testid="title-link"]').first();
      await card.evaluate((element) => {
        element.style.outline = "5px solid #0a8f72";
        element.style.outlineOffset = "4px";
        element.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    }
    await mkdir(this.artifactDir, { recursive: true });
    await this.searchPage.screenshot({ path: resolve(this.artifactDir, "01-selected-hotel.png"), fullPage: false });
    const before = this.searchPage.url();
    let openedPage;
    const popupPromise = this.context.waitForEvent("page", { timeout: 20_000 }).then((page) => { openedPage = page; return page; }).catch(() => null);
    const propertyUrl = new URL(candidate.href);
    const navigationPromise = this.searchPage.waitForURL((url) => url.origin === propertyUrl.origin && url.pathname === propertyUrl.pathname, { timeout: 20_000, waitUntil: "commit" }).then(() => null).catch(() => null);
    try {
      await link.click({ timeout: 5_000, noWaitAfter: true });
    } catch {
      if (!openedPage && this.searchPage.url() === before) {
        await dismissOrdinaryPopup(this.searchPage);
        await this.searchPage.keyboard.press("Escape").catch(() => {});
        await link.focus();
        await link.press("Enter");
      }
    }
    this.detailPage = await Promise.race([popupPromise, navigationPromise]);
    this.page = this.detailPage || this.searchPage;
    await this.page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
    await dismissOrdinaryPopup(this.page);
    assertAllowedUrl(this.page.url(), this.allowedHosts);
    await this.recoverBookingTemporaryFailure("RoomAgent");
    const title = await this.page.title();
    const heading = await this.page.locator('h1:visible, h2:visible').allInnerTexts().then((texts) => texts[0] || title).catch(() => title);
    if (hotelNameMatchScore(heading, candidate.title, goal?.destination) !== 1) {
      if (this.artifactDir) await writeFile(resolve(this.artifactDir, "opened-property-mismatch.json"), JSON.stringify({ expected: candidate.title, heading, title, url: safeUrlForTrace(this.page.url()) }, null, 2)).catch(() => {});
      throw new Error("The opened property did not match the observed hotel. No room was selected.");
    }
    if (this.supplier === "booking.com" && goal?.checkIn && goal.checkOut && Number.isInteger(goal.adults) && Number.isInteger(goal.rooms)) {
      const { observed } = await this.readBookingSearchState(goal);
      const occupancy = parseBookingOccupancySummary(observed.occupancy || "");
      const parameters = new URL(this.page.url()).searchParams;
      const expected = { checkin: goal.checkIn, checkout: goal.checkOut, group_adults: String(goal.adults), no_rooms: String(goal.rooms) };
      if (!bookingDateSummaryMatches(observed.dateSummary, goal.checkIn, goal.checkOut) || occupancy.adults !== goal.adults || occupancy.rooms !== goal.rooms
        || Object.entries(expected).some(([key, value]) => parameters.has(key) && parameters.get(key) !== value)) {
        throw supplierUiUnavailable("Booking.com did not retain the requested dates and guests on the property page. No room was selected.");
      }
    }
    let locationEvidence;
    if (this.supplier === "booking.com" && goal?.destination) {
      const addresses = this.page.locator('.hp_address_subtitle, [data-testid="address"], [data-testid*="PropertyAddress"], [itemprop="address"], address');
      await addresses.first().waitFor({ state: "visible", timeout: 3_000 }).catch(() => {});
      ensureActive(this.signal);
      let address = await this.page.evaluate(observeRenderedPropertyText, { addressOnly: true }).then((result) => result.address).catch(() => "");
      if (address) address = address.match(/^[\s\S]*?,\s*India\b/)?.[0] || address;
      if (!address) {
        const visibleHeadings = await this.page.locator("h1:visible, h2:visible").allInnerTexts();
        const propertyHeader = await this.observePropertyHeader(visibleHeadings.find((text) => hotelNameMatchScore(text, candidate.title, goal.destination) === 1) || heading);
        if (this.artifactDir) await writeFile(resolve(this.artifactDir, `property-header-${Number.isInteger(candidate.index) ? candidate.index : 0}.json`), JSON.stringify({
          hotel: candidate.title, ...propertyHeader,
          pageText: (await this.page.locator("body").innerText().catch(() => "")).slice(0, 16_000),
        }, null, 2)).catch(() => {});
        this.trace.emit("RoomAgent", "property.address_observed", "Inspecting bounded visible property-header text because address selectors changed", { hotel: candidate.title, characters: propertyHeader.visibleHeader.length, snippets: propertyHeader.nodes.length });
        if (propertyHeader.visibleHeader) {
          address = await this.propertyAddressReader({ hotel: candidate.title, visibleHeader: propertyHeader.visibleHeader }, { signal: this.signal, onQuotaWait: quotaWaitProgress(this, "RoomAgent") });
          ensureActive(this.signal);
          if (typeof address !== "string" || (address && !propertyHeader.visibleHeader.includes(address))) throw new Error("Policy rejected an ungrounded property address quotation. No room was selected.");
          this.trace.emit("RoomAgent", "property.address_read", address ? "AI extracted an exact quotation from the visible property header" : "No physical address was found in the visible property header", { hotel: candidate.title, address });
        }
      }
      locationEvidence = { ...bookingAddressLocationEvidence(address, goal.destination), address, hotel: candidate.title };
      this.trace.emit("RoomAgent", "property.location", locationEvidence.status === "confirmed"
        ? "The property's visible physical address matches the requested location"
        : "The property's physical location was not confirmed by its visible address", locationEvidence);
      if (locationEvidence.status === "conflict") throw new Error(`The property's visible address is in ${[locationEvidence.city, locationEvidence.region].filter(Boolean).join(", ")}, not the requested ${goal.destination}. No room was selected.`);
      if (locationEvidence.status === "locality-unconfirmed") throw new Error(`The property's visible address does not confirm the requested locality ${goal.destination}. No room was selected.`);
      if (locationEvidence.status !== "confirmed") throw new Error(`The property's visible address does not confirm the requested physical location ${goal.destination}. No room was selected.`);
    }
    await overlay(this.page, "RoomAgent", "Verifying occupancy, included meal plan, cancellation terms, and the full displayed room total.");
    return { title, url: safeUrlForTrace(this.page.url()), locationEvidence };
  }

  async observePropertyHeader(heading) {
    return this.page.evaluate(observeRenderedPropertyText, { headingText: heading });
  }

  async returnToSearch() {
    if (!this.searchPage) return;
    if (this.detailPage) await this.detailPage.close().catch(() => {});
    this.detailPage = null;
    this.page = this.searchPage;
    await this.searchPage.bringToFront().catch(() => {});
  }

  async observeRooms(goal) {
    ensureActive(this.signal);
    if (this.supplierMode === "universal-computer-use") return this.observeUniversalRooms(goal);
    const selects = this.page.locator("select[id^='hprt_nos_select_']");
    const bodyText = await this.page.locator("body").innerText();
    if (/sold out|no availability|not available for (?:your|these|the selected) dates|no rooms available/i.test(bodyText) && !await selects.count()) return [];
    await selects.first().waitFor({ state: "visible", timeout: 45_000 });
    const evidence = await selects.evaluateAll((elements) => elements.map((element, index) => {
        const row = element.closest("tr");
        let capacityRow = row;
        while (capacityRow && !capacityRow.querySelector(".hprt-table-cell-occupancy")) capacityRow = capacityRow.previousElementSibling;
        const capacityCell = capacityRow?.querySelector(".hprt-table-cell-occupancy");
        let typeRow = row;
        while (typeRow && !typeRow.querySelector(".hprt-roomtype-link, .hprt-table-cell-roomtype")) typeRow = typeRow.previousElementSibling;
        return {
          index, selectId: element.id, disabled: element.disabled,
          rowText: row?.innerText || "",
          roomType: typeRow?.querySelector(".hprt-roomtype-link, .hprt-table-cell-roomtype")?.innerText || "",
          capacityText: [capacityCell?.innerText || "", ...Array.from(capacityCell?.querySelectorAll("[title], [aria-label]") || []).map((node) => node.getAttribute("title") || node.getAttribute("aria-label"))].join(" "),
          priceText: row?.querySelector(".bui-price-display__value, .prco-valign-middle-helper, [data-testid='price-and-discounted-price']")?.textContent || "",
          taxesText: row?.querySelector(".prd-taxes-and-fees-under-price, [data-testid='taxes-and-charges']")?.textContent || "",
          options: Array.from(element.options).map((option) => ({ value: option.value, disabled: option.disabled, text: option.textContent })),
        };
    }));
    return evidence.map((row) => bookingRoomEvidence(row, goal)).filter(Boolean);
  }

  async observeUniversalRooms(goal) {
    if (goal.rooms !== 1) throw new Error(`${this.supplier}'s universal route cannot yet verify a multi-room quantity. No room was selected.`);
    const actions = this.page.locator("button, a[href]");
    const rooms = [];
    const count = Math.min(await actions.count(), 80);
    for (let index = 0; index < count; index += 1) {
      const action = actions.nth(index);
      if (!await action.isVisible().catch(() => false)) continue;
      const actionText = (await action.innerText().catch(() => "")).replace(/\s+/g, " ").trim();
      if (!/^(?:select|choose|reserve|book)(?:\s+(?:room|now))?|show rooms?$/i.test(actionText)) continue;
      if (/pay|confirm|complete|purchase|place order|final/i.test(actionText)) continue;
      const rowText = await action.evaluate((element) => {
        const container = element.closest("tr, article, li, [class*='room'], [class*='rate'], [class*='card']") || element.parentElement;
        return (container?.innerText || element.innerText || "").replace(/\s+/g, " ").trim().slice(0, 3_000);
      }).catch(() => "");
      const totalInr = genericInrTotal(rowText) ?? this.currentCandidate?.totalInr ?? null;
      if (totalInr === null) continue;
      const occupancyConfirmed = this.universalSearchConfigured
        || new RegExp(`(?:sleeps?|guests?|adults?)\\s*:?\\s*${goal.adults}|${goal.adults}\\s*(?:guests?|adults?)`, "i").test(rowText);
      rooms.push({
        index,
        totalInr,
        breakfastIncluded: /breakfast included|includes breakfast/i.test(rowText),
        occupancyConfirmed,
        freeCancellation: /free cancellation|fully refundable/i.test(rowText),
        rowText,
        actionText,
      });
    }
    if (!rooms.length) throw new Error(`${this.supplier} did not expose a safe, verifiable room-selection action.`);
    return rooms;
  }

  async selectRoom(room, goal) {
    this.assertWritable();
    if (this.supplierMode === "universal-computer-use") {
      const action = this.page.locator("button, a[href]").nth(room.index);
      await action.click({ timeout: 8_000 });
      await this.page.waitForTimeout(3_000);
      await dismissOrdinaryPopup(this.page);
      assertAllowedUrl(this.page.url(), this.allowedHosts);
      return;
    }
    const selects = this.page.locator("select[id^='hprt_nos_select_']");
    // Clear any supplier-recommended selections so the total contains only the requested quantity.
    for (let index = 0; index < await selects.count(); index += 1) {
      const other = selects.nth(index);
      if (await other.inputValue() !== "0") await other.selectOption("0");
    }
    const select = this.page.locator(`[id=${JSON.stringify(room.selectId)}]`);
    await select.selectOption(room.optionValue);
    if (await select.inputValue() !== String(goal.rooms)) throw new Error("The supplier did not retain the requested room quantity.");
    const refreshed = (await this.observeRooms(goal)).find((current) => current.selectId === room.selectId);
    if (!refreshed) throw new Error("The selected room is no longer available in the requested quantity.");
    return refreshed;
  }

  async verifySelectedRoom(room, goal) {
    this.assertWritable();
    if (this.supplierMode !== "verified-adapter") throw new Error("This provider cannot verify the selected room quantity before checkout.");
    const selects = this.page.locator("select[id^='hprt_nos_select_']");
    let selectedFound = false;
    for (let index = 0; index < await selects.count(); index++) {
      const select = selects.nth(index);
      const isSelected = await select.getAttribute("id") === room.selectId;
      if (await select.inputValue() !== (isSelected ? String(goal.rooms) : "0")) throw new Error("The selected room quantity changed before checkout. No booking was submitted.");
      selectedFound ||= isSelected;
    }
    if (!selectedFound) throw new Error("The selected room disappeared before checkout. No booking was submitted.");
    return (await this.observeRooms(goal)).find((rate) => rate.selectId === room.selectId);
  }

  async continueToGuestDetails() {
    this.assertWritable();
    if (this.supplierMode === "universal-computer-use") return this.continueUniversalToBoundary();
    const safeText = this.page.getByText(/you won['’]t be charged yet/i).first();
    if (!await safeText.isVisible().catch(() => false)) {
      throw new Error("The supplier did not show a clear no-charge checkout message, so the agent stopped.");
    }
    const button = this.page.getByRole("button", { name: /I['’]ll reserve/i }).first();
    await button.waitFor({ state: "visible", timeout: 20_000 });
    await overlay(this.page, "CheckoutAgent", "Opening guest details only. Booking and payment actions remain blocked.", "#9a5b00");
    const before = this.page.url();
    try {
      await button.click({ timeout: 8_000, noWaitAfter: true });
    } catch (error) {
      // A completed navigation can detach the button; never repeat that successful action.
      if (this.page.url() === before && !await this.protectedCheckoutVisible()) {
        await this.page.keyboard.press("Escape").catch(() => {});
        await dismissOrdinaryPopup(this.page);
        if (!await button.isVisible().catch(() => false)) throw error;
        await button.click({ timeout: 8_000, noWaitAfter: true });
      }
    }
    await this.page.waitForURL((url) => url.toString() !== before, { timeout: 60_000, waitUntil: "commit" });
    await this.page.waitForLoadState("domcontentloaded", { timeout: 60_000 });
    assertAllowedUrl(this.page.url(), this.allowedHosts);
    this.readOnly = true;
    return safeUrlForTrace(this.page.url());
  }

  async continueUniversalToBoundary() {
    await overlay(this.page, "CheckoutAgent", "Universal route: moving only toward guest details and stopping before confirmation or payment.", "#9a5b00");
    for (let step = 0; step < 3; step += 1) {
      if (await this.protectedCheckoutVisible()) {
        this.readOnly = true;
        return safeUrlForTrace(this.page.url());
      }
      const actions = this.page.getByRole("button", { name: /continue|reserve|book now|proceed|checkout/i });
      let clicked = false;
      for (let index = 0; index < Math.min(await actions.count(), 12); index += 1) {
        const action = actions.nth(index);
        if (!await action.isVisible().catch(() => false)) continue;
        const label = await action.innerText().catch(() => "");
        if (/pay|confirm|complete|purchase|place order|final/i.test(label)) continue;
        await action.click({ timeout: 8_000 });
        await this.page.waitForTimeout(3_000);
        await dismissOrdinaryPopup(this.page);
        assertAllowedUrl(this.page.url(), this.allowedHosts);
        clicked = true;
        break;
      }
      if (!clicked) break;
    }
    if (!await this.protectedCheckoutVisible()) {
      throw new Error(`${this.supplier} did not expose a safe route to guest details before a transactional action.`);
    }
    this.readOnly = true;
    return safeUrlForTrace(this.page.url());
  }

  async protectedCheckoutVisible() {
    const protectedFields = this.page.locator('input[type="email"]:visible, input[type="tel"]:visible, input[name*="firstname" i]:visible, input[name*="lastname" i]:visible, input[autocomplete="cc-number"]:visible, input[name*="card" i]:visible');
    const heading = this.page.getByText(/enter your details|guest details|traveler details|who['’]s checking in|payment details|secure checkout/i).first();
    return await heading.isVisible().catch(() => false) || await protectedFields.count() >= 2;
  }

  async verifyBoundary(receipt) {
    ensureActive(this.signal);
    assertAllowedUrl(this.page.url(), this.allowedHosts);
    const guestFields = this.page.locator('input[type="email"]:visible, input[name*="firstname" i]:visible, input[name*="lastname" i]:visible, input[type="tel"]:visible, input[autocomplete="cc-number"]:visible, input[name*="card" i]:visible');
    const visibleFields = await guestFields.count();
    const heading = this.page.getByText(/enter your details|your details|guest details|traveler details|payment details|secure checkout/i).first();
    const boundaryVisible = visibleFields > 0 || await heading.isVisible().catch(() => false);
    if (!boundaryVisible) throw new Error("Checkout opened, but the guest-details boundary could not be verified.");
    const pageText = await this.page.locator("body").innerText();
    await mkdir(this.artifactDir, { recursive: true });
    await writeFile(resolve(this.artifactDir, "checkout-observation.json"), JSON.stringify({
      url: safeUrlForTrace(this.page.url()), pageText,
    }, null, 2));
    const summary = bookingCheckoutSummaryEvidence(pageText, receipt);
    await overlay(this.page, "STOP — SafetyAgent locked the browser", "Guest-details stage reached. No personal data, final booking, or payment action will be performed.", "#b42318");
    await this.page.screenshot({ path: resolve(this.artifactDir, "02-booking-boundary.png"), fullPage: false });
    return { ...summary, boundary: "protected-checkout", provider: this.supplier, providerMode: this.supplierMode, url: safeUrlForTrace(this.page.url()), visibleProtectedFields: visibleFields };
  }

  async close() {
    const context = this.context;
    const browser = this.browser;
    const chromeProcess = this.chromeProcess;
    const profileDir = this.profileDir;
    const profilePrefix = this.profilePrefix;
    this.detailPage = null;
    this.searchPage = null;
    this.page = null;
    this.context = null;
    this.browser = null;
    this.chromeProcess = null;
    this.profileDir = null;
    this.profilePrefix = null;
    if (context) await context.close().catch(() => {});
    if (browser) await browser.close().catch(() => {});
    if (chromeProcess && !chromeProcess.killed) chromeProcess.kill();
    if (profileDir && profilePrefix && resolve(profileDir).startsWith(resolve(profilePrefix))) {
      await rm(profileDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(() => {});
    }
  }
}

class IntakeAgent {
  async run(task, context) {
    context.trace.emit("IntakeAgent", "agent.started", "Interpreting noisy language and extracting validated trip details");
    const goal = Object.freeze(await context.intakeParser(task));
    context.trace.goal = safeGoal(goal);
    context.trace.emit("IntakeAgent", "agent.completed", ["gemini", "groq"].includes(goal.intakeSource) ? "AI corrected the request and produced a validated trip goal" : "Produced a validated trip goal with the local fallback", safeGoal(goal));
    return goal;
  }
}

class PolicyAgent {
  async run(goal, context) {
    context.trace.emit("PolicyAgent", "agent.started", "Creating the run policy and tool permissions");
    const policy = {
      allowedHosts: [goal.supplier],
      providerMode: goal.supplierMode,
      currency: "INR",
      minimumTotalInr: goal.budgetMinInr || 0,
      maximumTotalInr: goal.budgetInr,
      stopAt: "guest-details",
      forbidden: ["login", "personal-data-entry", "final-booking", "payment"],
    };
    context.tools.bindPolicy(goal, policy);
    context.trace.emit("PolicyAgent", "agent.completed", "Locked browser tools to the approved supplier and the no-payment boundary", policy);
    return policy;
  }
}

class SearchAgent {
  async run({ goal, lastFailure }, context) {
    context.trace.emit("SearchAgent", "agent.started", `Launching an isolated browser session for ${goal.supplier}`, { provider: goal.supplier, providerMode: goal.supplierMode });
    if (context.sessionStarted && lastFailure?.phase === "search" && context.tools.page
      && /^\/(?:city|district)\//.test(new URL(context.tools.page.url()).pathname)) {
      context.trace.emit("SearchAgent", "supplier.session_retry", "A destination-page redirect stalled the search; retrying the unchanged trip in a fresh isolated session");
      await context.tools.close();
      context.sessionStarted = false;
    }
    if (!context.sessionStarted) {
      await context.tools.startSession(goal);
      context.sessionStarted = true;
    } else await context.tools.returnToSearch();
    const url = await context.tools.search(goal);
    const filterEvidence = {
      breakfast: goal.breakfast ? await context.tools.applyCheckbox(/breakfast included/i) : false,
      freeCancellation: goal.freeCancellation ? await context.tools.applyCheckbox(/free cancellation/i) : false,
    };
    const candidates = await context.tools.observeCandidates(goal, filterEvidence);
    context.trace.emit("SearchAgent", "agent.completed", `Observed ${candidates.length} live candidates on ${goal.supplier}`, { url, provider: goal.supplier, providerMode: goal.supplierMode, filters: filterEvidence, candidateCount: candidates.length });
    return candidates;
  }
}

class RankingAgent {
  async run({ goal, candidates }, context) {
    context.trace.emit("RankingAgent", "agent.started", "Comparing displayed stay totals and requested policies");
    const namedCandidates = goal.hotelName
      ? candidates
        .map((candidate) => ({ ...candidate, nameMatchScore: hotelNameMatchScore(candidate.title, goal.hotelName, goal.destination) }))
        .filter((candidate) => candidate.nameMatchScore === 1 && (candidate.destinationConfirmed || bookingLocationMatchScore(candidate.scopeText, goal.destination, goal.hotelName) >= 0.5))
      : candidates;
    if (goal.hotelName && !namedCandidates.length) {
      throw new Error(`${goal.hotelName} was not found in ${goal.destination} for the selected dates and guests. The agent rejected similarly named hotels from other locations.`);
    }
    const withinBudget = namedCandidates.filter((candidate) => budgetContains(goal, candidate.totalInr));
    if (goal.hotelName && !withinBudget.length) {
      throw new Error(`${goal.hotelName} was found, but no displayed stay is within the ${budgetLabel(goal)} total budget.`);
    }
    // Cards often omit policies or show a different rate; the live room table is authoritative.
    const eligible = withinBudget.filter((candidate) => goal.hotelName || Number.isFinite(candidate.rating)).sort((a, b) => compareHotelCandidates(a, b, Boolean(goal.hotelName)));
    if (!goal.hotelName && withinBudget.length && !eligible.length) throw new Error("No hotel with a visible guest rating matched the total budget. No unrated hotel was substituted.");
    if (!eligible.length) {
      if (goal.hotelName) throw new Error(`${goal.hotelName} has no displayed room within budget that also satisfies the requested policies.`);
      throw new Error("No observed hotel satisfied the total budget and requested policies.");
    }
    const selected = eligible[0];
    context.trace.emit("RankingAgent", "agent.completed", goal.hotelName ? "Matched the specifically requested hotel for room-level verification" : "Ranked eligible live candidates for room-level verification", { firstHotel: selected.title, firstTotalInr: selected.totalInr, rating: selected.rating, compared: eligible.length });
    return eligible;
  }
}

export function roomMatchesGoal(room, goal) {
  return Boolean(room && !room.sharedAccommodation && room.occupancyConfirmed && budgetContains(goal, room.totalInr)
    && (!goal.breakfast || room.breakfastIncluded) && (!goal.freeCancellation || room.freeCancellation)
    && (room.quantity === undefined || room.quantity === goal.rooms));
}

class SupervisorAgent {
  async run(state, context) {
    ensureActive(context.signal);
    if (state.supervisorSteps >= WORKFLOW_LIMITS.decisions) throw new Error("Workflow supervisor decision budget exhausted. No booking was submitted.");
    const observation = supervisorObservation(state);
    context.trace.emit("SupervisorAgent", "supervisor.observed", "Reviewing worker evidence and remaining execution budgets", {
      candidates: observation.candidates.length, remaining: observation.remaining, lastFailure: observation.lastFailure,
      inputCharacters: JSON.stringify(observation).length,
    });
    const started = Date.now();
    const decision = validateSupervisorDecision(await context.supervisorDecider(observation, { signal: context.signal, onQuotaWait: quotaWaitProgress(context, "SupervisorAgent") }), observation);
    ensureActive(context.signal);
    context.trace.emit("SupervisorAgent", "supervisor.decision", decision.summary, {
      action: decision.action, candidateId: decision.candidateId, modelLatencyMs: Date.now() - started,
      decision: state.supervisorSteps + 1,
    });
    if (decision.action === "needs_human") throw Object.assign(new Error(`Human input needed: ${decision.summary}`), { code: "NEEDS_HUMAN" });
    if (decision.action === "stop") throw new Error(state.lastFailure?.message || `Agent stopped safely: ${decision.summary}`);
    return {
      nextAction: decision.action, supervisorSteps: state.supervisorSteps + 1,
      ...(["inspect", "retry_room"].includes(decision.action) ? { candidateIndex: Number(decision.candidateId.slice(6)) } : {}),
      roomRetryUsed: state.roomRetryUsed || decision.action === "retry_room",
      workflowHistory: [...state.workflowHistory, { role: "supervisor", action: decision.action, candidateId: decision.candidateId, summary: decision.summary }].slice(-8),
    };
  }
}

class RoomAgent {
  async run({ goal, candidate }, context) {
    context.trace.emit("RoomAgent", "agent.started", "Opening the property and verifying its live room table", { hotel: candidate.title });
    const page = await context.tools.openCandidate(candidate, goal);
    for (let attempt = 0; attempt < WORKFLOW_LIMITS.roomObservations; attempt++) {
      const rooms = await context.tools.observeRooms(goal);
      ensureActive(context.signal);
      const eligible = rooms.filter((room) => roomMatchesGoal(room, goal)).sort((a, b) => {
        if (goal.bedPreference) {
          const pattern = new RegExp(`\\b${goal.bedPreference}\\s+beds?\\b`, "i");
          const preferenceDifference = Number(pattern.test(b.rowText)) - Number(pattern.test(a.rowText));
          if (preferenceDifference) return preferenceDifference;
        }
        return a.totalInr - b.totalInr;
      }).slice(0, 12);
      const allowedActions = eligible.map((_, index) => ({ action: "select", roomId: `room_${index}` }));
      if (attempt + 1 < WORKFLOW_LIMITS.roomObservations) allowedActions.push({ action: "observe", roomId: "" });
      allowedActions.push({ action: "stop", roomId: "" });
      const observation = { goal, hotel: candidate.title, allowedActions, remainingObservations: WORKFLOW_LIMITS.roomObservations - attempt - 1,
        observedRates: rooms.length, eligibleRooms: eligible.map((room, index) => ({ id: `room_${index}`, totalInr: room.totalInr,
          quantity: goal.rooms, roomType: room.roomType, breakfastIncluded: room.breakfastIncluded, freeCancellation: room.freeCancellation,
          evidence: room.rowText?.slice(0, 700) || "" })) };
      const started = Date.now();
      const decision = validateRoomDecision(await context.roomDecider(observation, { signal: context.signal, onQuotaWait: quotaWaitProgress(context, "RoomAgent") }), observation);
      ensureActive(context.signal);
      context.trace.emit("RoomAgent", "room.decision", decision.summary, {
        action: decision.action, roomId: decision.roomId, eligibleRates: eligible.length, modelLatencyMs: Date.now() - started,
        inputCharacters: JSON.stringify(observation).length,
      });
      if (decision.action === "observe") continue;
      if (decision.action === "stop") {
        if (goal.hotelName) throw new Error(`${goal.hotelName} has no verified available room for the selected dates, guests, budget, and policies.`);
        throw new Error("No room could be verified for occupancy, total price, and requested policies.");
      }
      const selected = eligible[Number(decision.roomId.slice(5))];
      const room = await context.tools.selectRoom(selected, goal) || selected;
      if (!roomMatchesGoal(room, goal)) throw new Error("The selected room price or policies changed and no longer meet the request. No booking was submitted.");
      context.trace.emit("RoomAgent", "agent.completed", `Selected ${goal.rooms} verified available room${goal.rooms === 1 ? "" : "s"}`, { hotel: candidate.title, provider: goal.supplier, providerMode: goal.supplierMode, rating: candidate.rating, availability: "available", rooms: goal.rooms, totalInr: room.totalInr, breakfastIncluded: room.breakfastIncluded, freeCancellation: room.freeCancellation, page });
      return room;
    }
    throw new Error("Room observation budget exhausted without verified selection.");
  }
}

class CheckoutAgent {
  async run({ goal, candidate, room }, context) {
    context.trace.emit("CheckoutAgent", "agent.started", "Navigating only to the supplier's guest-details stage");
    const current = await context.tools.verifySelectedRoom(room, goal);
    if (!roomMatchesGoal(current, goal) || current.totalInr !== room.totalInr) {
      throw new Error("The selected room price or policies changed before checkout. No booking was submitted.");
    }
    const url = await context.tools.continueToGuestDetails();
    const receipt = { hotel: candidate.title, provider: goal.supplier, providerMode: goal.supplierMode, rating: candidate.rating, availability: "available", rooms: goal.rooms, adults: goal.adults, checkIn: goal.checkIn, checkOut: goal.checkOut, roomType: room.roomType || "Not shown", totalInr: room.totalInr, roomPolicy: { breakfastIncluded: room.breakfastIncluded, freeCancellation: room.freeCancellation }, url };
    context.trace.emit("CheckoutAgent", "agent.completed", "Reached checkout without entering personal or payment data", receipt);
    return receipt;
  }
}

class SafetyAgent {
  async run(receipt, context) {
    context.trace.emit("SafetyAgent", "agent.started", "Independently verifying the protected transaction boundary");
    const proof = await context.tools.verifyBoundary(receipt);
    if (!proof?.checkoutSummaryVerified || hotelNameMatchScore(proof.hotel, receipt.hotel) !== 1
      || ["checkIn", "checkOut", "adults", "rooms", "totalInr", "roomType"].some((field) => proof[field] !== receipt[field])
      || receipt.roomPolicy.breakfastIncluded && !proof.roomPolicy?.breakfastIncluded
      || receipt.roomPolicy.freeCancellation && !proof.roomPolicy?.freeCancellation) {
      throw new Error("The current checkout reservation summary was not verified. No booking was submitted.");
    }
    context.trace.emit("SafetyAgent", "boundary.reached", "Browser locked read-only before personal data, booking, or payment", { ...receipt, ...proof });
    return { ...receipt, ...proof };
  }
}

function compileHotelGraph(context, setStatus, checkpointer) {
  const intake = new IntakeAgent();
  const policy = new PolicyAgent();
  const search = new SearchAgent();
  const ranking = new RankingAgent();
  const room = new RoomAgent();
  const checkout = new CheckoutAgent();
  const safety = new SafetyAgent();
  const supervisor = new SupervisorAgent();

  const workflow = new StateGraph(HotelGraphState)
    .addNode("intake", async (state) => {
      setStatus("planning");
      return { goal: await intake.run(state.task, context) };
    })
    .addNode("policy", async (state) => ({ runPolicy: await policy.run(state.goal, context) }))
    .addNode("webDiscovery", async (state) => {
      setStatus("discovering");
      context.trace.emit("DiscoveryAgent", "agent.started", "Checking public identity evidence before the live supplier search");
      let discovery;
      try { discovery = await context.discoverySearch(state.goal, { signal: context.signal }); }
      catch (error) {
        ensureActive(context.signal);
        discovery = { status: "unavailable", summary: error.message, sources: [], claims: [] };
      }
      ensureActive(context.signal);
      context.trace.emit("DiscoveryAgent", "discovery.completed", discovery.summary, discovery);
      if (discovery.status === "ambiguous") throw Object.assign(new Error(`Human input needed: ${discovery.summary}`), { code: "NEEDS_HUMAN" });
      context.trace.emit("DiscoveryAgent", "agent.completed", discovery.status === "unavailable"
        ? "Web lookup unavailable; continuing with the unchanged request and live supplier verification" : discovery.summary);
      return { discovery };
    })
    .addNode("supervisor", async (state) => {
      setStatus("planning");
      return supervisor.run(state, context);
    })
    .addNode("search", async (state) => {
      setStatus("searching");
      let phase = "search";
      try {
        const candidates = await search.run({ goal: state.goal, lastFailure: state.lastFailure }, context);
        phase = "selection";
        setStatus("ranking");
        const rankedCandidates = await ranking.run({ goal: state.goal, candidates }, context);
        return { candidates, rankedCandidates, searchAttempts: state.searchAttempts + 1, rejectedCandidates: [],
          candidate: null, selectedRoom: null, lastFailure: undefined,
          workflowHistory: [...state.workflowHistory, { role: "search", outcome: "verified", candidates: rankedCandidates.length }].slice(-8) };
      } catch (error) {
        ensureActive(context.signal);
        if (/human verification|captcha|login|AI .*decision|classification is unavailable|Policy rejected|Policy blocked/i.test(error.message)) throw error;
        const message = publicAgentErrorMessage(error);
        return { candidates: [], rankedCandidates: [], searchAttempts: state.searchAttempts + 1, candidate: null, selectedRoom: null,
          lastFailure: { phase, message, recoverable: phase === "search" && recoverableWorkflowFailure(error.message) },
          workflowHistory: [...state.workflowHistory, { role: phase, outcome: "failed", message }].slice(-8) };
      }
    })
    .addNode("room", async (state) => {
      setStatus("room_verification");
      ensureActive(context.signal);
      const candidate = state.rankedCandidates[state.candidateIndex];
      if (!candidate) throw new Error("Policy rejected an unknown candidate delegation.");
      try {
        return { candidate, selectedRoom: await room.run({ goal: state.goal, candidate }, context), lastRoomError: undefined,
          inspectionAttempts: state.inspectionAttempts + 1, lastFailure: undefined,
          workflowHistory: [...state.workflowHistory, { role: "room", outcome: "verified", hotel: candidate.title }].slice(-8) };
      } catch (error) {
        ensureActive(context.signal);
        if (/page crashed|target page, context or browser has been closed/i.test(error.message)) {
          throw new Error("The supplier browser became unstable, so the run stopped safely. Close other Chrome tabs and retry.");
        }
        if (/human verification|captcha|login|AI .*decision|Policy rejected|Policy blocked/i.test(error.message)) throw error;
        context.trace.emit("RoomAgent", "candidate.rejected", "Candidate failed room-level verification; routing to the next ranked hotel", {
          hotel: candidate.title,
          reason: publicAgentErrorMessage(error),
        });
        await context.tools.returnToSearch();
        return { candidate: null, selectedRoom: null, inspectionAttempts: state.inspectionAttempts + 1,
          rejectedCandidates: [...new Set([...state.rejectedCandidates, state.candidateIndex])], lastRoomError: error.message,
          lastFailure: { phase: "room", message: publicAgentErrorMessage(error), recoverable: recoverableWorkflowFailure(error.message) },
          workflowHistory: [...state.workflowHistory, { role: "room", outcome: "rejected", hotel: candidate.title, message: publicAgentErrorMessage(error) }].slice(-8) };
      }
    })
    .addNode("checkout", async (state) => {
      setStatus("checkout");
      return { checkoutReceipt: await checkout.run({ goal: state.goal, candidate: state.candidate, room: state.selectedRoom }, context) };
    })
    .addNode("safety", async (state) => {
      const receipt = await safety.run(state.checkoutReceipt, context);
      setStatus("awaiting_human");
      return { receipt };
    })
    .addNode("humanApproval", async () => {
      const decision = interrupt({
        kind: "transaction-boundary",
        message: "Guest details are visible. The browser is read-only; a human must close it.",
        allowedActions: ["close"],
      });
      return { humanDecision: decision };
    })
    .addEdge(START, "intake")
    .addEdge("intake", "policy")
    .addEdge("policy", "webDiscovery")
    .addEdge("webDiscovery", "supervisor")
    .addConditionalEdges("supervisor", (state) => ["inspect", "retry_room"].includes(state.nextAction) ? "room" : state.nextAction, ["search", "room", "checkout"])
    .addEdge("search", "supervisor")
    .addEdge("room", "supervisor")
    .addEdge("checkout", "safety")
    .addEdge("safety", "humanApproval")
    .addEdge("humanApproval", END);

  return workflow.compile({ checkpointer });
}

export class AgentOrchestrator {
  constructor({ runId = `run_${crypto.randomUUID()}`, onEvent, holdAtBoundary = false, intakeParser = parseTravelRequestHybrid, browserDecider,
    supervisorDecider = decideSupervisorAction, roomDecider = decideRoomAction, discoverySearch = discoverHotel } = {}) {
    this.runId = runId;
    this.holdAtBoundary = holdAtBoundary;
    this.controller = new AbortController();
    this.status = "queued";
    this.releaseBoundary = null;
    this.boundaryWait = new Promise((resolveBoundary) => { this.releaseBoundary = resolveBoundary; });
    this.artifactDir = resolve("artifacts", `${runId}-${new Date().toISOString().replaceAll(":", "-").replaceAll(".", "-")}`);
    this.trace = new RunTrace(runId, this.artifactDir, onEvent);
    this.tools = new BrowserToolGateway({ trace: this.trace, signal: this.controller.signal, artifactDir: this.artifactDir, browserDecider });
    this.checkpointer = new MemorySaver();
    this.intakeParser = intakeParser;
    this.supervisorDecider = supervisorDecider;
    this.roomDecider = roomDecider;
    this.discoverySearch = discoverySearch;
  }

  async run(task) {
    const context = { trace: this.trace, tools: this.tools, signal: this.controller.signal, intakeParser: this.intakeParser,
      supervisorDecider: this.supervisorDecider, roomDecider: this.roomDecider, discoverySearch: this.discoverySearch };
    try {
      const graph = compileHotelGraph(context, (status) => { this.status = status; }, this.checkpointer);
      const graphConfig = { configurable: { thread_id: this.runId }, recursionLimit: WORKFLOW_LIMITS.decisions * 3 + 10 };
      this.trace.emit("Orchestrator", "graph.compiled", "Initialized the multi-agent workflow with recovery checkpoints and an approval boundary", {
        framework: ORCHESTRATION.framework,
        nodes: GRAPH_NODES,
        checkpointer: ORCHESTRATION.checkpointer,
      });
      let state = await graph.invoke({ task }, graphConfig);
      const goal = state.goal;
      const receipt = state.receipt;
      if (!receipt || this.status !== "awaiting_human") throw new Error("The workflow ended without reaching the protected checkout boundary.");
      await this.trace.save("awaiting-human-at-guest-details");
      if (this.holdAtBoundary) await this.boundaryWait;
      ensureActive(this.controller.signal);
      this.trace.emit("Orchestrator", "human.resume", "Human acknowledged the boundary; resuming the checkpointed graph only to close the supplier browser");
      state = await graph.invoke(new Command({ resume: { action: "close" } }), graphConfig);
      await this.tools.close();
      this.status = "completed";
      this.trace.emit("Orchestrator", "run.completed", "Agent run finished safely; the supplier browser was closed", { artifactDir: this.artifactDir, humanDecision: state.humanDecision });
      await this.trace.save("completed");
      return { runId: this.runId, goal: safeGoal(goal), receipt, artifactDir: this.artifactDir, status: this.status };
    } catch (error) {
      await this.tools.close();
      if (this.controller.signal.aborted || error?.name === "AbortError") {
        this.status = "cancelled";
        this.trace.emit("Orchestrator", "run.cancelled", "Run cancelled and browser session closed");
        await this.trace.save("cancelled");
        return { runId: this.runId, status: this.status, artifactDir: this.artifactDir };
      }
      this.status = error.code === "NEEDS_HUMAN" || /captcha|challenge|login|human verification|verify (?:that )?you are human/i.test(error.message) ? "needs_human" : "failed";
      const publicMessage = publicAgentErrorMessage(error);
      this.trace.emit("Orchestrator", "run.failed", publicMessage);
      await this.trace.save(this.status, error);
      throw new Error(publicMessage);
    }
  }

  async cancel() {
    if (["completed", "cancelled", "failed"].includes(this.status)) return;
    this.controller.abort();
    this.releaseBoundary?.();
    await this.tools.close();
  }

  closeAtBoundary() {
    if (this.status !== "awaiting_human") throw new Error("The browser can be closed only after the safety boundary is reached.");
    this.releaseBoundary?.();
  }
}

export { AGENTS };
