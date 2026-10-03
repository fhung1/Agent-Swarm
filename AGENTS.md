# Quant Swarm: project brief

## Purpose

Build a system in which multiple specialized agents share a live view of a changing environment, communicate through structured messages, divide work, and coordinate actions. SpacetimeDB is the shared state and communication backbone. The system should make every decision traceable: what an agent observed, what it proposed, who accepted it, what action ran, and what happened next.

The first application is a fundamental analysis swarm that coordinates with Alpaca to place and monitor **paper trades**. Agents research companies, challenge each other's investment theses, propose trades, and track the results in a simulated brokerage account. Factorio and Minecraft remain possible later applications of the same swarm core.

## What the system should do

An operator defines a research universe, paper portfolio, and risk limits. Data adapters publish market and company observations to SpacetimeDB. Agents subscribe to relevant changes, collect evidence, debate opportunities, and submit trade proposals with a thesis, valuation or catalyst, counterarguments, confidence, and exit conditions. A deterministic risk gate checks each proposal against account state and policy. A paper execution service sends approved orders to Alpaca, then records order updates, fills, positions, and portfolio outcomes back in SpacetimeDB. The operator can see why each order was proposed and what happened to it.

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

SpacetimeDB's module owns authoritative swarm state and validates writes through reducers. Workers run outside the database so they can call models and data sources. Subscriptions deliver relevant state changes to workers and the dashboard. Durable tables retain evidence, decisions, orders, and outcomes for recovery and audit. The paper execution adapter alone holds Alpaca paper credentials and may submit orders. A separate risk gate uses fixed rules; an agent cannot approve its own trade by wording its proposal differently.

## How the agents connect to SpacetimeDB

