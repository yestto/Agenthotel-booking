# StayPilot — multi-agent hotel computer-use platform

StayPilot accepts a natural-language hotel request, uses a configured Gemini or Groq model for interpretation, workflow supervision, browser action selection and room-rate decisions, and coordinates nine specialist roles through LangGraph.js. Optional source-linked web discovery remains a separate Gemini/Google integration. The supervisor delegates from current evidence rather than a fixed search-to-checkout sequence. It controls an isolated visible Chrome session. Booking.com has a dedicated state-verifying adapter; other providers remain experimental, not universally supported. The current live end-to-end flow still needs a passing run under the latest safety guards. Live hotel, room, price, rating, tax, breakfast, occupancy and cancellation evidence comes from the visible supplier interface—not simulated inventory.

The system navigates through search, comparison, room verification, and the provider's protected checkout stage. SafetyAgent then locks the browser read-only before personal data, final booking, or payment.

## Run the complete platform

Requirements: Node.js 20.12+, Google Chrome or Microsoft Edge.
Keep at least 500 MB free on the browser temporary-files drive. The service checks storage before launching Chrome and the console displays a low-space warning instead of attempting a browser run. This is a minimum startup guard, not a guarantee against renderer memory pressure.

Configure one core model provider in `.env`:

```dotenv
LLM_PROVIDER=groq
GROQ_API_KEY=your_groq_key
GROQ_MODEL=openai/gpt-oss-120b
```

Groq keys belong in `GROQ_API_KEY`; Groq and xAI/Grok are different services. For migration only, `LLM_PROVIDER=groq` accepts a Groq-shaped `gsk_...` key already saved in `GEMINI_API_KEY`, but prefer moving it to the correctly named field. A key in that old field never selects Groq automatically and never enables Google discovery. For the existing Gemini route, use `LLM_PROVIDER=gemini`, `GEMINI_API_KEY`, and optionally `GEMINI_MODEL`. If `LLM_PROVIDER` is omitted, a configured `GROQ_API_KEY` selects Groq; otherwise Gemini remains the default. Unknown provider names fail closed. Keep credentials local and never paste them into the UI or commit them.

Without a configured provider/key, the validated deterministic intake parser remains available for local development, but live AI browser decisions are unavailable. An explicitly selected Groq route without its usable key fails closed instead of silently using local parsing. When a key is configured, classification is fail-closed: a provider error is reported instead of silently relabeling a rule-based result as AI interpretation. The service's readiness indicator confirms configuration, not a successful provider request.

Groq's Free plan has request and token quotas; a single browser run makes multiple model requests. Keep observations compact and run one scenario at a time. A conservative in-process request/token budget paces calls and reconciles successful reservations to actual usage with headroom. During browser search, only actual local quota waiting has a separate five-minute allowance; active work remains bounded to three minutes, with an eight-minute combined decision deadline. The UI shows the allowance wait and keeps Cancel available. Other model calls retain their existing end-to-end deadlines. The limiter does not coordinate other programs using the same project/key. Quota errors stop explicitly rather than changing accounts, rotating keys or silently falling back to scripted execution. Free access is not a reliability guarantee for a recruiter demo. Check the account's current limits in the provider console before a live test.

```powershell
git clone https://github.com/yestto/Agenthotel-booking.git
cd Agenthotel-booking
npm ci
Copy-Item .env.example .env
# Set LLM_PROVIDER and the matching API key in .env before a browser run.
npm run agent-ui
```

