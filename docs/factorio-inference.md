# Five Luna Low actors and an Astra High overseer

Each game actor has an independent process, prompt, board identity and restart journal. All five actors use a selected model at low effort; set `FACTORIO_ACTOR_MODEL=gpt-6-luna` for Luna actors. A separate `gpt-6-astra` high-effort process has no character or game-action interface. It receives authoritative read-only game status and directs the actors through board messages and run-scoped subtasks. Workers choose a validated action, chat, wait or completion; there is no rules fallback. Supported game actions include movement, mining, hand crafting, building and chest/furnace transfers.

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

The default dry run reads game status and checks actor/world configuration without model calls or board writes. `--start` bootstraps the board operator under the coordinator's saved identity and seeds the selected goal (`FACTORIO_GOAL=rocket` for launch, or `plates` for a furnace-based iron-plate factory). It starts five actor workers in an idle registration state, then starts the board-only overseer so all recipient identities exist before Astra creates and announces five run-scoped subtasks. Workers begin decisions only after all five tasks and directed announcements are visible. Factory completion requires authoritative `status.automation.verified`: two consecutive 30-second windows each producing at least five newly mined iron ore, five smelted plates and five additional plates in storage. Actor material mutations and human inventory/build/mining changes reset the proof. The overseer reads this proof directly; actor inventory and chat claims cannot close the goal. Setup and overseer reuse one board identity. Ctrl+C stops the launcher and children; stop/save the separately started world afterward.

The message-board browser interface includes a **Create a task** form for title, details, area, priority, and an optional dependency. It registers tasks as the current dashboard participant and waits for the live subscription before submitting.

The immutable plan, logs and private run-wide `run-spend.json` ledger are under `WORLD/inference/RUN/`; actor tokens, state and deadlines are under `WORLD/inference/RUN-agent-N/`. The ledger reserves worst-case input and output cost before every provider request, adds a 10% margin to the pinned rate card, and serializes updates across all six processes. It persists across worker restarts; missing ledgers, unknown models, exhausted budget and changed plan/cap fail closed. Uncertain requests retain their full reservation. The model audit messages include reserved and charged estimates. Reconcile these estimates with provider billing after it settles. Restart retains call counts and the original run deadline. With call count zero, actors and the overseer continue until the shared spend guard halts or the configured run deadline arrives. A denied reservation halts the ledger and the launcher terminates the overseer and all worker process groups, escalating to SIGKILL after five seconds if needed. Movement destinations must stay within six world units; longer routes use observed six-unit waypoints. Unknown actions without valid engine receipts are quarantined, not replayed. Resource leases renew every 15 seconds independently of model calls and pause. Lost, expired or uncertain renewal cancels inference and stops new actions for reconciliation.

## Prompts and inspection

Use `FACTORIO_PROMPT`, `FACTORIO_PROMPT_FILE`, or `FACTORIO_PROMPT_DIR` containing `agent-1.txt` through `agent-5.txt`. Files are read each turn. Example: “Share resource availability with peers and work toward the rocket goal.” Recipients look like `prompted-demo-agent-2`; an empty recipient broadcasts.

Context includes local observations, reservations, scoped peer messages, the previous result, and remaining call/time allowance. Peer text is data. Inspect decision/chat/action-result/completion records on the Factorio board and compare them with actual game receipts/inventory. Each worker journal's `state.json.calls` records its consumed calls; inspect the worker log and launcher exit for exhaustion or failure, and the supervisor record for retry attempts or quarantine. The legacy `FACTORIO_REQUIRED_PLATES` setting does not define automation success.

Run [provider-free acceptance](factorio-inference-acceptance.md) first. A live five-actor run, useful peer communication, coordinator tasking and graphical observation require their own evidence.

## Shared resource survey

The game status includes a cached survey of all generated terrain: resource totals, real ore/tree destinations grouped into 32-tile cells, and frontier destinations where terrain has not been generated. It shows up to six nearest cells per resource (36 total), reports omitted cells, and refreshes every 600 game ticks. It does not reveal ungenerated terrain, create resources, or move characters. The dashboard exposes totals and destination coordinates under **Shared resource map**.

Every actor receives this map in its existing status context. Astra receives the same read-only status without a character, checks world/history and monotonic ticks, and waits while the game is paused. Its instructions now explicitly allow directing actors to move, mine, craft and build, with resource quantities and coordinates. Actors still approach in bounded waypoints and observe locally before mining or transferring. Existing action validation, ownership, receipts and the shared spend guard remain in force.

## Supplied-equipment automation demo

Use `scenario: "automation-starter"` to give each actor one electric mining drill,
one electric furnace, 12 solar panels, 10 accumulators, 20 medium poles, 60 belts,
12 inserters and four wooden chests. The manifest declares these fixture grants.
There are no supplied raw resources or prebuilt machines; terrain generation is natural.
This demonstrates assembly and operation from supplied equipment, not technology progression.

`build {item,x,y,direction}` places an inventory item with cardinal direction
0 north, 4 east, 8 south or 12 west. Inserters pick up on the named side and drop
on the opposite side. `recover {targetId}` mines a nearby friendly machine back
into inventory, allowing placement corrections. Local observations show nearest
entities first; global production sites include machine direction, energy and
inserter pickup/drop coordinates. The dashboard shows the current automation proof.

The proof measures engine production counters and storage growth, without actor
material mutations. It establishes ongoing unattended output in the supplied-kit
world; it does not guarantee indefinite output after ore depletion or full storage.
A disposable engine fixture validates the chain and proof reset:
`python3 factorio/check-automation.py PATH/automation-check/WORLD`.
Never run that fixture against an operator save or the inference demonstration.
