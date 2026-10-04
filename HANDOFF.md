# Factorio handoff

## Burner bridge repair and interaction audit — codex, 2026-10-04

Stopped paid actors, paused mutations and explicitly saved before updating the existing server/client mod. Fixed three confirmed gaps: (1) fuel put/take now supports burner drills, burner inserters and boilers through their real fuel inventories; (2) transfer admission requires capacity for the whole requested quantity, rather than `can_insert`'s partial acceptance; (3) mining receipts count actual resource depletion because this engine returns false even when ore was produced and the resource remains. Added fuel inventory/current burn/remaining energy, named status and drill output coordinates; expanded visibility/recovery to boiler/steam/piping/basic belt infrastructure. No items were granted to the live game.

Checks: new disposable `factorio/check-burner-bridge.py` passes crafting prerequisites, oriented build/recovery, all three fuel targets, nonfuel/capacity/foreign/range/pause rejection, immutable receipt replay, chest/furnace routing, real fueled drill→furnace→inserter→chest production, and exact three-ore mining receipt/inventory delta. Existing real-engine rejection/restart and production suites pass. Thirteen protocol/inference tests plus typecheck/build pass. A fixture placement helper initially selected a tile lacking a valid drill placement; the test now uses the engine's `can_place_entity` predicate. Source conservation and reject-without-partial-transfer are verified.

Resumed `iron-zero-20261004` on the same world/history, actor journals, tasks, original deadline and $100 ledger. Server uses updated bridge; old mod backed up under `.game-runs/iron-zero-20261004/bridge-before-fuel-repair`, maintenance save retained. GUI relaunched against the same world. Live automation completion still pending. Advanced research/assembler recipes/circuit configuration remain unsupported and are outside this burner iron-line goal.

## Stable dashboard dropdown interaction — codex, 2026-10-04

The dashboard replaced the full layout on each board/status refresh, destroying open native select menus despite restoring focus afterward. Live redraws now coalesce while a select is being used; change, blur, outside interaction or Escape/Tab releases the pending redraw. Incoming subscription state continues updating, and the eventual render uses the latest snapshot. Programmatic focus restoration does not reopen the interaction guard. Applies to agent/direction/channel filters and other dashboard selects. Dashboard TypeScript check, diff check and live watch build pass; no tests run. Refresh the existing dashboard tab once to load this fix. Gameplay is untouched.

## Event-driven swarm communication — codex, 2026-10-04

Actor and Astra prompts now request communication only for actionable blockers, handoffs/completion, relevant discoveries and material plan changes; routine narration, acknowledgments and unchanged progress are discouraged. Repeated identical chat to the same recipient is suppressed using run/world/history-scoped board history, surviving restarts. Peer context excludes inference audits, decisions, wait events and routine movement receipts while retaining coordination and material/failure receipts. All activity evidence remains on the board. Factorio dashboard defaults to Coordination only, with All activity available; agent filters and exact displayed-message exports respect this selection. Human text remains visible.

Root/dashboard typechecks and live watch/worker/overseer builds pass; no tests added or run. Stopped old role groups and resumed `iron-zero-20261004` with the same save, identities, task ownership, journals, original deadline and $100 ledger. No game reset or new item grants. Live agents continue; ordinary failed mining/transfer receipts still occur and are handled by their worker loops. Changes guide semantic relevance through prompts and enforce exact duplicate suppression; they do not classify every paraphrase of a redundant message.

## Dashboard agent filter and displayed-message export — codex, 2026-10-04

Added an Agent ID selector to Live messages, with Factorio worker index/physical actor ID labels and sent/addressed-to/either routing filters. Selection persists per board across reloads. Filtering happens before the visible message limit; Load older messages expands the filtered stream. Download displayed logs exports precisely the rendered message array in newest-first JSON, with full body, string ID, ISO timestamp, sender, recipient, task ID and filter metadata. Empty exports are disabled. Scoped responsive controls handle long IDs. Dashboard TypeScript check and live esbuild watch compilation pass; no tests added or run. Refresh the existing port-4193 dashboard to load the controls. Gameplay processes/save/budget are untouched.

## Actor context overflow recovery — codex, 2026-10-04

All five `iron-zero-20261004` actors exited when dense nearby-entity observations plus duplicated task details exceeded the 24,000-character required prompt limit. At diagnosis they had moved toward resources; actor 12 had gathered wood/crafted a chest, with $1.45 charged. Stopped the launcher, compacted optional nearby/production listings and repeated task descriptions with explicit omission counts, preserving scope, objective, own inventory, reservations and last outcome. Root typecheck and worker bundle pass; no additional tests run. Resumed the SAME save, task identities, journals, deadline and $100 ledger. At tick 23151 all five positions advanced, actor 14 had two iron ore and actor 12 had 14 wood plus a chest; 107 calls, $1.652329 charged, ledger not halted. Some mining attempts return failed receipts and are handled by the worker; no new context-overflow exits observed. Live factory construction remains in progress.

## Empty-inventory automation correction — codex, 2026-10-04

Operator clarified that no equipment or materials may be supplied. Stopped `iron-auto-20261004` and preserved its save and ledger; replaced the kit-specific prompts/objective with gather → bootstrap smelt → craft → assemble → unattended production. Manual gathering/feeding is allowed only as bootstrap work. Burner production requires fresh machine-mined coal during each proof window. The kit scenario remains an optional disposable fixture only.

