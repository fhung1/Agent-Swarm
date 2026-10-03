# Quant Swarm backend

This repository contains a SpacetimeDB 2.10.2 module and a Node.js worker that demonstrates agent coordination. The module stores runs, agents, leased tasks, messages, research evidence, theses, decisions, trade proposals, risk decisions, operator approvals, and a paper-order ledger. It does not connect to Alpaca or place orders; those adapters are separate delivery phases in [IMPLEMENTATION_PLAN.md](IMPLEMENTATION_PLAN.md).

Agents should record task progress and next steps in the shared [handoff log](HANDOFF.md) when finishing or pausing work.

## Local setup

Install Node.js and the [SpacetimeDB CLI](https://spacetimedb.com/install), then select CLI version 2.10.2. Check the installed version with `spacetime --version`; see the [CLI reference](https://spacetimedb.com/docs/cli-reference/) for its version manager. In the project directory:

```sh
npm install
npm run db:start
```

Leave the local server running. In another terminal:

```sh
# Log in once if the SpacetimeDB CLI has no current identity.
spacetime login
npm run db:publish
npm run db:generate
npm run typecheck
npm run build
```

The `db:start` process is the backend database server. It listens only on `127.0.0.1:3000`; local database files go in ignored `.spacetimedb-data/`. Keep that terminal open while using the backend. Stop it with Ctrl+C; data persists between starts. The generated client bindings in `src/module_bindings/` are committed source. Regenerate them after changing `spacetimedb/src/`.

### One general-purpose message board

All workers use the same board in the `quant-swarm` database. Development uses this application interface directly, alongside trading, Minecraft, and Factorio work. There are no separate development or application boards. Workers subscribe to all tasks and messages over one connection; run IDs identify workflow context within the board, not separate boards. `RUN_ID` limits synthetic auto-claim to a selected workflow only.

Connect to the board:

```sh
AGENT_NAME=codex-board-observer AUTO_CLAIM=0 npm run worker
```

Existing work uses run `demo`. Workers log messages; model responses still require an external agent loop.

### Run a worker

After publishing the module and building the worker, start a worker in another terminal:

```sh
AGENT_NAME=analyst-a RUN_ID=demo npm run worker
```

The process connects to the configured database, saves its token on first connection, subscribes to the shared board, and prints task and message updates. It retries dropped connections with backoff. Stop it with Ctrl+C. The worker does not run an LLM or research source; set `AUTO_CLAIM=1` only for the synthetic claim/result demo below.

Worker settings are environment variables. Defaults are defined in `src/worker.ts`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_NAME` | `analyst-a` | Logical worker name; use a different name for each worker. |
| `RUN_ID` | `demo` | Workflow for synthetic auto-claim; does not filter the shared board subscription. The run must exist. |
| `SPACETIMEDB_HOST` | `ws://localhost:3000` | SpacetimeDB websocket URI. |
| `SPACETIMEDB_DB_NAME` | `quant-swarm` | Published database name. |
| `AGENT_TOKEN_FILE` | `~/.local/share/quant-swarm/tokens/<AGENT_NAME>.token` | Optional token file override. Use a different file per logical worker and keep it private. |
| `AUTO_CLAIM` | `0` | Set to `1` to claim open tasks and post a synthetic result automatically. |

The token file preserves a worker's SpacetimeDB identity across restarts. If you change `AGENT_NAME`, the worker connects as a new identity and must be granted a role separately. Do not commit token files or put broker credentials in worker environment variables.

### Common operator commands

The CLI identity that first publishes the module is its owner. Use that identity for owner-only role grants. `spacetime login show` displays the CLI identity. Grant the owner the `operator` role before using it to create runs, then grant worker identities after they connect and print their identities:

```sh
spacetime login show
spacetime call --server local quant-swarm grant_agent <OWNER_IDENTITY> operator
spacetime call --server local quant-swarm create_run demo 'Verify two-agent coordination'
spacetime call --server local quant-swarm grant_agent <WORKER_IDENTITY> analyst
```

Run IDs cannot be created twice. To inspect public coordination tables, query through the local CLI:

```sh
spacetime sql --server local quant-swarm 'SELECT * FROM run'
spacetime sql --server local quant-swarm 'SELECT * FROM task'
spacetime sql --server local quant-swarm 'SELECT * FROM message'
```

Pause a run to block new task claims and messages; an operator can resume a paused run. A closed run cannot be reopened:

```sh
spacetime call --server local quant-swarm set_run_status demo paused
spacetime call --server local quant-swarm set_run_status demo active
```

### Updating or resetting local state

After editing module code, publish again. After changing its schema or reducers, regenerate bindings and rebuild the worker:

```sh
npm run db:publish
npm run db:generate
npm run typecheck
npm run build
```

Publishing updates the existing `quant-swarm` database; keep the CLI's migration prompts enabled and read them before accepting. To intentionally erase all databases in this project's local data directory, stop the server first, then run `spacetime server clear --data-dir .spacetimedb-data`. This deletes local database data, including runs and messages; publishing again recreates the module. Do not use this reset for any database containing data you need.

### Troubleshooting

- **Connection refused:** make sure `npm run db:start` is still running and the worker host points to `ws://localhost:3000` (or the configured local host).
- **Database not found:** publish it with `npm run db:publish`; the configured name is `quant-swarm`.
- **Role not authorized:** grant the printed worker identity the role its reducer needs. The publisher/owner must grant roles; a worker cannot grant itself one.
- **Worker connects but does not claim tasks:** check that `RUN_ID` matches an active run and that `AUTO_CLAIM=1` is set. Without auto-claim, the worker only observes and logs.
- **Two processes act as the same worker:** give each process a distinct `AGENT_NAME` and token file. Existing token files intentionally reuse their saved identity.

## Two-agent check

The publisher is the module owner. Grant its CLI identity the `operator` role so it can create runs and tasks:

```sh
spacetime login show
spacetime call --server local quant-swarm grant_agent <OWNER_IDENTITY> operator
spacetime call --server local quant-swarm create_run demo 'Verify two-agent coordination'
```

Start two terminals. On first connection, each worker prints a distinct identity and saves its token under `~/.local/share/quant-swarm/tokens/` (or the `AGENT_TOKEN_FILE` path you provide):

```sh
AGENT_NAME=analyst-a RUN_ID=demo AUTO_CLAIM=1 npm run worker
```

```sh
AGENT_NAME=analyst-b RUN_ID=demo AUTO_CLAIM=1 npm run worker
```

Grant both printed identities the `analyst` role, then create a task:

```sh
spacetime call --server local quant-swarm grant_agent <ANALYST_A_IDENTITY> analyst
spacetime call --server local quant-swarm grant_agent <ANALYST_B_IDENTITY> analyst
spacetime call --server local quant-swarm create_task demo-task-1 demo AAPL research 'Review the latest filing'
spacetime sql --server local quant-swarm 'SELECT * FROM task'
```

Both workers receive the task. One claim commits; the other gets a conflict. The winner posts a message and completes the task. Every worker receives that message as a live row update; messages have no recipient field, and the board subscription includes all runs. Restarting a worker uses its saved token, so it keeps its identity and receives the completed task and existing messages in its initial subscription snapshot. `AUTO_CLAIM=1` performs a synthetic result for this check; it does not run a model, research a filing, or start an agent conversation.

## Database behavior

The owner uses `grant_agent` and `revoke_agent` to assign roles; a worker cannot assign itself a role. Granted workers call `heartbeat`; the demo repeats it every 15 seconds. `create_run` and `set_run_status` require `operator`. Coordinators or operators create tasks; analysts, skeptics, and coordinators compete for them. A claim checks the task's expected version and open status in an atomic reducer, assigns a 60-second lease, and schedules expiry. The module exposes `renew_task_lease` for long work, but the demo does not call it because its synthetic result is immediate. Lease expiry reopens the task only if the scheduled version still matches. `complete_task` and `fail_task` require the current assignee and an unexpired lease. Message IDs are stable and retry-safe when the repeated request has the same sender and payload.

Agents communicate through `post_message`, which inserts a durable row into `message`. The module fills in the sender identity from the authenticated caller; the caller supplies message ID, run ID, optional task ID, kind, body, and evidence reference. The worker subscribes to all messages on the shared board and logs incoming rows with their run context. SpacetimeDB pushes each inserted row to connected clients whose subscriptions match; on reconnect, the initial subscription snapshot includes existing messages. This is shared board publish/subscribe with run metadata: there is no recipient field, direct-message reducer, or model-driven reply loop yet. `post_message` requires an active run and an allowed role; if a task ID is given, it must belong to that run. Repeating the same ID with the same sender and payload is idempotent; reusing it for different content is rejected.

### Reducer inventory

| Area | Reducers and rules |
| --- | --- |
| Agent and run administration | `grant_agent` / `revoke_agent` are owner-only. `heartbeat` requires a granted role. `create_run` and `set_run_status` require `operator`. |
| Tasks and messages | `create_task` requires operator/coordinator. `claim_task`, `renew_task_lease`, `complete_task`, and `fail_task` enforce role, ownership, version, and lease rules. `expire_task_lease` is scheduled by the database. `post_message` writes run-scoped messages. |
| Research and decisions | `add_source` / `add_fact` require `ingestor`; `publish_thesis` allows analyst/skeptic/coordinator; `record_decision` requires coordinator/operator; `propose_trade` requires coordinator and a trade decision. |
| Risk and paper order ledger | `record_risk_decision` requires `risk`; `approve_proposal` requires `operator`; order reservation, status updates, fills, account snapshots, and reconciliations require `executor`. Reservation requires an active run, fresh risk pass, and operator approval. Unique proposal, client-order, and fill activity IDs prevent duplicate ledger entries. |
| Metrics | `record_run_metric` requires operator/coordinator/risk and an existing run. |

The research and order reducers enforce a separate flow: ingestors add sources and facts, agents publish theses, a coordinator records a trade decision and proposal, a separate risk identity records the risk outcome, an operator approves, and only an executor can reserve a paper-order intent or record Alpaca events. Reserving an intent requires an active run, unexpired risk pass, and operator approval. The unique proposal and client-order IDs prevent a second reservation for the same intent. Money and quantities are stored as decimal strings; adapters must apply strategy-specific bounds and freshness checks before requesting these reducers.

This is a **local development module**. Its public agent, run, task, message, source, fact, thesis, decision, and trade-proposal tables are readable by any client that can connect to the host; reducer role checks control writes but do not scope reads. Keep the host local until identity-scoped read views and deployment authentication are implemented. Private tables hold owner configuration, task lease timers, account snapshots, risk decisions, approvals, paper orders, fills, reconciliations, and run metrics; consumers need authorized views before they can subscribe to those records. Broker credentials must stay in the future paper execution adapter, never in SpacetimeDB.

## Game-agent VM fleet

The later vision-only game-agent prototype includes a libvirt tool for cloning and managing isolated desktop VMs. See [the VM fleet setup guide](vm_fleet/README.md) for host requirements, desktop-template preparation, configuration, lifecycle commands, and recovery. The broader [game-agent plan](GAME_AGENT_IMPLEMENTATION_PLAN.md) describes how the VMs fit into that application; they are not needed for the current SpacetimeDB worker demo.
