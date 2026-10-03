# Quant Swarm: Alpaca paper trading implementation plan

SpacetimeDB and Alpaca paper trading are confirmed choices. There is no human approval in the trade path: the deterministic risk gate is the only gate before paper execution. The first strategy, symbols, risk settings, and model provider are open decisions. This plan describes a research-led US equity pilot that can be narrowed or changed without replacing the swarm core.

## 1. Product workflow

1. The operator selects a small stock or ETF universe, sets a research question, review cadence, benchmark, and paper portfolio limits.
2. Data services collect current account state, prices, and company filings. Each fact carries a source, retrieval time, and as-of time.
3. Specialist agents independently analyze filings, valuation, market context, and portfolio exposure. A skeptic agent challenges assumptions and missing evidence.
4. The coordinator creates an evidence-linked investment thesis and either a paper order proposal or an explicit no-trade decision. A proposal includes target size, reason, invalidation condition, review trigger, and expected holding horizon.
5. A deterministic risk gate checks symbol eligibility, buying power, open orders, position and portfolio limits, data age, market hours, and whether the run is paused. It is the only gate before execution; there is no per-order operator approval.
6. The execution adapter submits a risk-passed order to Alpaca's paper API with a unique `client_order_id`. It records Alpaca's order ID and request ID where available.
7. Trade updates and periodic reconciliation update the order lifecycle, fills, positions, and cash. Agents review open positions on a schedule and when thesis conditions change, then propose holds, reductions, or exits. The operator sees a complete decision trace.