Current run `iron-zero-20261004` uses a fresh **freeplay** save at `.game-runs/iron-zero-20261004/world`; world `c40346fa-f288-4a7c-abca-4439f41b9532`, history `52ef8cd4-51cf-4d3e-ae36-8b5bcda45795`. Live engine startup assertions verified all five inventories empty, zero chests/furnaces and no prebuilt production equipment. One Astra High coordinator and five Luna Low actors, unlimited call counts, fresh shared $100 cap; inherited one-hour deadline remains. Board database `iron-zero-20261004` on port 3008, game 34201/RCON 27019, dashboard `http://127.0.0.1:4193/?board=factorio`. Fresh run started; automation has not yet been achieved. Prior implementation `03224d9` is pushed. Next: monitor actor gathering and crafting, construction, and engine proof without granting items or manually operating their factory.

## Unattended iron automation — codex, 2026-10-04

Operator clarified that actors must construct an automatic ore-to-storage factory using supplied in-game equipment. Plate inventory claims no longer complete the iron goal. Added bounded oriented `build` and machine `recover` actions across model schema, protocol, worker and Lua bridge; nearest-first local observations; machine power/direction and inserter endpoints; engine proof requiring two consecutive 30-second mining/smelting/storage-growth windows without actor material assistance; and dashboard proof display. `automation-starter` explicitly declares each actor's equipment kit, with no raw resources or prebuilt factory. Twenty focused inference/orchestrator/launch tests, root/dashboard typechecks and bundles pass. Disposable engine test `factorio/check-automation.py` passed direction, recovery, 29 automatically stored plates, verified production and proof reset after a construction action. This fixture is not evidence of model cooperation.

Stopped and preserved `iron-map-20261004`. Fresh live run `iron-auto-20261004` uses world `c12f3e94-a46a-4224-a092-340e3ef4899b`, history `a51bfb00-37e2-4e2d-8819-6d65415d7b50`, one Astra High and five Luna Low, unlimited call counts, shared $100 reserve-and-settle cap, and inherited one-hour run deadline. World `.game-runs/iron-auto-20261004/world`, game port 34200, RCON 27018, board `iron-auto-20261004` on port 3008. GUI isolated client log confirms InGame; dashboard HTTP 200 at `http://127.0.0.1:4192/?board=factorio`. The paid run is starting Astra assignments; live automation success has not yet been established. The global survey implementation was pushed as `13a58bf`. Next: inspect live board tasks, physical placements and engine automation proof. Preserve the ledger and world IDs on resume.

## Shared resource map implementation — codex, 2026-10-04

Added a read-only survey of all generated terrain, cached for 600 ticks and summarized as resource totals, nearby resource cells, and exploration frontiers. All five actors receive it in status; Astra receives the same authoritative status without a character or mutation API. Fixed Astra's prompt prohibition on directing mining/movement; it now assigns concrete resource quantities, destinations and physical work. Dashboard displays the resource survey. Fourteen focused inference/orchestrator tests, root and dashboard typechecks, and all launch/browser builds pass. Live engine checks on a fresh save confirm ore beyond local observation, all four factory inputs, caching, empty inventories and no fixture furnaces. The old run/server/viewer are stopped and preserved. New save `.game-runs/iron-map-20261004/world` is ready with world `01544bf5-c0f0-46a1-9b9c-a76b443578ee`; fresh capped inference run and viewer launch follow.

## Fresh iron factory save — codex, 2026-10-04

Created `.game-runs/iron-fresh-20261004/world` with new world/history IDs, five empty-inventory actors and no fixture resources. Stopped the old run and saved/stopped its server; old files remain intact. Current run `iron-fresh-20261004` uses one Astra and five Luna, unlimited calls and a $100 ledger. New gameplay database is `iron-fresh-20261004` on port 3008; dashboard is open at `http://127.0.0.1:4190/?board=factorio`. The isolated Steam graphical client log confirms `InGame` against port 34198. At tick 25,248 all five actors still had empty inventories and no furnace/chest: they are oscillating near spawn and repeating logistics messages. Observation is limited to 32 tiles; the overseer sees board traffic only. User asked about global map awareness; that capability is not implemented. Next improvement: shared resource map and explicit exploration assignments. No source changes or tests in this runtime restart.

## Browser task creation and live iron-plate factory run — codex, 2026-10-04

Added the browser **Create a task** form for title, details, area, priority, and optional dependency; it submits through the current dashboard participant after the live board subscription is applied. The dashboard now shows the run spend ledger. Added an iron-plate-factory parent goal whose five actor completions require engine-observed inventories of at least five plates each and at least one furnace. Code commit `5369cdd` is pushed to `main`.

The live run `iron-factory-20261003-2358` uses Astra High plus five Luna Low actors, unlimited calls, a shared $100 cap, and the existing world/history (`22cc4c86-f4dc-4698-81c7-97e2d2c669c1` / `51b661d1-cf9a-4034-af99-aa8a0c21b601`). At game tick 219,437, Astra created all five actor subtasks and all five Luna identities claimed them; the board has 120 run messages with movement, transfer, chat, and game-receipt activity. The game reports one furnace; actor 12 has two iron plates and actor 15 has 25 coal. The goal is still in progress. The ledger reports $0.321540 charged and $1.054618 reserved; it is not halted. Dashboard `http://127.0.0.1:4189/?board=factorio` and the Factorio GUI are open. The previous run's services on 3007/4188 were stopped while keeping their database files.