**Connection model.** Each logical agent runs as a separate, long-lived worker process and opens its own client connection to the same SpacetimeDB database. Research ingestors, the risk gate, the paper execution adapter, and the dashboard also connect as clients, each with an identity and permissions appropriate to its job. The proposed first implementation uses the official TypeScript/Node.js SDK. SpacetimeDB hosts a module containing tables, reducers, and views; the workers run model inference and external API calls outside that module. The SDK maintains a WebSocket connection and a local cache of subscribed rows. [Architecture](https://spacetimedb.com/docs/intro/key-architecture/) · [Node.js client](https://spacetimedb.com/docs/quickstarts/nodejs/)

**Setup and address.** Build and publish the module to a local SpacetimeDB host first. Generate module-specific client bindings with `spacetime generate` whenever the module schema changes. A worker creates a generated `DbConnection` with the host URI, database name, and token. Local development uses `ws://localhost:3000`; a remotely hosted database uses its secure host URI. The worker receives its URI and database name from configuration, not from agent prompts. `spacetime dev --template nodejs-ts` provides a local module and working Node.js client as the starting scaffold. [Node.js quickstart](https://spacetimedb.com/docs/quickstarts/nodejs/) · [Connection API](https://spacetimedb.com/docs/clients/connection/)

**Identity and access.** Give each logical worker a distinct token. During local development, a tokenless first connection receives an identity and token; save that token securely per worker and supply it on later connections so a restart retains the same identity. For deployment, use OIDC service identities and validate identity and authorized role in module functions. An agent cannot gain permission by naming itself a different role. Keep Alpaca credentials only in the paper execution adapter; never put tokens or API keys in public tables or messages. Private tables hold sensitive state, while scoped views expose only rows a client is permitted to read. [Authentication](https://spacetimedb.com/docs/core-concepts/authentication/) · [Table access](https://spacetimedb.com/docs/tables/access-permissions/) · [Views for access control](https://spacetimedb.com/docs/how-to/rls/)

**Read and write flow.** On connection, an agent subscribes to the run, symbols, task types, and messages relevant to its role. It waits for the subscription's `onApplied` callback before processing the initial snapshot, then reacts to row insert and update callbacks. The subscription keeps the agent's local cache current. To change shared state, an agent calls a generated reducer such as `registerAgent`, `claimTask`, `postMessage`, or `completeTask`; it does not edit the cache. `claimTask` verifies the caller and task status inside one atomic transaction, so only one competing agent receives a claim. Short reducers record state transitions; the worker performs slow research and model calls after a claim succeeds. Messages and results include stable operation IDs and evidence references so retries can be deduplicated. Subscriptions are scoped rather than broadcasting every row to every agent. [Subscriptions](https://spacetimedb.com/docs/clients/subscriptions/) · [Reducer transactions](https://spacetimedb.com/docs/functions/reducers/)

**Recovery and coordination.** A direct Node.js `DbConnection` does not reconnect itself. On error or disconnect, the worker creates a new connection with bounded backoff and the same token, restores subscriptions, waits for a fresh snapshot, and reconciles its unfinished tasks and uncertain reducer results before resuming. Claimed tasks have renewable leases; an expired lease can be returned to the queue by a scheduled reducer. A reconnect must not create a second trade proposal or paper order, so proposals and order intents carry stable IDs. The risk gate, operator approval path, and paper execution adapter retain their separate authority even when an agent reconnects. [Reconnection behavior](https://spacetimedb.com/docs/clients/connection/) · [Scheduled work](https://spacetimedb.com/docs/tables/schedule-tables/)

**First proof.** Before adding Alpaca integration, run two workers with distinct identities against one local database. Both must see a new task, exactly one must claim it, the result must appear for the other worker, and a restarted worker must reconnect with its original identity and recover the correct task state. The detailed schema, reducer surface, and delivery phases are in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

## First application: Alpaca paper trading

Start with a small universe of liquid US stocks or ETFs and one paper account. A first research cycle pulls recent SEC filings and Alpaca market data, checks data freshness, builds evidence-linked theses, and invites an opposing view. The coordinator can recommend a bounded trade or **no trade** when evidence is weak. The risk gate checks symbol eligibility, buying power, current positions and open orders, per-position and portfolio limits, market hours, and run status. The first pilot requires operator approval for each order. The adapter submits only to Alpaca's paper endpoint and reconciles the resulting order and position state.

The swarm must manage open positions as well as entries. Each thesis has a review date or trigger, invalidation conditions, and a proposed exit path. New filings, major price moves, fills, and portfolio drift can trigger a fresh review. A paused run blocks new submissions; an account or data mismatch blocks trading until reconciled. The initial product objective is to prove coordinated, evidence-based decisions and reliable paper execution, not to promise a profitable strategy.

Alpaca paper trading simulates fills and does not reproduce every live-market effect. Evaluate the swarm by decision quality, evidence quality, policy compliance, reconciliation, and paper portfolio behavior; do not treat paper returns alone as proof of a profitable live strategy. The system must never infer that an accepted order request is a fill. It should use Alpaca order updates and periodic account reconciliation to determine what happened. [Alpaca paper trading](https://docs.alpaca.markets/us/v1.4.2/docs/paper-trading) · [Order updates](https://docs.alpaca.markets/us/docs/working-with-orders)

## Later applications

- **Factorio or Minecraft:** Replace the research and broker adapters with game observation and action adapters. Reuse goals, task allocation, messages, proposals, and outcome tracking; add world-specific data and action types. The vision-only, ten-client design is in [GAME_AGENT_IMPLEMENTATION_PLAN.md](GAME_AGENT_IMPLEMENTATION_PLAN.md).
- **Live trading:** A possible separate product phase only after paper evaluation, an independent risk design, and explicit owner authorization. The paper trading service must not have live credentials or a configurable live endpoint.

## Operating principles

- Use SpacetimeDB as the source of truth for live swarm state. Store large documents or raw model traces outside hot tables and keep references in the database.
- Make messages purposeful. Publish observations and decisions that another agent can act on; scope subscriptions by run and role.
- Treat model output as a proposal. Validate evidence, permissions, buying power, exposure limits, and current account state before execution.
- Give every order a unique client order ID and recorded lifecycle. Reconcile with Alpaca after a worker or adapter restart.
- Keep the operator able to pause a run, inspect its history, and override a plan.
- Measure evidence coverage, decision quality including justified no-trade outcomes, risk compliance, order reconciliation, paper portfolio performance against a stated baseline, coordination overhead, and recovery behavior.

## Status and decisions

- **Confirmed:** use SpacetimeDB; build a communicating agent swarm; coordinate with Alpaca for paper trading as the first application.
- **Proposed:** fundamental analysis of a small US equity universe, SEC filings as a primary research source, TypeScript for the module and worker services, and a dashboard for paper portfolio oversight.
- **To decide:** the starting symbols and holding horizon, research and trading cadence, benchmark, paper account and data entitlements, agent model and budget, deployment, and numeric risk limits. Per-order operator approval is the first-pilot default; broader paper autonomy is a later decision.

See [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md) for the schema, delivery phases, acceptance checks, and research references.
