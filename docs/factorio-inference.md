# Five Luna Low actors and an Astra High overseer

Each game actor has an independent process, prompt, board identity and restart journal. All five actors use a selected model at low effort; set `FACTORIO_ACTOR_MODEL=gpt-6-luna` for Luna actors. A separate `gpt-6-astra` high-effort process has no game-action interface and directs the actors only through board messages and run-scoped subtasks. Workers choose a validated action, chat, wait or completion; there is no rules fallback. Supported game actions include movement, mining, hand crafting, building and chest/furnace transfers.

## Prepare

Use Node 24+, installed dependencies, a running disposable [cooperative world](../factorio/README.md) with exactly five actors, and the dedicated Factorio board. The launcher does not create/reset worlds or databases.

```sh
npx esbuild scripts/factorio-inference-worker.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-worker.mjs
npx esbuild scripts/factorio-inference-supervisor.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-supervisor.mjs
npx esbuild scripts/factorio-inference-orchestrator.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-orchestrator.mjs
npx esbuild scripts/factorio-inference-swarm.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-swarm.mjs
```

Set `AGENT_BRAIN=codex`, `AGENT_MODEL=gpt-6-astra` for the overseer, `FACTORIO_ACTOR_MODEL=gpt-6-luna` for Luna actors, the provider credential, `BOARD_URI` and `BOARD_DATABASE=quant-swarm-factorio-coord`. Registration has a reducer-enforced cap of eight. Production mode requires `FACTORIO_MAX_CALLS=0` and `FACTORIO_ORCHESTRATOR_MAX_CALLS=0`, meaning unlimited model-call counts. Smoke mode supports one to three calls per actor. The overseer must create and announce one task for each actor. The shared spend cap stops all six agents when a new worst-case reservation would exceed the run budget. The default run dollar limit is $400; `FACTORIO_RUN_BUDGET_USD` can lower it but values above $400 are rejected. If a worst-case pre-call reservation would exceed the cap, the shared ledger halts and the launcher terminates the overseer and all workers.

## Launch and stop

```sh
node dist/factorio-inference-swarm.mjs /absolute/path/to/world prompted-demo
node dist/factorio-inference-swarm.mjs /absolute/path/to/world prompted-demo --start
```

The default dry run reads game status and checks actor/world configuration without model calls or board writes. `--start` bootstraps the board operator under the coordinator's saved identity and seeds only the rocket goal. It starts five actor workers in an idle registration state, then starts the board-only overseer so all recipient identities exist before Astra creates and announces five run-scoped subtasks. Workers begin decisions only after all five tasks and directed announcements are visible. Setup and overseer reuse one board identity. Ctrl+C stops the launcher and children; stop/save the separately started world afterward.

The immutable plan, logs and private run-wide `run-spend.json` ledger are under `WORLD/inference/RUN/`; actor tokens, state and deadlines are under `WORLD/inference/RUN-agent-N/`. The ledger reserves worst-case input and output cost before every provider request, adds a 10% margin to the pinned rate card, and serializes updates across all six processes. It persists across worker restarts; missing ledgers, unknown models, exhausted budget and changed plan/cap fail closed. Uncertain requests retain their full reservation. The model audit messages include reserved and charged estimates. Reconcile these estimates with provider billing after it settles. Restart retains call counts and the original run deadline. With call count zero, actors and the overseer continue until the shared spend guard halts or the configured run deadline arrives. A denied reservation halts the ledger and the launcher terminates the overseer and all worker process groups, escalating to SIGKILL after five seconds if needed. Movement destinations must stay within six world units; longer routes use observed six-unit waypoints. Unknown actions without valid engine receipts are quarantined, not replayed. Resource leases renew every 15 seconds independently of model calls and pause. Lost, expired or uncertain renewal cancels inference and stops new actions for reconciliation.

## Prompts and inspection

Use `FACTORIO_PROMPT`, `FACTORIO_PROMPT_FILE`, or `FACTORIO_PROMPT_DIR` containing `agent-1.txt` through `agent-5.txt`. Files are read each turn. Example: “Share resource availability with peers and work toward the rocket goal.” Recipients look like `prompted-demo-agent-2`; an empty recipient broadcasts.

Context includes local observations, reservations, scoped peer messages, the previous result, and remaining call/time allowance. Peer text is data. Inspect decision/chat/action-result/completion records on the Factorio board and compare them with actual game receipts/inventory. Each worker journal's `state.json.calls` records its consumed calls; inspect the worker log and launcher exit for exhaustion or failure, and the supervisor record for retry attempts or quarantine. `FACTORIO_REQUIRED_PLATES` defaults to five; different objectives need an appropriate verifier.

Run [provider-free acceptance](factorio-inference-acceptance.md) first. A live five-actor run, useful peer communication, coordinator tasking and graphical observation require their own evidence.