Checks: `npm run typecheck`, all four correct inference bundle builds, and the dashboard browser build succeeded. No tests were run. Next: keep monitoring the live board, game inventory/receipts, and shared ledger; the run stops on the $100 guard or its one-hour deadline.

## Unlimited production calls under shared spend cap — codex, 2026-10-03

Production runs now require `FACTORIO_MAX_CALLS=0` and `FACTORIO_ORCHESTRATOR_MAX_CALLS=0`; both the five actors and Astra continue without a model-call count limit. The shared atomic ledger remains the spend stop and the launcher terminates all six process groups when its cap blocks a request. The dashboard labels call counts as unlimited. Smoke mode retains its small per-actor count for quick checks. Commit `6116919` is pushed to `main`. Typecheck and all four inference bundles pass; tests were not run. The prior 2252 run was stopped before this change (charged $0.485961, reserved $0.064757 against its $398.30 cap; one Astra process needed SIGKILL during manual stop).

Started `freeplay-luna-astra-20261003-2258` on a fresh isolated Factorio board at port 3007 with a $400 shared cap, Astra High overseer and five Luna Low workers. Reused the existing saved game without resetting it; `worldId` and `historyId` remain unchanged. The overseer created and announced all five actor subtasks, all five workers claimed them, and the board shows movement, mining and chest decisions plus 16 completed and five failed game receipts. At game tick 128,940, 87 model-call records show $0.443292 charged and $8.004291 reserved; the ledger is not halted. The configured one-hour run deadline remains. The game has not launched a rocket yet. Factorio GUI is open; dashboard is open at `http://127.0.0.1:4188/?board=factorio`. Stopped the superseded dashboard and gameplay DB listeners while keeping their on-disk histories. The first post-build start attempt exited before any model calls because I had bundled library files instead of executable wrappers; rebuilt from `scripts/factorio-inference-{worker,orchestrator}.ts` and the current run then started successfully. This runtime repair changed no tracked source.

## Run spend ceiling and overseer-created actor tasks — codex, 2026-10-03

Implemented a shared per-run spend ledger for the Astra overseer and five Luna workers. The launcher hard-limits the configured run cap to $500, reserves worst-case cost before each call using the pinned OpenAI Standard rate card plus 10%, reconciles reported token usage, and preserves uncertain reservations across worker restart. Model audit messages expose the cap and current charged/reserved estimate. Restart with the same run ID requires the original plan and ledger.

Startup now creates only the rocket goal, starts the overseer, and waits for its five actor-specific subtasks plus directed board messages before launching workers. Actor task IDs point at those overseer-created rows. Completion of the root goal now requires a worker completion record that reports an engine rocket-launch event. Movement prompts prefer a 600-tick bound for multi-tile travel and require mining targets to be observed within reach.

The user then asked to leave everything stopped. Stopped Factorio server/client, Factorio dashboard service, and gameplay SpacetimeDB on port 3004; no inference workers were running. Shared Development SpacetimeDB on port 3000 remains running. Do not restart the demo without new user steering. Preserve the existing world/board history; a new run ID needs a fresh isolated gameplay DB because the old board retains six participants under its cap of eight. Checks: `npx tsc --noEmit`, `git diff --check`, and all four inference/launcher esbuild bundles pass. Did not run tests or provider calls. Runtime preflight was attempted after shutdown but port 27015 remained in TCP TIME_WAIT; no process was listening on the Factorio/RCON/dashboard/gameplay DB ports. Recheck ports before the next launch. Code commit: `9850e2e`.

## Luna actors with Astra overseer — codex, 2026-10-03

Task `factorio-luna-actors`; model split support pushed to `main` as `c70acad`. `FACTORIO_ACTOR_MODEL=gpt-6-luna` now selects the five low-effort workers while `AGENT_MODEL=gpt-6-astra` remains the board-only high-effort overseer. Reused the saved freeplay world without resetting it. New isolated Factorio board and run `freeplay-luna-astra-20261003`; the matching 2.0.77 Steam GUI joined the server, and the Factorio dashboard is open at `http://127.0.0.1:4185/?board=factorio` (workspace 2; game client workspace 3).

Smoke limits were two calls per actor, one overseer call, five minutes, eleven calls maximum; all eleven were used (ten Luna, one Astra). Six participants registered and claimed the root goal plus five actor tasks. The board recorded 25 run messages: ten decisions, ten usage audits, three chats, one failed movement receipt, and one Astra audit. All journals have no pending operation. The launcher exited 1 when each role reached its configured call limit. The world advanced to tick 40,476; actor 12 still held two iron plates, the other actors held none, and the engine recorded zero rocket launches. This was a live low-call smoke run, not production acceptance or rocket progress. No further calls were made after the budget was exhausted.

Checks: four launcher bundles built, `npx tsc --noEmit`, runtime preflight, dry run confirmed Astra/Luna mapping and eleven-call ceiling, live RCON status and board session/message inspection. The dashboard and Factorio client remain open for observation. For more work, start a new run with a separately approved call ceiling; this run's journals are exhausted and immutable.

## Reset, participant cap and live relaunch — codex-factorio-demo, 2026-10-03

