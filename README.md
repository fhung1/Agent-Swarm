# Quant Swarm backend

This repository contains a SpacetimeDB 2.10.2 module, a Node.js coordination worker, and the read-only phase of the Alpaca paper adapter. The module stores runs, agents, leased tasks, messages, research evidence, theses, decisions, trade proposals, risk decisions, operator approvals, paper-account snapshots, and market observations. The adapter reads the paper account and selected market quotes; this slice has no order submission or cancellation path.

Agents should record task progress and next steps in the shared [handoff log](HANDOFF.md) when finishing or pausing work.

See the [implementation review](IMPLEMENTATION_REVIEW.md) for current phase status, verified checks, remaining work, and correctness findings.

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

### Read-only Alpaca snapshot

The adapter makes `GET` requests to Alpaca's fixed paper trading host for the account, positions, and open orders, and to the market-data host for latest stock quotes. It writes account totals, JSON position/order snapshots, and all selected quote observations through one reducer transaction, so a snapshot and its quotes commit together or not at all. Account details go to the private `account_snapshot` table; normalized quotes go to the private `market_observation` table with authorized `my_market_observation` reads. Each observation has both Alpaca's quote timestamp and the SpacetimeDB capture timestamp.

Publish the current module and generate bindings first. Build the adapter and register its SpacetimeDB identity without contacting Alpaca, then grant that identity only the `market_data` role using the module owner:

```sh
npm run build
npm run alpaca:read -- --register
spacetime call --server local quant-swarm grant_agent <READER_IDENTITY> market_data
spacetime call --server local quant-swarm grant_account_access <READER_IDENTITY> <PAPER_ACCOUNT_ID>
```

Set `ALPACA_API_KEY` and `ALPACA_API_SECRET` in your local shell or secret manager, then run a one-shot read with a selected feed and small symbol list:

```sh
ALPACA_DATA_FEED=iex ALPACA_SYMBOLS=AAPL,MSFT npm run alpaca:read
```

The valid `ALPACA_DATA_FEED` values are `sip`, `iex`, `delayed_sip`, `boats`, `overnight`, and `otc`; access depends on the Alpaca subscription. `ALPACA_SYMBOLS` accepts 1–50 comma-separated US equity symbols. The adapter uses the same key and secret for both Alpaca APIs. It is the only process that reads Alpaca credentials; its paper trading origin is fixed in code and cannot be overridden by environment variables. Its HTTP helper allows only `GET`, and the adapter defines no order-writing calls. `SPACETIMEDB_HOST` and `SPACETIMEDB_DB_NAME` can point to the local database defaults; `SPACETIMEDB_TOKEN_FILE` can override the private token-file path. By default, the adapter stores its SpacetimeDB token in `~/.local/share/quant-swarm/tokens/alpaca-reader.token` with owner-only permissions.

The account snapshot includes account ID/status, cash, buying power, equity, and JSON arrays for positions and open orders. Account reads require an explicit account grant and an allowed role. Research workers see same-symbol quotes for their authorized tasks through `my_market_observation`; they cannot read account snapshots. Grant the adapter only `market_data`; order-writing reducers still require the separate `executor` role.

### SEC filings ingestor

The SEC ingestor records research evidence from EDGAR, the SEC's public filings database. It does not trade or contact a broker. For each symbol it records the latest 10-K and 10-Q as sources in a run, then adds up to ten reported facts per filing: revenue, net income, operating income, operating cash flow, diluted EPS, total assets, total liabilities, stockholders' equity, cash, and long-term debt. Each fact is the value the filing reports for its own period end. Duration facts use the shortest period ending then (the quarter in a 10-Q), except cash flow, which 10-Qs report only year to date; the stored `period` shows the exact dates and XBRL concept. A source's `as_of` is the SEC acceptance time, when the filing became public. Each source's checksum is the SHA-256 of the primary filing document its URI names. Its `artifact_ref` is a manifest under `~/.local/share/quant-swarm/artifacts/sec/` pointing to the saved document and that filing's XBRL facts (only entries with its accession), each with its own SHA-256.

