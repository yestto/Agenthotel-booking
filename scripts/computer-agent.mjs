import { pathToFileURL } from "node:url";

const MONTH_NAMES = ["january", "february", "march", "april", "may", "june", "july", "august", "september", "october", "november", "december"];
const MONTHS = new Map(MONTH_NAMES.flatMap((name, index) => [[name, index], [name.slice(0, 3), index]]));
MONTHS.set("sept", 8);
const NIGHT_WORDS = new Map([["one", 1], ["two", 2], ["three", 3], ["four", 4], ["five", 5], ["six", 6], ["seven", 7], ["eight", 8], ["nine", 9], ["ten", 10], ["eleven", 11], ["twelve", 12], ["thirteen", 13], ["fourteen", 14]]);
const COUNT_WORDS = new Map([...NIGHT_WORDS].filter(([, value]) => value <= 10));
const TOKEN_ALIASES = new Map([
  ["adlts", "adult"], ["adlt", "adult"], ["aduts", "adult"],
  ["rom", "room"], ["roms", "room"], ["ppl", "people"],
]);
const FUZZY_TERMS = [...MONTH_NAMES, "budget", "adult", "room", "breakfast", "cancellation", "tonight", "tomorrow"];

const DEFAULT_TASK = "Find a hotel in Bengaluru, 15–17 December 2026, for 2 adults and 1 room, under ₹50,000 total, with breakfast.";
const DEFAULT_SUPPLIER = "booking.com";
const SUPPLIER_ALIASES = new Map([
  ["booking", DEFAULT_SUPPLIER], ["booking.com", DEFAULT_SUPPLIER],
  ["agoda", "agoda.com"], ["agoda.com", "agoda.com"],
  ["expedia", "expedia.com"], ["expedia.com", "expedia.com"],
  ["hotels.com", "hotels.com"], ["hotels", "hotels.com"],
  ["makemytrip", "makemytrip.com"], ["makemytrip.com", "makemytrip.com"],
  ["goibibo", "goibibo.com"], ["goibibo.com", "goibibo.com"],
  ["cleartrip", "cleartrip.com"], ["cleartrip.com", "cleartrip.com"],
  ["trip.com", "trip.com"], ["trivago", "trivago.in"], ["trivago.in", "trivago.in"],
  ["airbnb", "airbnb.com"], ["airbnb.com", "airbnb.com"],
]);

function isoDate(year, month, day) {
  const date = new Date(Date.UTC(year, month, day));
  if (date.getUTCFullYear() !== year || date.getUTCMonth() !== month || date.getUTCDate() !== day) {
    throw new Error("The travel dates are not valid calendar dates.");
  }
  return date.toISOString().slice(0, 10);
}