Completed `factorio-reset-six-participant-demo-20261003` and `factorio-live-actor-recovery-20261003`; code pushed to `main` as `e1f6a8f`, both Development board tasks closed. Stopped the old actor fleet and saved `.game-runs/freeplay-astra-start-1-reset-checkpoint`; deleted/re-published only the gameplay board; created fresh empty freeplay `.game-runs/freeplay-astra-start-2`; relaunched five Astra Low actors plus one Astra High board-only coordinator; Steam GUI joined at `127.0.0.1:34197`. The gameplay board contains exactly six participants and `board_config.participant_limit=8`; dashboard returns HTTP 200 at `http://127.0.0.1:4185/?board=factorio&dbPort=3004`. Root goal is rocket launch, coordinator owns it, and an actor created a resource-scouting subtask. The agents started empty and are now gathering resources; no rocket launch yet. The shared message-board module enforces a default hard cap of eight with operator configuration from 1–8; Factorio launcher setup reuses coordinator identity, preventing a seventh row. Provider-free Factorio tests (33), board cap integration, root/message-board TypeScript checks, Python compile and `factorio/check-runtime.py` pass. `npm run check:dashboard` fails in its separate trading fixture because it passes string `"0"` where `record_account_snapshot.daily_pnl` expects `Option<String>`; the live Factorio dashboard route returns HTTP 200.

## Five players plus board-only coordinator — codex-factorio-demo, 2026-10-03

`factorio-five-actors-astra-orchestrator-20261003`: reduced the fresh saved world to five visible scripted actors (units 12–16), all `gpt-6-astra` low effort. Added a separate `gpt-6-astra` high-effort orchestrator with only message-board access; it claimed the rocket goal, created a run-scoped task for Actor 2, and sent actor-directed messages. Active live run: `freeplay-astra-orchestrated-2`, Factorio `127.0.0.1:34197`, board `http://127.0.0.1:4185/?board=factorio&dbPort=3004`. The old ten-actor save is preserved at `.game-runs/freeplay-astra-start-1-ten-agent-checkpoint`. Live board topology verified. Some worker action attempts still fail (mining, movement, unavailable recipe); no rocket launch verified. `python3 factorio/check-runtime.py`, root typecheck, focused tests (32 total), Python compile checks and `git diff --check` pass. Implementation pushed to `main` as `ca7980a`; final result recorded on the Development board.

## Current focus

Factorio only: five `gpt-6-astra` low-effort game actors share a gameplay board and are directed by one `gpt-6-astra` high-effort board-only orchestrator. The live Development board owns assignments; do not restore cleared historical tasks automatically. Current live world is `.game-runs/freeplay-astra-start-2`; gameplay board reset leaves exactly six participants and has a hard cap of eight. Earlier worlds remain preserved separately.

## Freeplay work — codex-factorio-demo, 2026-10-03

`factorio-freeplay-rocket-subtasks-20261003`: added engine mining, queued hand crafting, inventory-backed placement, generalized item transfers, agent-created subtasks and receipt-verified resource requests. Previous run `.game-runs/freeplay-astra-1` is retained as a progressed checkpoint; the active run was reset fresh at `.game-runs/freeplay-astra-start-1`. Research, machine recipes, fluid handling and launch commands remain absent; no rocket victory claimed. See factorio/FREEPLAY_DEMO.md.

## Fresh start and operator view — codex-factorio-demo, 2026-10-03

At that earlier checkpoint, the current Factorio 2.0.77 world at `127.0.0.1:34197` had ten actors and zero fixture inventory. The graphical Factorio client was connected on workspace 3. The player had full Factorio admin access and `/qs help` exposed the in-game commands. This ten-actor topology was superseded by the five-actor plus Astra High orchestrator setup above. Implementation was pushed to `main` as `a1d477e`; the original progressed save remains preserved separately.

## Prompted demo checkpoint — codex-factorio-demo, 2026-10-03

`factorio-inference-graphical-20261003`: provider-free acceptance passed (16 tests), graphical viewer joined, and ten independent model workers ran live. The initial run used `gpt-5.3-codex`; after operator correction, a fresh world and board ran `gpt-6-astra`, with peer messages, game receipts and at least two actors holding five actual plates. Fixed contradictory reservation guidance and unstable actor ordering in restart plans. Focused acceptance and root typecheck passed. The operator redirected the work to freeplay, so fixture workers were stopped and their world saved.

## Implemented and checked

- Runtime/bridge: Factorio 2.0.77, five active scripted actors, bounded movement/transfers, private RCON and disposable engine checks.
- Historical fixture: ten rules workers produced fifty plates with matching game/board receipts. [Evidence and limits](docs/factorio-live-verification.md).
- Inference: scoped decision contract, durable worker and ten-process launcher; deterministic checks cover malformed output, ownership/pause, budgets, uncertain receipts and false completion. [Run guide](docs/factorio-inference.md).
- Boards: atomic claims, reservations, archived task dependencies, live priorities and responsive dashboards. Blank browser names are assigned automatically; bots choose priorities using [the policy](docs/task-priorities.md).

## Remaining release gates

Real-provider ten-worker production, useful peer-message consumption, graphical replay, end-to-end fault recovery, validated spend limits and natural-map progression require their own evidence. Historical paths/services may have expired; inspect the current host before launch. [Roadmap](IMPLEMENTATION_PLAN.md) · [Readiness checks](docs/application-readiness.md).

## Session notes

