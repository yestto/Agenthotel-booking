import assert from "node:assert/strict";
import { bookingFieldReadiness, bookingRoomEvidence, browserStorageIssue } from "../scripts/agent-orchestrator.mjs";
import { AgentOrchestrator, AGENTS, ORCHESTRATION, bookingDateLabel, bookingDateLabelPattern, bookingDateSummaryMatches, bookingEntryUrl, bookingLocationMatchScore, bookingOccupancyControlId, bookingSearchSubmissionMatches, bookingVisibleSearchStateMatches, chooseBookingSuggestion, classifySearchFailure, compareHotelCandidates, displayedTotalInr, hotelNameMatchScore, isBookingLandingPage, isBookingTemporaryFailure, parseBookingOccupancySummary, parseReviewRating, publicAgentErrorMessage, shouldBlockBrowserResource, universalCandidatesFromLinks } from "../scripts/agent-orchestrator.mjs";

assert.deepEqual(AGENTS, ["IntakeAgent", "PolicyAgent", "DiscoveryAgent", "SupervisorAgent", "SearchAgent", "RankingAgent", "RoomAgent", "CheckoutAgent", "SafetyAgent"]);
const readinessGoal = { destination: "Pune", checkIn: "2026-11-11", checkOut: "2026-11-12", adults: 1, rooms: 1 };
const readinessState = { destination: "Pune", dateSummary: "Nov 11 — Nov 12", occupancy: "1 adult · 0 children · 1 room" };
assert.deepEqual(bookingFieldReadiness(readinessState, readinessGoal, { value: "Pune", text: "Pune" }), { destination: true, dates: true, occupancy: true });
assert.equal(bookingFieldReadiness(readinessState, readinessGoal, null).destination, false, "Typed destination text is not a committed suggestion");
assert.equal(bookingFieldReadiness({ ...readinessState, dateSummary: "Select dates" }, readinessGoal, { value: "Pune", text: "Pune" }).dates, false, "Discarded fields must invalidate an old checkpoint");
assert.equal(bookingFieldReadiness(readinessState, readinessGoal, { value: "Pune, Maharashtra, India", text: "Pune\nMaharashtra, India" }).destination, true, "Supplier-normalized labels must retain the verified geographic selection");
assert.equal(bookingFieldReadiness({ ...readinessState, destination: "Mumbai" }, readinessGoal, { value: "Pune", text: "Pune" }).destination, false);
const namedReadinessGoal = { ...readinessGoal, destination: "Pune, Maharashtra", hotelName: "Hyatt Place Pune Hinjawadi" };
const namedSelection = { value: "Hyatt Place Pune Hinjawadi, Pune, Maharashtra, India", text: "Hyatt Place Pune Hinjawadi\nPune, Maharashtra, India" };
assert.equal(bookingFieldReadiness({ ...readinessState, searchOutcomeVisible: true }, namedReadinessGoal, namedSelection).destination, true, "After a verified hotel suggestion, supplier results may canonicalize the search field to its city");
assert.equal(bookingFieldReadiness(readinessState, namedReadinessGoal, namedSelection).destination, false, "Before results, an uncommitted city cannot replace the requested property");
assert.equal(bookingFieldReadiness({ ...readinessState, destination: "Mumbai", searchOutcomeVisible: true }, namedReadinessGoal, namedSelection).destination, false);
assert.equal(ORCHESTRATION.framework, "LangGraph.js");
assert.equal(ORCHESTRATION.stateSchema, "Zod");
assert.equal(ORCHESTRATION.checkpointer, "MemorySaver");
assert.equal(ORCHESTRATION.humanInterrupt, "humanApproval");
assert.equal(ORCHESTRATION.maxRoomCandidates, 3);
assert.deepEqual(ORCHESTRATION.nodes, ["intake", "policy", "webDiscovery", "supervisor", "search", "room", "checkout", "safety", "humanApproval"]);
assert.equal(displayedTotalInr("₹8,000 ₹5,600", "+ ₹280 taxes and fees"), 5880);
assert.equal(displayedTotalInr("₹12,400", "Includes taxes and fees"), 12400);
assert.equal(displayedTotalInr("Price unavailable", "+ ₹280 taxes"), null);
assert.equal(displayedTotalInr("₹1,999.50", "+ ₹100.75 taxes"), 2100.25);
assert.equal(bookingDateSummaryMatches("Nov 13 — Nov 15", "2026-11-01", "2026-11-15"), false);
assert.equal(bookingDateSummaryMatches("Nov 13 2025 — Nov 15 2025", "2026-11-13", "2026-11-15"), false);
const roomRow = { index: 0, selectId: "hprt_nos_select_test", rowText: "2 adults Breakfast included Free cancellation", priceText: "₹1,999.50", taxesText: "+ ₹100.75", options: [{ value: "1", disabled: false }, { value: "2", disabled: false }] };
assert.equal(bookingRoomEvidence(roomRow, { adults: 3, rooms: 2 }).totalInr, 4200.5);
assert.equal(bookingRoomEvidence(roomRow, { adults: 3, rooms: 2 }).occupancyConfirmed, true);
assert.equal(bookingRoomEvidence(roomRow, { adults: 5, rooms: 2 }).occupancyConfirmed, false);
assert.equal(bookingRoomEvidence({ ...roomRow, roomType: "Bed in 6-Bed Mixed Dormitory Room" }, { adults: 1, rooms: 1 }).sharedAccommodation, true);
assert.equal(bookingRoomEvidence({ ...roomRow, roomType: "Double Room with Shared Bathroom" }, { adults: 1, rooms: 1 }).sharedAccommodation, false);
assert.equal(bookingRoomEvidence(roomRow, { adults: 1, rooms: 3 }), null);
assert.equal(bookingRoomEvidence({ ...roomRow, disabled: true }, { adults: 1, rooms: 1 }), null);
assert.match(browserStorageIssue(60 * 1024 * 1024), /only 60 MB.*500 MB/);
assert.equal(browserStorageIssue(500 * 1024 * 1024), null);
assert.equal(bookingRoomEvidence({ ...roomRow, options: [{ value: "2", disabled: true }] }, { adults: 2, rooms: 2 }), null);
assert.equal(parseReviewRating("Scored 8.7\nExcellent\n1,240 reviews"), 8.7);
assert.equal(parseReviewRating("No rating yet"), null);
assert.equal(parseReviewRating("Scored out of 10, guest rating 9.7\n9.7"), 9.7, "The rating scale must not be mistaken for a perfect score");
assert.equal(parseReviewRating("Scored out of 10"), null);
assert.equal(shouldBlockBrowserResource("image"), true);
assert.equal(shouldBlockBrowserResource("media"), true);
assert.equal(shouldBlockBrowserResource("font"), true);
assert.equal(shouldBlockBrowserResource("script"), false);
assert.equal(shouldBlockBrowserResource("xhr"), false);
assert.equal(classifySearchFailure("Verify that you are human"), "human-verification");
assert.equal(classifySearchFailure("No properties found for these dates"), "no-results");
assert.equal(classifySearchFailure("The page is still loading"), "retry");
assert.equal(isBookingTemporaryFailure("Oops! Something went wrong on our end. Error code: 502"), true);
assert.equal(isBookingTemporaryFailure("Search hotels and homes"), false);
assert.equal(isBookingLandingPage("https://www.booking.com/index.en-gb.html?label=test"), true);
assert.equal(isBookingLandingPage("https://www.booking.com/searchresults.html?ss=Pune"), false);
assert.equal(isBookingLandingPage("https://evil.example/index.en-gb.html"), false);
assert.deepEqual(parseBookingOccupancySummary("2 adults · 0 children · 1 room"), { adults: 2, rooms: 1 });
assert.equal(bookingOccupancyControlId("Adults"), "group_adults");
assert.equal(bookingOccupancyControlId("Rooms"), "no_rooms");
assert.equal(bookingDateLabel("2026-11-13"), "Friday, November 13, 2026");
assert.equal(bookingDateLabelPattern("2026-11-13").test("Friday, November 13, 2026"), true);
assert.equal(bookingDateLabelPattern("2026-11-13").test("Friday, 13 November 2026"), true);
assert.equal(bookingDateLabelPattern("2026-11-13").test("Friday, November 13, 2026, Check-in date"), true);
assert.equal(bookingDateSummaryMatches("Fri, Nov 13 — Sun, Nov 15", "2026-11-13", "2026-11-15"), true);
assert.equal(bookingDateSummaryMatches("Fri, 13 Nov — Sun, 15 Nov", "2026-11-13", "2026-11-15"), true);
assert.equal(bookingDateSummaryMatches("Sat, Oct 10 — Sun, Oct 11", "2026-11-13", "2026-11-15"), false);
assert.equal(bookingSearchSubmissionMatches("https://www.booking.com/searchresults.html?ss=Bengaluru&checkin=2026-11-13&checkout=2026-11-15&group_adults=2&no_rooms=1", { checkIn: "2026-11-13", checkOut: "2026-11-15", adults: 2, rooms: 1 }), true);
assert.equal(bookingSearchSubmissionMatches("https://www.booking.com/searchresults.html?ss=Bengaluru&checkin=2026-11-13&checkout=2026-11-15&group_adults=1&no_rooms=1", { checkIn: "2026-11-13", checkOut: "2026-11-15", adults: 2, rooms: 1 }), false);
assert.equal(bookingSearchSubmissionMatches("https://www.booking.com/searchresults.html?ss=Hyderabad&checkin=2026-11-13&checkout=2026-11-15&group_adults=1&no_rooms=1", { destination: "Visakhapatnam, Andhra Pradesh", checkIn: "2026-11-13", checkOut: "2026-11-15", adults: 1, rooms: 1 }), false);
assert.equal(bookingSearchSubmissionMatches("https://www.booking.com/searchresults.html?ss=Visakhapatnam&checkin=2026-11-13&checkout=2026-11-15&group_adults=1&no_rooms=1", { destination: "Visakhapatnam, Andhra Pradesh", checkIn: "2026-11-13", checkOut: "2026-11-15", adults: 1, rooms: 1 }), true);
assert.equal(bookingVisibleSearchStateMatches({ destination: "New Town, Kolkata, West Bengal, India", dateSummary: "Fri, Jan 8 — Sun, Jan 10", occupancy: "2 adults · 0 children · 1 room", searchOutcomeVisible: true }, { destination: "New Town, Kolkata", checkIn: "2027-01-08", checkOut: "2027-01-10", adults: 2, rooms: 1 }), true);
assert.equal(bookingVisibleSearchStateMatches({ destination: "New Town, Kolkata", dateSummary: "Fri, Jan 8 — Sun, Jan 10", occupancy: "1 adult · 0 children · 1 room", searchOutcomeVisible: true }, { destination: "New Town, Kolkata", checkIn: "2027-01-08", checkOut: "2027-01-10", adults: 2, rooms: 1 }), false);
assert.equal(publicAgentErrorMessage(new Error("locator.click: Timeout 8000ms exceeded. Call log: waiting for getByRole('button')")), "The supplier page changed or did not respond in time. The browser run stopped safely; please try again.");
assert.equal(publicAgentErrorMessage(new Error("No verified available room matched the total budget.")), "No verified available room matched the total budget.");
assert.equal(bookingEntryUrl({ supplier: "booking.com", hotelName: "Holiday Inn Express" }), "https://www.booking.com/");
assert.equal(bookingEntryUrl({ supplier: "booking.com", destination: "Pune" }), "https://www.booking.com/");
assert.equal(bookingEntryUrl({ supplier: "agoda.com", destination: "Pune" }), "https://www.agoda.com/");
assert.equal(hotelNameMatchScore("Taj Krishna, Hyderabad", "Taj Krishna"), 1);
assert.equal(hotelNameMatchScore("FabHotel Broholic Prime Suites - Nr Nexus Mall", "FabHotel Broholic Prime Suites"), 1);
assert.equal(hotelNameMatchScore("Taj Krishna Hotel", "Taj Krishana"), 1);
assert.equal(hotelNameMatchScore("Holiday Inn Express", "Taj Krishna"), 0);
assert.notEqual(hotelNameMatchScore("Hyatt Place", "Hyatt Place Pune Hinjawadi"), 1);
assert.notEqual(hotelNameMatchScore("Holiday Inn Express Pune Wakad", "Holiday Inn Express Pune Hinjawadi"), 1);
assert.equal(bookingLocationMatchScore("The Vaishali Residency · Vaishali, Bihar", "Bihar Vaishali", "The Vaishali Residency"), 1);
assert.equal(bookingLocationMatchScore("The Vaishali Residency · Hyderabad", "Bihar Vaishali", "The Vaishali Residency"), 0);
assert.equal(chooseBookingSuggestion(["Hyatt Pune\nPune, Maharashtra, India", "Hyatt Place Pune Hinjawadi\nPune, Maharashtra, India"], { destination: "Pune, Maharashtra", hotelName: "Hyatt Place Pune Hinjawadi" }), 1);
assert.equal(chooseBookingSuggestion(["Hyatt Place Pune Hinjawadi\nHyderabad, Telangana, India"], { destination: "Pune, Maharashtra", hotelName: "Hyatt Place Pune Hinjawadi" }), -1);
assert.equal(chooseBookingSuggestion(["Hyatt Place Hyderabad Banjara Hills\nHyderabad, Telangana, India"], { destination: "Pune, Maharashtra", hotelName: "Hyatt Place Pune Hinjawadi" }), -1);
assert.equal(chooseBookingSuggestion(["New Town\nKolkata, West Bengal, India", "New Town\nEdinburgh, United Kingdom"], { destination: "New Town, Kolkata, West Bengal" }), 0);
assert.equal(chooseBookingSuggestion(["New Town\nEdinburgh, United Kingdom"], { destination: "New Town, Kolkata" }), -1, "A locality name alone does not prove the requested city");
assert.equal(chooseBookingSuggestion(["New Delhi\nDelhi, India"], { destination: "New Town, Kolkata" }), -1, "A shared first word must not match a different place");
const rankedByRating = [
  { title: "Budget Stay", rating: 7.1, totalInr: 2_000 },
  { title: "Best Rated", rating: 9.2, totalInr: 3_800 },
  { title: "Unrated", rating: null, totalInr: 1_500 },
].sort((a, b) => compareHotelCandidates(a, b));
assert.deepEqual(rankedByRating.map((candidate) => candidate.title), ["Best Rated", "Budget Stay", "Unrated"]);
const namedHotelRates = [
  { title: "Requested Hotel", nameMatchScore: 1, rating: 6.2, totalInr: 2_500 },
  { title: "Requested Hotel Premium", nameMatchScore: 1, rating: 9.8, totalInr: 3_000 },
].sort((a, b) => compareHotelCandidates(a, b, true));
assert.deepEqual(namedHotelRates.map((candidate) => candidate.totalInr), [2_500, 3_000]);

const universalCandidates = universalCandidatesFromLinks([
  { title: "Example Hotel", text: "Example Hotel room ₹4,200 Guest rating 8.6 Breakfast included Free cancellation", href: "https://secure.agoda.com/example" },
  { title: "Unsafe Hotel", text: "Unsafe Hotel room ₹1,000 Guest rating 9.9", href: "https://evil.example/hotel" },
], "agoda.com");
assert.equal(universalCandidates.length, 1);
assert.equal(universalCandidates[0].title, "Example Hotel");
assert.equal(universalCandidates[0].totalInr, 4200);
assert.equal(universalCandidates[0].rating, 8.6);
assert.equal(universalCandidates[0].source, "universal-computer-use");

const events = [];
const orchestrator = new AgentOrchestrator({ runId: "run_test", onEvent: event => events.push(event), holdAtBoundary: true });
await orchestrator.cancel();
assert.equal(orchestrator.controller.signal.aborted, true);

console.log("Multi-agent orchestrator checks passed");