function strictIso(value) {
  const match = value.match(/^(20\d{2})-(\d{2})-(\d{2})$/);
  if (!match) throw new Error("Use dates in YYYY-MM-DD format.");
  return isoDate(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
}

function addDays(value, days) {
  const [year, month, day] = value.split("-").map(Number);
  return new Date(Date.UTC(year, month - 1, day + days)).toISOString().slice(0, 10);
}

function stayLength(checkIn, checkOut) {
  return Math.round((Date.parse(`${checkOut}T00:00:00Z`) - Date.parse(`${checkIn}T00:00:00Z`)) / 86_400_000);
}

function monthIndex(value) {
  const month = MONTHS.get(value.toLowerCase().replace(/\.$/, ""));
  if (month === undefined) throw new Error(`Unknown month: ${value}`);
  return month;
}

function isMonth(value) {
  return MONTHS.has(value.toLowerCase().replace(/\.$/, ""));
}

function editDistance(left, right) {
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

function normalizeToken(token, before, after) {
  const lower = token.toLowerCase();
  if (TOKEN_ALIASES.has(lower)) return TOKEN_ALIASES.get(lower);
  if (lower.length < 4) return token;
  let best = token;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const candidate of FUZZY_TERMS) {
    const distance = editDistance(lower, candidate);
    if (distance < bestDistance) {
      best = candidate;
      bestDistance = distance;
    }
  }
  const maximumDistance = lower.length <= 5 ? 1 : 2;
  if (bestDistance > maximumDistance) return token;
  if (MONTH_NAMES.includes(best)) {
    const hasDateContext = /\d(?:st|nd|rd|th)?(?:\s+of)?\s*$/i.test(before) || /^\s+\d{1,4}\b/.test(after);
    if (!hasDateContext) return token;
  }
  return best;
}

export function normalizeTravelText(task) {
  const source = task.normalize("NFKC");
  return source.replace(/\b[A-Za-z]+\b/g, (token, offset) => normalizeToken(token, source.slice(0, offset), source.slice(offset + token.length)));
}

export function budgetContains(goal, amount) {
  return Number.isFinite(amount)
    && amount >= (goal.budgetMinInr || 0)
    && amount <= goal.budgetInr;
}

export function budgetLabel(goal) {
  const maximum = `₹${goal.budgetInr.toLocaleString("en-IN")}`;
  return goal.budgetMinInr
    ? `₹${goal.budgetMinInr.toLocaleString("en-IN")}–${maximum}`
    : maximum;
}

function countValue(value) {
  if (!value) return null;
  return /^\d+$/.test(value) ? Number(value) : COUNT_WORDS.get(value.toLowerCase()) ?? null;
}

function clarificationMessage(fields) {
  if (fields.length === 2 && fields.includes("adults") && fields.includes("rooms")) {
    return "How many adults and rooms should I search for? For example: 2 adults, 1 room.";
  }
  const labels = {
    destination: "a destination",
    dates: "a check-in date or date range",
    adults: "the number of adults",
    rooms: "the number of rooms",
    budget: "a total budget in INR",
  };
  const details = fields.map((field) => labels[field]);
  const list = details.length === 1 ? details[0] : `${details.slice(0, -1).join(", ")} and ${details.at(-1)}`;
  return `I still need ${list}. Example: Bengaluru, 15–17 December 2026, 2 adults, 1 room, under ₹50,000 total.`;
}

function missingDetails(fields, partial) {
  const error = new Error(clarificationMessage(fields));
  error.code = "MISSING_TRIP_DETAILS";
  error.missingFields = fields;
  error.partial = partial;
  return error;
}

export function normalizeSupplierHost(value) {
  const host = value.toLowerCase().replace(/^https?:\/\//, "").replace(/^www\./, "").split(/[/?#]/, 1)[0].replace(/\.$/, "");
  if (!/^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,24}$/.test(host) || host.endsWith(".local")) {
    throw new Error("Use a public hotel-booking website name or full HTTPS URL.");
  }
  return host;
}

function requestedSupplier(task) {
  const urlHost = task.match(/https?:\/\/([a-z0-9.-]+)/i)?.[1];
  const domain = task.match(/\b(?:on|using|via|from)\s+(?:https?:\/\/)?(?:www\.)?([a-z0-9-]+(?:\.[a-z0-9-]+)+)(?:\/[^\s]*)?/i)?.[1];
  const names = [...SUPPLIER_ALIASES.keys()].sort((left, right) => right.length - left.length).map((name) => name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
  const named = task.match(new RegExp(`\\b(?:on|using|via|from)\\s+(${names})\\b`, "i"))?.[1];
  const requested = urlHost || domain || named;
  if (!requested) return DEFAULT_SUPPLIER;
  return SUPPLIER_ALIASES.get(requested.toLowerCase()) || normalizeSupplierHost(requested);
}

export function supplierMode(supplier) {
  return normalizeSupplierHost(supplier) === DEFAULT_SUPPLIER ? "verified-adapter" : "universal-computer-use";
}

function cleanHotelName(value) {
  const cleaned = value
    ?.replace(/^[\s"'“”‘’:-]+|[\s"'“”‘’:-]+$/g, "")
    .replace(/\s+hotel$/i, "")
    .replace(/\s+/g, " ")
    .trim();
  if (!cleaned || /^(?:a|any|the)$|^(?:a|any|the)?\s*hotels?$/i.test(cleaned)) return null;
  return cleaned;
}

function requestedHotelName(task) {
  const stop = "(?=\\s+(?:in|near|around|on|from|for|under|below|with|without|using|via|dates?|check-?in)\\b|[,.;]|$)";
  const patterns = [
    new RegExp(`\\b(?:hotel\\s+(?:named|called)|hotel\\s+name(?:\\s+is)?|specific\\s+hotel(?:\\s+(?:is|named|called))?)\\s*[:\\-]?\\s*[\"“']?(.+?)[\"”']?${stop}`, "i"),
    new RegExp(`\\b(?:stay|book(?:\\s+a\\s+room)?|reserve(?:\\s+a\\s+room)?)\\s+at\\s+[\"“']?(.+?)[\"”']?${stop}`, "i"),
    /\b(?:book|reserve|want)\s+([A-Za-z0-9&.'’ -]+?\s+(?:hotel|resort|inn|suites?))(?=\s+(?:in|near|around|on|from|for|under|below|with|without|using|via)\b|[,.;]|$)/i,
    /\b(?:hotel|stay|book(?:\s+a\s+room)?\s+at)\s+["“]([^"”]{2,80})["”]/i,
  ];
  for (const pattern of patterns) {
    const hotelName = cleanHotelName(task.match(pattern)?.[1]);
    if (hotelName) return hotelName;
  }
  return null;
}

function requestedNights(task) {
  const numberOrWord = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve|thirteen|fourteen)";
  const match = task.match(new RegExp(`\\b(?:for|staying\\s+for)\\s+${numberOrWord}\\s+(?:nights?|days?)\\b`, "i"))
    || task.match(new RegExp(`\\b${numberOrWord}\\s+(?:nights?|days?)\\s+(?:stay\\b)?`, "i"));
  if (!match) return null;
  const nights = /^\d+$/.test(match[1]) ? Number(match[1]) : NIGHT_WORDS.get(match[1].toLowerCase());
  if (!Number.isInteger(nights) || nights < 1 || nights > 30) throw new Error("The stay must be between 1 and 30 nights.");
  return nights;
}

function inferredYear(month, day, explicitYear, now) {
  if (explicitYear) return Number(explicitYear);
  let year = now.getFullYear();
  const candidate = isoDate(year, month, day);
  const today = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  if (candidate < today) year += 1;
  return year;
}

function finishStay(checkIn, checkOut, nights, now) {
  const today = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
  if (checkIn < today) throw new Error("Check-in date cannot be in the past.");
  const calculatedNights = stayLength(checkIn, checkOut);
  if (calculatedNights < 1) throw new Error("Check-out must be after check-in.");
  if (calculatedNights > 30) throw new Error("The stay must be between 1 and 30 nights.");
  if (nights !== null && nights !== calculatedNights) throw new Error(`The date range is ${calculatedNights} nights, but the request says ${nights} nights.`);
  return { checkIn, checkOut, nights: calculatedNights };
}

export function parseStayDates(task, now = new Date()) {
  const nights = requestedNights(task);
  const isoRange = task.match(/\b(20\d{2}-\d{2}-\d{2})\s*(?:to|until|through|–|—|\s-\s)\s*(20\d{2}-\d{2}-\d{2})\b/i);
  if (isoRange) return finishStay(strictIso(isoRange[1]), strictIso(isoRange[2]), nights, now);

  const crossMonth = task.match(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([A-Za-z.]+)(?:\s*,?\s*(20\d{2}))?\s*(?:to|until|through|–|—|-)\s*(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([A-Za-z.]+)(?:\s*,?\s*(20\d{2}))?/i);
  if (crossMonth && isMonth(crossMonth[2]) && isMonth(crossMonth[5])) {
    const startMonth = monthIndex(crossMonth[2]);
    const endMonth = monthIndex(crossMonth[5]);
    let startYear;
    let endYear;
    if (crossMonth[3]) startYear = Number(crossMonth[3]);
    if (crossMonth[6]) endYear = Number(crossMonth[6]);
    if (!startYear && endYear) startYear = endYear - (startMonth > endMonth ? 1 : 0);
    if (startYear && !endYear) endYear = startYear + (endMonth < startMonth ? 1 : 0);
    if (!startYear && !endYear) {
      startYear = inferredYear(startMonth, Number(crossMonth[1]), null, now);
      endYear = startYear + (endMonth < startMonth ? 1 : 0);
    }
    return finishStay(isoDate(startYear, startMonth, Number(crossMonth[1])), isoDate(endYear, endMonth, Number(crossMonth[4])), nights, now);
  }

  const sameMonth = task.match(/\b(\d{1,2})(?:st|nd|rd|th)?\s*(?:to|until|through|–|—|-)\s*(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z.]+)(?:\s+(20\d{2}))?/i);
  if (sameMonth && isMonth(sameMonth[3])) {
    const month = monthIndex(sameMonth[3]);
    const year = inferredYear(month, Number(sameMonth[1]), sameMonth[4], now);
    return finishStay(isoDate(year, month, Number(sameMonth[1])), isoDate(year, month, Number(sameMonth[2])), nights, now);
  }

  const monthFirstRange = task.match(/\b([A-Za-z.]+)\s+(\d{1,2})(?:st|nd|rd|th)?\s*[–—-]\s*(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/i);
  if (monthFirstRange && isMonth(monthFirstRange[1])) {
    const month = monthIndex(monthFirstRange[1]);
    const year = inferredYear(month, Number(monthFirstRange[2]), monthFirstRange[4], now);
    return finishStay(isoDate(year, month, Number(monthFirstRange[2])), isoDate(year, month, Number(monthFirstRange[3])), nights, now);
  }

  const relativeDays = /\btonight\b/i.test(task) ? 0 : /\btomorrow(?:\s+night)?\b/i.test(task) ? 1 : null;
  if (relativeDays !== null) {
    const today = isoDate(now.getFullYear(), now.getMonth(), now.getDate());
    const checkIn = addDays(today, relativeDays);
    return finishStay(checkIn, addDays(checkIn, nights || 1), null, now);
  }

  const singleIso = task.match(/\b(20\d{2}-\d{2}-\d{2})\b/);
  if (singleIso) {
    const checkIn = strictIso(singleIso[1]);
    return finishStay(checkIn, addDays(checkIn, nights || 1), null, now);
  }

  const dayFirst = [...task.matchAll(/\b(\d{1,2})(?:st|nd|rd|th)?(?:\s+of)?\s+([A-Za-z.]+)(?:\s*,?\s*(20\d{2}))?/gi)]
    .find((match) => isMonth(match[2]));
  if (dayFirst) {
    const month = monthIndex(dayFirst[2]);
    const year = inferredYear(month, Number(dayFirst[1]), dayFirst[3], now);
    const checkIn = isoDate(year, month, Number(dayFirst[1]));
    return finishStay(checkIn, addDays(checkIn, nights || 1), null, now);
  }

  const monthFirst = [...task.matchAll(/\b([A-Za-z.]+)\s+(\d{1,2})(?:st|nd|rd|th)?(?:,?\s+(20\d{2}))?/gi)]
    .find((match) => isMonth(match[1]));
  if (monthFirst) {
    const month = monthIndex(monthFirst[1]);
    const year = inferredYear(month, Number(monthFirst[2]), monthFirst[3], now);
    const checkIn = isoDate(year, month, Number(monthFirst[2]));
    return finishStay(checkIn, addDays(checkIn, nights || 1), null, now);
  }

  throw new Error("Add a check-in date or range, for example: 11 November 2026 or 15–17 December 2026.");
}

export function parseTravelRequest(task, now = new Date()) {
  if (!task || !task.trim()) throw new Error("Please provide a hotel request.");
  if (/\b(?:[1-9]\d*|one|two|three|four|five)\s+(?:children|child|kids?|infants?|bab(?:y|ies))\b/i.test(task)) {
    throw new Error("Child occupancy is not supported yet. Please use an adults-only request; the agent will not omit children from a booking.");
  }
  if (/\b(?:per|each|a)\s+night\b|\/\s*night\b/i.test(task)) {
    throw new Error("Please give the total budget for all rooms and nights, including taxes, rather than a per-night budget.");
  }
  if (/\b(?:0?[1-9]|1[0-2])[/.](?:0?[1-9]|1[0-2])[/.]20\d{2}\b/.test(task)) {
    throw new Error("Please spell out the month or use YYYY-MM-DD so the dates are unambiguous.");
  }

  const hotelName = requestedHotelName(task);
  const normalized = normalizeTravelText(task);
  const supplier = requestedSupplier(normalized);
  const destination = normalized.match(/\b(?:in|near|around)\s+([^,.;]+?)(?=\s+(?:\d{1,2}(?:st|nd|rd|th)?(?:\s+of)?\s+[A-Za-z]+|20\d{2}-\d{2}-\d{2}|from|on|for|under|below|with|without|tonight|tomorrow|(?:my\s+)?budget)\b|[,.;]|$)/i)?.[1]?.trim().replace(/^the\s+/i, "") || null;
  let dates = null;
  try {
    dates = parseStayDates(normalized, now);
  } catch (error) {
    if (!error.message.startsWith("Add a check-in date")) throw error;
  }

  const countPattern = "(\\d+|one|two|three|four|five|six|seven|eight|nine|ten)";
  const adultText = normalized.match(new RegExp(`\\b${countPattern}\\s*(?:adults?|people|persons?|guests?|pax)\\b`, "i"))?.[1];
  const roomText = normalized.match(new RegExp(`\\b${countPattern}\\s*(?:rooms?|units?)\\b`, "i"))?.[1];
  const adults = countValue(adultText)
    ?? (/\b(?:solo|alone)\b/i.test(normalized) ? 1 : /\b(?:couple|two\s+of\s+us)\b/i.test(normalized) ? 2 : null);
  const rooms = countValue(roomText)
    ?? (/\b(?:a|one|single)\s+room\b|\bsingle\s+bed\b/i.test(normalized) ? 1 : null);
  const bedPreference = normalized.match(/\b(single|twin|double|queen|king)\s+beds?\b/i)?.[1]?.toLowerCase() || null;
  const budgetRange = normalized.match(/\b(?:budget|price\s+range)(?:\s+is)?(?:\s+(?:between|from))?\s*(?:₹|INR|Rs\.?)?\s*(\d[\d,]*)\s*(?:-|–|—|to|and)\s*(?:₹|INR|Rs\.?)?\s*(\d[\d,]*)\b/i)
    || normalized.match(/(?:₹|\bINR\b|\bRs\.?)[\s]*(\d[\d,]*)\s*(?:-|–|—|to)\s*(?:₹|INR|Rs\.?)?\s*(\d[\d,]*)\b/i)
    || normalized.match(/\b(\d[\d,]*)\s*(?:-|–|—|to|and)\s*(\d[\d,]*)\s*(?:total\s+)?budget\b/i);
  const budgetText = normalized.match(/(?:₹|\bINR\b|\bRs\.?)[\s]*(\d[\d,]*)/i)?.[1]
    || normalized.match(/\b(?:my\s+)?budget(?:\s+is)?(?:\s+(?:around|about|under|below|up\s+to))?\s*(?:₹|INR|Rs\.?)?\s*(\d[\d,]*)/i)?.[1]
    || normalized.match(/\b(?:under|below|up\s+to)\s*(?:₹|INR|Rs\.?)?\s*(\d[\d,]*)\b/i)?.[1];
  const budgetMinInr = budgetRange ? Number(budgetRange[1].replaceAll(",", "")) : null;
  const budgetInr = budgetRange ? Number(budgetRange[2].replaceAll(",", "")) : budgetText ? Number(budgetText.replaceAll(",", "")) : null;

  if (adults !== null && (!Number.isInteger(adults) || adults < 1 || adults > 30)) throw new Error("Adults must be between 1 and 30.");
  if (rooms !== null && (!Number.isInteger(rooms) || rooms < 1 || rooms > 10)) throw new Error("Rooms must be between 1 and 10.");
  if (budgetInr !== null && (!Number.isFinite(budgetInr) || budgetInr < 500)) throw new Error("The total budget is too low or invalid.");
  if (budgetMinInr !== null && (!Number.isFinite(budgetMinInr) || budgetMinInr < 500 || budgetMinInr > budgetInr)) throw new Error("The budget range is invalid. Enter the lower amount first.");

  const missingFields = [];
  if (!destination) missingFields.push("destination");
  if (!dates) missingFields.push("dates");
  if (adults === null) missingFields.push("adults");
  if (rooms === null) missingFields.push("rooms");
  if (budgetInr === null) missingFields.push("budget");
  if (missingFields.length) {
    throw missingDetails(missingFields, { destination, hotelName, ...dates, adults, rooms, budgetInr, ...(budgetMinInr !== null ? { budgetMinInr } : {}) });
  }

  if (!Number.isFinite(budgetInr) || budgetInr < 500) throw new Error("The total budget is too low or invalid.");

  return {
    destination,
    supplier,
    supplierMode: supplierMode(supplier),
    checkIn: dates.checkIn,
    checkOut: dates.checkOut,
    adults,
    rooms,
    budgetInr,
    ...(budgetMinInr !== null ? { budgetMinInr } : {}),
    breakfast: /\b(?:with|including|includes?)\s+breakfast\b|\bbreakfast included\b/i.test(normalized),
    freeCancellation: /\bfree cancellation\b/i.test(normalized),
    ...(hotelName ? { hotelName } : {}),
    ...(bedPreference ? { bedPreference } : {}),
    originalRequest: task.trim(),
  };
}

export function bookingSearchText(goal) {
  return goal.hotelName ? `${goal.hotelName}, ${goal.destination}` : goal.destination;
}


export function parseInr(text = "") {
  const values = [...text.matchAll(/₹\s*([\d,]+)/g)].map((match) => Number(match[1].replaceAll(",", "")));
  return values.find((value) => Number.isFinite(value)) ?? null;
}

export function assertAllowedUrl(rawUrl, allowedHosts = [DEFAULT_SUPPLIER]) {
  const parsedUrl = new URL(rawUrl);
  if (parsedUrl.protocol !== "https:" || parsedUrl.username || parsedUrl.password) throw new Error("Policy blocked non-HTTPS or credential-bearing navigation.");
  const host = parsedUrl.hostname.toLowerCase();
  const roots = (Array.isArray(allowedHosts) ? allowedHosts : [allowedHosts]).map(normalizeSupplierHost);
  if (!roots.some((allowed) => host === allowed || host.endsWith(`.${allowed}`))) {
    throw new Error(`Policy blocked navigation to ${host}`);
  }
  return true;
}

export function safeUrlForTrace(rawUrl) {
  const source = new URL(rawUrl);
  if (!/^https?:$/.test(source.protocol)) return `${source.protocol}//${source.hostname}${source.pathname}`;
  const safe = new URL(`${source.origin}${source.pathname}`);
  for (const key of ["ss", "checkin", "checkout", "group_adults", "no_rooms", "hotel_id", "stage"]) {
    if (source.searchParams.has(key)) safe.searchParams.set(key, source.searchParams.get(key));
  }
  return safe.toString();
}


async function waitForEnter() {
  if (process.env.STAYPILOT_AGENT_NO_PAUSE === "1") return;
  process.stdin.resume();
  await new Promise((resolveInput) => process.stdin.once("data", resolveInput));
}


export async function runComputerAgent(task, { pauseAtBoundary = true } = {}) {
  // Keep the old entry point on the same guarded UI workflow, never a constructed search URL.
  const { AgentOrchestrator } = await import("./agent-orchestrator.mjs");
  let orchestrator;
  orchestrator = new AgentOrchestrator({
    holdAtBoundary: pauseAtBoundary,
    onEvent(event) {
      if (event.type === "boundary.reached" && pauseAtBoundary) {
        console.log("Safe boundary reached. Press Enter to close the supplier browser.");
        waitForEnter().then(() => orchestrator.closeAtBoundary()).catch(() => orchestrator.cancel());
      }
    },
  });
  return orchestrator.run(task);
}

function readTaskFromCli(argv) {
  const filtered = argv.filter((value) => value !== "--no-pause");
  return filtered.join(" ").trim() || DEFAULT_TASK;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { process.loadEnvFile(".env"); } catch (error) { if (error.code !== "ENOENT") throw error; }
  const task = readTaskFromCli(process.argv.slice(2));
  const pauseAtBoundary = !process.argv.includes("--no-pause");
  runComputerAgent(task, { pauseAtBoundary }).catch((error) => {
    console.error(`\nComputer-use agent stopped safely: ${error.message}`);
    process.exitCode = 1;
  });
}