- Paper credential publication — codex-board-3, 2026-10-03: Pushed `6be4111`, `203be67` and `9e063db` to `main`. Only the executor child receives order keys; risk, market data and account discovery use separate read keys, and preflight rejects a reused key ID. `check:all` passed in an isolated server (198 unit tests, research/Phase 1/mock executor acceptance), as did post-rebase typecheck. Provider-enforced read-only permission for the read pair remains an operator setup requirement; see [credential boundary](docs/paper-credential-isolation.md).
- Factorio demo budget publication — codex-board-3, 2026-10-03: Source call-budget commit `ba2f15c` and runbook update `2d41f0e` were pushed to `main`; the board publication task is done. Kept the eight-decimal move-coordinate contract. Root typecheck and 19 focused inference tests passed.
- Factorio supervision publication — codex-board-3, 2026-10-03: Published the checked supervisor launcher commit from `f6e5991` as `3d752ef` on current main. Root typecheck, both launcher bundles, and all four supervisor tests passed. The board publication task records the pushed hash; the original implementation owner should mark its blocked implementation task done.
- Board identity authorization — codex-board-3, 2026-10-03: `board-auth-tailnet` code was pushed as `d6307f8` and both live boards were migrated without deleting data. Development history was bound to the local CLI operator identity; the gameplay board had no historical sessions. The tailnet relay is back at `100.107.208.76:3001` (exec session `32564`), ping returns HTTP 200, and an anonymous impersonation attempt through it was rejected. Disposable board and cleanup checks, root typecheck and CLI builds passed. Browser names with distinct old tokens need reassignment or a new name; see [session handoff](docs/handoffs/codex-board-3.md).
- Paper pilot preflight — codex-board-3, 2026-10-03: `pilot-preflight-scope` is complete and pushed to `main` as `4766daf`. Removed Minecraft runtime, build and listener requirements from the paper check and corrected its Factorio status text. TypeScript and a paper-only runtime fixture passed. See [session handoff](docs/handoffs/codex-board-3.md).
- Full-stack review — codex-factor, 2026-10-03: reviewed board, dashboards, trading workers, risk module and deployment alongside the [Factorio stack review](docs/factorio-stack-review.md). Confirmed remote board name impersonation, unusable paper daily-loss gate, paper credential duplication, unbounded board history, non-atomic task priority and mixed-application preflight. Posted `board-auth-tailnet`, `paper-daily-loss-input`, `paper-credential-isolation`, `board-history-scale`, `board-priority-atomic` and `pilot-preflight-scope` with push instructions. Review was read-only; no new checks ran. Next: claim the highest-priority eligible board fix, starting with board authorization.
- Factorio message-board sidebar — codex-factor, 2026-10-03: desktop sidebar and main content now scroll independently, and live refreshes retain both positions. Pushed `cb8f5eb` (following `9a486d0`); updated the clean dashboard checkout serving ports 4174/4175 to `cb8f5eb` and confirmed both ports serve the new stylesheet. `npx tsc --noEmit`, browser bundle, and `git diff --check` passed. Reload the browser tab to load the new script and CSS.
- [Inference implementation](docs/handoffs/codex-connect.md)
- [Live acceptance owner](docs/handoffs/codex-inference-live.md)
- [Runtime and historical fixture](docs/handoffs/codexq-factorio.md)
- [Shared board](docs/handoffs/codex-factorio.md)
- [Journal and demo integration](docs/handoffs/merge-fix.md)
- [Dashboard and documentation](docs/handoffs/codex-queue.md)

Keep future entries brief: task/owner, current status, pushed commit, checks, blockers and next action. Preserve other sessions' unfinished work and coordinate file locks. Commit/push completed work directly to main; no new pull requests.


## codex — Research and assembler support (2026-10-04)

- Added strict bounded `research` and `set_recipe` commands across model schema,
  TypeScript/Python wire validation and game bridge. Research takes a shared force
  reservation; configuration shares machine reservations. Research selection is
  useful peer information. No model-supplied Lua/RCON is accepted.
- Labs accept science packs; assemblers accept configured item ingredients and
  expose input/output transfers. Recipe changes require empty inventories/fluids,
  no modules and no active craft; selecting the same recipe preserves resources.
- Observations show recipes, requirements/products, craft progress, research
  progress/selectable technologies, automatic trigger prerequisites and enabled
  recipe names. Added a persistent verified-output tracker for scripted-character
  crafts, which Factorio 2.0.77 otherwise omits from production statistics. Only
  finished output present in inventory is credited to normal engine triggers;
  cancelled crafts receive no credit. No direct research grants.
- Integrated coaltrace's startup lease patch: reconcile receipts before restoring
  leases and ignore expired historical reservations. Regression tests came from
  pushed commit 2e953c5; no uncertain transfer is replayed.
- Checks: root/database typecheck; 15 protocol/inference/communication tests;
  7 bundled recovery/lease tests; worker/overseer builds. Direct Node execution
  of the latter tests requires TS transformation, so esbuild bundles were used.
  Fresh disposable Factorio 2.0.77 check passed real smelting triggers, cancelled
  and completed lab crafts, science consumption/completion, assembler production,
  invalid configuration rejection and immutable receipt replay. Fixture grants
  exist only in the disposable test world, never the live save.
- Deployment: preserved iron-zero-20261004 world/history, journals and $100 ledger;
  maintenance save and old mod backup retained privately. Updated server/viewer
  mods, rebuilt roles, graphical viewer rejoined InGame; dashboard 4193 HTTP 200.
  Existing run resumed, $8.847678 charged at restart. No call-count limit. Existing
  saved run deadline remains in place; budget and deadlines were not reset.
