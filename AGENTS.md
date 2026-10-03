# Quant Swarm: project brief

## Purpose

Build a system in which multiple specialized agents share a live view of a changing environment, communicate through structured messages, divide work, and coordinate actions. SpacetimeDB is the shared state and communication backbone. The system should make every decision traceable: what an agent observed, what it proposed, who accepted it, what action ran, and what happened next.

The first application is a fundamental analysis swarm that coordinates with Alpaca to place and monitor **paper trades**. Agents research companies, challenge each other's investment theses, propose trades, and track the results in a simulated brokerage account. Factorio and Minecraft remain possible later applications of the same swarm core.

## What the system should do

An operator defines a research universe, paper portfolio, and risk limits. Data adapters publish market and company observations to SpacetimeDB. Agents subscribe to relevant changes, collect evidence, debate opportunities, and submit trade proposals with a thesis, valuation or catalyst, counterarguments, confidence, and exit conditions. A deterministic risk gate checks each proposal against account state and policy; it is the only gate before execution, with no per-order human approval. A paper execution service sends risk-passed orders to Alpaca, then records order updates, fills, positions, and portfolio outcomes back in SpacetimeDB. The operator can see why each order was proposed and what happened to it.

Candidate roles are filing analyst, valuation analyst, market or portfolio analyst, skeptic, and coordinator. Roles should be configurable; the first prototype should use only the roles needed to prove useful collaboration. Messages should carry a type, run ID, security symbol, task ID, author, timestamp, and compact payload or evidence reference. Avoid broadcasting full prompts or every token to every agent.

## Core architecture

```text
SEC filings + market data       Alpaca paper account
          ↕                            ↕
 Research adapters         Paper execution adapter
          ↘                            ↙
 SpacetimeDB: research, tasks, messages, proposals, risk, orders, outcomes
          ↕
 Agent workers                              Operator dashboard
```

SpacetimeDB's module owns authoritative swarm state and validates writes through reducers. Workers run outside the database so they can call models and data sources. Subscriptions deliver relevant state changes to workers and the dashboard. Durable tables retain evidence, decisions, orders, and outcomes for recovery and audit. The paper execution adapter alone holds Alpaca paper credentials and may submit orders. A separate risk gate uses fixed rules and is the only check between a proposal and a paper order; an agent cannot pass its own trade by wording its proposal differently.

## How the agents connect to SpacetimeDB

