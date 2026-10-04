# Factorio handoff

## Current focus

Factorio only: ten individually prompted workers sharing a gameplay board in a private world. The live Development board owns assignments; do not restore cleared historical tasks automatically. This documentation pass changes Markdown only.

## Freeplay work — codex-factorio-demo, 2026-10-03

Started `factorio-freeplay-rocket-subtasks-20261003` after the operator requested a ten-agent freeplay start with no resources, an overarching beat-the-game goal, agent-created subtasks, and shared-container resource requests. Current protocol supports only move/take/put; mine, craft, build, research and rocket-event verification are absent. Next: extend the real-engine action contract and task protocol, verify a zero-grant world, then measure progression. Fixture worlds were saved and stopped.

## Prompted demo checkpoint — codex-factorio-demo, 2026-10-03

`factorio-inference-graphical-20261003`: provider-free acceptance passed (16 tests), graphical viewer joined, and ten independent model workers ran live. The initial run used `gpt-5.3-codex`; after operator correction, a fresh world and board ran `gpt-6-astra`, with peer messages, game receipts and at least two actors holding five actual plates. Fixed contradictory reservation guidance and unstable actor ordering in restart plans. Focused acceptance and root typecheck passed. The operator redirected the work to freeplay, so fixture workers were stopped and their world saved.

## Implemented and checked

- Runtime/bridge: Factorio 2.0.77, ten scripted actors, bounded movement/transfers, private RCON and disposable engine checks.
- Historical fixture: ten rules workers produced fifty plates with matching game/board receipts. [Evidence and limits](docs/factorio-live-verification.md).
- Inference: scoped decision contract, durable worker and ten-process launcher; deterministic checks cover malformed output, ownership/pause, budgets, uncertain receipts and false completion. [Run guide](docs/factorio-inference.md).
- Boards: atomic claims, reservations, archived task dependencies, live priorities and responsive dashboards. Blank browser names are assigned automatically; bots choose priorities using [the policy](docs/task-priorities.md).

## Remaining release gates

Real-provider ten-worker production, useful peer-message consumption, graphical replay, end-to-end fault recovery, validated spend limits and natural-map progression require their own evidence. Historical paths/services may have expired; inspect the current host before launch. [Roadmap](IMPLEMENTATION_PLAN.md) · [Readiness checks](docs/application-readiness.md).

## Session notes

- Board identity authorization — codex-board-3, 2026-10-03: Claimed `board-auth-tailnet` and locked the development and gameplay board modules. Added identity-bound registrations, operator-only recovery and cleanup, CLI migration commands, and distinct-token impersonation checks. Disposable board and cleanup checks, root typecheck and CLI builds passed. Publishing and live migration are next; see [session handoff](docs/handoffs/codex-board-3.md).
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