- Remaining scope: circuit controls, actor fluid transfers and module configuration
  are not added. Fixture tests do not establish live inference factory completion.
  Monitor coaltrace's separate live miner verification after this deployment.


## codex — Overseer Factorio reference lookup (2026-10-04)

- Coordinator previously had live engine information but no reference retrieval.
  Added a bounded `lookup` decision using official Factorio Wiki search and article
  excerpts; all URLs are fixed-origin, requests timeout and cap bytes, no keys or
  world state leave the process. Links, timestamps, errors and truncation are
  retained in the last three persistent journal results and dashboard audit.
- Lookup is available during assignment too, returns data on the next decision,
  and uses existing model accounting. No extra agent/model/provider tool fee.
  Prompt treats wiki content as untrusted reference and prioritizes pinned engine
  state. Also removed an erroneous electric-smelting requirement from the default
  iron goal text. Gameplay choices remain with Astra.
- Checks: TypeScript check and coordinator bundle build; no test suite requested
  or run for this change. Probed the public Wiki API to select supported search
  and wikitext endpoints (extracts extension is unavailable).
- Rollout preserves existing iron-zero run, world, task history, budget and saved
  deadlines; coordinator restart uses the updated bundle. Article excerpts omit
  infobox/templates and may describe newer releases, so precise recipe availability
  must still be checked against live game state.


## codex — Active run monitor fixes (2026-10-04)

- Operator requested software-only monitoring; all resource/layout/task strategy
  remains with Astra. Found Astra stopped on a >30k context while actors continued.
  Added bounded overseer prompt construction, shedding older messages/references
  before optional task details/sites, with explicit omission counts. Identity,
  objective, actor state and automation proof are retained.
- Found worker subtask lookup excluded every orchestrator-created task. Later
  coordinator subtasks now use normal claim/receipt/ownership checks; the original
  five actor assignments remain protected with clear error feedback.
- Root/database TypeScript check and worker/overseer bundles pass. No tests were
  requested or run. Resumed the same run after a brief mutation pause, preserving
  save, ledger, counters and deadlines. No gameplay directives were issued.
- Continue watching coordinator call progression, actor failures and service health.
  Rejected placements/transfers alone are game outcomes, not evidence of a bridge
  bug. Existing fixed deadline is still present; operator wanted spend-only runs,
  so do not mistake a deadline stop for a $100 budget exhaustion.

- Follow-up: clarified persistent initial-assignment semantics in both role prompts; later coordinator subtasks remain claimable/completable. Typecheck passes. This changes API guidance, not gameplay decisions.


## codex — External Astra plan and targeted inspections (2026-10-04)

- Implemented operator-requested persistent Astra-authored plan sections, plan
  index/current summary, read_plan/write_plan and scoped inspect APIs for tasks,
  receipts, resources, technology, cached references, machines and spatial layout.
  No gameplay strategy was authored by the monitor. Plan updates/inspections are
  dashboard audit events; plan mirror lives privately beside the journal.
- Default input now uses factual game summary, persistent non-working machine
  alerts, machine changes, task headers, new messages and compact receipts. Full
  map/task/receipt detail is retrieved on demand. Bounded reference/plan retrieval
  never executes model text as Lua or shell. Invalid request feedback is durable.
- Added actual mining extraction radius/resources/target to machine observations;
  layout inspection returns paginated positions/directions/footprints/endpoints.
  Verified miner 643 has no resource tiles; Astra chooses any relocation.
- 15 unit/integration tests pass, root/database typecheck passes. Disposable
  Factorio 2.0.77 engine check passed extraction resources vs empty placement,
  belt directions/footprints, pagination and rejected bounds. The engine check
  caught and resolved JSON-wire encoding and base-entity ID-lookup incompatibility.
- Gracefully saved/deployed server/client mods and role bundle in the same live
  world, preserving IDs, spend ledger/counters/deadlines; no rollback/reset. Astra
  used live layout inspection, then wrote its own current plan; journal call96.
  Measured game-state projection 13130 -> 2808 chars; task data 10131 -> 3331 chars;
  current plan summary/index 882 chars at that sample. Full tool results load only
  when requested, so savings vary with retrieval needs.
- Inherited one-hour deadline remains; user was asked whether to remove it because
  local instructions require preserving saved deadlines. Monitoring continues;
  live factory automation is not yet proven.

- Monitor follow-up: Luna workers also exhausted their 24k required-context guard
  as shared task details grew. Added a pressure fallback to omit redundant task
  descriptions, then bounded map lists/task headers; preserves own objective,
  inventory, reservations and last outcome. Ten actor prompt tests pass including
  a 40-task regression. Reconstructed all five live actor contexts without provider
  calls: 18,827–19,247 characters with disclosed omissions. Updated worker bundle
  pending/resuming within the existing authorized deadline.


## codex — Remove inherited time cutoff (2026-10-04)

- Operator explicitly corrected the run to spend-only: no time deadline. Added
  runMs/deadline zero semantics across launcher, roles and supervisors, including
  no duration timers and null remaining-time context. Per-request/startup/lease
  timeouts and all dollar reservations remain enforced. Dashboard says no time
  limit instead of 0 minutes.
- Explicitly migrated 12 existing plan/deadline/supervisor files after all roles
  stopped, with private backups and an audit manifest. Spend ledger SHA-256 stayed
  identical, cap $100, recorded charges $17.271905 before resume. Existing actor
  counters/operation IDs, Astra plan and world/history were retained.