Alpaca uses separate paper credentials and a paper trading endpoint at `https://paper-api.alpaca.markets`; market data uses a separate data service. The execution adapter will have a fixed paper endpoint and no live account credentials. Paper fills are simulated and omit some live effects such as market impact and latency slippage, so evaluation must report that limitation. [Authentication](https://docs.alpaca.markets/us/v1.1/docs/authentication-1) · [Paper trading](https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading)

## 2. Architecture

```text
SEC EDGAR ──→ research ingestor ──┐
Alpaca data ─→ market ingestor ───┼─→ SpacetimeDB ←→ agent workers
Alpaca paper ←→ order adapter ─────┘          ↕
                                        operator dashboard
```

The SpacetimeDB module holds authoritative swarm state and enforces state transitions through reducers. Agent workers use subscriptions to react to relevant research, task, and portfolio changes. The data ingestors and order adapter run outside the database because they manage external network calls, rate limits, credentials, and retries. Durable tables record evidence, decisions, order requests, and outcomes; transient event tables are optional for UI notifications. [Architecture](https://spacetimedb.com/docs/intro/key-architecture/) · [Reducers](https://spacetimedb.com/docs/functions/reducers/) · [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions/) · [Event tables](https://spacetimedb.com/docs/tables/event-tables/)

Use SEC EDGAR company submissions and XBRL facts as a primary source for fundamentals. Ingestion needs caching, source timestamps, and the SEC's fair-access limits. Alpaca supplies trading/account state and market data, whose feed and historical access depend on account entitlements. Validate the selected feed during setup; do not assume free data covers every US venue. [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces) · [SEC developer guidance](https://www.sec.gov/about/developer-resources) · [Alpaca market data FAQ](https://docs.alpaca.markets/us/docs/market-data-faq)

## 3. Agent roles

| Role | Output |
| --- | --- |
| Filing analyst | Extracts revenue, margins, cash flow, debt, guidance, and material filing changes with citations and as-of dates. |
| Valuation analyst | Builds simple, explicit scenarios and identifies assumptions driving upside and downside. |
| Market/portfolio analyst | Checks price and liquidity context, current exposure, cash, and diversification. |
| Skeptic | Finds missing evidence, stale data, accounting caveats, and reasons to reject the trade. |
| Coordinator | Resolves conflicting claims and produces a concise thesis and trade proposal; cannot bypass risk policy. |

For the first pilot, combine roles where needed to keep the worker count small. Agents communicate through structured messages keyed by research run, symbol, and task. Each message includes a claim or question, evidence references, timestamp, and intended recipient or role. Store full prompts and large source documents outside high-frequency SpacetimeDB tables, with stable references in the database.

## 4. Data model

| Table | Purpose and important fields |
| --- | --- |
| `run` | Research goal, universe, status, policy version, model budget, creation time. |
| `agent` | Identity, role, capabilities, heartbeat, status. |
| `task` | Symbol, objective, dependencies, status, owner, lease expiry, version. |
| `source` | URL or accession, source type, retrieved time, as-of time, checksum, artifact reference. |
| `fact` | Symbol, metric, value, unit, period, source ID, confidence/quality flag. |
| `message` | Run, symbol, task, sender, kind, compact content, evidence references. |
| `thesis` | Symbol, bull/bear case, assumptions, catalysts, invalidation, evidence, version. |
| `decision` | Thesis, decision to trade or abstain, rationale, reviewer, time, next review trigger. |
| `trade_proposal` | Symbol, side, quantity or notional, order type, limit price, thesis ID, status, proposed time. |
| `risk_decision` | Proposal, policy version, checks, result, reviewer, time. |
| `paper_order` | Proposal, client order ID, Alpaca order ID, request ID, status, submitted/updated times. |
| `fill` | Order, event ID, quantity, price, time; deduplicated on Alpaca identifiers. |
| `account_snapshot` | Private account ID/status, cash, buying power, equity, JSON position/order snapshots, capture time. |
| `market_observation` | Private, scoped symbol/feed bid and ask observations with Alpaca source time and SpacetimeDB capture time. |
| `reconciliation` | Snapshot time, source IDs, discrepancies, resolution status, operator acknowledgement. |
| `run_metric` | Research cost, latency, policy failures, order discrepancies, and portfolio metrics. |

Index run and symbol fields used by subscriptions and lookups. Keep account, order, and confidential research rows private; expose only scoped views to authorized agents and the dashboard. Reducers must check caller identity and payload bounds. [SpacetimeDB table access](https://spacetimedb.com/docs/tables/access-permissions/) · [SpacetimeDB authorization](https://spacetimedb.com/docs/http/authorization/)

## 5. Order and risk state machine

Keep the risk verdict, submission attempts, Alpaca order status, and reconciliation as separate state fields; Alpaca has intermediate statuses such as `pending_cancel`, `done_for_day`, and `replaced` in addition to filled, canceled, and rejected. A risk pass expires after a configured interval or a material change in account, quote, or thesis. The risk gate is code with versioned configuration. It should reject stale account or market snapshots, unknown symbols, duplicate pending intent, excessive exposure including pending orders, and proposals outside the run's policy. Neither the proposing agent nor the coordinator can mark its own proposal as risk passed. The execution adapter rechecks the unexpired risk pass and latest account state immediately before submission. [Alpaca order lifecycle](https://docs.alpaca.markets/us/docs/orders-at-alpaca)

Use a deterministic, unique `client_order_id` for every order intent. Alpaca supports tracking orders by this ID and streaming order updates. On timeout, query Alpaca by client order ID before retrying; never assume a failed HTTP response means no order was accepted. If submission remains uncertain, block another submission for that intent until reconciliation resolves it. Reconcile open orders, positions, account state, and account activities on startup and periodically, because a streaming connection can drop and manual paper-account activity can occur outside this app. Record partial fills once using Alpaca activity IDs. [Working with orders](https://docs.alpaca.markets/us/docs/working-with-orders) · [Trade update stream](https://docs.alpaca.markets/us/docs/websocket-streaming) · [Account activities](https://docs.alpaca.markets/us/docs/account-activities)

The operator can pause new proposals and submissions and can request cancellation of open paper orders. Pausing does not erase a submitted order or guarantee cancellation. The dashboard should distinguish requested, accepted, filled, and reconciled states. Keep paper API secrets in the execution service's secret store, never in SpacetimeDB rows or agent prompts.

### Research and strategy contract

Before judging a trade, define the pilot's eligible symbols, long-only or other side permissions, intended holding period, maximum order frequency, allowed order types and time-in-force, market-hours behavior, thesis review schedule, and what merits a no-trade decision. Treat these as versioned configuration, not ad hoc agent instructions. A thesis must cite source IDs and include dates for both the underlying company facts and the market price. A pre-trade snapshot freezes the evidence available when the decision was made, so later filings cannot leak into historical evaluation. For SEC XBRL facts, preserve reporting period, filing date, units, and amended-filing status; flag inconsistent or missing facts for review. [SEC EDGAR APIs](https://www.sec.gov/search-filings/edgar-application-programming-interfaces)

Market-hours logic should use Alpaca's clock/calendar rather than local weekday assumptions, including early closes. After entry, the position monitor revisits the thesis on its review date, a new filing, a risk breach, or an invalidation trigger. Holds and exits go through the same evidence, risk, and order path as entries. Corporate actions or symbol changes must prompt reconciliation and a new review rather than a silent adjustment to the thesis. [Alpaca calendar](https://docs.alpaca.markets/us/v1.4.2/reference/getcalendar-1) · [Corporate actions](https://docs.alpaca.markets/us/docs/mandatory-corporate-actions)

### Operating controls

Fail closed for new paper submissions when Alpaca, SpacetimeDB, the risk gate, or required data is unavailable; continue recording recovery and reconciliation events. Alert the operator on stale market/account data, stuck orders, a broken trade-update stream, rejected orders, an exposure breach, or an unresolved account mismatch. Specify a backup and restore procedure for SpacetimeDB and source artifacts, and verify one restore before an unattended run. Keep a versioned policy and deployment record so every decision can be tied to the code, model, data, and limits in force at the time.

## 6. Delivery phases and checks

| Phase | Deliverable | Exit check |
| --- | --- | --- |
| 0. Connectivity | Pin compatible SpacetimeDB CLI and SDK versions; connect read-only to Alpaca paper account and data API. | Read account, positions, open orders, and selected market data without sending an order. |
| 1. Swarm core | Module tables, reducers, subscriptions/views, identities, task leases, and message protocol. | Three workers can exchange a sourced thesis and recover after a worker restart. |
| 2. Research | SEC filing ingestor, source store, dated fact extraction, evidence links, and skeptic review. | A thesis or no-trade decision can be traced to information available at its decision time. |
| 3. Risk and review | Versioned paper strategy/risk policy, risk-pass expiry, and an authoritative risk gate that is the only check before execution. | Tests reject stale, duplicate, over-limit, unauthorized, and expired proposals. |
| 4. Paper execution | Fixed paper endpoint, order submission, client IDs, trade updates, account-activity reconciliation, and cancel workflow. | One risk-passed test order reaches a reconciled state with no duplicate submission after a simulated timeout; partial fill and external activity are handled. |
| 5. Position monitoring | Scheduled thesis reviews and event-triggered hold/exit proposals. | A held paper position gets reviewed and a proposed exit follows the same risk path as entry. |
| 6. Evaluation and operations | Paper run reports, baseline comparison, alerting, failure drills, backup/restore, and cost accounting. | Report decision quality, no-trade rate, policy compliance, paper P&L and drawdown, order discrepancies, model/API cost, and a successful restore drill. |

Start with a tiny watchlist and a low paper notional cap. The first end-to-end demo is complete when an agent-generated thesis passes independent review, the risk gate passes one paper order, Alpaca records it, and the dashboard shows the resulting order and position state. Compare decisions with a declared baseline over the same dates and symbols; report both accepted trades and abstentions, and separate research errors from broker simulation effects. Paper performance is an experiment, not evidence of future live returns. Alpaca states that paper trading does not simulate dividends or several live execution effects, so the evaluation must account for those limits. [Alpaca paper trading limitations](https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading)

## 7. Proposed repository layout

```text
AGENTS.md                    Product brief and standing guidance
IMPLEMENTATION_PLAN.md       Architecture and delivery plan
spacetimedb/                 Schema, reducers, views, schedules
packages/protocol/           Shared domain types and validation
apps/worker/                 Agent roles and coordination loop
apps/dashboard/              Research, risk review, and portfolio UI
adapters/sec/                EDGAR ingestion and artifact references
adapters/alpaca-data/        Market data and account observations
adapters/alpaca-paper/       Paper-only order execution and reconciliation
tests/integration/           State transitions, order timeout, reconnect
docs/decisions/              Architecture and policy decisions
```

## 8. Open product decisions

- Starting universe, strategy hypothesis, holding horizon, research cadence, baseline, and explicit no-trade criteria; choose a narrow, testable strategy rather than an open-ended search for trades.
- Paper account credentials and available market-data feed; confirm entitlements before relying on a quote or bar.
- Initial per-order notional, per-symbol exposure, total exposure, daily loss, maximum open-order limits, and risk-pass lifetime.
- Whether the first pilot covers long-only stocks/ETFs, which is the proposed narrow scope, or other asset classes.
- Model provider, spending limit, run schedule, and deployment location.

## 9. How the agents connect to SpacetimeDB

Each agent role is a long-running worker process with one SpacetimeDB client connection. The workers, research adapters, risk gate, and paper execution adapter use the same connection pattern but have separate identities and permissions. The database module stores shared state; model calls, SEC requests, Alpaca requests, and other slow work run in the workers or adapters. [SpacetimeDB architecture](https://spacetimedb.com/docs/intro/key-architecture/) · [Functions and external I/O](https://spacetimedb.com/docs/functions/)

### Connection lifecycle

1. **Configure:** give each process the database URI, database name, role, and a dedicated authentication token. Use `ws://localhost:3000` locally and a secure `wss://` or `https://` URI when remote. Keep tokens outside the repository. A development connection without a token gets a new identity; persist the issued token per logical worker so its identity survives a restart. Use OIDC service identities for deployed workers. [Node.js quickstart](https://spacetimedb.com/docs/quickstarts/nodejs/) · [Authentication](https://spacetimedb.com/docs/core-concepts/authentication/)
2. **Build a client:** generate TypeScript bindings from the module with `spacetime generate`, then create a `DbConnection` using `withUri`, `withDatabaseName`, `withToken`, `onConnect`, `onConnectError`, and `onDisconnect`. The Node.js worker uses the `spacetimedb` package and its generated module bindings. The official `spacetime dev --template nodejs-ts` project supplies a working local starting point. [Node.js quickstart](https://spacetimedb.com/docs/quickstarts/nodejs/) · [TypeScript client](https://spacetimedb.com/docs/clients/typescript/)
3. **Subscribe before working:** the current Node.js worker subscribes to agent and run tables and to task/message rows for its `RUN_ID`. It waits for `onApplied`, then reads the cache and reacts to task and message row callbacks. Its demo subscription is run-scoped for tasks and messages, but is not yet role-filtered. [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions/)
4. **Grant, heartbeat, and claim:** the module owner calls `grantAgent` for each worker identity; workers cannot assign their own roles. A granted worker calls `heartbeat`. When a candidate task appears, a coordinator, analyst, or skeptic calls `claimTask(taskId, expectedVersion)`. The reducer checks the caller role, active run, open task state, and version, then atomically assigns the worker and schedules a 60-second lease expiry. A task can also require a role and a completed same-symbol dependency. The worker renews its lease every 20 seconds while working. [Reducers](https://spacetimedb.com/docs/functions/reducers/) · [Schedule tables](https://spacetimedb.com/docs/tables/schedule-tables/)
5. **Communicate and finish:** an agent calls `postMessage` to insert a durable row containing its authenticated sender, run/task IDs, symbol, recipient role, typed kind, body, and validated evidence references. Connected clients subscribed to the matching run receive that row as a live update; reconnecting clients see stored rows in the initial snapshot. The recipient role is a routing label; delivery is still run-wide rather than private. The worker supports deterministic rules or structured model calls for analyst, skeptic, and coordinator tasks; model coordinators consume stored skeptic challenges. The assignee can complete or fail its task while the lease is valid. Stable message IDs make identical retries idempotent.
6. **Recover:** the worker saves one token per logical agent under `~/.local/share/quant-swarm/tokens/` by default. A direct `DbConnection` does not reconnect itself, so the worker creates a fresh connection with bounded exponential backoff, restores subscriptions, and reads a new snapshot. The module's scheduled expiry reopens a still-claimed task only if the scheduled lease version remains current. After each snapshot the worker resumes any task it still holds, using stable thesis, message, and decision IDs so a retry does not duplicate work, and records `failTask` for permanent errors instead of retrying. [Connection recovery](https://spacetimedb.com/docs/clients/connection/) · [Authentication](https://spacetimedb.com/docs/core-concepts/authentication/)

The module validates roles in state-changing reducers. All authoritative trading/research tables are private; indexed identity/run/account-scoped views enforce reads and live revocation. The separate localhost development board uses public tables and self-declared session names. Production service identities and deployment provisioning remain required before remote hosting. The worker's identity and role are separate concepts: a client-supplied role string is not proof of authority. [Table permissions](https://spacetimedb.com/docs/tables/access-permissions/) · [Views and access control](https://spacetimedb.com/docs/how-to/rls/)

### First connection milestone

Build the smallest vertical slice before integrating Alpaca: one module with `agent`, `task`, and `message` tables; two Node.js workers with distinct saved identities; and reducers for registration, task creation, claiming, and completion. Create one task and verify that both workers see it, exactly one claim succeeds, the winner posts a result, and a restarted worker reconnects with the same identity and sees the correct task state. This proves the communication mechanism that the later paper-trading workflow depends on.

### Implemented backend snapshot

As of 2026-10-03, **Phase 1 is complete for the local prototype**. `npm run check:phase-one` passed against the published database with real worker processes: private views, role/run/account isolation and live revocation; a two-worker claim race; same-token restart; analyst/skeptic/coordinator sourced decision; pause/resume; expired-lease takeover preserving authorship; maximum-length IDs; and a 65-second task completing through renewable leases. Acceptance run: `phase-one-1791058021567`. Temporary roles were revoked and runs closed. No model/provider/broker calls were made by that check.

All authoritative tables are private. Indexed `my_*` views enforce authenticated role/run/account grants. Workers support `AGENT_BRAIN=rules|claude|codex`; structured handlers have separate synthetic model tests, and earlier handoffs record a live Codex cycle. Model calls reserve durable run budgets, record actual model/usage/output, and replay completed output after interruptions. Decision input rows freeze evidence, critiques, sizing quote and configuration.

Risk is recomputed in the module against an immutable operator policy and stored snapshot/clock, with strict parsing, per-symbol marks and account-wide reservations. Changed inputs invalidate a pass; unsubmitted proposals can be re-reviewed with prior verdicts archived. Fresh risk passes authorize paper intent reservation without human approval. Order/fill reducers enforce identity, state and exact cumulative quantity. These are local ledger checks; no Alpaca order was submitted.

| Phase | Current status |
| --- | --- |
| 0 | Connectivity implemented; real Alpaca paper-account/feed read pending. |
| 1 | Local swarm core complete and acceptance passed. Production service/OIDC provisioning remains deployment work. |
| 2 | SEC primary-filing artifacts/manifests and accession-filtered facts, evidence/thesis pipeline, immutable decision inputs and model audit implemented. Qualitative excerpts, richer research/exit semantics and a real model-backed sourced decision acceptance remain. |
| 3 | Authoritative policy/risk gate and regression checks passed. Risk-worker implementation and build integration are complete; live broker inputs remain unverified. |
| 4 | Paper-only polling executor, stable client IDs, order/fill recording and basic order reconciliation implemented. Live broker acceptance, durable attempt recovery, immediate pre-submit revalidation, full account reconciliation/interlock, per-order cancellation and trade-update stream remain. |
| 5 | Position monitoring not implemented. |
| 6 | Trading/development dashboards, supervisor, isolated CI checks and verified offline backup/restore implemented. Currency-cost reporting, evaluation/benchmark, alerts and production deployment remain. |

See [IMPLEMENTATION_REVIEW.md](IMPLEMENTATION_REVIEW.md) for original findings and follow-up resolutions. `scripts/check-phase-one.ts` creates clearly labeled synthetic local order/fill records for reducer regression; these are not broker trades. The first risk-passed and reconciled Alpaca paper-order demo has not run.
