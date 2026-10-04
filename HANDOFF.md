# Factorio handoff

## Five players plus board-only coordinator — codex-factorio-demo, 2026-10-03

`factorio-five-actors-astra-orchestrator-20261003`: reduced the fresh saved world to five visible scripted actors (units 12–16), all `gpt-6-astra` low effort. Added a separate `gpt-6-astra` high-effort orchestrator with only message-board access; it claimed the rocket goal, created a run-scoped task for Actor 2, and sent actor-directed messages. Active live run: `freeplay-astra-orchestrated-2`, Factorio `127.0.0.1:34197`, board `http://127.0.0.1:4185/?board=factorio&dbPort=3004`. The old ten-actor save is preserved at `.game-runs/freeplay-astra-start-1-ten-agent-checkpoint`. Live board topology verified. Some worker action attempts still fail (mining, movement, unavailable recipe); no rocket launch verified. `python3 factorio/check-runtime.py`, root typecheck, focused tests (32 total), and Python compile checks pass. Direct push and final board result pending.

## Current focus

Factorio only: five `gpt-6-astra` low-effort game actors share a gameplay board and are directed by one `gpt-6-astra` high-effort board-only orchestrator. The live Development board owns assignments; do not restore cleared historical tasks automatically. Current live world is `.game-runs/freeplay-astra-start-1`, reset to empty-inventory freeplay at the operator's request. The original ten-actor save and earlier progressed save are preserved separately.

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