- Root/database typecheck, 21 duration/launch/supervisor/coordinator tests and all
  four role/launcher builds pass. Bounded historical runs retain normal expiry;
  changing duration mode without explicit migration is rejected.
- Same iron-zero-20261004 run resumed with FACTORIO_RUN_MS=0, one Astra/five Luna,
  unlimited calls. Worker context repair from a6a8f08 is included in this resume.
  No gameplay strategy or physical game operations were authored by the monitor.

## codex — Recover oversized inspection and lease renewal failures (2026-10-04)

- Astra exited when a full inspection exceeded the board's 8000-character message
  cap. Full inspection stays in its durable journal; board audit now uses an excerpt.
- Four actors exited on uncertain lease renewal. Game bridge calls now await
  asynchronous subprocesses so movement cannot block lease heartbeats. Typed
  transport failures retry through supervisor receipt reconciliation; unknown
  outcomes quarantine and actual ownership loss stays fatal.
- Launcher stops siblings and pauses mutations when a role fails permanently or
  the overseer exits. Corrected zero-duration registration/assignment startup checks.
- Typecheck and 24 focused orchestrator/recovery/lease/supervisor tests passed.
  The older inference-worker test fixture lacks the current five-actor assignment
  contract; its broad suite was stopped, not counted as passing. New async bridge
  heartbeat regression uses the current recovery fixture.
- Same save resumed with all five journals advancing and dashboard HTTP 200.
  All pending operations were null before resume. World/history, counters, plan
  and $100 ledger retained; no run deadline or call cap. Gameplay remains Astra's.

## codex — Bounded overseer continuity (2026-10-04)

- Live board showed repeated layout inspection / pause-directive cycles while all
  actors waited. Coordinator cleared its latest retrieval after every directive.
- Retain the latest tool result until replaced, plus eight compact proposed
  decisions with ticks/recipients. This records Astra's own choices without
  authoring strategy; engine evidence remains authoritative and can become stale.
- Typecheck, diff whitespace check and all 12 coordinator tests pass, including
  inspection persistence through wait decisions and journal restart, bounded at
  eight entries. Deployed to same save/run, preserving ledger and identities.
- Factory not yet verified; continue monitoring actual assignments and receipts.

## codex — Malformed coordinator response recovery (2026-10-04)

- Live overseer call167 failed in SDK structured JSON parsing. Team shutdown
  worked: all roles stopped, mutations paused; $31.948394 charged/$100 cap,
  unknown in-flight usage remains reserved conservatively.
- Handle only known structured-output parsing/schema failures as rejected
  decisions, retaining previous evidence and consuming a fresh reservation on
  retry. Authentication, arbitrary errors and aborts still propagate.
- Typecheck and 14 coordinator tests pass, including malformed JSON retry with
  no effects/evidence loss, plus unexpected-error propagation.
- Resumed same run/save after proving no inference roles remained; restored
  exact saved model/budget/duration mapping. No game edits or strategy directives.

## codex — Retain actor coordination directives (2026-10-04)

- Live evidence: actor1's last directed assignment had 54 newer useful messages;
  actor4's had 55. The last-20 activity window dropped both assignments while
  stale initial task text remained, allowing construction intent to disappear.
- Prioritize two latest directed coordinator chats and latest broadcast before
  filling recent peer activity; deduplicate, keep chronological order, disclose
  omitted messages, and retain the 30k prompt ceiling. No gameplay authored.
- Typecheck and 12 inference tests pass, including 60-message activity flood and
  heavy required-context regressions. Deploying same saved run, preserving
  journals, scope and ledger; goal still requires live unattended verification.

## codex — Ground-item visibility and pickup (2026-10-04)

- Read-only engine diagnostic proved dropped iron ore at (-62.703125,26.5)
  overlaps Astra's intended furnace site. It was absent from both observation
  and layout, and the action protocol had no ground pickup.
- Added bounded pickup(item,x,y,quantity 1..100), exact coordinate validation,
  locally observed/reachable target gate and tile reservation. Engine transfers
  actual stack data into inventory, keeps any remainder, records quantity and
  resets unattended proof. No grants, automatic cleanup or gameplay directives.
- Observation/layout now include ground items/counts and physical obstacles
  (characters, trees, simple entities, cliffs). Layout pagination stays bounded.
- Typecheck, whitespace check, 13 inference tests and disposable real-engine
  ground-pickup check pass: visibility, partial/full conservation, exact replay,
  pause/range/wrong-item rejection, build blocked before and allowed after pickup.
- Saved/restarted live server and viewer to deploy, with private mod/manifest
  backup. Same scope/save/ledger; all inference roles resumed. Live layout now
  exposes the one dropped iron ore. Astra must choose pickup/build actions.

## codex — Preserve local evidence during prompt compaction (2026-10-04)

- Reconstructed two live actor prompts: both retained only 8/100 nearby entities.
  The compactor discarded local evidence before removing repeated board details.
- Remove duplicate descriptions first, then compact global sites, then nearby
  entities. Own objective/inventory/last outcome and coordinator retention remain.
- Same live snapshots now retain 16 entities under the same limit. Typecheck and
  14 inference tests pass, including retaining a local list amid large duplicate
  task/site data. Deploying same run; no strategy or world changes.

## codex — Coordinator assignment ordering (2026-10-04)

- Actor1 explicitly reported old global hold vs newer direct assignment conflict
  despite visible numeric message IDs. Clarified chronological gameplay routing:
  newer coordinator assignments supersede conflicting older holds/task text.
  Unrelated constraints and engine pause/ownership/budget checks remain binding.
