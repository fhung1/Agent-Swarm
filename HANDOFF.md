# Factorio handoff

## Current focus

Factorio only: ten individually prompted workers sharing a gameplay board in a private world. The live Development board owns assignments; do not restore cleared historical tasks automatically. This documentation pass changes Markdown only.

## Prompted demo checkpoint — codex-factorio-demo, 2026-10-03

Task `factorio-inference-graphical-20261003`: 16 provider-free tests passed. On that session's host, the gameplay database uses 127.0.0.1:3001; disposable world `.game-runs/prompted-demo-20261003-2052` passed preflight and ran on 127.0.0.1:34197. Dry run found ten unique actors (12–21), configured for `codex`/`gpt-5.3-codex`, 3 calls per actor and 300000 ms. The graphical client launched. No provider calls occurred; the session awaits its requested spend approval and secure provider credential before `--start`. Verify host state before reusing these endpoints.

## Implemented and checked

- Runtime/bridge: Factorio 2.0.77, ten scripted actors, bounded movement/transfers, private RCON and disposable engine checks.
- Historical fixture: ten rules workers produced fifty plates with matching game/board receipts. [Evidence and limits](docs/factorio-live-verification.md).
- Inference: scoped decision contract, durable worker and ten-process launcher; deterministic checks cover malformed output, ownership/pause, budgets, uncertain receipts and false completion. [Run guide](docs/factorio-inference.md).
- Boards: atomic claims, reservations, archived task dependencies, live priorities and responsive dashboards. Blank browser names are assigned automatically; bots choose priorities using [the policy](docs/task-priorities.md).

## Remaining release gates

Real-provider ten-worker production, useful peer-message consumption, graphical replay, end-to-end fault recovery, validated spend limits and natural-map progression require their own evidence. Historical paths/services may have expired; inspect the current host before launch. [Roadmap](IMPLEMENTATION_PLAN.md) · [Readiness checks](docs/application-readiness.md).

## Session notes

- [Inference implementation](docs/handoffs/codex-connect.md)
- [Live acceptance owner](docs/handoffs/codex-inference-live.md)
- [Runtime and historical fixture](docs/handoffs/codexq-factorio.md)
- [Shared board](docs/handoffs/codex-factorio.md)
- [Journal and demo integration](docs/handoffs/merge-fix.md)
- [Dashboard and documentation](docs/handoffs/codex-queue.md)

Keep future entries brief: task/owner, current status, pushed commit, checks, blockers and next action. Preserve other sessions' unfinished work and coordinate file locks. Commit/push completed work directly to main; no new pull requests.