The SEC requires a contact email in the User-Agent of every request. Set it in your shell; it is sent only to SEC hosts:

```sh
npm run build
npm run ingest:sec -- --register
spacetime call --server local quant-swarm grant_agent <SEC_INGESTOR_IDENTITY> ingestor
spacetime call --server local quant-swarm grant_run_access <SEC_INGESTOR_IDENTITY> sec1
RUN_ID=sec1 SYMBOLS=AAPL,MSFT SEC_USER_AGENT='Quant Swarm research you@example.com' npm run ingest:sec
```

The run must exist and be active. `SYMBOLS` accepts 1–20 tickers. The ingestor makes only `GET` requests to a fixed set of SEC routes, spaced 200 ms apart to stay under the SEC's 10-requests-per-second limit. Rerunning it for the same run skips filings and facts already recorded. To use real filings in the [three-agent thesis check](#three-agent-thesis-check), ingest into the run instead of using the fixture ingestor. The skeptic then passes the evidence and the coordinator records `abstain`, because no valuation model exists yet.

### Run a worker

After publishing the module and building the worker, start a worker in another terminal:

```sh
AGENT_NAME=analyst-a RUN_ID=demo npm run worker
```

The process connects to the configured database, saves its token on first connection, subscribes to its run, and prints task and message updates. It retries dropped connections with backoff. Stop it with Ctrl+C. With `AUTO_CLAIM=1` it acts according to the role the owner granted its identity (see [Three-agent thesis check](#three-agent-thesis-check)). By default those role behaviors are deterministic placeholders. With `AGENT_BRAIN=claude` or `AGENT_BRAIN=codex`, the analyst, skeptic, and coordinator call a model instead (see [Model-backed roles](#model-backed-roles)).

Worker settings are environment variables. Defaults are defined in `src/worker.ts`:

| Variable | Default | Purpose |
| --- | --- | --- |
| `AGENT_NAME` | `analyst-a` | Logical worker name; use a different name for each worker. |
| `RUN_ID` | `demo` | Run whose tasks and messages the worker subscribes to. The run must exist. |
| `SPACETIMEDB_HOST` | `ws://localhost:3000` | SpacetimeDB websocket URI. |
| `SPACETIMEDB_DB_NAME` | `quant-swarm` | Published database name. |
| `AGENT_TOKEN_FILE` | `~/.local/share/quant-swarm/tokens/<AGENT_NAME>.token` | Optional token file override. Use a different file per logical worker and keep it private. |
| `AUTO_CLAIM` | `0` | Set to `1` to act on tasks for the worker's granted role. Without it, the worker only observes and logs. |
| `WORK_DELAY_MS` | `0` | Test-only delay before each task's work, simulating a slow model call (0–600000). |
| `AGENT_BRAIN` | `rules` | `rules` for the deterministic placeholders; `claude` or `codex` for model-backed analyst, skeptic, and coordinator steps. |
| `AGENT_MODEL` | `claude-opus-5-5` (claude), `gpt-5.3-codex` (codex) | Model override for the selected brain. |
| `AGENT_EFFORT` | `high` | Model effort level: `low`, `medium`, `high`, `xhigh`, or `max`. |
| `MAX_ORDER_NOTIONAL` | `1000` | Dollar cap a model coordinator's proposed order must stay under at the latest quote. |

The token file preserves a worker's SpacetimeDB identity across restarts. If you change `AGENT_NAME`, the worker connects as a new identity and must be granted a role separately. Do not commit token files or put broker credentials in worker environment variables.

### Common operator commands

The CLI identity that first publishes the module is its owner. Use that identity for owner-only role grants. `spacetime login show` displays the CLI identity. Grant the owner the `operator` role before using it to create runs, then grant worker identities after they connect and print their identities:

```sh
spacetime login show
spacetime call --server local quant-swarm grant_agent <OWNER_IDENTITY> operator
spacetime call --server local quant-swarm create_run demo 'Verify two-agent coordination'
spacetime call --server local quant-swarm grant_agent <WORKER_IDENTITY> analyst
spacetime call --server local quant-swarm grant_run_access <WORKER_IDENTITY> demo
```

Run IDs cannot be created twice. The publisher can inspect private coordination tables through the local CLI; other clients use authorized `my_*` views:

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

## Three-agent thesis check

This is the Phase 1 exit check: a coordinator, an analyst, and a skeptic exchange a sourced thesis, and a worker restart does not lose its task. This reproducible example uses a fixture ingestor whose rows are labeled `fixture`; the SEC ingestor is available for real research. The skeptic flags them, so the expected decision is `revise`.

The publisher is the module owner. Grant its CLI identity the `operator` role, create a run, then register the fixture ingestor and grant it `ingestor`:

```sh
spacetime login show
spacetime call --server local quant-swarm grant_agent <OWNER_IDENTITY> operator
spacetime call --server local quant-swarm create_run phase1 'Sourced thesis across three workers'
npm run ingest:fixture -- --register
spacetime call --server local quant-swarm grant_agent <INGESTOR_IDENTITY> ingestor
spacetime call --server local quant-swarm grant_run_access <INGESTOR_IDENTITY> phase1
RUN_ID=phase1 SYMBOL=AAPL npm run ingest:fixture
```

Start three workers in separate terminals. Each prints its identity on first connection; grant each the matching role:

```sh
AGENT_NAME=coord-1 RUN_ID=phase1 AUTO_CLAIM=1 npm run worker
AGENT_NAME=analyst-a RUN_ID=phase1 AUTO_CLAIM=1 WORK_DELAY_MS=8000 npm run worker
AGENT_NAME=skeptic-1 RUN_ID=phase1 AUTO_CLAIM=1 npm run worker
```

```sh
spacetime call --server local quant-swarm grant_agent <COORD_IDENTITY> coordinator
spacetime call --server local quant-swarm grant_agent <ANALYST_IDENTITY> analyst
spacetime call --server local quant-swarm grant_agent <SKEPTIC_IDENTITY> skeptic
spacetime call --server local quant-swarm grant_run_access <COORD_IDENTITY> phase1
spacetime call --server local quant-swarm grant_run_access <ANALYST_IDENTITY> phase1
spacetime call --server local quant-swarm grant_run_access <SKEPTIC_IDENTITY> phase1
spacetime call --server local quant-swarm create_task thesis-aapl-1 phase1 AAPL thesis 'Write an evidence-linked thesis for AAPL' analyst ''
```

The flow is:

1. The analyst claims `thesis-aapl-1`, publishes `thesis.thesis-aapl-1` citing the stored sources and facts, and posts a `claim` message to the coordinator.
2. The coordinator creates `review.thesis-aapl-1` for the `skeptic` role, depending on the thesis task.
3. The skeptic claims the review once its dependency completes, checks the cited evidence (fixture data, sources older than 400 days, non-`ok` fact quality, fewer than two sources), and posts a `challenge` message.
4. The coordinator records a decision (`revise` if the skeptic raised concerns, otherwise `abstain`) and posts a `decision` message. It never decides `trade` in this phase.

To check recovery, stop the analyst with Ctrl+C during its 8-second delay and start it again without `WORK_DELAY_MS`. It reconnects with the same identity, finds the task it still holds, and resumes it; each step uses a stable ID, so a retry does not duplicate the thesis or message. If two workers share a role, they race for each task and exactly one claim commits. Inspect the result:

```sh
spacetime sql --server local quant-swarm "SELECT id, kind, role, depends_on, status FROM task WHERE run_id = 'phase1'"
spacetime sql --server local quant-swarm "SELECT id, kind, recipient_role, body FROM message WHERE run_id = 'phase1'"
spacetime sql --server local quant-swarm 'SELECT id, outcome, rationale FROM decision'
```

### Model-backed roles

Set `AGENT_BRAIN=claude` or `AGENT_BRAIN=codex` on any worker to replace its placeholder logic with a model call. Both use the same prompts, output schemas, and validation:

| Brain | API | Default model | Credentials |
| --- | --- | --- | --- |
| `claude` | Anthropic Messages API | `claude-opus-5-5` | `ANTHROPIC_API_KEY` or an `ant auth login` profile |
| `codex` | OpenAI Responses API | `gpt-5.3-codex` | `OPENAI_API_KEY` |

Keep credentials in your shell or secret manager, never in SpacetimeDB. The Codex brain makes plain API calls with no tools and `store: false`; it does not run the `codex` CLI agent, so data in prompts cannot trigger commands or file reads. The granted role still decides what the worker does:

- **Analyst:** writes a thesis from the run's stored sources, facts, and market observations for the task's symbol. It may cite only those IDs.
- **Skeptic:** challenges the thesis against the same evidence and posts a structured `challenge` message (verdict, objections, missing evidence, unsupported claims).
- **Coordinator:** queues reviews as before, then decides `trade`, `abstain`, or `revise` from the thesis, critiques, and latest `market_observation` quote. A trade is checked against `MAX_ORDER_NOTIONAL` and the order rules before the decision is recorded; an unusable order becomes `revise`. A valid trade commits its decision and `trade_proposal` together through `record_trade_decision` for risk review; nothing is submitted to Alpaca.

Model output is validated before any reducer call, a resumed task does not repeat a model call whose result is already stored, and a failed coordinator call is retried after five minutes by the periodic worker scan. Trade decisions and proposals commit atomically, and identical retries reuse both records. Brains can mix within a run: for example, a Claude analyst, a Codex skeptic, and a rule-based coordinator.

To verify the model handlers locally without provider credentials, publish the module and run:

```sh
npm run check:research-fixture
# If spacetime is not on PATH:
SPACETIME_CLI="$HOME/.local/bin/spacetime" npm run check:research-fixture
```

This check requires the local database publisher's CLI login. It creates distinct client identities, injects schema-validated synthetic responses, and checks thesis/critique/decision flow, bounded proposals, abstention, rejected sizing, identical retries, atomic rollback, and coordinator reconnection. It closes its run and revokes its temporary roles afterward. Synthetic `QFIX` evidence remains as an audit record. It checks handlers and database reducers; live provider responses and the long-lived worker loop require a separate check.

## Database behavior

The owner uses `grant_agent` and `revoke_agent` to assign roles; a worker cannot assign itself a role. Granted workers call `heartbeat`; the demo repeats it every 15 seconds. `create_run` and `set_run_status` require `operator`. Coordinators or operators create tasks; analysts, skeptics, and coordinators compete for them. A claim checks the task's expected version and open status in an atomic reducer, assigns a 60-second lease, and schedules expiry. A worker renews its lease every 20 seconds while working; a 70-second simulated call has been verified to complete without losing the lease. A task can name a required `role` and a `depends_on` task for the same run and symbol; `claim_task` rejects other roles and waits for the dependency to complete. When a worker hits a permanent error on a task it holds, it records `fail_task` instead of retrying. Lease expiry reopens the task only if the scheduled version still matches. `complete_task` and `fail_task` require the current assignee and an unexpired lease. Message IDs are stable and retry-safe when the repeated request has the same sender and payload.

Agents communicate through `post_message`, which inserts a durable row into `message`. The module fills in the sender identity from the authenticated caller; the caller supplies message ID, run ID, optional task ID and symbol, recipient role, kind, body, and evidence reference. `kind` must be one of `observation`, `claim`, `question`, `challenge`, `answer`, `result`, `decision`, or `status`. Evidence references are comma-separated source, fact, thesis, or market-observation IDs; each must exist and match the message symbol. The worker subscribes to messages for its configured run and logs incoming rows. SpacetimeDB pushes each inserted row to connected clients whose subscriptions match; on reconnect, the initial subscription snapshot includes existing messages. `recipient_role` addresses a message to a role (empty means everyone), but it is a routing label, not access control: every client subscribed to the run still receives the row. `post_message` requires an active run and an allowed role; if a task ID is given, it must belong to that run. Repeating the same ID with the same sender and payload is idempotent; reusing it for different content is rejected.

### Reducer inventory

| Area | Reducers and rules |
| --- | --- |
| Agent and run administration | `grant_agent` / `revoke_agent` are owner-only. `heartbeat` requires a granted role. `create_run` and `set_run_status` require `operator`. |
| Tasks and messages | `create_task` requires operator/coordinator and takes an optional required role and same-symbol dependency; identical retries are accepted. `claim_task`, `renew_task_lease`, `complete_task`, and `fail_task` enforce role, ownership, version, and lease rules. `expire_task_lease` is scheduled by the database. `post_message` writes run-scoped messages. |
| Research and decisions | `add_source` / `add_fact` require `ingestor`; `publish_thesis` allows analyst/skeptic/coordinator, requires at least one same-symbol source, fact, or market-observation reference, and, when given a task ID, requires the caller to hold that task; `record_decision` requires coordinator/operator; `propose_trade` requires coordinator and a trade decision; `record_trade_decision` commits a trade decision and proposal atomically. Identical proposal retries are accepted. |
| Risk and paper order ledger | Operator provisions immutable `add_risk_policy`; risk submits snapshot/clock-pinned `record_risk_decision`, evaluated again in the database. `executor` reserves orders with an active run and fresh risk pass; no human approval is required. Risk/market_data/executor record account facts with explicit account grants. Order states, broker identity and exact cumulative fills are validated. |
| Metrics | `record_run_metric` requires operator/coordinator/risk and an existing run. |

The research and order reducers enforce a separate flow: ingestors publish evidence, workers publish theses, coordinators propose trades, the deterministic database risk gate validates persisted account/quote/clock inputs and reserves exposure, and only an executor records order intents and broker events. `approve_proposal` and old approval rows are optional legacy audit records; execution never requires them. Re-review of an unsubmitted pass archives its old verdict in `risk_decision_history`. Any new account snapshot or policy requires fresh review before reservation. Submitted uncertain intents retain exposure until reconciled; accepted order requests are never treated as fills.

### Read authorization and recovery

All authoritative tables are private. Generated clients subscribe to `my_*` views. An ungranted/revoked identity sees no swarm rows. The owner assigns a role plus `grant_run_access(identity, runId)` for each run. Operators oversee all runs. Account data additionally requires `grant_account_access(identity, accountId)` and an operator/risk/executor/market_data role. Revoking grants removes subscribed rows live. Team messages are shared inside the authorized run; recipient role is a routing label.

Workers wait for a complete subscription snapshot, preserve their token across restart, recreate connections with bounded backoff, and resume owned work. Pausing a run aborts active model requests and defers work. Transient failures retry with bounded backoff; permanent errors or exhausted attempts fail held tasks. Expired tasks can transfer to a different identity without rewriting the original thesis/message authorship. Derived IDs remain within 128 characters.

`configure_run_limits` sets per-run call, token, concurrency and attempt limits. Defaults are 50 calls, 1,000,000 reserved tokens, 2 concurrent calls, and 3 attempts per work item. Before each model call, `begin_inference` reserves budget; `finish_inference` stores usage, actual model and structured output. Uncertain failures retain their token reservation. Completed outputs can be replayed without another model call. Coordinator `decision_input` rows freeze the thesis, critiques, quote, model, prompt version, policy and sizing cap. Monetary API cost reporting and production service/OIDC provisioning remain later operating work.

### Repeatable local acceptance

With the local server and published module running:

```sh
npm run build
SPACETIME_CLI="$HOME/.local/bin/spacetime" npm run check:phase-one
SPACETIME_CLI="$HOME/.local/bin/spacetime" npm run check:research-fixture
```

The Phase 1 check starts actual worker processes and exercises scoped reads, grant revocation, a claim race, same-identity restart, three-role sourced decisions, pause/resume, lease takeover and renewal, long IDs, inference budgets, authoritative risk and local order-ledger validation. It uses synthetic evidence and local ledger records; it makes no provider or Alpaca calls. Allow roughly two minutes for real lease timers. Runs are closed, temporary roles revoked, and worker token files removed afterward. The separate research fixture checks structured model handlers, output replay, atomic rollback and coordinator restart.

This remains a local deployment. Keep the host on loopback until deployment service identities, secret provisioning and supervision are configured. Real broker submission/reconciliation and live gameplay have separate acceptance checks.

## One-client Factorio and Minecraft prototype on macOS

The repo has a one-client Mac prototype for Factorio and Minecraft Java Edition. It captures the foreground game window, asks a vision model for a short action sequence, applies bounded mouse/keyboard input, and records before/after screenshots. Minecraft adds relative camera movement, simultaneous movement keys, and crosshair mouse-button actions. Build it with `npm run game:build`, then follow [the Mac setup and run guide](src/game/README.md). Live gameplay has not yet been verified on this Mac.

## Game-agent VM fleets

The repo has a **local Tart fleet for macOS and Linux guests on an Apple silicon Mac** and a **remote libvirt fleet on a Linux host**. Both clone and manage prepared desktop VMs for later multi-client work. They do not install Minecraft or Factorio, launch a game server, or start game agents inside the guests. The macOS game agent can be installed and run inside a macOS guest; Linux guest agent control still needs a Linux desktop adapter. See the [full VM fleet guide](vm_fleet/README.md).

### Start one local Tart VM on a Mac

Install Tart, prepare and stop a local macOS or Linux template, and copy the matching example config. For a macOS guest:

```sh
cp vm_fleet/tart-macos.example.json vm_fleet/tart-macos.json
python3 vm_fleet/tart_fleet.py --config vm_fleet/tart-macos.json plan
python3 vm_fleet/tart_fleet.py --config vm_fleet/tart-macos.json up --wait-ip
python3 vm_fleet/tart_fleet.py --config vm_fleet/tart-macos.json status
```

Use `vm_fleet/tart-linux.example.json` and `vm_fleet/tart-linux.json` for a Linux guest. Tart opens a GUI for each started VM. The guest must have its game and agent runtime configured separately. Shut down the managed guests with `python3 vm_fleet/tart_fleet.py --config vm_fleet/tart-macos.json stop` (or the Linux config).

### Start one remote libvirt desktop VM

This requires a remote Linux host with `qemu:///system` libvirt access over SSH and a shut-off desktop template. Prepare the template with a desktop, the game client you want to use, and QEMU Guest Agent. The manager does not install or configure any of these. See the [full VM fleet setup guide](vm_fleet/README.md) for host and template requirements.

Copy the sample configuration, then set `ssh_target` to your SSH host, `template` to the prepared libvirt domain name, and `count` to `1`:

```sh
cp vm_fleet/config.example.json vm_fleet/config.json
```

Preview and start the VM from the repository root:

```sh
python3 vm_fleet/fleet.py --config vm_fleet/config.json plan
python3 vm_fleet/fleet.py --config vm_fleet/config.json up --wait-ip
python3 vm_fleet/fleet.py --config vm_fleet/config.json status
```

Open the VM's graphical console with your libvirt/desktop access tools. Start the game client there and connect it to a game server that you have set up separately. The fleet manager reports guest IPs but does not provide remote desktop access or game input control. Shut the VM down with:

```sh
python3 vm_fleet/fleet.py --config vm_fleet/config.json stop
```

This is infrastructure for the later multi-client game-agent application, separate from the current SpacetimeDB worker demo. The one-client macOS adapter supports both games on the host or in a macOS guest; Linux guest control and multiplayer coordination are still planned. See the [game-agent plan](GAME_AGENT_IMPLEMENTATION_PLAN.md) for the remaining phases and intended architecture.