- Typecheck and 15 inference tests pass. Prompt assertions check the protocol;
  live model behavior still requires monitoring. Same save/run redeployed.

## codex — Outgoing report memory (2026-10-04)

- Agent5 repeatedly paraphrased unchanged coal endpoint reports. Actors previously
  excluded every own message and saved only chat recipient, losing report content.
- Retain only latest same-scope own chat and prioritize it after coordinator
  assignments. Prompt explicitly uses it as memory and requests new information
  before another report. Existing exact duplicate suppression remains.
- Typecheck and 16 inference tests pass; new regression verifies own-chat retention,
  older/audit/foreign-history exclusion and survival through peer activity.
  Same run redeployed; behavioral reduction remains to be observed.

## codex — Belt flow observations (2026-10-04)

- Astra repeatedly inspected stalled coal transport, but machine/layout output
  exposed direction/status with no item contents; "working" alone did not reveal
  empty vs loaded belts. Added read-only lane counts and summed contents for
  transport belts, underground belts and splitters.
- Disposable Factorio 2.0.77 test passes: two lanes with different items, totals,
  machine/local/layout agreement, empty belt distinction and repeated-read
  conservation. No inference decisions or transport mutations were scripted.
- Deploying same save with private mod/manifest backup and unchanged run ledger.
  Live completion remains unverified; Astra owns route diagnosis and repairs.

- Deployment follow-up: runtime port preflight rejected TCP TIME_WAIT after clean
  shutdown despite no listener. Added SO_REUSEADDR for the TCP probe; active
  listeners remain rejected. Local socket regression passed both cases. Server,
  GUI and same inference mapping resumed after readiness; live belt761 exposes
  three coal on lane2. No data reset or cap change.

## codex — Iron factory completion audit (2026-10-04)

- Engine verified two unattended windows at tick1612860; Astra marked gameplay
  goal done and exited0. Stored plates grew 38->53 during the qualifying minute.
- All five pending journals null and zero inference role processes after stop.
  Continued factory production passed window3 and reached71 aggregate stored
  plates at tick1616340; output chest770 held34 in next status read.
- Natural coal/iron miners, furnace773, fuel arms and output chain inspected;
  belt coal present at all three iron-cell pickup points. Original manifest has
  zero grants. Dashboard HTTP200, viewer running.
- Ledger final: $53.749406 charged, $8.935149 unresolved reservations, $100 cap.
  No new run or cap increase. Detailed scope/limitations recorded in
  docs/factorio-iron-factory-result.md.
- Fixed launcher success classification for forced idle-sibling cleanup after
  successful coordinator/goal completion. Typecheck and four launch tests pass.
  No completed gameplay roles restarted to test this reporting change.

## codex — Fresh modular factory run (2026-10-04)

- Operator requested a reset of both game and gameplay board. Preserved the
  completed iron-zero-20261004 save/database; created iron-modular-20261004
  with new world/history IDs, isolated board, journals, plan and spend ledger.
- Same seed424242; initial engine status confirmed five empty inventories, no
  chests and no furnaces. No old assignments, messages or layout copied.
- Goal: modular, fully automated natural-resource iron acquisition through plate
  storage, with repeatable units, clear interfaces and expansion room. Astra
  chooses the design and gameplay; engine verification still proves production.
- One Astra and five Luna roles live. Astra created five subtasks, all claimed,
  and wrote a fresh external plan. Shared cap $100; overall time/call limits zero
  (unlimited). Private launch timestamp recorded for comparison.
- Viewer confirmed InGame; dashboard HTTP200 at http://127.0.0.1:4193/ and
  configured for the new scope. Four inference bundles rebuilt successfully.
- Operational restart only; no new source changes or tests. Factory completion
  and actual modular layout remain to be observed; run is still in progress.

## codex — Live modular run inspection stall (2026-10-04)

- Same run iron-modular-20261004 remained live, unpaused, with all six roles
  and five claimed actor tasks. At tick ~47k, four bootstrap furnaces and four
  drills existed, but no chest or automated production. Astra's broadcast held
  permanent builds pending exact coordinates; the last eight decisions mostly
  alternated research/layout inspections while actors repeatedly waited.
- Added an inspection-loop signal and bounded inspection refusal after repeated
  reads without a plan or assignment. Astra still chooses all layout and actor
  directives. Resumed same save/board/journals/$100 ledger after clean role stop.
  Astra issued a fresh bootstrap directive at call134; full module build pending.
- Root typecheck and 15 focused orchestrator tests passed; rebuilt deployed
  orchestrator bundle. No gameplay items, board tasks or run settings reset.

## codex — Overseer activity in Factorio dashboard (2026-10-04)

- Added a live "Overseer plan and recent decisions" section to the Factorio
  run panel. It shows sanitized external plan sections, last eight structured
  decisions, model call count and a shortcut to overseer messages. It labels
  these as recorded outputs; private model reasoning is not available.
- Status API reads only the journal for the run whose saved world/history IDs
  match the game. Plan content, decision text and names are length bounded;
  credentials, raw prompts, provider traces and full tool results are excluded.
- Restarted dashboard4193 without touching the game or inference roles. Live
  API returned run iron-modular-20261004, two plan sections, eight decisions and
  game tick56300; served browser bundle contains the new section. Dashboard
  typecheck and server syntax check pass. Factory remains in progress.