Open [http://127.0.0.1:4180](http://127.0.0.1:4180), enter a request, and select **Start agent run**.

Do not commit `.env`, `.env.share`, browser profiles, or generated `artifacts/`. The public repository contains an unbound `.openai/hosting.json` build manifest; private hosting project identifiers and credentials must be configured separately. On non-Windows machines, set `CHROME_PATH` to your installed Chrome/Chromium executable before running browser tests or the agent.

The runtime checks temporary-drive space and available memory before launching a supplier browser. Less than 500 MB of disk space or 512 MB of available memory blocks launch with a clear resource warning. These minimum checks reduce avoidable failures; they do not guarantee that a heavy supplier page cannot exhaust memory later. Close unused apps/tabs on the host for a live remote demo.

The hosted page is the presentation entry point. Browsers that isolate HTTPS pages from loopback cannot attach to the local Chrome agent directly; its **Open local agent console** button carries the typed request to `127.0.0.1` instead.

Example:

```text
Find a hotel in Bengaluru, 15–17 December 2026, for 2 adults,
and 1 room, under ₹50,000 total, with breakfast.
```

Omit the website for the default provider, name a recognized provider, or paste a public hotel-booking domain:

```text
Find a hotel in Bengaluru on 15 December 2026 for 2 adults and 1 room
under ₹20,000 using Agoda.

Book Taj Krishna in Hyderabad on 12–13 December 2026 for 2 adults
and 1 room under ₹20,000 using https://example-hotel-site.com.
```

Single-night requests are valid. A single check-in date implies checkout on the following day:

```text
Find a hotel in Hyderabad Chandanagar on 11 November 2026
for one night, for 1 adult and 1 room, under ₹2,000 total.
```

The selected model first corrects noisy language and produces schema-constrained fields. The deterministic validator then checks ordinal dates (`11th November`), month-first dates (`November 11`), ISO dates (`2026-11-11`), `tonight`/`tomorrow night`, explicit night counts, month/year-crossing ranges, and dates without a year. It rejects past or impossible dates, stays longer than 30 nights, and conflicts such as a two-night range combined with “for one night.” Ambiguous numeric dates such as `11/12/2026` are not guessed when the intent remains uncertain.

The frontend streams genuine backend events while Chrome operates. It shows the selected provider and whether the run uses the verified adapter or universal route. At the protected checkout boundary it displays the hotel, rating, availability, total, proof screenshot, and **Close supplier browser** control.

The selected core provider handles both language understanding and search-time tool decisions. SearchAgent runs an observe → decide → act → verify loop: each model call sees the current visible controls, verified search state, completed skills and recent tool outcomes, then chooses one allowed tool. Verified destination, calendar, occupancy and submission skills remain reusable primitives; after a failure the model can re-observe and choose safe visible controls or stop. No model-supplied JavaScript, selectors, URLs or arbitrary input values are executed. Values come only from the validated trip. Zod and deterministic code still enforce dates, people, rooms, budget, provider restrictions, prices and the transaction boundary. Ranking, room eligibility and checkout safety intentionally remain evidence-based deterministic checks rather than unconstrained model decisions.

The service requires the AI key for browser decisions; missing credentials, invalid model output or model failure never silently switch a live agent run to scripted execution. Directly instantiated gateway tests can explicitly disable the model with `browserDecider: null`. Decision events (`agent.observed`, `agent.decision`, `agent.action`, `agent.replanned`, `model.quota_wait`, `model.quota_resumed`) are genuine backend activity, not simulated progress. Each decision is operational metadata, not private chain-of-thought. Search has bounded decisions, active-work and quota-wait deadlines, and bounded supplier-tool timeouts. Core model requests default to 15 seconds with Gemini or 90 seconds with Groq; browser search separates only measured local pacing from active request time, and cancellation aborts either. Current-state action schemas exclude premature submission and unavailable field skills. Three identical no-progress observations stop the loop. Supplier text is untrusted input; policy rejects personal-data fields, transaction controls, arbitrary navigation and premature completion. Navigation requests are constrained to the chosen supplier domain. A visible supplier retry is accepted only after independently re-verifying matching trip fields and results. Exhausted supplier recovery reports the supplier error, not a fabricated request for human input. The loop stops for genuine human verification rather than bypassing it.

Supplier search remains strict UI-only: open the homepage, commit a geographically matching destination suggestion, visibly enter dates and occupancy, and click Search. Completion requires independently observed supplier results with the requested fields—not merely a model assertion. No constructed search URL or inventory API recovery is used. Booking.com has the verified search-state adapter; other suppliers can expose observed controls, but cannot be marked complete until an equivalent state verifier exists. This is not a guarantee that arbitrary websites work. Nuitee is not required for the computer-use path.

Occupancy extracted by the model must include exact source quotations, so omitted adults or rooms cannot be silently filled in. Clearly stated adult/room counts, dates, budget caps and required or negated breakfast/cancellation constraints remain authoritative even when the model is inconsistent. Contradictory explicit constraints require clarification. A complete quoted hotel name cannot lose identifying words or acquire an invented branch. Ambiguous bed-versus-room counts and numeric dates require clarification. Per-night budgets require a total budget; child occupancy is not yet supported and is explicitly rejected rather than omitted.

Booking room availability is checked for the requested quantity. The verified total includes taxes for every room for the displayed stay, with decimal precision, and is re-read after selection. Dormitory beds and capsules cannot satisfy a private-room request. Policies missing from a hotel card are checked in the room table. Up to 30 displayed hotel cards are compared; the system does not claim to exhaust the provider's entire inventory. Only three ranked properties are attempted for room verification. Universal-provider multi-room selection is rejected until quantity can be verified by an adapter.

Before room selection, the visible physical address must confirm the requested city/locality; marketing names and fuzzy name similarity are not geographic or exact-property proof. If address markup changes, the configured core model may extract one exact address quotation from bounded visible property-header text. Address buttons, fragmented text and `display:contents` wrappers are readable; hidden tooltip geometry and adjacent review widgets do not hide the actual address row. Reviews, hidden text and footer addresses are excluded; the quotation must occur literally in the observation and pass the same location guard. Unknown address formats stop safely. Property pages recheck the requested dates and occupancy, including after the single shared visible 502 retry. At the protected checkout stage, current hotel identity, dated stay, adults, quantity, room type, policies and an explicitly labeled full total are checked again. A generic guest form or a cancellation-fee amount is insufficient. Missing or changed checkout evidence stops without a successful reservation receipt, even when earlier room evidence was valid.

## Agent architecture

### Senior-engineer audit safeguards

The runtime is a bounded, DOM/tool-based hierarchical agentic workflow, not a universal vision/desktop agent or nine independent LLM processes. Intake, DiscoveryAgent, SupervisorAgent, SearchAgent and RoomAgent use distinct model tasks. The model chooses worker delegations, search actions and eligible room rates; deterministic code remains authoritative for eligibility, ranking order, arithmetic and transaction safety.

### Source-linked web discovery

Named hotels and non-default suppliers trigger DiscoveryAgent before the supplier browser opens. This optional lookup requires a genuine Google Gemini key in `GEMINI_API_KEY`; a Groq core key cannot authorize Google Search. Grounding uses `GEMINI_DISCOVERY_MODEL` when set, otherwise the core Gemini model if Gemini is selected, or the default Gemini discovery model when Groq is selected. The cited hotel/location evidence is then assessed separately. It is a direct API integration, not an external MCP server and not visibly typing into Google. Ordinary unnamed Booking.com searches skip the additional requests.

Only hotel name, destination and supplier are sent to discovery—not the original request, trip dates, budget or guest counts. An assessment may cite only facts linked by the provider's grounding metadata to observed HTTPS sources; fabricated IDs and unsafe URLs are rejected. The UI displays those facts, citations and Google's returned search suggestions. Attribution HTML is isolated in an opaque sandbox without scripts or same-origin access.

Discovery never changes the validated hotel, destination, supplier, dates, occupancy or budget, and never navigates the browser to a discovered link. Ambiguous identity evidence requests human clarification before browser launch. Missing citations or a search outage is explicitly reported and allows the unchanged request to continue through live supplier verification; it does not mean the hotel is sold out. Search snippets cannot establish room availability, ratings, prices or checkout permissions. The supervisor receives compact discovery evidence, while supplier UI checks remain authoritative.

There is one grounding request and one assessment at most per run, within a 20-second discovery deadline. The grounding provider may issue multiple underlying queries; Google search charges and the configured discovery model's quota apply. See [Google's grounding documentation](https://ai.google.dev/gemini-api/docs/google-search). No extra package is required. With only a Groq key, or a model without grounding support, discovery reports the lookup as unavailable and continues only with the unchanged request and live supplier verification; it does not fabricate sources or silently introduce another search service.

Verification status (13 October 2026): controlled discovery, workflow and browser-rendering checks passed. The latest actual Google-grounded lookup returned HTTP 429 `RESOURCE_EXHAUSTED`; live web discovery is not yet successfully verified. The live harness covers exact/typo/wrong-city hotel identity, alternative supplier identity, an invented hotel, and deliberate generic-search skipping. It stops further live lookups after quota/authentication errors and records blocked scenarios separately from passes. No booking flow runs in this harness; reports are generated locally under `artifacts/live-discovery-scenarios-report.json`.

SupervisorAgent reviews worker outcomes and selects a typed delegation: search, inspect, retry_room, checkout, needs_human or stop. Allowed delegations are recomputed from current evidence. Generic requests cannot skip the highest-ranked untried candidate, and named-hotel requests cannot substitute another property. A transient room failure may be retried once or trigger a fresh UI search; known price/policy failures cannot use that recovery. There are at most two searches, three total property inspections, twelve supervisor decisions and two room observations per inspection. Re-search normally reuses the isolated browser session; a failed search stuck on a static city/district landing page uses a fresh isolated session for the remaining bounded retry. Worker prompts receive compact bounded evidence, and events record model latency/input size without exposing private reasoning.

RoomAgent independently decides between a current eligible rate, another observation or stopping. Invented/ineligible IDs are rejected; values and quantities come from verified evidence, not the model. The selected rate is re-read after selection and again after supervisor review before checkout. PolicyAgent now binds an immutable policy to the browser gateway. Property links are reidentified from their observed URL and title before clicking, and the resulting property title is checked. Same-tab navigation no longer waits for a nonexistent popup. The old standalone runner delegates to this same workflow; constructed search-URL helpers and the generic property goto shortcut were removed.

Search completion requires a current visible Search submission, matching destination, dates and occupancy, and live results. Re-entering fields alone cannot validate old inventory. Any conflicting trip parameters, including the destination query, invalidate that evidence; a matching URL can never override wrong visible fields. Field-entry checkpoints require actual skill execution or verified manual interactions and are recomputed against the current page. They handle supplier-normalized labels, including Bangalore/Bengaluru, without accepting another city/property. Generic searches require a place suggestion rather than a similarly named hotel; remembered-trip suggestions are not geographic autocomplete evidence. A discarded field invalidates its checkpoint. Search verifies visible results without requiring a document navigation, so SPA updates work too. The model receives only currently available field skills and may restart the supplier homepage once after a reset; the supervisor can use its remaining bounded search after a no-progress stop. All recovery still enters fields through UI, never a constructed results URL.

The action gateway blocks telephone and payment fields by type as well as label. It detects changes to associated labels, accessibility labels and form membership before using a previously observed control. Snapshot links and out-of-stay calendar cells that cannot be acted on, plus redundant intake audit prose, are omitted from the model copy to reduce input; full runtime evidence remains unchanged. A failed submission stays unavailable until verified form state changes, even if page animations or promoted controls change. Known repeated city aliases such as `Bangalore (Bengaluru)` cannot discard an otherwise exact hotel suggestion. Safe AI failure diagnostics distinguish provider HTTP errors, timeouts, oversized required observations and invalid action schemas without exposing credentials or response bodies.

Groq decision schemas are derived from the same Zod validators used at runtime, including bounded summaries, IDs and address quotations, then restricted to currently permitted action names and target IDs. This avoids asking the provider for an unconstrained string and later rejecting it solely for exceeding a separate runtime limit. Strict structured output constrains the supplied schema, not hotel eligibility or successful browser operation; those require the independent guards described above. See [Groq's structured-output documentation](https://console.groq.com/docs/structured-outputs).

Generic highest-rating selection requires an observed guest rating; a specifically requested hotel does not. Model clarification cannot override an already explicit, source-grounded occupancy count, and contradictory counts still require clarification. Essential omitted adults/rooms are asked before a speculative budget-basis question.

```text
Frontend
  ├─ POST /api/runs
  ├─ SSE  /api/runs/:id/events
  └─ POST /api/runs/:id/cancel|close
              ↓
LangGraph.js (validated state + in-process checkpoints)
  START → IntakeAgent → PolicyAgent → DiscoveryAgent → SupervisorAgent (configured model)
                                           ├─ search → SearchAgent (model browser loop) + deterministic ranking
                                           ├─ inspect/retry → RoomAgent (model rate decisions + hard verification)
                                           ├─ needs_human/stop → safe terminal outcome
                                           └─ checkout (verified room only) → CheckoutAgent → SafetyAgent
  Search/room outcomes return to SupervisorAgent for the next evidence-driven delegation.
  SafetyAgent → humanApproval interrupt (close only) → END
              ↓
Guarded browser-tool gateway → isolated Chrome → requested provider
              ↓
Read-only lock at guest-details/payment boundary
```

Each agent performs real, separate work:

| Agent | Responsibility |
|---|---|
| IntakeAgent | Correct noisy language with the selected core model, extract structured intent, and validate every field before execution. |
| PolicyAgent | Bind navigation to the requested provider domain, INR budget cap, and forbidden actions. |
| DiscoveryAgent | Use Google-grounded public evidence to assess hotel/location identity; cite sources and request clarification for ambiguity. |
| SupervisorAgent | Use the selected core model to delegate from worker evidence, bounded recovery choices and remaining budgets. |
| SearchAgent | Observe the live search UI, ask the model for the next guarded tool, verify outcomes, replan after failures and extract live cards. |
| RankingAgent | Compare complete displayed totals, including separately displayed taxes. |
| RoomAgent | Use the selected core model to choose an eligible observed rate or re-observe; hard-check occupancy, policies, quantity and price. |
| CheckoutAgent | Use the verified room quantity and navigate only to guest details. |
| SafetyAgent | Detect protected fields, lock browser tools read-only, capture proof, and stop. |

LangGraph owns shared state, conditional routing, checkpoints and the human interrupt; SupervisorAgent makes the permitted delegation decisions. Cancellation, audit events and browser cleanup remain enforced by the runtime. Multiple agents never click the browser concurrently.

### Why LangGraph instead of CrewAI

CrewAI is a valid Python framework for open-ended crews that delegate and converse. This workflow is a transaction-adjacent browser process: control flow, retry bounds, state transitions, and the human stop must be inspectable and deterministic. LangGraph.js fits the existing Node/Playwright runtime and makes those transitions explicit without introducing a second Python service.

The current `MemorySaver` checkpointer preserves and resumes graph state during the running Node process. A production deployment should replace it with a PostgreSQL checkpointer; if workflows must survive worker crashes or wait days for approval, place the graph execution inside Temporal rather than pretending in-memory state is durable.

### Runtime stack

| Layer | Technology | Purpose |
|---|---|---|
| Language understanding and decisions | Gemini or Groq structured output | Spelling correction, typed agent decisions and hotel-intent extraction with explicit failures |
| Orchestration | LangGraph.js | Stateful nodes, conditional edges, checkpoint/resume, human interrupt |
| State contracts | Zod | Runtime validation for task and graph state |
| Computer use | Playwright + visible Chrome | Semantic UI interaction and live supplier evidence |
| Tool security | Capability-scoped gateway | HTTPS/domain allowlist, purpose-specific actions, read-only transaction lock |
| Live telemetry | Server-Sent Events | Ordered agent events from backend to control tower |
| Audit | JSON trace + screenshots | Reproducible evidence for decisions and the stop boundary |
| Cancellation | AbortController | Propagated run cancellation and browser cleanup |

## Agent tools

Agents do not receive arbitrary browser access. The gateway exposes purpose-specific operations:

- start isolated browser session;
- route to the requested public provider, with Booking.com as the default;
- use a verified adapter when available or bounded semantic computer use otherwise;
- apply allowed breakfast/cancellation filters;
- observe hotel cards and complete displayed totals;
- open a ranked candidate;
- observe and select a verified room;
- continue only to guest details;
- capture evidence and close the session.

Navigation is restricted to HTTPS pages on the single provider domain selected during intake, including its subdomains. Cross-provider redirects, private hosts, transaction buttons, and unproven totals are blocked. Once guest or payment fields are detected, every write action is rejected.

This gateway is an internal tool layer, not an MCP server. MCP is useful when these capabilities must be shared with external model hosts; wrapping the same narrow operations as MCP tools is straightforward, but adding MCP inside one Node process would add transport without adding safety or capability. The architecture keeps the tool contracts MCP-shaped and provider-neutral.

## Frontend and local API

- `POST /api/intake` runs AI-assisted interpretation and deterministic validation.
- `POST /api/runs` starts one browser run.
- `GET /api/runs/:id/events` streams sequence-numbered agent events using Server-Sent Events.
- `GET /api/runs/:id` returns current state and evidence.
- `POST /api/runs/:id/cancel` aborts an active run and closes Chrome.
- `POST /api/runs/:id/close` closes the browser after the safe boundary.
- `GET /api/runs/:id/artifacts/02-booking-boundary.png` returns the proof screenshot.

Only one run is allowed at a time so agents cannot fight over the same browser.
For a temporary remote test, a separate loopback runtime on port 4184 can be shared through the password-protected gateway on port 4185. The gateway authenticates every route, checks the exact HTTPS Host and Origin, strips sharing credentials before forwarding, blocks framing, and preserves event streaming. It never removes the local agent service's own guards.

The gateway allows up to 100 seconds for intake response headers so its timeout covers the core model's 90-second deadline, including free-plan pacing. The frontend bounds intake to 95 seconds and allows local cancellation before browser launch. Other gateway requests retain a 20-second header deadline; an established event stream is not buffered or cut off by that deadline.

The private, Git-ignored `.env.share` contains `SHARE_PORT`, `SHARE_UPSTREAM`, `SHARE_PUBLIC_ORIGIN`, `SHARE_USERNAME` and `SHARE_PASSWORD`. Keep the password out of URLs and send it separately from the link. After stopping any existing sharing processes, restart with: start `AGENT_PORT=4184` using `npm run agent-ui`; run `ngrok http http://127.0.0.1:4185 --inspect=false`; update `SHARE_PUBLIC_ORIGIN` to its actual HTTPS URL; then run `npm run share-gateway`. The upstream must remain loopback-only and the password must contain at least 16 characters. A new tunnel hostname requires updating the configured origin; mismatches fail closed.

`npm run test:share` checks the gateway against an isolated HTTP fixture. `npm run test:share:live` verifies password/Origin rejection, the real frontend, API input validation and event streaming through the configured public tunnel. The live sharing probe deliberately uses an invalid calendar date and never opens a supplier browser. This is temporary access to this computer, not a cloud deployment; keep the PC, runtime, gateway and tunnel running, and do not run local and remote browser jobs simultaneously on a low-memory machine.
Concurrent starts are rejected atomically, matching intake requests share one model call, reconnecting clients receive only new events, and terminal in-memory run history is limited to 32 entries. The local service rejects foreign request origins and non-loopback Host headers. Disk audit artifacts are retained separately.

## Safety guarantees

The computer-use platform does not:

- use a saved browser profile, stored account, or saved cards;
- type names, email, phone, address, passwords, OTPs, or card data;
- click final-booking, purchase, or payment controls;
- treat an unknown total, occupancy, or policy as acceptable;
- bypass CAPTCHA, bot challenges, login walls, or unsafe redirects;
- substitute simulated hotels when the live browser run fails.

The browser stops at the first guest-details page. Payment is outside the implemented scope.

## Verification

```powershell
npm test
npm run test:all
# Controlled Google-search contracts, identity handoff and safe citation UI:
npm run test:discovery
# Two actual Google-grounded identity lookups; no supplier browser is opened:
npm run test:discovery:live
# Actual model decisions against an isolated supplier fixture, not live inventory:
npm run test:agentic:live
# Actual supervisor/room-model decisions against controlled evidence, not live hotels:
npm run test:workflow:live
# With npm run agent-ui running, this operates live sites and stops before transactions:
npm run test:intake:live
npm run test:live
```

The offline suite covers parsing, providers, navigation restrictions, dates, exact totals, graph topology, the frontend, Worker build and deployment artifact. Thirty-seven real-graph scenarios use controlled tools and injected test decisions, including adaptive delegation, transient room/search recovery, fresh-session recovery from a static destination-page redirect, invented IDs, premature checkout, worker-model failure, price changes during supervisor review and changed or incomplete checkout evidence. These fixtures are not live inventory and the production code never uses their test routing. Actual-model suites are separate from controlled provider contracts; configuring Groq is not evidence of a successful live run. Browser fixtures cover autocomplete, wrong locations, delayed/covered controls, SPA submission, room quantities/prices, labels, double clicks and event replay. Nine adversarial browser checks cover mislabeled personal fields, conflicting evidence, hidden mirrors, stale labels, manual date recovery, destination-query conflicts and premature completion without submission. HTTP tests cover concurrent starts, intake coalescing, untrusted origins, cancellation and bounded retention.

The live intake suite checks 17 cases: 12 actual model interpretations and five local invalid-date or contradictory-constraint guards. The latest round passed all 17. The live browser suite separately checks named Pune stays, over-budget rejection, a Kolkata budget range, two-room occupancy, the user's noisy five-night Vizag request, Bengaluru breakfast and a new Chennai one-night request. Successful city-search scenarios require independent physical-address evidence tied to the selected hotel, not just a matching search query. Reports are saved under `artifacts/live-intake-report.json` and `artifacts/live-booking-report.json`. Filter live browser scenarios by name, for example `npm run test:live -- "two rooms" "Vizag"`. Live availability and rates can change; the report records what was observed, not guaranteed inventory. Older report entries predate current fixes and must not be counted as current end-to-end passes.

A historical live run on 9 October 2026 observed 11 Booking.com candidates, selected Millennials Hotel, calculated ₹5,600 plus ₹280 taxes as a ₹5,880 total, checked a breakfast-inclusive room for two adults, reached `secure.booking.com` guest details, and performed no booking or payment. That result predates the stronger physical-address and current-checkout-summary guards; it is not proof that the current full flow passes every live scenario.

Latest verification (14 October 2026): the complete regression suite passed, including 37 controlled graph scenarios and nine adversarial browser checks. Real intake passed 17 cases (12 model calls and five local guards). A live named-hotel run confirmed the Bengaluru address and selected a breakfast-inclusive room at INR 8,921, but did not complete current checkout proof. Subsequent schema and guest-details-action clarification fixes passed actual model contract probes; the final complete live retry was blocked by HTTP 429. Do not claim current end-to-end or universal-prompt reliability until a fresh full live run passes after model availability returns.

## Assignment explanation

This is an agentic computer-use architecture, not RAG. RAG may later retrieve company travel policies or destination knowledge, but it must never invent live availability or prices. The visible supplier UI is the source of live inventory.

The earlier Nuitee/API prototype remains in the repository as a separate comparison path. Its Worker model integration remains Gemini-only; the Groq core provider switch applies to the Node computer-use runtime, not that legacy path. The primary executable assignment is now `npm run agent-ui`.

The primary AI route can inspect semantic controls on the requested domain, but verified search completion currently requires the Booking.com state adapter. Other providers are not end-to-end supported merely because their homepage loads. The older generic scripted gateway remains for explicit adapter development, not a silent recovery from an AI failure. Third-party sites can change UI, require login, redirect to another provider or present a CAPTCHA. The correct behavior is a bounded attempt followed by a precise failure or human handoff—not fabricated availability or challenge bypass. Add and test a provider-specific state verifier before claiming support for another supplier.
Transient model HTTP 502/503/504 responses receive one abort-aware retry within the same request timeout. Invalid model output, quota errors and persistent failures still stop; no scripted browser fallback is used.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md) for shell-specific setup, the available test suites, the pull-request workflow, and guidance on safely reporting problems.