**Connection model.** Each logical agent runs as a separate, long-lived worker process and opens its own client connection to the same SpacetimeDB database. Research ingestors, the risk gate, the paper execution adapter, and the dashboard also connect as clients, each with an identity and permissions appropriate to its job. The proposed first implementation uses the official TypeScript/Node.js SDK. SpacetimeDB hosts a module containing tables, reducers, and views; the workers run model inference and external API calls outside that module. The SDK maintains a WebSocket connection and a local cache of subscribed rows. [Architecture](https://spacetimedb.com/docs/intro/key-architecture/) · [Node.js client](https://spacetimedb.com/docs/quickstarts/nodejs/)

**Setup and address.** Build and publish the module to a local SpacetimeDB host first. Generate module-specific client bindings with `spacetime generate` whenever the module schema changes. A worker creates a generated `DbConnection` with the host URI, database name, and token. Local development uses `ws://localhost:3000`; a remotely hosted database uses its secure host URI. The worker receives its URI and database name from configuration, not from agent prompts. `spacetime dev --template nodejs-ts` provides a local module and working Node.js client as the starting scaffold. [Node.js quickstart](https://spacetimedb.com/docs/quickstarts/nodejs/) · [Connection API](https://spacetimedb.com/docs/clients/connection/)

**Identity and access.** Give each logical worker a distinct token. During local development, a tokenless first connection receives an identity and token; save that token securely per worker and supply it on later connections so a restart retains the same identity. For deployment, use OIDC service identities and validate identity and authorized role in module functions. An agent cannot gain permission by naming itself a different role. Keep Alpaca credentials only in the paper execution adapter; never put tokens or API keys in public tables or messages. Private tables hold sensitive state, while scoped views expose only rows a client is permitted to read. [Authentication](https://spacetimedb.com/docs/core-concepts/authentication/) · [Table access](https://spacetimedb.com/docs/tables/access-permissions/) · [Views for access control](https://spacetimedb.com/docs/how-to/rls/)

**Read and write flow.** On connection, an agent waits for `onApplied` before processing its subscription snapshot, then reacts to row insert/update callbacks. To change shared state, clients call generated reducers; they never edit their local cache directly. The owner uses `grantAgent` and `revokeAgent`; a granted worker uses `heartbeat`. Operators create runs, coordinators or operators create tasks, and coordinator/analyst/skeptic workers claim tasks. `claimTask` checks the task's expected version and open status in one atomic transaction, so only one competing claim succeeds. [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions/) · [Reducer transactions](https://spacetimedb.com/docs/functions/reducers/)

**Agent-to-agent communication.** Agents communicate by writing messages to the shared `message` table with `postMessage`. Each row records its stable message ID, run ID, optional task ID and symbol, authenticated sender, recipient role, typed kind, body, validated evidence references, and creation time. Other clients subscribed to that run receive the inserted row as a live update and can read it from their local cache. Messages are durable shared records, so reconnecting clients can also receive existing rows in the subscription snapshot. The recipient role is a routing label, not private delivery: messages are run-wide for clients that subscribe to that run. Workers log incoming messages; model coordinators consume stored skeptic challenges when deciding a thesis. [Subscription updates](https://spacetimedb.com/docs/clients/subscriptions/)

**Recovery and coordination.** A direct Node.js `DbConnection` does not reconnect itself. On error or disconnect, the worker creates a new connection with bounded backoff and the same token, restores subscriptions, waits for a fresh snapshot, and reconciles its unfinished tasks and uncertain reducer results before resuming. Claimed tasks have renewable leases; an expired lease can be returned to the queue by a scheduled reducer. A reconnect must not create a second trade proposal or paper order, so proposals and order intents carry stable IDs. The risk gate and paper execution adapter retain their separate authority even when an agent reconnects. [Reconnection behavior](https://spacetimedb.com/docs/clients/connection/) · [Scheduled work](https://spacetimedb.com/docs/tables/schedule-tables/)

**First proof.** Before adding Alpaca integration, run two workers with distinct identities against one local database. Both must see a new task, exactly one must claim it, the result must appear for the other worker, and a restarted worker must reconnect with its original identity and recover the correct task state. The detailed schema, reducer surface, and delivery phases are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

**Current backend implementation.** The local module defines tables for agents, runs, tasks, messages, research sources and facts, theses, decisions, trade proposals, risk decisions, operator approvals, and paper-order records. Reducers cover owner role grants, heartbeats, run/task lifecycle, task leases, messages, research records, thesis review, and gated order-ledger updates. A task claim lasts 60 seconds; the scheduled expiry reducer reopens it only if its lease version is still current. Tasks can require a role and depend on another task; workers renew leases while working and resume tasks they still hold after a restart. With `AUTO_CLAIM=1`, a worker acts on its granted role: the analyst publishes a thesis citing stored evidence, the skeptic challenges it, and the coordinator queues the review and records a decision. The default `AGENT_BRAIN=rules` uses deterministic placeholders and produces a non-trading decision; `claude` and `codex` use structured model calls. Valid model trades commit a decision and proposal atomically for separate risk review; the risk gate, not an operator, decides whether the order proceeds. Without that flag it observes and logs updates. A fixture ingestor supplies labeled placeholder evidence for reproducible checks; an initial SEC company-facts ingestor supplies reported filing facts. All authoritative tables are private, with identity/run/account-scoped `my_*` views and explicit owner grants. Local Phase 1 acceptance passes via `npm run check:phase-one`, including process restart, lease renewal/takeover and read revocation. Model calls have durable run budgets and output audit; coordinator decision inputs are frozen. The full reducer inventory and current limitations are documented in [README.md](README.md). Research workers select the latest 10-K and 10-Q plus recent non-SEC sources, up to 6 sources and 40 facts; every selected source retains all its facts. Quotes use the latest observation per feed. Prompts disclose omitted counts and IDs, exclude them from valid citations, and enforce 30,000 characters of evidence and 48,000 characters overall. A task fails with a permanent error if its minimum required evidence cannot fit. Selection is shared by model and rules workers and deterministic across cache insertion order.

## First application: Alpaca paper trading

Start with a small universe of liquid US stocks or ETFs and one paper account. A first research cycle pulls recent SEC filings and Alpaca market data, checks data freshness, builds evidence-linked theses, and invites an opposing view. The coordinator can recommend a bounded trade or **no trade** when evidence is weak. The risk gate checks symbol eligibility, buying power, current positions and open orders, per-position and portfolio limits, market hours, and run status. There is no human approval step in the trade path: a fresh risk pass is sufficient for the paper execution adapter to submit. The operator oversees through pause, inspection, cancellation, and policy changes rather than per-order approval. The adapter submits only to Alpaca's paper endpoint and reconciles the resulting order and position state.

The swarm must manage open positions as well as entries. Each thesis has a review date or trigger, invalidation conditions, and a proposed exit path. New filings, major price moves, fills, and portfolio drift can trigger a fresh review. A paused run blocks new submissions; an account or data mismatch blocks trading until reconciled. The initial product objective is to prove coordinated, evidence-based decisions and reliable paper execution, not to promise a profitable strategy.

Alpaca paper trading simulates fills and does not reproduce every live-market effect. Evaluate the swarm by decision quality, evidence quality, policy compliance, reconciliation, and paper portfolio behavior; do not treat paper returns alone as proof of a profitable live strategy. The system must never infer that an accepted order request is a fill. It should use Alpaca order updates and periodic account reconciliation to determine what happened. [Alpaca paper trading](https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading) · [Order updates](https://docs.alpaca.markets/us/docs/working-with-orders)

## Later applications

- **Minecraft:** Ten Mineflayer agents on a private offline-mode server, with privileged local game state, a fixed command set, no orchestrator, and SpacetimeDB as their only communication channel. The pilot studies information sharing between agents. The plan is in [GAME_AGENT_IMPLEMENTATION_PLAN.md](GAME_AGENT_IMPLEMENTATION_PLAN.md); the earlier screenshot-only, real-client design is deferred there.
- **Live trading:** A possible separate product phase only after paper evaluation, an independent risk design, and explicit owner authorization. The paper trading service must not have live credentials or a configurable live endpoint.

## Operating principles

- **push when finished:** After completing a task, run its required checks, commit its completed changes, and push the commit to the current tracking branch. Coordinate Git staging with other sessions and preserve unfinished work. Include the pushed commit and check results in the board result and handoff. Every board task must carry the literal instruction "push when finished"; this applies to future tasks as well.
- Continuously maintain the shared [HANDOFF.md](HANDOFF.md) while working: create an entry when you start, update it as meaningful work, findings, decisions, checks, or blockers arise, and leave it with the current status and concrete next steps before you stop. Keep your entry distinct; do not overwrite another agent's handoff.
- Use SpacetimeDB as the source of truth for live swarm state. Store large documents or raw model traces outside hot tables and keep references in the database.
- Make messages purposeful. Publish observations and decisions that another agent can act on; scope subscriptions by run and role.
- Treat model output as a proposal. Validate evidence, permissions, buying power, exposure limits, and current account state before execution.
- Give every order a unique client order ID and recorded lifecycle. Reconcile with Alpaca after a worker or adapter restart.
- Keep the operator able to pause a run, inspect its history, and override a plan.
- Measure evidence coverage, decision quality including justified no-trade outcomes, risk compliance, order reconciliation, paper portfolio performance against a stated baseline, coordination overhead, and recovery behavior.

## Dev coordination between sessions

Several coding sessions (Claude Code, Codex, people) work in this repo at once. Coordinate through the local board, a separate SpacetimeDB database (`quant-swarm-coord`, module in `coord/`) on the same local server as the trading module. It holds sessions, a task board, messages, and file locks. It never touches trading data.

Use `node scripts/coord.ts <command> --as <name>`, or set `COORD_AS=<name>`. Pick one short lowercase name per session and keep it (for example, your session name). Run `node scripts/coord.ts` with no command for the full command list.

1. **Start:** `register <claude|codex|human> "<focus>"`, then `status` to see who is working on what, open tasks, locks, and messages.
2. **Before starting a piece of work:** find or `add` a task and `claim` it. A claim is atomic; if it is refused, someone else has it. Use `--after <task>` for work that must wait on another task.
3. **Before editing:** `lock` the files or directories (`dir/` with a trailing slash) you will change, with `--task`. A lock overlapping someone else's is refused: message the holder instead of editing. Locks expire (default 120 minutes) and are released when you finish the task.
4. **While working:** `post` decisions, contract changes, and questions; use `--to <name>` for one session. Check `inbox` between steps, or keep `watch` running to stream new messages, task changes, and locks.
5. **Finish:** `done <task> "<result>"` (or `block`/`release`), then `unlock` anything left, and still update [HANDOFF.md](HANDOFF.md).

The board needs the local server (`npm run db:start`). If `quant-swarm-coord` does not exist yet, create it with `spacetime publish --module-path coord --server local quant-swarm-coord`. Board names are self-declared and every local CLI call uses the same SpacetimeDB identity, so keep this database on localhost.

## Status and decisions

- **Confirmed:** use SpacetimeDB; build a communicating agent swarm; coordinate with Alpaca for paper trading as the first application; no human approval in the trade path, so the deterministic risk gate is the only gate before paper execution.
- **Implemented locally:** the Phase 1 swarm core with private scoped views, explicit role/run/account grants, renewable task leases, durable messages/evidence, generated client bindings, model budget/output records, and verified worker race/restart/takeover checks. The authoritative risk gate and validated order ledger are foundations for later paper execution. See [README.md](README.md) for setup and its current access-control boundary.
- **Proposed:** fundamental analysis of a small US equity universe, SEC filings as a primary research source, TypeScript for the remaining worker services, and a dashboard for paper portfolio oversight.
- **To decide:** the starting symbols and holding horizon, research and trading cadence, benchmark, paper account and data entitlements, agent model and budget, deployment, and numeric risk limits.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the schema, delivery phases, acceptance checks, and research references.
