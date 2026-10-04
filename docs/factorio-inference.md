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

The immutable plan, logs and private run-wide `run-spend.json` ledger are under `WORLD/inference/RUN/`; actor tokens, state and deadlines are under `WORLD/inference/RUN-agent-N/`. The ledger reserves worst-case input and output cost before every provider request, adds a 10% margin to the pinned rate card, and serializes updates across all six processes. It persists across worker restarts; missing ledgers, unknown models, exhausted budget and changed plan/cap fail closed. Uncertain requests retain their full reservation. The model audit messages include reserved and charged estimates. Reconcile these estimates with provider billing after it settles. Restart retains call counts and the original run deadline. With call count zero, actors and the overseer continue until the shared spend guard halts or the configured run deadline arrives. A denied reservation halts the ledger and the launcher terminates the overseer and all worker process groups, escalating to SIGKILL after five seconds if needed. Movement destinations must stay within six world units; longer routes use observed six-unit waypoints. `maxTicks` is a Factorio tick timeout, not a distance; 120 ticks is the normal movement allowance, within the 1–600 command bound. After validating the 1–600 bound, the worker raises any shorter move timeout to 120 ticks, preserving the model-selected destination. After a timeout, reobserve and increase the timeout or choose another waypoint. Never repeat an unchanged failed command. Unknown actions without valid engine receipts are quarantined, not replayed. Resource leases renew every 15 seconds independently of model calls and pause. Lost, expired or uncertain renewal cancels inference and stops new actions for reconciliation.

## Prompts and inspection

The active Astra-created board subtask is each worker's task instruction. To redirect a worker, have Astra replace its current subtask; the worker then receives the new title and details on its next decision. Recipients look like `prompted-demo-agent-2`; an empty recipient broadcasts.

Worker context is limited to the current Astra assignment, the actor's inventory and up to ten nearest observed entities, a compact last result, at most one short direct Astra note, and nearby conflicting reservations. Water terrain details are included only for water, pump, pipe, fluid or steam tasks. The prompt omits the operator-wide goal, global game status/map, unrelated peer history and call/time budgets; Astra retains the full map and overall plan. Each input is capped at 6 KB, and `inference_audit.promptBytes` records its actual UTF-8 size. Peer/task text remains untrusted data. Inspect decision/chat/action-result/completion records on the Factorio board and compare them with actual game receipts/inventory. Each worker journal's `state.json.calls` records its consumed calls; inspect the worker log and launcher exit for exhaustion or failure, and the supervisor record for retry attempts or quarantine. The legacy `FACTORIO_REQUIRED_PLATES` setting does not define automation success.

Run [provider-free acceptance](factorio-inference-acceptance.md) first. A live five-actor run, useful peer communication, coordinator tasking and graphical observation require their own evidence.

## Shared resource survey

The game status includes a cached survey of all generated terrain: resource totals, real ore/tree destinations grouped into 32-tile cells, and frontier destinations where terrain has not been generated. It shows up to six nearest cells per resource (36 total), reports omitted cells, and refreshes every 600 game ticks. It does not reveal ungenerated terrain, create resources, or move characters. The dashboard exposes totals and destination coordinates under **Shared resource map**.

Every actor receives this map in its existing status context. Astra receives the same read-only status without a character, checks world/history and monotonic ticks, and waits while the game is paused. Its instructions now explicitly allow directing actors to move, mine, craft and build, with resource quantities and coordinates. Actors still approach in bounded waypoints and observe locally before mining or transferring. Existing action validation, ownership, receipts and the shared spend guard remain in force.

## Empty-inventory automation run

The current operator goal uses `scenario: "freeplay"`, with five empty inventories,
no supplied raw resources and no prebuilt machines. Agents gather natural wood,
stone, iron and coal, bootstrap smelting, craft unlocked machines and assemble the
factory themselves. Manual work is allowed during construction; completion still
requires unattended mining, smelting and plate storage. Burner production setups
also need newly machine-mined coal in each verification window. Coordinate fuel
acquisition and delivery as part of the factory, not ongoing actor feeding.

## Optional supplied-equipment test fixture

This fixture is **not** the current live run configuration.

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

## Bridge coverage for the burner iron line

The bounded bridge supports moving, mining observed resources/trees, hand crafting
unlocked recipes (including craftable intermediates), placing with cardinal
orientation, recovering placed machines, chest/furnace transfers, and fuel-only
put/take for burner drills, burner inserters and boilers. The last three use their
actual fuel inventory; non-fuel items and electric machines without fuel slots
are rejected. Full requested transfer quantities must fit before mutation.

Observations include fuel stacks, currently burning fuel, remaining burner energy,
readable machine status and mining-drill output coordinates. Boiler/steam/piping
and basic belt infrastructure are visible and recoverable. Fuel in the active
burner is distinct from items still in its inventory. Mining receipts count actual
resource depletion: Factorio 2.0.77 can return false from `mine_entity` while still
adding ore to the character and leaving the resource entity present.

`python3 factorio/check-burner-bridge.py PATH/burner-bridge-check/WORLD` is a
**destructive disposable fixture**, requiring a path containing
`burner-bridge-check`. It checks crafting/build/recovery, fuel transfers,
full-capacity rejection, immutable replay, ownership/range/pause rejection,
observations, chest/furnace routing, real fueled production and mining receipts.
It must never target the live inference save.

## Research and assembly

