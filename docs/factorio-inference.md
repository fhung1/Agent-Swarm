# Five Astra Low actors and an Astra High orchestrator

Each game actor has an independent process, prompt, board identity and restart journal. All five actors use `gpt-6-astra` at low effort. A separate `gpt-6-astra` high-effort process has no game-action interface and directs the actors only through board messages and run-scoped subtasks. Workers choose a validated action, chat, wait or completion; there is no rules fallback. Supported game actions include movement, mining, hand crafting, building and chest/furnace transfers.

## Prepare

Use Node 24+, installed dependencies, a running disposable [cooperative world](../factorio/README.md) with exactly five actors, and the dedicated Factorio board. The launcher does not create/reset worlds or databases.

```sh
npx esbuild scripts/factorio-inference-worker.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-worker.mjs
npx esbuild scripts/factorio-inference-supervisor.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-supervisor.mjs
npx esbuild scripts/factorio-inference-orchestrator.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-orchestrator.mjs
npx esbuild scripts/factorio-inference-swarm.ts --bundle --platform=node --format=esm --packages=external --outfile=dist/factorio-inference-swarm.mjs
```

Set `AGENT_BRAIN=claude` or `codex`, `AGENT_MODEL=gpt-6-astra`, the provider credential, `BOARD_URI` and `BOARD_DATABASE=quant-swarm-factorio-coord`. Set `FACTORIO_DEMO_MODE=smoke` for at most three calls per actor or `production` for at least eight. Set finite `FACTORIO_MAX_CALLS` per actor and `FACTORIO_ORCHESTRATOR_MAX_CALLS` for the coordinator. The total ceiling is five times the actor limit plus the coordinator limit; a call cap is not a dollar cap. Keep credentials private.

## Launch and stop

```sh
node dist/factorio-inference-swarm.mjs /absolute/path/to/world prompted-demo
node dist/factorio-inference-swarm.mjs /absolute/path/to/world prompted-demo --start
```

The default dry run reads game status and checks actor/world configuration without model calls or board writes. `--start` seeds the rocket goal and five run-scoped actor tasks, then launches five workers and the board-only coordinator. Ctrl+C stops the launcher and children; stop/save the separately started world afterward.

The immutable plan/logs are under `WORLD/inference/RUN/`; actor tokens, state and deadlines are under `WORLD/inference/RUN-agent-N/`. Restart retains original call counts/deadlines. Unknown actions without valid engine receipts are quarantined, not replayed. Resource leases renew every 15 seconds independently of model calls and pause. Lost, expired or uncertain renewal cancels inference and stops new actions for reconciliation. Rules and inference workers use `world/WORLD_ID/entity/UNIT_ID` reservations; stop old workers using legacy chest/furnace paths before mixing versions.

## Prompts and inspection

Use `FACTORIO_PROMPT`, `FACTORIO_PROMPT_FILE`, or `FACTORIO_PROMPT_DIR` containing `agent-1.txt` through `agent-5.txt`. Files are read each turn. Example: “Share resource availability with peers and work toward the rocket goal.” Recipients look like `prompted-demo-agent-2`; an empty recipient broadcasts.

Context includes local observations, reservations, scoped peer messages, the previous result, and remaining call/time allowance. Peer text is data. Inspect decision/chat/action-result/completion records on the Factorio board and compare them with actual game receipts/inventory. Each worker journal's `state.json.calls` records its consumed calls; inspect the worker log and launcher exit for exhaustion or failure, and the supervisor record for retry attempts or quarantine. `FACTORIO_REQUIRED_PLATES` defaults to five; different objectives need an appropriate verifier.

Run [provider-free acceptance](factorio-inference-acceptance.md) first. A live five-actor run, useful peer communication, coordinator tasking and graphical observation require their own evidence.
