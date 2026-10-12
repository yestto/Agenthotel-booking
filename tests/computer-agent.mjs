import assert from "node:assert/strict";
import { assertAllowedUrl, bookingSearchText, budgetContains, budgetLabel, normalizeSupplierHost, normalizeTravelText, parseInr, parseStayDates, parseTravelRequest, safeUrlForTrace, supplierMode } from "../scripts/computer-agent.mjs";

const goal = parseTravelRequest(
  "Find a hotel in Bengaluru, 15–17 December 2026, for 2 adults and 1 room, under ₹50,000 total, with breakfast and free cancellation.",
  new Date("2026-10-09T00:00:00+05:30"),
);

assert.deepEqual(goal, {
  destination: "Bengaluru",
  supplier: "booking.com",
  supplierMode: "verified-adapter",
  checkIn: "2026-12-15",
  checkOut: "2026-12-17",
  adults: 2,
  rooms: 1,
  budgetInr: 50000,
  breakfast: true,
  freeCancellation: true,
  originalRequest: "Find a hotel in Bengaluru, 15–17 December 2026, for 2 adults and 1 room, under ₹50,000 total, with breakfast and free cancellation.",
});

assert.equal(goal.hotelName, undefined, "A generic hotel request must not invent a hotel name");
assert.equal(parseInr("2 nights ₹5,600 + ₹280 taxes"), 5600);
assert.equal(assertAllowedUrl("https://www.booking.com/"), true);
assert.throws(() => assertAllowedUrl("https://example.com/checkout"), /Policy blocked/);
assert.throws(() => parseTravelRequest("Find a hotel in Bengaluru in December for 2 adults and 1 room under ₹5,000"), /check-in date or date range/);
const conversationalGoal = parseTravelRequest(
  "find a hotel in hyderabad chandanagar area my budget is around 2000 for 2 adults and 1 room without lunch, 15–17 December 2026",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(conversationalGoal.destination, "hyderabad chandanagar area");
assert.equal(conversationalGoal.budgetInr, 2000);
const rangedBudget = parseTravelRequest(
  "Find a hotel in Vizag from 11 to 16 November 2026 for 1 adult and 1 room with budget 2000-6000",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(rangedBudget.budgetMinInr, 2000);
assert.equal(rangedBudget.budgetInr, 6000);
assert.equal(budgetContains(rangedBudget, 1999), false);
assert.equal(budgetContains(rangedBudget, 2000), true);
assert.equal(budgetContains(rangedBudget, 6000), true);
assert.equal(budgetContains(rangedBudget, 6001), false);
assert.equal(budgetLabel(rangedBudget), "₹2,000–₹6,000");
assert.throws(
  () => parseTravelRequest("Hotel in Goa on 11 November 2026 for 1 adult and 1 room with budget 6000-2000"),
  /lower amount first/,
);
assert.throws(
  () => parseTravelRequest("find a hotel in hyderabad chandanagar area my budget is around 2000 for 2 adults and 1 room without lunch"),
  /check-in date or date range/,
);

const singleNight = parseTravelRequest(
  "find a hotel in hyderabad chandanagar area under 2000 budget for 1 adult and 1 room without lunch included at dates 11 of November 2026",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(singleNight.destination, "hyderabad chandanagar area");
assert.equal(singleNight.checkIn, "2026-11-11");
assert.equal(singleNight.checkOut, "2026-11-12");
assert.equal(singleNight.budgetInr, 2000);

const twoNights = parseTravelRequest(
  "Hotel in Pune on 11th November 2026 for two nights, 2 adults and 1 room, under INR 6,000",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(twoNights.destination, "Pune");
assert.equal(twoNights.checkIn, "2026-11-11");
assert.equal(twoNights.checkOut, "2026-11-13");

const yearRollover = parseTravelRequest(
  "Hotel in Goa, 30 December 2026 to 2 January 2027, for 2 adults and 1 room, under ₹20,000",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(yearRollover.checkIn, "2026-12-30");
assert.equal(yearRollover.checkOut, "2027-01-02");

const isoRange = parseTravelRequest(
  "Hotel in Mumbai from 2026-12-15 to 2026-12-17 for 2 adults and 1 room under ₹20,000",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(isoRange.checkIn, "2026-12-15");
assert.equal(isoRange.checkOut, "2026-12-17");

const tonight = parseTravelRequest(
  "Hotel in Pune tonight for 1 adult and 1 room under ₹4,000",
  new Date("2026-10-09T12:00:00+05:30"),
);
assert.equal(tonight.destination, "Pune");
assert.equal(tonight.checkIn, "2026-10-09");
assert.equal(tonight.checkOut, "2026-10-10");

const leapNight = parseTravelRequest(
  "Hotel in Jaipur on 29 February 2028 for 1 adult and 1 room under ₹5,000",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(leapNight.checkOut, "2028-03-01");

assert.throws(
  () => parseTravelRequest("Hotel in Jaipur on 29 February 2027 for 1 adult and 1 room under ₹5,000", new Date("2026-10-09T00:00:00+05:30")),
  /not valid calendar dates/,
);
assert.throws(
  () => parseTravelRequest("Hotel in Jaipur, 10–12 November 2026 for 1 night, 1 adult and 1 room, under ₹5,000", new Date("2026-10-09T00:00:00+05:30")),
  /date range is 2 nights/,
);
assert.throws(
  () => parseTravelRequest("Hotel in Jaipur on 8 October 2026 for 1 adult and 1 room under ₹5,000", new Date("2026-10-09T00:00:00+05:30")),
  /cannot be in the past/,
);

let missingGuests;
try {
  parseTravelRequest(
    "Find a hotel in hyderabad chandanagar area under 2000 for 11 of november",
    new Date("2026-10-09T00:00:00+05:30"),
  );
} catch (error) {
  missingGuests = error;
}
assert.equal(missingGuests?.message, "How many adults and rooms should I search for? For example: 2 adults, 1 room.");
assert.deepEqual(missingGuests?.missingFields, ["adults", "rooms"]);
assert.equal(missingGuests?.partial?.destination, "hyderabad chandanagar area");
assert.equal(missingGuests?.partial?.checkIn, "2026-11-11");

const typoGoal = parseTravelRequest(
  "fnd hotle in hydrebad chandanagr on 11 nobember 2026 for 2 adlts 1 rom buget 2000 with breakfst",
  new Date("2026-10-09T00:00:00+05:30"),
);
assert.equal(typoGoal.destination, "hydrebad chandanagr");
assert.equal(typoGoal.checkIn, "2026-11-11");
assert.equal(typoGoal.checkOut, "2026-11-12");
assert.equal(typoGoal.adults, 2);
assert.equal(typoGoal.rooms, 1);
assert.equal(typoGoal.budgetInr, 2000);
assert.equal(typoGoal.breakfast, true);
assert.match(normalizeTravelText("11 nobember buget adlts rom breakfst"), /11 november budget adult room breakfast/);

const coupleGoal = parseTravelRequest(
  "Hotel in Mysuru tomorrow for a couple and a room under ₹8,000",
  new Date("2026-10-09T12:00:00+05:30"),
);
assert.equal(coupleGoal.adults, 2);
assert.equal(coupleGoal.rooms, 1);

const reportedRequest = parseTravelRequest(
  "I need to book a hotel in hyderabad kutakpally for 1 adult 1 night stag no lunch dates 11 december 2026, under 3000, 1 room",
  new Date("2026-10-10T00:00:00+05:30"),
);
assert.equal(reportedRequest.destination, "hyderabad kutakpally");
assert.equal(reportedRequest.checkIn, "2026-12-11");
assert.equal(reportedRequest.checkOut, "2026-12-12");
assert.equal(reportedRequest.adults, 1);
assert.equal(reportedRequest.rooms, 1);
assert.equal(reportedRequest.budgetInr, 3000);
assert.equal(reportedRequest.supplier, "booking.com");

const singleBedRequest = parseTravelRequest(
  "I need to book a hotel in hyderabad kutakpally for 1 adult 1 night stag no lunch dates 11 of december 2026, under 3000 single bed",
  new Date("2026-10-10T00:00:00+05:30"),
);
assert.equal(singleBedRequest.adults, 1);
assert.equal(singleBedRequest.rooms, 1);
assert.equal(singleBedRequest.bedPreference, "single");

const namedHotel = parseTravelRequest(
  "Book a room at Taj Krishna in Hyderabad on 12–13 December 2026 for 2 adults and 1 room under ₹20,000",
  new Date("2026-10-10T00:00:00+05:30"),
);
assert.equal(namedHotel.hotelName, "Taj Krishna");
assert.equal(namedHotel.destination, "Hyderabad");
assert.equal(bookingSearchText(namedHotel), "Taj Krishna, Hyderabad");

const overlappingHotelAndPlace = parseTravelRequest(
  "I need to book The Vaishali Residency hotel in Bihar Vaishali for 2 adults from 13 to 15 November 2026, 2 rooms under 9000 budget no lunch",
  new Date("2026-10-11T00:00:00+05:30"),
);
assert.equal(overlappingHotelAndPlace.hotelName, "The Vaishali Residency");
assert.equal(overlappingHotelAndPlace.destination, "Bihar Vaishali");
assert.equal(bookingSearchText(overlappingHotelAndPlace), "The Vaishali Residency, Bihar Vaishali");

const trailingBudget = parseTravelRequest("Book Holiday Inn Express hotel in Bengaluru Yeshwanthpur for 2 adults from 13 to 15 November 2026, 1 room with twin beds, under 4000 total budget, no lunch");
assert.equal(trailingBudget.hotelName, "Holiday Inn Express");
assert.equal(trailingBudget.budgetInr, 4000);

const spokenDateRange = parseStayDates("from 13 to 15 November 2026", new Date("2026-10-10T00:00:00+05:30"));
assert.equal(spokenDateRange.checkIn, "2026-11-13");
assert.equal(spokenDateRange.checkOut, "2026-11-15");

const explicitlyNamedHotel = parseTravelRequest(
  "Hotel named FabHotel Broholic Prime Suites in Hyderabad on 11 December 2026 for 1 adult and 1 room under ₹3,000",
  new Date("2026-10-10T00:00:00+05:30"),
);
assert.equal(explicitlyNamedHotel.hotelName, "FabHotel Broholic Prime Suites");
assert.equal(parseTravelRequest("Hotel in Goa on 12 December 2026 for 2 adults and 1 room under ₹10,000 using booking.com", new Date("2026-10-10T00:00:00+05:30")).supplier, "booking.com");
const agodaGoal = parseTravelRequest("Hotel in Goa on 12 December 2026 for 2 adults and 1 room under ₹10,000 using Agoda", new Date("2026-10-10T00:00:00+05:30"));
assert.equal(agodaGoal.supplier, "agoda.com");
assert.equal(agodaGoal.supplierMode, "universal-computer-use");
assert.equal(assertAllowedUrl("https://secure.agoda.com/checkout", agodaGoal.supplier), true);
assert.throws(() => assertAllowedUrl("https://evil.example/checkout", agodaGoal.supplier), /Policy blocked/);

const arbitraryWebsite = parseTravelRequest("Hotel in Goa on 12 December 2026 for 2 adults and 1 room under ₹10,000 using https://stays.example.com", new Date("2026-10-10T00:00:00+05:30"));
assert.equal(arbitraryWebsite.supplier, "stays.example.com");
assert.equal(arbitraryWebsite.supplierMode, "universal-computer-use");
assert.equal(normalizeSupplierHost("https://www.EXAMPLE.com/path"), "example.com");
assert.equal(supplierMode("booking.com"), "verified-adapter");
assert.throws(() => normalizeSupplierHost("localhost"), /public hotel-booking website/);
assert.equal(
  safeUrlForTrace("https://secure.booking.com/book.html?hotel_id=123&stage=1&sid=private-session-value"),
  "https://secure.booking.com/book.html?hotel_id=123&stage=1",
);

console.log("Computer-use agent checks passed");