`research {technology}` selects an available science technology. It rejects locked
prerequisites and switching away from different active research. Selection does
not complete research: powered labs must consume the required science packs.
`status.research` reports active progress, available science technologies, earned
technologies and automatic production triggers (for example, smelting fifty iron
plates unlocks steam power). Trigger technologies are earned in game, not queued.

Factorio 2.0.77 omits production statistics for hand crafts by scripted characters.
For research-trigger products, the bridge tracks the engine craft queue and exact
inventory increase, excluding further inventory actions until it finishes. Only
verified output is reported to the engine production statistics, which applies
normal research prerequisites. Cancelled/unverified output gets no credit. The
tracker persists across saves; observations expose `triggerCraftPending` and
`craftingQueue`, and status retains the last verification evidence.

`set_recipe {targetId,recipe}` configures a nearby friendly assembler with an
unlocked recipe supported by its crafting category. Before changing recipes,
empty its input/output, modules and fluids and finish the current craft. Selecting
the same recipe is a no-op, retaining ingredients and progress. This prevents the
engine's recipe-change item ejection from silently discarding resources.

`put` accepts recipe item ingredients into assembler input and science packs into
labs; `take` retrieves assembler output or remaining inputs and lab science packs.
Observations include recipes, ingredients/products, progress and separate assembler
input/output inventories. Configuration operations use the existing pause,
reservation and immutable receipt safeguards; research selection is shared peer
information. `status.recipeCatalog` lists enabled recipe names.

`python3 factorio/check-research-assemblers.py PATH/research-assembler-check/WORLD`
requires a **disposable world**. It grants explicit test materials/machines/power,
then verifies engine production triggers, scripted lab crafting, science research,
actual assembler output, transfer/replay and invalid configuration rejection.
These fixture checks do not prove inference agents have completed a factory.

Circuit programming, fluid loading by actors, module configuration and other
advanced machine controls remain outside the bounded action vocabulary.


## Overseer reference lookup

The coordinator receives live game state and can issue `kind=lookup` with a
specific Factorio Wiki search query in `message` (maximum 160 characters; all
other strings empty). This read-only action searches the official wiki and
returns up to two English article excerpts with source links, timestamps and
truncation flags. The latest three results persist in the coordinator journal
and enter subsequent model context; older results are omitted if context is full.
The dashboard records results as `reference_lookup` events (select all activity).

Requests use a fixed HTTPS wiki endpoint, no redirects, a 12-second timeout and
bounded response sizes. Only the public query is sent, without game credentials
or world state. Errors become explicit lookup results. There is no additional
model or agent: lookup decisions and subsequent reasoning retain the shared
run spend guard. Pages are external reference data, never executable instructions;
Factorio 2.0.77 base-game observations override newer/wiki/Space Age information.
Excerpts omit templates and infobox details, so precise current recipe/technology
availability still comes from the running game.


## Persistent coordinator plan and spatial inspection

The Astra coordinator authors its own plan through `write_plan` decisions. The
message is JSON `{section,content}` (20 sections maximum, 1700 characters each).
`current` is the short working summary; other sections load only through
`read_plan`. The journal persists the canonical plan, with an atomically written
`overseer-plan.json` mirror beside it. Each update increments a revision and logs
`plan_update` on the dashboard. No monitor code authors gameplay strategy.

Default context now contains compact live facts, persistent machine alerts,
changes since the prior decision, resource totals, task headers and new compact
messages. Full request copies are omitted from routine receipt summaries. Task
history and full map data remain stored and are retrieved when needed, rather
than resubmitted every call. Retrieved data carries ticks; stale plans never
prove completion. Invalid structured reads produce feedback instead of crashing
Astra, and pause/scope/budget checks still apply.

`inspect` takes JSON in message: `layout` with x/y/radius (1..16)/offset,
`machine` with id, `task` with id, `receipt` with operation id, `map` with resource,
`research`, or `reference` with cached query. Layout returns 40 placed entities
per page with nextOffset, exact positions, cardinal directions, bounding boxes
and inserter/drill endpoints. It is spatial data, not a screenshot; judgments of
layout quality belong to Astra. Machine details include drill extraction areas,
resource tile counts and current mining target. Persistent alerts keep unchanged
non-working machines visible in the default briefing.

Checks: `src/factorio/overseer-memory.test.ts` and `orchestrator.test.ts` cover
bounded requests, compact context, plan ownership/persistence and scoped reads.
`python3 factorio/check-overseer-inspection.py PATH/overseer-inspection-check/world`
is a destructive disposable fixture checking extraction areas, empty placements,
belt directions/footprints, pagination and rejected bounds. Never run it on a
live world. Factorio base entities can lack the get-by-unit-number flag, so the
read bridge falls back to a friendly-entity lookup without changing game state.


## Spend-only runs (no run deadline)

Set `FACTORIO_RUN_MS=0` along with both call limits set to zero. Zero persists as
an explicit unlimited deadline in the launcher, actor, overseer and supervisor
journals. No run-duration timer is scheduled; the shared dollar guard still
reserves every model request and stops all roles on exhaustion. Per-request,
startup and lease timeouts remain recovery safeguards, not run-duration limits.
The dashboard labels this mode `no time limit`.

Existing finite deadlines are never silently extended. An explicit operator
change requires a stopped-run migration of plan.runMs and the existing actor,
overseer and supervisor deadline fields to zero, keeping world/history IDs,
operation journals, call counters, plans and the spend ledger intact. The
iron-zero-20261004 migration was explicitly authorized; original configuration
files and the unchanged ledger digest were archived privately beside the run.
